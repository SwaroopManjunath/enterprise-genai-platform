export interface QueueMessage<T> {
  id: string;
  body: T;
  /** How many times this message has been handed to a consumer, including this delivery. */
  deliveryCount: number;
  /** Proves this consumer still holds the message; stale tokens are rejected. */
  lockToken: string;
}

export interface DeadLetter<T> {
  id: string;
  body: T;
  reason: string;
  deliveryCount: number;
  deadLetteredAt: string;
}

/** The consumer's lock expired and the message may now belong to someone else. */
export class LockLostError extends Error {
  constructor(messageId: string) {
    super(`Lock lost for message ${messageId}`);
    this.name = 'LockLostError';
  }
}

/**
 * Peek-lock queue, the same contract as Azure Service Bus: a received message is hidden (locked)
 * for a visibility timeout. The consumer must complete it; if it abandons it, or crashes and the
 * lock expires, the message becomes visible again. After too many deliveries it is moved to the
 * dead-letter queue instead of being retried forever.
 */
export interface MessageQueue<T> {
  enqueue(body: T): Promise<string>;
  /** Returns the next visible message and locks it, or undefined when there is none. */
  receive(): Promise<QueueMessage<T> | undefined>;
  /** Removes a processed message. */
  complete(message: QueueMessage<T>): Promise<void>;
  /** Releases the lock so the message is redelivered after `delayMs` (used for backoff). */
  abandon(message: QueueMessage<T>, delayMs?: number): Promise<void>;
  /** Parks the message in the dead-letter queue with a human-readable reason. */
  deadLetter(message: QueueMessage<T>, reason: string): Promise<void>;
  deadLetters(): Promise<DeadLetter<T>[]>;
  /** Moves a dead-lettered message back to the main queue with its delivery count reset. */
  requeueDeadLetter(id: string): Promise<boolean>;
}

export const MESSAGE_QUEUE = Symbol('MESSAGE_QUEUE');
