import { mapWithLimit } from '../src/common/parallel';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('mapWithLimit', () => {
  it('returns input order when items finish out of order', async () => {
    const items = ['first', 'second', 'third'];
    const gates = items.map(() => deferred<string>());
    const completed: string[] = [];
    const result = mapWithLimit({
      items,
      concurrency: 3,
      fn: async (item, index) => {
        const value = await gates[index]!.promise;
        completed.push(item);
        return value;
      },
    });

    gates[2]!.resolve('THIRD');
    gates[0]!.resolve('FIRST');
    gates[1]!.resolve('SECOND');

    await expect(result).resolves.toEqual(['FIRST', 'SECOND', 'THIRD']);
    expect(completed).toEqual(['third', 'first', 'second']);
  });

  it('never exceeds the requested concurrency', async () => {
    const items = [0, 1, 2, 3, 4];
    const gates = items.map(() => deferred<void>());
    const started = items.map(() => deferred<void>());
    let active = 0;
    let peak = 0;
    const result = mapWithLimit({
      items,
      concurrency: 2,
      fn: async (item) => {
        active++;
        peak = Math.max(peak, active);
        started[item]!.resolve();
        await gates[item]!.promise;
        active--;
        return item;
      },
    });

    expect(active).toBe(2);
    gates[0]!.resolve();
    await started[2]!.promise;
    expect(active).toBe(2);
    gates[1]!.resolve();
    await started[3]!.promise;
    expect(active).toBe(2);
    gates[2]!.resolve();
    await started[4]!.promise;
    expect(active).toBe(2);
    gates[3]!.resolve();
    gates[4]!.resolve();

    await expect(result).resolves.toEqual(items);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('reports an item failure without stopping other items', async () => {
    const error = new Error('item failed');
    const onError = jest.fn();
    const fn = jest.fn(async (item: number) => {
      if (item === 2) throw error;
      return item * 2;
    });

    await expect(mapWithLimit({ items: [1, 2, 3], concurrency: 2, fn, onError })).resolves.toEqual([
      2,
      null,
      6,
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, 2, 1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('keeps a failed slot null when no error callback is supplied', async () => {
    await expect(
      mapWithLimit({
        items: [1],
        concurrency: 1,
        fn: async () => {
          throw new Error('item failed');
        },
      }),
    ).resolves.toEqual([null]);
  });

  it('returns an empty result without invoking the mapper', async () => {
    const fn = jest.fn(async () => 'unused');

    await expect(mapWithLimit({ items: [], concurrency: 2, fn })).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('still maps every item when concurrency is zero', async () => {
    const fn = jest.fn(async (item: number) => item * 2);

    await expect(mapWithLimit({ items: [1, 2, 3], concurrency: 0, fn })).resolves.toEqual([
      2, 4, 6,
    ]);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
