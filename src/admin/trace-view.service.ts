import { Injectable, Logger, Optional } from '@nestjs/common';
import { merge, type MonoTypeOperatorFunction, type Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { Surreal } from 'surrealdb';
import { LRUCache } from '../common/lru-cache';
import type { DebugTraceSnapshot } from '../common/debug-trace-core';
import { TraceBufferService, type TraceListItem } from '../common/trace-buffer.service';
import { SurrealService, queryRows } from '../db/surreal.service';
import { anchorAt, pollingObservable, type PollPage } from './db-poll-stream';

/** Cadence at which traces recorded by other replicas reach a stream. */
export const TRACE_STREAM_POLL_MS = 1_500;
/** Re-read window behind the cursor: `ts` is stamped by the producing
 *  replica before its write lands, so a row can appear carrying a ts
 *  older than the newest one already seen. */
const TRACE_OVERLAP_MS = 10_000;
const PAGE = 200;

interface TraceRow {
  requestId: string;
  ts: string | Date;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  companyId?: string | null;
  errored?: { message: string; name?: string } | null;
}

/** The debug_trace rows to read on one tick: newer than `from`, cursor `at`. */
interface TraceWindow {
  at: Date;
  from: Date;
}

/**
 * The operator's tenant-scoped view of request traces. `list` is this
 * replica's ring buffer; `get` falls through to debug_trace; `observe`
 * is the SSE source — same-process traces arrive through
 * TraceBufferService's Subject with no delay, and, when
 * DEBUG_TRACE_PERSIST writes traces to debug_trace, that table is polled
 * so traces served by other replicas appear too, each requestId once.
 * With persistence off, the stream is what this replica saw.
 */
@Injectable()
export class TraceViewService {
  private readonly logger = new Logger(TraceViewService.name);

  constructor(
    private readonly traces: TraceBufferService,
    @Optional() private readonly surreal?: SurrealService,
  ) {}

  list(companyId: string): TraceListItem[] {
    return this.traces.list(companyId);
  }

  get(requestId: string, companyId: string): Promise<DebugTraceSnapshot | undefined> {
    return this.traces.get(requestId, companyId);
  }

  observe(companyId: string): Observable<TraceListItem> {
    const local = this.traces.observe().pipe(filter((t) => t.companyId === companyId));
    const surreal = this.surreal;
    if (!surreal || !this.traces.persistsToDb()) return local;
    let floor: Date | undefined;
    const polled = pollingObservable<TraceListItem, Date>({
      intervalMs: TRACE_STREAM_POLL_MS,
      initialCursor: async (subscribedAt) => {
        floor = anchorAt(subscribedAt, await surreal.withCompany(companyId, dbNow));
        return floor;
      },
      poll: (at) =>
        surreal.withCompany(companyId, (db) => {
          const overlap = new Date(at.getTime() - TRACE_OVERLAP_MS);
          const from = floor && overlap < floor ? floor : overlap;
          return tracesSince(db, companyId, { at, from });
        }),
      onError: (e) => this.logger.warn(`trace stream poll failed (${companyId}): ${e.message}`),
    });
    return merge(local, polled).pipe(distinctRequestIds());
  }
}

async function dbNow(db: Surreal): Promise<Date> {
  const [now] = await db.query<[string | Date]>(`RETURN time::now()`);
  return new Date(now);
}

async function tracesSince(
  db: Surreal,
  companyId: string,
  window: TraceWindow,
): Promise<PollPage<TraceListItem, Date>> {
  const rows = await queryRows<TraceRow>(
    db,
    `SELECT requestId, ts, method, path, status, durationMs, companyId, errored
       FROM debug_trace
      WHERE companyId = $c AND ts > $from
      ORDER BY ts ASC LIMIT ${PAGE}`,
    { c: companyId, from: window.from },
  );
  let cursor = window.at;
  const out = rows.map((r) => {
    const at = new Date(r.ts);
    if (at > cursor) cursor = at;
    return toItem(r, companyId);
  });
  return { rows: out, cursor };
}

function toItem(r: TraceRow, companyId: string): TraceListItem {
  const item: TraceListItem = {
    requestId: r.requestId,
    ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString(),
    method: r.method,
    path: r.path,
    status: r.status,
    durationMs: r.durationMs,
    companyId,
  };
  if (r.errored) item.errored = r.errored;
  return item;
}

/** Per-subscription: each requestId once, whichever path delivered it first. */
function distinctRequestIds(): MonoTypeOperatorFunction<TraceListItem> {
  const seen = new LRUCache<string, true>(2_000);
  return filter((t) => {
    if (seen.has(t.requestId)) return false;
    seen.set(t.requestId, true);
    return true;
  });
}
