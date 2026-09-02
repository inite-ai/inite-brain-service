import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { isReadConflict } from '../db/surreal-retry';
import { outcomeTelemetryEnabled, outcomeTxWritesEnabled } from '../common/outcome-flags';
import {
  getCorrelationId,
  getRequestContext,
  type RequestContext,
} from '../common/request-context';
import { AUTO_STAT, buildOutcomeTxPayload, outcomeDedupeKey, runOutcomeTx } from './outcome-tx';

export { outcomeDedupeKey, outcomeEventId } from './outcome-tx';

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

/**
 * 'evidence' binds to evidence_asset ids ONLY (0109): a fragment-level
 * outcome ROLLS UP to its parent asset — the ranking currency is
 * per-observation, and a per-fragment rollup would split the signal.
 * outcomeSubjectFor() in src/common/evidence-ref.ts owns the mapping.
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

/**
 * 0113 dimension: which evidence modality the outcome concerns. Mirrors
 * the `EvidenceCapability` union (synthesize.types.ts) value-for-value —
 * duplicated here as its own name so this substrate layer never imports
 * from the engine dirs it serves. Absent = legacy/text (the migration's
 * NONE contract).
 */
export type OutcomeModality = 'text' | 'visual' | 'audio' | 'document_region';

export interface OutcomeEventInput {
  subjectKind: OutcomeSubjectKind;
  /** Full record id string, e.g. 'knowledge_fact:abc'. */
  subjectId: string;
  event: OutcomeEventName;
  actor?: string | undefined;
  /**
   * 0113: evidence modality of the outcome. A TOP-LEVEL column, not a
   * meta key — meta is content-free ids-only AND the dedupe key ignores
   * meta, so a meta-buried dimension would be invisible to partitioning
   * (see the 0113 migration header). Absent = legacy/text. No writer in
   * the text pipeline stamps it yet — the media paths (sibling PRs) do.
   */
  modality?: OutcomeModality | undefined;
  /**
   * 0113: free-form representation tag within the modality (e.g.
   * 'caption', 'ocr_text', 'frame_embedding'). Same top-level-column
   * rationale as `modality`; absent = legacy.
   */
  representationKind?: string | undefined;
  /** CONTENT-FREE: ids / verdict strings only — never fact text. */
  meta?: Record<string, unknown> | undefined;
  /**
   * 0119: join key to the memory_decision row this outcome descends from
   * (the request's primary decision — abstain gate or L3 trigger). A
   * plain string column (== the decision record-id tail), stamped by the
   * synthesize emit seam ONLY under OUTCOME_DECISION_CAPTURE; absent =
   * legacy / capture-off. NOT part of the dedupe key (0113-pinned):
   * callers stamp one decision per request path, so two same-key events
   * with different decisionIds do not occur.
   */
  decisionId?: string | undefined;
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
 * Dedupe on (subjectKind, subjectId, event, actor, modality,
 * representationKind) then cap. Pure and exported for the unit spec.
 * The key string lives in outcome-tx.ts (outcomeDedupeKey) because the
 * OUTCOME_TX_WRITES deterministic event id derives from the SAME key —
 * one definition, no drift.
 *
 * 0113: the two dimension components extend the key so the SAME event on
 * DIFFERENT modalities stays two rows. Every existing (text-path) writer
 * passes neither field, so its key gains a constant `||` suffix —
 * partitioning identical to pre-0113, pinned by the unit spec.
 */
export function dedupeOutcomeEvents(events: OutcomeEventInput[]): OutcomeEventInput[] {
  const seen = new Set<string>();
  const out: OutcomeEventInput[] = [];
  for (const ev of events) {
    const key = outcomeDedupeKey(ev);
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

/**
 * OUTCOME_TX_WRITES batch counter, per request context (D2 batchSeq):
 * two recordOutcomes calls in ONE request (the search-loop refine case —
 * identical dedupe keys) get distinct seqs and stay distinct rows
 * exactly like today. WeakMap keyed on the ALS context object so the
 * counter dies with the request; no context (cron/jobs) → seq 0, where
 * the randomUUID request-scope fallback already makes the call unique.
 */
const txBatchSeq = new WeakMap<RequestContext, number>();

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
    // OUTCOME_TX_WRITES: the atomic/idempotent branch (outcome-tx.ts).
    // A SEPARATE branch by design — the flag-off path below stays the
    // VERBATIM legacy two-statement shape (byte-identity pinned by the
    // unit spec against literal SQL constants).
    if (outcomeTxWritesEnabled()) {
      this.recordOutcomesTx(opts, events, now);
      return;
    }
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
      // 0119: decision join key — stamped only when a caller threads it
      // (OUTCOME_DECISION_CAPTURE emit seams); existing writers pass
      // nothing → row byte-identical.
      ...(ev.decisionId !== undefined ? { decisionId: ev.decisionId } : {}),
      // 0113 dimensions ride the raw row only. The rollup (statRows below)
      // stays UNIQUE-per-subject with NO per-modality columns — deliberate:
      // no scorer consumes a per-modality stat yet, and the raw rows retain
      // full dimensionality, so a modality rollup can be added later
      // without loss. Existing writers pass neither → row byte-identical.
      ...(ev.modality !== undefined ? { modality: ev.modality } : {}),
      ...(ev.representationKind !== undefined ? { representationKind: ev.representationKind } : {}),
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

  /**
   * OUTCOME_TX_WRITES branch: deterministic ids + one BEGIN/COMMIT
   * (outcome-tx.ts) with a SINGLE immediate retry on the OCC-abort
   * class only. Request scope + batch seq are captured SYNCHRONOUSLY
   * before detaching (ALS is dead inside the detached promise); the
   * payload — ids included — is computed once and reused verbatim by
   * the retry, so the retry can never mint different ids. The
   * fire-and-forget contract is unchanged: after the one retry (or on
   * any non-retriable error) we warn and drop, never throw into the
   * serving path. Callers untouched.
   */
  private recordOutcomesTx(
    opts: {
      companyId: string;
      events: OutcomeEventInput[];
      requestId?: string | undefined;
      statDeltas?: 'auto' | StatDelta[] | undefined;
    },
    events: OutcomeEventInput[],
    now: Date,
  ): void {
    const ctx = getRequestContext();
    let batchSeq = 0;
    if (ctx) {
      batchSeq = txBatchSeq.get(ctx) ?? 0;
      txBatchSeq.set(ctx, batchSeq + 1);
    }
    // The requestId COLUMN carries only a real correlation id; the id
    // SCOPE additionally falls back to a random UUID so an uncorrelated
    // call (cron/jobs) is unique rather than colliding on seq 0.
    const correlated = opts.requestId ?? getCorrelationId();
    const payload = buildOutcomeTxPayload({
      events,
      statDeltas: opts.statDeltas ?? 'auto',
      now,
      requestScope: correlated ?? randomUUID(),
      batchSeq,
      requestId: correlated,
    });
    if (!payload) return;
    void this.surreal
      .withCompany(opts.companyId, async (db) => {
        try {
          await runOutcomeTx(db, payload);
        } catch (e) {
          // One immediate retry, ONLY for the enriched OCC-abort class
          // (runTransaction already enriches the bare "failed
          // transaction" wrapper). No backoff machinery: the racing
          // committer's row is visible immediately, and the re-run's
          // pre-select then gates every already-applied delta.
          if (!isReadConflict(e)) throw e;
          await runOutcomeTx(db, payload);
        }
      })
      .catch((e: Error) => {
        this.logger.warn(`outcome recording failed for ${opts.companyId}: ${e.message}`);
      });
  }
}
