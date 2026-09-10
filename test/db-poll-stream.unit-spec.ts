/**
 * pollingObservable — the shared engine behind the DB-driven admin SSE
 * streams: fixed cadence, no overlapping ticks, errors retried, timer
 * released on unsubscribe.
 */
import { pollingObservable, stableStringify } from '../src/admin/db-poll-stream';

describe('pollingObservable', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('polls on the cadence, threads the cursor, and emits every row', async () => {
    const polls: number[] = [];
    let initialReads = 0;
    const seen: string[] = [];
    const sub = pollingObservable<string, number>({
      intervalMs: 100,
      initialCursor: async () => {
        initialReads += 1;
        return 10;
      },
      poll: async (cursor) => {
        polls.push(cursor);
        return { rows: [`r${cursor}a`, `r${cursor}b`], cursor: cursor + 1 };
      },
    }).subscribe((r) => seen.push(r));

    await jest.advanceTimersByTimeAsync(0);
    expect(polls).toEqual([10]);
    await jest.advanceTimersByTimeAsync(250);
    expect(polls).toEqual([10, 11, 12]);
    expect(seen).toEqual(['r10a', 'r10b', 'r11a', 'r11b', 'r12a', 'r12b']);
    expect(initialReads).toBe(1);
    sub.unsubscribe();
  });

  it('never overlaps a slow tick with the next one', async () => {
    let polls = 0;
    let release: (() => void) | undefined;
    const sub = pollingObservable<string, number>({
      intervalMs: 100,
      initialCursor: async () => 0,
      poll: async (cursor) => {
        polls += 1;
        await new Promise<void>((r) => (release = r));
        return { rows: [], cursor };
      },
    }).subscribe();

    await jest.advanceTimersByTimeAsync(350);
    expect(polls).toBe(1);
    release!();
    await jest.advanceTimersByTimeAsync(100);
    expect(polls).toBe(2);
    sub.unsubscribe();
  });

  it('reports a failing tick and polls again on the next one', async () => {
    const errors: string[] = [];
    let polls = 0;
    const sub = pollingObservable<string, number>({
      intervalMs: 100,
      initialCursor: async () => 0,
      poll: async (cursor) => {
        polls += 1;
        if (polls === 1) throw new Error('db hiccup');
        return { rows: [], cursor };
      },
      onError: (e) => errors.push(e.message),
    }).subscribe();

    await jest.advanceTimersByTimeAsync(100);
    expect(errors).toEqual(['db hiccup']);
    expect(polls).toBe(2);
    sub.unsubscribe();
  });

  it('stops polling and releases the timer when the subscriber goes away', async () => {
    let polls = 0;
    const sub = pollingObservable<string, number>({
      intervalMs: 100,
      initialCursor: async () => 0,
      poll: async (cursor) => {
        polls += 1;
        return { rows: [], cursor };
      },
    }).subscribe();
    await jest.advanceTimersByTimeAsync(100);
    const before = polls;
    sub.unsubscribe();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(500);
    expect(polls).toBe(before);
  });
});

describe('stableStringify', () => {
  it('encodes the same value identically whichever side ordered the keys', () => {
    const a = { z: 1, a: { d: [{ y: 1, x: 2 }], c: null } };
    const b = { a: { c: null, d: [{ x: 2, y: 1 }] }, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"a":{"c":null,"d":[{"x":2,"y":1}]},"z":1}');
  });
});
