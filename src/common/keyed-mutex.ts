/**
 * In-process async mutex keyed by an arbitrary string. Serializes
 * sections that share a key; sections with different keys run freely.
 *
 * Why this exists: SurrealDB 2.x raised an optimistic-concurrency read
 * conflict when two `fn::resolve_fact` calls raced on the same
 * (entity, predicate), so the loser retried and superseded instead of
 * inserting a second active row. SurrealDB 3.x no longer surfaces that
 * conflict reliably for single-statement SELECT-then-write inside a
 * function, so concurrent resolves could each insert an `active` row.
 * Serializing resolves per (company, entity, predicate) restores the
 * "at most one active" invariant within a process; the retry loop still
 * covers the cross-pod case best-effort.
 *
 * The key is dropped from the map as soon as the last holder releases,
 * so the map never grows unbounded.
 */
export class KeyedMutex {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Wait until no one holds this key. Re-check after each await: when
    // the holder releases, every waiter wakes, but the first to fall
    // through synchronously re-takes the lock (set() happens before any
    // further await), so the rest loop and wait again.
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(key, held);
    try {
      return await fn();
    } finally {
      this.locks.delete(key);
      release();
    }
  }
}
