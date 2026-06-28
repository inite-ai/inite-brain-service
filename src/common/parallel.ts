/**
 * Tiny bounded-parallel helper. Runs `fn(item)` for every item with
 * at most `concurrency` in flight. Returns results in the SAME order
 * as input. Errors don't short-circuit — `mapper` receives `null` for
 * the failing slot via the optional `onError` callback.
 *
 * Why not p-limit / Bluebird.map? Both fine; this is 12 lines and
 * removes the dep, which matters for our cold-start budget (BGE-M3
 * already imports onnxruntime + ~150MB model).
 */
export interface MapWithLimitOptions<T, R> {
  items: readonly T[];
  concurrency: number;
  fn: (item: T, index: number) => Promise<R>;
  onError?: (err: Error, item: T, index: number) => void;
}

export async function mapWithLimit<T, R>({
  items,
  concurrency,
  fn,
  onError,
}: MapWithLimitOptions<T, R>): Promise<Array<R | null>> {
  const out: Array<R | null> = new Array(items.length).fill(null);
  let cursor = 0;
  const cap = Math.max(1, Math.min(concurrency, items.length || 1));
  const workers = Array.from({ length: cap }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        onError?.(e as Error, items[i], i);
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
