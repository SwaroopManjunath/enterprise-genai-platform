import { randomUUID } from 'node:crypto';
import {
  LockLostError,
  type DeadLetter,
  type MessageQueue,
  type QueueMessage,
} from './message-queue';

interface Entry<T> {
  id: string;
  body: T;
  deliveryCount: number;
  /** Message is invisible until this time (lock expiry or backoff delay). */
  visibleAt: number;
  lockToken: string | undefined;
}

export interface InMemoryQueueOptions {
  maxDeliveries: number;
  visibilityTimeoutMs: number;
  now?: () => number;
}

/** In-process stand-in for Service Bus so the pipeline runs and tests with no cloud account. */
export class InMemoryQueue<T> implements MessageQueue<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly dead = new Map<string, DeadLetter<T>>();
  private readonly now: () => number;

  constructor(private readonly options: InMemoryQueueOptions) {
    this.now = options.now ?? Date.now;
  }

  enqueue(body: T): Promise<string> {
    const id = randomUUID();
    this.entries.set(id, {
      id,
      body: structuredClone(body),
      deliveryCount: 0,
      visibleAt: this.now(),
      lockToken: undefined,
    });
    return Promise.resolve(id);
  }

  receive(): Promise<QueueMessage<T> | undefined> {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.visibleAt > now) continue;

      // A consumer that keeps crashing never gets to dead-letter the message itself, so the
      // queue enforces the delivery limit on the way out.
      if (entry.deliveryCount >= this.options.maxDeliveries) {
        this.moveToDeadLetter(entry, 'MaxDeliveryCountExceeded');
        continue;
      }

      entry.deliveryCount += 1;
      entry.visibleAt = now + this.options.visibilityTimeoutMs;
      entry.lockToken = randomUUID();
      return Promise.resolve({
        id: entry.id,
        body: structuredClone(entry.body),
        deliveryCount: entry.deliveryCount,
        lockToken: entry.lockToken,
      });
    }
    return Promise.resolve(undefined);
  }

  async complete(message: QueueMessage<T>): Promise<void> {
    this.locked(message);
    this.entries.delete(message.id);
  }

  async abandon(message: QueueMessage<T>, delayMs = 0): Promise<void> {
    const entry = this.locked(message);
    entry.visibleAt = this.now() + delayMs;
    entry.lockToken = undefined;
  }

  async deadLetter(message: QueueMessage<T>, reason: string): Promise<void> {
    this.moveToDeadLetter(this.locked(message), reason);
  }

  deadLetters(): Promise<DeadLetter<T>[]> {
    return Promise.resolve([...this.dead.values()].map((d) => structuredClone(d)));
  }

  requeueDeadLetter(id: string): Promise<boolean> {
    const letter = this.dead.get(id);
    if (!letter) return Promise.resolve(false);

    this.dead.delete(id);
    this.entries.set(id, {
      id,
      body: letter.body,
      deliveryCount: 0,
      visibleAt: this.now(),
      lockToken: undefined,
    });
    return Promise.resolve(true);
  }

  /** The entry, if `message` still holds its lock; otherwise the lock expired and moved on. */
  private locked(message: QueueMessage<T>): Entry<T> {
    const entry = this.entries.get(message.id);
    if (!entry || entry.lockToken !== message.lockToken) throw new LockLostError(message.id);
    return entry;
  }

  private moveToDeadLetter(entry: Entry<T>, reason: string): void {
    this.entries.delete(entry.id);
    this.dead.set(entry.id, {
      id: entry.id,
      body: entry.body,
      reason,
      deliveryCount: entry.deliveryCount,
      deadLetteredAt: new Date(this.now()).toISOString(),
    });
  }
}
