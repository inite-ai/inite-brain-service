/**
 * Tiny insertion-order LRU. Map preserves insertion order, so a get()
 * deletes-and-re-inserts to bump the entry to the most-recent slot;
 * set() evicts the oldest key when capacity is reached.
 *
 * Sized for embedding hits — a few thousand entries, ~6 KB each at
 * 1536 dims × 4 bytes = ~6 MB at 1000 entries. Plenty for repeat
 * extractions on similar text inside a single tenant burst.
 */
export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error(`LRUCache capacity must be a positive integer, got ${capacity}`);
    }
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
