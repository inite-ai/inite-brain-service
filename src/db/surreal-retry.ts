/**
 * SurrealDB error-classification + retry helpers.
 *
 * Pure, driver-message-matching logic pulled out of the SurrealService
 * god-file so it can be unit-tested without a live datastore. The runtime
 * source of truth for "is this error retriable" lives here; the service
 * and its transaction runner delegate to these functions.
 */

/**
 * Detect SurrealDB unique-index violation. The driver surfaces these
 * as plain Errors with the index name embedded in the message; we
 * match on the marker text rather than coupling to a specific class.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes('already contains') || // "already contains a record with id ..."
    m.includes('Database index') || // "Database index `xxx` already contains ..."
    m.includes('IndexExists') ||
    m.includes('already exists') || // "Database record `xxx:yyy` already exists" — explicit-id CREATE collision
    m.includes('Found a record') // SurrealDB v2 wording variant for the same condition
  );
}

/**
 * Detect SurrealDB optimistic-concurrency read conflict — narrow match.
 * Only the specific datastore-level abort messages are retriable; the
 * broader "failed transaction" envelope wraps non-retriable failures
 * too (parse errors, type assertions, permission denials), and looping
 * those burns the retry budget for nothing.
 *
 * v2.2.x rocksdb backend surfaces commit-time OCC aborts with a new,
 * more explicit wording: "Failed to commit transaction due to a read
 * or write conflict. This transaction can be retried". Under
 * concurrent CREATEs against a UNIQUE-indexed key, the FIRST few
 * attempts in a fanout often abort here at commit time before the
 * uniqueness check fires (so they never present as
 * `isUniqueViolation`). Both patterns must be caught for the
 * retry loop to converge.
 */
export function isReadConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes('Transaction read conflict') ||
    m.includes('wrote at the same key') ||
    m.includes('read or write conflict') ||
    m.includes('This transaction can be retried') ||
    // SurrealDB 3.x single-statement conflict wording:
    // "Transaction conflict: Write conflict, retry the transaction. This
    //  transaction can be retried" (already matched by the line above, but
    //  match the distinctive prefix too in case the trailing sentence drops).
    m.includes('Transaction conflict') ||
    m.includes('Write conflict')
  );
}

/**
 * Enrich a multi-statement BEGIN/COMMIT batch rejection so the retry
 * detector can see it.
 *
 * SurrealDB v2.2.8 surfaces aborted BEGIN/COMMIT batches as a single
 * top-level rejection with the bare wrapper "The query was not executed
 * due to a failed transaction" — the per-statement cause (e.g. "Failed to
 * commit transaction due to a read or write conflict. This transaction can
 * be retried") is dropped by the time the JS driver builds the error.
 * Without enrichment, `isReadConflict(err)` sees only the wrapper and the
 * surrounding retry loop won't fire.
 *
 * Mitigation: any `failed transaction` wrapper emerging from a
 * multi-statement BEGIN/COMMIT batch IS, by construction, a commit-level
 * abort — for our usage (atomic upsert), commit aborts under contention
 * are exactly the retriable case. Re-throw with the canonical
 * read-or-write-conflict suffix so the retry detector picks it up. Parse
 * errors and permission denials don't surface via this wrapper (they fail
 * at parse/auth before the tx is even entered), so the false-positive risk
 * is bounded.
 *
 * Non-wrapper errors are returned unchanged so callers can `throw
 * enrichTransactionError(err)` unconditionally.
 */
export function enrichTransactionError(err: unknown): unknown {
  if (err instanceof Error && err.message.includes('failed transaction')) {
    const cause = (err as { cause?: { message?: string } }).cause;
    const suffix =
      cause?.message ?? 'read or write conflict; this transaction can be retried';
    const enriched = new Error(`${err.message}: ${suffix}`);
    (enriched as Error & { cause?: unknown }).cause = err;
    return enriched;
  }
  return err;
}

/** Real wall-clock backoff used in production. Swappable in tests. */
const defaultBackoffSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Retry a body on transient concurrency failures: unique-index
 * violations OR optimistic-concurrency read conflicts. Both arise
 * from the same SELECT-then-CREATE race window — under contention,
 * one tx commits and others either (a) see a duplicate index entry
 * (unique violation) or (b) have their read-set invalidated (read
 * conflict). Both are retriable: re-run the closure, which on its
 * second SELECT will see the racing caller's commit and either
 * short-circuit (read path) or write fresh state (rare).
 *
 * We use exponential backoff with jitter so a herd of FANOUT
 * retries doesn't synchronise into a second collision wave. The
 * `sleep` injection point keeps the schedule real in production while
 * letting unit tests run the loop without wall-clock delay.
 */
export async function retryOnUniqueViolation<T>(
  fn: () => Promise<T>,
  attempts = 7,
  sleep: (ms: number) => Promise<void> = defaultBackoffSleep,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isUniqueViolation(err) && !isReadConflict(err)) throw err;
      lastErr = err;
      if (i < attempts - 1) {
        // Exponential backoff with full jitter: 10..20, 20..40, 40..80,
        // 80..160, 160..320, 320..640 ms — total worst case ~1.3s.
        // Sized for FANOUT-up-to-pool-size contention on the rocksdb
        // backend: that's the regime where retries actually help (the
        // racing committer's row appears within hundreds of ms).
        // Beyond that the test path needs to back off load itself.
        const baseMs = 10 * Math.pow(2, i);
        const jitter = Math.random() * baseMs;
        await sleep(baseMs + jitter);
      }
    }
  }
  throw lastErr;
}
