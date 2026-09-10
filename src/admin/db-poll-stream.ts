import { Observable } from 'rxjs';

/** One polling round: the rows that changed after `cursor`, and where to resume. */
export interface PollPage<T, C> {
  rows: T[];
  cursor: C;
}

export interface PollingSource<T, C> {
  intervalMs: number;
  /**
   * Read once per subscription, before the first poll. `subscribedAt` is
   * a monotonic mark taken the instant the subscription began and is the
   * same value on every retry, so a cursor read off the database clock can
   * name that instant rather than whenever the read got through — see
   * `anchorAt`.
   */
  initialCursor: (subscribedAt: bigint) => Promise<C>;
  poll: (cursor: C) => Promise<PollPage<T, C>>;
  onError?: (e: Error) => void;
}

/**
 * The database's clock rewound to the moment the subscription began.
 * Reading that clock enters the tenant scope and can block for seconds —
 * the replica pays the tenant's schema bootstrap when it is the first
 * caller through that tenant's door — and a cursor anchored after the
 * wait sits ahead of everything written during it, which a `>= cursor`
 * filter then never returns. Subtracting the locally measured wait keeps
 * the anchor behind those writes; the cost is replaying the wait's worth
 * of rows, which the caller's de-duplication absorbs.
 */
export function anchorAt(subscribedAt: bigint, dbNow: Date): Date {
  const waitedMs = Number(process.hrtime.bigint() - subscribedAt) / 1_000_000;
  return new Date(dbNow.getTime() - Math.ceil(Math.max(0, waitedMs)));
}

/**
 * An Observable that polls a source on a fixed cadence for as long as it
 * has a subscriber. The timer is unref'd (a stream never keeps the
 * process alive), a slow tick is never overlapped by the next one, a
 * failing tick is reported to `onError` and retried on the next tick,
 * and unsubscribing (the SSE client going away) stops the timer.
 */
export function pollingObservable<T, C>(source: PollingSource<T, C>): Observable<T> {
  return new Observable<T>((subscriber) => {
    const subscribedAt = process.hrtime.bigint();
    let cursor: { value: C } | undefined;
    let inFlight = false;
    let closed = false;

    const tick = async (): Promise<void> => {
      if (inFlight || closed) return;
      inFlight = true;
      try {
        if (!cursor) cursor = { value: await source.initialCursor(subscribedAt) };
        const page = await source.poll(cursor.value);
        cursor.value = page.cursor;
        for (const row of page.rows) {
          if (closed) break;
          subscriber.next(row);
        }
      } catch (e) {
        source.onError?.(e as Error);
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), source.intervalMs);
    timer.unref?.();
    return () => {
      closed = true;
      clearInterval(timer);
    };
  });
}

/** JSON with object keys sorted at every depth, so two encodings of the
 *  same value compare equal whichever side (this process, the database)
 *  ordered the keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) out[key] = src[key];
      return out;
    }
    return v;
  });
}
