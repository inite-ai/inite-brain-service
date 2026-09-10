/**
 * TraceViewService — /admin/traces/stream shows traces from every
 * replica when DEBUG_TRACE_PERSIST writes them to debug_trace; each
 * requestId is emitted once whichever path delivered it first. list/get
 * pass through to the buffer unchanged.
 */
import { Subject } from 'rxjs';
import { TRACE_STREAM_POLL_MS, TraceViewService } from '../src/admin/trace-view.service';
import type { TraceBufferService, TraceListItem } from '../src/common/trace-buffer.service';
import type { SurrealService } from '../src/db/surreal.service';

const T0 = new Date('2026-09-10T00:00:00.000Z');

interface DbTrace {
  requestId: string;
  ts: Date;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  companyId: string;
  errored?: { message: string } | null;
}

function harness(opts: { persist: boolean }) {
  const local = new Subject<TraceListItem>();
  const calls: string[] = [];
  const traces = {
    observe: () => local.asObservable(),
    persistsToDb: () => opts.persist,
    list: (c: string) => {
      calls.push(`list:${c}`);
      return [item({ requestId: 'buffered' })];
    },
    get: async (id: string, c: string) => {
      calls.push(`get:${id}:${c}`);
      return undefined;
    },
  } as unknown as TraceBufferService;
  const state = { rows: [] as DbTrace[], froms: [] as Date[] };
  const surreal = {
    withCompany: async (_c: string, fn: (db: any) => Promise<any>) =>
      fn({
        query: async (sql: string, vars?: { c: string; from: Date }) => {
          if (sql.startsWith('RETURN time::now()')) return [T0];
          state.froms.push(vars!.from);
          const rows = state.rows
            .filter((r) => r.companyId === vars!.c && r.ts > vars!.from)
            .sort((a, b) => a.ts.getTime() - b.ts.getTime());
          return [rows];
        },
      }),
  } as unknown as SurrealService;
  const svc = new TraceViewService(traces, surreal);
  const seen: TraceListItem[] = [];
  const sub = svc.observe('co_a').subscribe((t) => seen.push(t));
  return { svc, local, state, seen, sub, calls };
}

function item(over: Partial<TraceListItem> = {}): TraceListItem {
  return {
    requestId: 'req-1',
    ts: T0.toISOString(),
    method: 'POST',
    path: '/v1/search',
    status: 200,
    durationMs: 12,
    companyId: 'co_a',
    ...over,
  };
}

function dbTrace(over: Partial<DbTrace> = {}): DbTrace {
  return {
    requestId: 'req-2',
    ts: new Date(T0.getTime() + 400),
    method: 'GET',
    path: '/v1/entities/x',
    status: 500,
    durationMs: 40,
    companyId: 'co_a',
    errored: { message: 'boom' },
    ...over,
  };
}

describe('TraceViewService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('list and get pass through to the buffer, tenant-scoped', async () => {
    const h = harness({ persist: false });
    expect(h.svc.list('co_a').map((t) => t.requestId)).toEqual(['buffered']);
    await h.svc.get('req-x', 'co_a');
    expect(h.calls).toEqual(['list:co_a', 'get:req-x:co_a']);
    h.sub.unsubscribe();
  });

  it('does not poll when traces are not persisted (nothing to see from other replicas)', async () => {
    const h = harness({ persist: false });
    h.local.next(item());
    await jest.advanceTimersByTimeAsync(TRACE_STREAM_POLL_MS * 2);
    expect(h.seen).toHaveLength(1);
    expect(h.state.froms).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
    h.sub.unsubscribe();
  });

  it('emits a trace recorded by another replica, as list metadata', async () => {
    const h = harness({ persist: true });
    await jest.advanceTimersByTimeAsync(0);
    h.state.rows.push(dbTrace());
    await jest.advanceTimersByTimeAsync(TRACE_STREAM_POLL_MS);
    expect(h.seen).toEqual([
      {
        requestId: 'req-2',
        ts: new Date(T0.getTime() + 400).toISOString(),
        method: 'GET',
        path: '/v1/entities/x',
        status: 500,
        durationMs: 40,
        companyId: 'co_a',
        errored: { message: 'boom' },
      },
    ]);
    h.sub.unsubscribe();
  });

  it('emits a requestId once when it arrives locally and then from the database', async () => {
    const h = harness({ persist: true });
    await jest.advanceTimersByTimeAsync(0);
    h.local.next(item({ requestId: 'req-9' }));
    h.state.rows.push(dbTrace({ requestId: 'req-9', ts: new Date(T0.getTime() + 100) }));
    await jest.advanceTimersByTimeAsync(TRACE_STREAM_POLL_MS * 2);
    expect(h.seen).toHaveLength(1);
    h.sub.unsubscribe();
  });

  it('re-reads a window behind the cursor for late-landing rows, never before connect time', async () => {
    const h = harness({ persist: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(h.state.froms[0]).toEqual(T0); // overlap clamped to the connect-time floor
    const late = new Date(T0.getTime() + 30_000);
    h.state.rows.push(dbTrace({ requestId: 'req-late', ts: late }));
    await jest.advanceTimersByTimeAsync(TRACE_STREAM_POLL_MS);
    expect(h.seen.map((t) => t.requestId)).toEqual(['req-late']);
    await jest.advanceTimersByTimeAsync(TRACE_STREAM_POLL_MS);
    expect(h.state.froms[h.state.froms.length - 1]).toEqual(new Date(late.getTime() - 10_000));
    // A row that landed with an older ts than the cursor is still picked up once.
    h.state.rows.push(dbTrace({ requestId: 'req-lagged', ts: new Date(late.getTime() - 5_000) }));
    await jest.advanceTimersByTimeAsync(TRACE_STREAM_POLL_MS * 2);
    expect(h.seen.map((t) => t.requestId)).toEqual(['req-late', 'req-lagged']);
    h.sub.unsubscribe();
  });

  it('stops polling when the client disconnects', async () => {
    const h = harness({ persist: true });
    await jest.advanceTimersByTimeAsync(TRACE_STREAM_POLL_MS);
    const before = h.state.froms.length;
    h.sub.unsubscribe();
    await jest.advanceTimersByTimeAsync(TRACE_STREAM_POLL_MS * 3);
    expect(h.state.froms).toHaveLength(before);
  });
});
