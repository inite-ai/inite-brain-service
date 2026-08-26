import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { outcomeTelemetryEnabled } from '../common/outcome-flags';

/**
 * MemoryOutcomeService — the ONE write seam for outcome telemetry
 * (memory_outcome + memory_outcome_stat, migration 0107).
 *
 * Every writer (search `retrieved`, synthesize selected/used/verifier,
 * ingest contradicted, feedback confirmed/rejected) hands this service a
 * batch of events; it appends the raw rows and folds the corresponding
 * counter deltas into the per-subject rollup in ONE detached round-trip.
 *
 * Discipline (the fact_usage/usage.ts idiom, 0053):
 *   * master-flag guard INSIDE the service — callers may cheaply check
 *     too, but flag-off is a no-op here regardless;
 *   * fire-and-forget on a fresh ROOT-pool connection (the caller's
 *     scoped connection returns to the pool when the request ends — a
 *     detached write must not borrow it); a failure warns, never errors
 *     or slows the serving path;
 *   * dedupe + cap per call bounds the write amplification.
 *
 * meta is CONTENT-FREE by contract: record ids / verdict strings only,
 * never fact text (see the 0107 header for why that is load-bearing).
 */

export type OutcomeSubjectKind = 'fact' | 'episode' | 'belief' | 'evidence';

export type OutcomeEventName =
  | 'retrieved'
  | 'selected_for_context'
  | 'used_in_answer'
  | 'verifier_supported'
  | 'user_confirmed'
  | 'user_rejected'
  | 'contradicted';

/** Rollup counters a stat delta may target (0107 columns). */
export type OutcomeCounter =
  | 'selectedCount'
  | 'usedCount'
  | 'verifiedUseCount'
  | 'confirmedCount'
  | 'rejectedCount'
  | 'contradictedCount';

export interface OutcomeEventInput {
  subjectKind: OutcomeSubjectKind;
  /** Full record id string, e.g. 'knowledge_fact:abc'. */
  subjectId: string;
  event: OutcomeEventName;
  actor?: string | undefined;
  /** CONTENT-FREE: ids / verdict strings only — never fact text. */
  meta?: Record<string, unknown> | undefined;
}

/**
 * One signed counter move on the rollup. Explicit deltas exist for the
 * verdict-replacement writers (feedback): a replaced vote is −1 on the
 * old bucket and +1 on the new one — a shape the event→counter 'auto'
 * mapping cannot express.
 */
export interface StatDelta {
  subjectKind: OutcomeSubjectKind;
  subjectId: string;
  counter: OutcomeCounter;
  delta: number;
  lastUsedAt?: Date | undefined;
  lastVerifiedUseAt?: Date | undefined;
}

/** Max events recorded per call — bounds the write amplification (usage.ts RECORD_CAP idiom). */
export const OUTCOME_RECORD_CAP = 100;

/**
 * Event → rollup mapping for statDeltas: 'auto'. `retrieved` is
 * DELIBERATELY absent: the raw stream is prunable volume, and readCount
 * already lives on fact_usage (0053) — a retrieved counter here would
 * duplicate it.
 */
const AUTO_STAT: Partial<
  Record<OutcomeEventName, { counter: OutcomeCounter; used?: boolean; verified?: boolean }>
> = {
  selected_for_context: { counter: 'selectedCount' },
  used_in_answer: { counter: 'usedCount', used: true },
  verifier_supported: { counter: 'verifiedUseCount', verified: true },
  user_confirmed: { counter: 'confirmedCount', verified: true },
  user_rejected: { counter: 'rejectedCount' },
  contradicted: { counter: 'contradictedCount' },
};

/**
 * Dedupe on (subjectKind, subjectId, event, actor) then cap. Pure and
 * exported for the unit spec.
 */
