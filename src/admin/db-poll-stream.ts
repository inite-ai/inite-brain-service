import { Observable } from 'rxjs';

/** One polling round: the rows that changed after `cursor`, and where to resume. */
export interface PollPage<T, C> {
  rows: T[];
  cursor: C;
}

export interface PollingSource<T, C> {
  intervalMs: number;
  /** Read once per subscription, before the first poll. */
  initialCursor: () => Promise<C>;
  poll: (cursor: C) => Promise<PollPage<T, C>>;
  onError?: (e: Error) => void;
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
    let cursor: { value: C } | undefined;
    let inFlight = false;
    let closed = false;

    const tick = async (): Promise<void> => {
      if (inFlight || closed) return;
      inFlight = true;
      try {
        if (!cursor) cursor = { value: await source.initialCursor() };
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
