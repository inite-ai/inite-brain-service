/**
 * Bounded worker pool — the one concurrency loop every eval runner used
 * to re-implement inline. Items are claimed by index, so ordering of
 * side effects is stable enough for progress tags (`[axis 3/50]`).
 */
export async function runPool<T>(
  concurrency: number,
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!, i);
    }
  });
  await Promise.all(lanes);
}