export function dedupeOutcomeEvents(events: OutcomeEventInput[]): OutcomeEventInput[] {
  const seen = new Set<string>();
  const out: OutcomeEventInput[] = [];
  for (const ev of events) {
    const key = `${ev.subjectKind}|${ev.subjectId}|${ev.event}|${ev.actor ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
    if (out.length >= OUTCOME_RECORD_CAP) break;
  }
  return out;
}

/** The 'auto' event→counter mapping. Pure and exported for the unit spec. */
export function autoStatDeltas(events: OutcomeEventInput[], now: Date): StatDelta[] {
  const deltas: StatDelta[] = [];
  for (const ev of events) {
    const spec = AUTO_STAT[ev.event];
    if (!spec) continue;
    deltas.push({
      subjectKind: ev.subjectKind,
      subjectId: ev.subjectId,
      counter: spec.counter,
      delta: 1,
      ...(spec.used ? { lastUsedAt: now } : {}),
      ...(spec.verified ? { lastVerifiedUseAt: now } : {}),
    });
  }
  return deltas;
}

/** One aggregated rollup row per subject, ready for the batched INSERT. */
interface StatRow {
  subjectId: StringRecordId;
  subjectKind: OutcomeSubjectKind;
  selectedCount: number;
  usedCount: number;
  verifiedUseCount: number;
  confirmedCount: number;
  rejectedCount: number;
  contradictedCount: number;
  lastUsedAt?: Date;
  lastVerifiedUseAt?: Date;
  updatedAt: Date;
}

/** Aggregate deltas per subject into insertable rollup rows. */
function buildStatRows(deltas: StatDelta[], now: Date): StatRow[] {
  const bySubject = new Map<string, StatRow>();
  for (const d of deltas) {
    let row = bySubject.get(d.subjectId);
    if (!row) {
      row = {
        subjectId: new StringRecordId(d.subjectId),
        subjectKind: d.subjectKind,
        selectedCount: 0,
        usedCount: 0,
        verifiedUseCount: 0,
        confirmedCount: 0,
        rejectedCount: 0,
        contradictedCount: 0,
        updatedAt: now,
      };
      bySubject.set(d.subjectId, row);
    }
    row[d.counter] += d.delta;
    if (d.lastUsedAt && (!row.lastUsedAt || d.lastUsedAt > row.lastUsedAt)) {
      row.lastUsedAt = d.lastUsedAt;
    }
    if (
      d.lastVerifiedUseAt &&
      (!row.lastVerifiedUseAt || d.lastVerifiedUseAt > row.lastVerifiedUseAt)
    ) {
      row.lastVerifiedUseAt = d.lastVerifiedUseAt;
    }
  }
  return [...bySubject.values()];
}

@Injectable()
export class MemoryOutcomeService {
  private readonly logger = new Logger(MemoryOutcomeService.name);

  constructor(private readonly surreal: SurrealService) {}

  /**
   * Master-flag check, exposed as a static so the engine dirs (S5.2 —
   * no process.env below the profile boundary) can gate cheaply via the
   * service class, the FocusSignalService.captureEnabled() idiom.
   */
  static enabled(): boolean {
    return outcomeTelemetryEnabled();
  }

  /**
   * Append raw outcome events and fold the matching rollup deltas —
   * fire-and-forget. `statDeltas` defaults to 'auto' (the per-event
   * mapping above); pass an explicit array for signed replacement
   * semantics (feedback), or when raw events and counter moves diverge.
   */
  recordOutcomes(opts: {
    companyId: string;
    events: OutcomeEventInput[];
    requestId?: string | undefined;
    statDeltas?: 'auto' | StatDelta[] | undefined;
  }): void {
    if (!outcomeTelemetryEnabled()) return;
    const now = new Date();
    const events = dedupeOutcomeEvents(opts.events);
    const deltas =
      opts.statDeltas === undefined || opts.statDeltas === 'auto'
        ? autoStatDeltas(events, now)
        : opts.statDeltas;
    const statRows = buildStatRows(deltas, now);
    if (events.length === 0 && statRows.length === 0) return;

    const rows = events.map((ev) => ({
      subjectKind: ev.subjectKind,
      subjectId: new StringRecordId(ev.subjectId),
      event: ev.event,
      createdAt: now,
      // undefined → dropped from the payload → NONE (option<...> rejects NULL).
      ...(ev.actor !== undefined ? { actor: ev.actor } : {}),
      ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
      ...(ev.meta !== undefined ? { meta: ev.meta } : {}),
    }));

    // Two batched statements, one detached round-trip on the ROOT pool
    // (usage.ts:98-99 idiom). The rollup rides the UNIQUE subjectId
    // index: first sight INSERTs the row, every later one folds the
    // per-row deltas in via $input (verified against SurrealDB 3.2.4);
    // the `?? column` coalesce keeps a timestamp the batch didn't carry.
    const statements: string[] = [];
    const params: Record<string, unknown> = {};
    if (rows.length > 0) {
      statements.push('INSERT INTO memory_outcome $rows');
      params.rows = rows;
    }
    if (statRows.length > 0) {
      statements.push(
        `INSERT INTO memory_outcome_stat $statRows
           ON DUPLICATE KEY UPDATE
             selectedCount += $input.selectedCount,
             usedCount += $input.usedCount,
             verifiedUseCount += $input.verifiedUseCount,
             confirmedCount += $input.confirmedCount,
             rejectedCount += $input.rejectedCount,
             contradictedCount += $input.contradictedCount,
             lastUsedAt = $input.lastUsedAt ?? lastUsedAt,
             lastVerifiedUseAt = $input.lastVerifiedUseAt ?? lastVerifiedUseAt,
             updatedAt = time::now()`,
      );
      params.statRows = statRows;
    }
    void this.surreal
      .withCompany(opts.companyId, async (db) => {
        await db.query(statements.join(';\n'), params);
      })
      .catch((e: Error) => {
        this.logger.warn(`outcome recording failed for ${opts.companyId}: ${e.message}`);
      });
  }
}
