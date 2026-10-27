import { Semaphore } from '../src/common/semaphore';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Semaphore', () => {
  it.each([0, -1, NaN])('rejects an invalid limit of %s', (limit) => {
    expect(() => new Semaphore(limit)).toThrow('Semaphore limit must be a positive integer');
  });

  it('bounds in-flight work and starts waiters in FIFO order', async () => {
    const semaphore = new Semaphore(2);
    const gates = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const jobs = gates.map((gate, index) =>
      semaphore.run(async () => {
        active++;
        peak = Math.max(peak, active);
        started.push(index);
        await gate.promise;
        active--;
        return index;
      }),
    );

    expect(semaphore.inFlight()).toBe(2);
    expect(semaphore.pending()).toBe(3);
    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    gates[1]!.resolve();
    await jobs[1];
    expect(started).toEqual([0, 1, 2]);
    expect(semaphore.inFlight()).toBe(2);
    expect(semaphore.pending()).toBe(2);

    gates[0]!.resolve();
    await jobs[0];
    expect(started).toEqual([0, 1, 2, 3]);
    expect(semaphore.pending()).toBe(1);

    gates[2]!.resolve();
    await jobs[2];
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(semaphore.pending()).toBe(0);

    gates[3]!.resolve();
    gates[4]!.resolve();
    await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(semaphore.inFlight()).toBe(0);
    expect(semaphore.pending()).toBe(0);
  });

  it('returns the task value', async () => {
    const semaphore = new Semaphore(1);
    const value = { id: 'result' };

    await expect(semaphore.run(async () => value)).resolves.toBe(value);
  });

  it('releases a failed task slot and preserves its error', async () => {
    const semaphore = new Semaphore(1);
    const gate = deferred();
    const error = new Error('task failed');
    const failed = semaphore.run(async () => {
      await gate.promise;
      throw error;
    });
    const rejection = expect(failed).rejects.toBe(error);
    const nextTask = jest.fn(async () => 'next');
    const next = semaphore.run(nextTask);

    expect(semaphore.inFlight()).toBe(1);
    expect(semaphore.pending()).toBe(1);
    expect(nextTask).not.toHaveBeenCalled();

    gate.resolve();
    await rejection;
    await expect(next).resolves.toBe('next');
    expect(nextTask).toHaveBeenCalledTimes(1);
    expect(semaphore.inFlight()).toBe(0);
    expect(semaphore.pending()).toBe(0);
  });
});
