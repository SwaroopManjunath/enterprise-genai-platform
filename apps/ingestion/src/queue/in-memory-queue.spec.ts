import { InMemoryQueue } from './in-memory-queue';
import { LockLostError } from './message-queue';

function setup(maxDeliveries = 3, visibilityTimeoutMs = 1000) {
  const clock = { now: 0 };
  const queue = new InMemoryQueue<{ n: number }>({
    maxDeliveries,
    visibilityTimeoutMs,
    now: () => clock.now,
  });
  return { queue, clock };
}

describe('InMemoryQueue', () => {
  it('delivers messages in order and removes them once completed', async () => {
    const { queue } = setup();
    await queue.enqueue({ n: 1 });
    await queue.enqueue({ n: 2 });

    const first = await queue.receive();
    const second = await queue.receive();
    await queue.complete(first!);
    await queue.complete(second!);

    expect([first?.body.n, second?.body.n]).toEqual([1, 2]);
    expect(await queue.receive()).toBeUndefined();
  });

  it('hides a received message from other consumers while it is locked', async () => {
    const { queue } = setup();
    await queue.enqueue({ n: 1 });

    expect(await queue.receive()).toBeDefined();
    expect(await queue.receive()).toBeUndefined();
  });

  it('redelivers after the visibility timeout (consumer crash recovery)', async () => {
    const { queue, clock } = setup(3, 1000);
    await queue.enqueue({ n: 1 });
    const first = await queue.receive();

    clock.now += 1001; // consumer died without completing

    const second = await queue.receive();
    expect(second?.id).toBe(first?.id);
    expect(second?.deliveryCount).toBe(2);
  });

  it('abandon redelivers after the requested delay (backoff)', async () => {
    const { queue, clock } = setup();
    await queue.enqueue({ n: 1 });
    const message = await queue.receive();

    await queue.abandon(message!, 5000);
    expect(await queue.receive()).toBeUndefined();

    clock.now += 5000;
    expect((await queue.receive())?.deliveryCount).toBe(2);
  });

  it('rejects a stale consumer whose lock was taken over', async () => {
    const { queue, clock } = setup(3, 1000);
    await queue.enqueue({ n: 1 });
    const stale = await queue.receive();
    clock.now += 1001;
    const current = await queue.receive();

    await expect(queue.complete(stale!)).rejects.toBeInstanceOf(LockLostError);
    await expect(queue.complete(current!)).resolves.toBeUndefined();
  });

  it('dead-letters after maxDeliveries even if the consumer never reports back', async () => {
    const { queue, clock } = setup(2, 1000);
    await queue.enqueue({ n: 1 });

    await queue.receive();
    clock.now += 1001;
    await queue.receive();
    clock.now += 1001;

    expect(await queue.receive()).toBeUndefined();
    const dead = await queue.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ reason: 'MaxDeliveryCountExceeded', deliveryCount: 2 });
  });

  it('dead-letters explicitly with a reason', async () => {
    const { queue } = setup();
    await queue.enqueue({ n: 1 });
    const message = await queue.receive();

    await queue.deadLetter(message!, 'unsupported file type');

    expect(await queue.receive()).toBeUndefined();
    expect((await queue.deadLetters())[0]?.reason).toBe('unsupported file type');
  });

  it('requeues a dead letter with its delivery count reset', async () => {
    const { queue } = setup(1);
    await queue.enqueue({ n: 7 });
    const message = await queue.receive();
    await queue.deadLetter(message!, 'boom');

    expect(await queue.requeueDeadLetter(message!.id)).toBe(true);
    expect(await queue.requeueDeadLetter(message!.id)).toBe(false);

    const again = await queue.receive();
    expect(again).toMatchObject({ id: message!.id, deliveryCount: 1, body: { n: 7 } });
    expect(await queue.deadLetters()).toEqual([]);
  });

  it('copies bodies so consumers cannot mutate queued data', async () => {
    const { queue } = setup();
    await queue.enqueue({ n: 1 });
    const message = await queue.receive();
    message!.body.n = 99;
    await queue.abandon(message!);

    expect((await queue.receive())?.body.n).toBe(1);
  });
});
