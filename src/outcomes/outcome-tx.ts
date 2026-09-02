import { createHash } from 'node:crypto';
import { StringRecordId, type Surreal } from 'surrealdb';
import { runTransaction } from '../db/surreal.service';
import type {
  OutcomeCounter,
  OutcomeEventInput,
  OutcomeEventName,
  OutcomeSubjectKind,
  StatDelta,
} from './memory-outcome.service';

/**
 * OUTCOME_TX_WRITES — the transactional/idempotent write branch of
 * MemoryOutcomeService, assembled here as PURE payload builders + one
 * transaction runner so the service file keeps the legacy branch
 * verbatim (byte-identity contract) and the unit spec can exercise the
 * assembly without a datastore.
 *
 * Idempotency = deterministic RECORD ids + INSERT IGNORE, NOT a unique
 * index (see the 0119 header): a replayed batch recomputes the same ids,
 * collides on the primary key, and no-ops. The stat fold is gated by an
 * IN-TX pre-select of already-present ids — never by INSERT IGNORE's
 * return shape (historically unreliable across server versions) — so a
 * replay folds ZERO deltas and the rollup never double-counts.
 *
 * Race safety: two concurrent identical batches both pass the
 * pre-select and INSERT the same record id → SurrealDB's OCC aborts one
 * at commit (`isReadConflict` wordings, enriched by runTransaction) →
 * the caller's single retry re-runs the tx, now sees $existing
 * populated, and applies 0 deltas. One-tx design = race-correct, not
 * just replay-correct.
 */

/** In-tx pre-select: which of this batch's deterministic ids already
 *  exist (a replay / the loser of a concurrent race after retry). */
export const OUTCOME_TX_PRESELECT = `LET $existing = (SELECT VALUE id FROM memory_outcome WHERE id INSIDE $rawIds)`;

/** Raw append — rows carry explicit deterministic ids; IGNORE no-ops
 *  primary-key collisions (the #92 changefeed idiom). */
export const OUTCOME_TX_RAW_INSERT = `INSERT IGNORE INTO memory_outcome $rows`;

/**
 * Delta gating: only deltas whose gating raw row is NEW this dispatch
 * fold into the rollup. A delta with no matching batch event (possible
 * only for explicit statDeltas shapes) has NO rawId and stays UNGATED —
 * today's behavior, documented residual: such deltas are not
 * replay-protected.
 */
export const OUTCOME_TX_DELTA_GATE = `LET $newDeltas = (SELECT * FROM $deltas WHERE rawId NOTINSIDE $existing OR rawId IS NONE)`;

/**
 * Per-delta stat fold. Multiple deltas per subject fold naturally
 * through ON DUPLICATE KEY UPDATE (first INSERT creates, later ones
 * fold) — semantics equal to the legacy TS-side aggregation. The
 * `LET $r = $d.row` hop keeps the INSERT source a plain variable (the
 * form verified in prod code) rather than a path expression.
 */
export const OUTCOME_TX_STAT_FOLD = `FOR $d IN $newDeltas {
  LET $r = $d.row;
  INSERT INTO memory_outcome_stat $r
    ON DUPLICATE KEY UPDATE
      selectedCount += $input.selectedCount,
      usedCount += $input.usedCount,
      verifiedUseCount += $input.verifiedUseCount,
      confirmedCount += $input.confirmedCount,
      rejectedCount += $input.rejectedCount,
      contradictedCount += $input.contradictedCount,
      lastUsedAt = $input.lastUsedAt ?? lastUsedAt,
      lastVerifiedUseAt = $input.lastVerifiedUseAt ?? lastVerifiedUseAt,
      updatedAt = time::now();
}`;

/** Observability tail: how many raw ids the batch carried and how many
 *  were already present (replay/race detection in logs, if ever read). */
export const OUTCOME_TX_RETURN = `RETURN { total: array::len($rawIds), skipped: array::len($existing) }`;

/**
 * Event → rollup mapping ('auto' statDeltas). `retrieved` is
 * DELIBERATELY absent: the raw stream is prunable volume, and readCount
 * already lives on fact_usage (0053) — a retrieved counter here would
 * duplicate it. Lives here (imported by the service's autoStatDeltas)
 * so the tx builder and the legacy path share ONE mapping.
 */
export const AUTO_STAT: Partial<
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
 * The 0113-pinned dedupe key (subjectKind|subjectId|event|actor|
 * modality|representationKind) — UNCHANGED by this PR. Shared by the
 * service's dedupeOutcomeEvents and the deterministic event-id
 * derivation below, so the id components can never drift from the
 * dedupe partitioning.
 */
export function outcomeDedupeKey(ev: OutcomeEventInput): string {
  return (
    `${ev.subjectKind}|${ev.subjectId}|${ev.event}|${ev.actor ?? ''}` +
    `|${ev.modality ?? ''}|${ev.representationKind ?? ''}`
  );
}

/**
 * Deterministic event id (D2): sha256(dedupeKey|requestScope|batchSeq),
 * first 32 hex chars. Hex tail ⇒ unquoted-safe record id (the #92
 * "numeric/table-name tokens" reasoning). requestScope is the
 * correlation scope captured synchronously by the service; batchSeq the
 * per-request monotonic counter, so two recordOutcomes calls in ONE
 * request (the search-loop refine case: identical dedupe keys) stay
 * distinct rows exactly like today. Deterministic across an upstream
 * HTTP replay that reuses x-request-id; always deterministic across the
 * service's own retry (ids computed once, payload reused).
 */
export function outcomeEventId(dedupeKey: string, requestScope: string, batchSeq: number): string {
  return createHash('sha256')
    .update(`${dedupeKey}|${requestScope}|${batchSeq}`)
    .digest('hex')
    .slice(0, 32);
}

/** One per-delta stat row: six counters (one signed non-zero), gated by
 *  the raw row that produced it (absent rawId = ungated). */
export interface OutcomeTxDeltaRow {
  rawId?: StringRecordId;
  row: {
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
  };
}

/** The bound payload of one transactional dispatch. */
export interface OutcomeTxPayload {
  rawIds: StringRecordId[];
  rows: Array<Record<string, unknown>>;
  deltas: OutcomeTxDeltaRow[];
}

/** A StatDelta expanded to the full six-counter row shape. */
function deltaRow(d: StatDelta, now: Date): OutcomeTxDeltaRow['row'] {
  const row: OutcomeTxDeltaRow['row'] = {
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
  row[d.counter] += d.delta;
  if (d.lastUsedAt) row.lastUsedAt = d.lastUsedAt;
  if (d.lastVerifiedUseAt) row.lastVerifiedUseAt = d.lastVerifiedUseAt;
  return row;
}

/**
 * Assemble the transactional payload from an already-deduped batch.
 * Pure — exported for the unit spec. Delta gating (D3):
 *   - 'auto' deltas carry the rawId of the event that PRODUCED them
 *     (1:1 with the AUTO_STAT mapping);
 *   - explicit signed deltas (feedback) gate on the raw id of the batch
 *     event with the same (subjectKind, subjectId) — both the −1 and
 *     the +1 ride the vote's raw row;
 *   - a delta with no matching event stays ungated (rawId absent).
 * Returns null when there is nothing to write.
 */
/** One raw memory_outcome row with its explicit deterministic id. */
function eventRow(
  ev: OutcomeEventInput,
  rid: StringRecordId,
  ctx: { now: Date; requestId: string | undefined },
): Record<string, unknown> {
  const { now, requestId } = ctx;
  return {
    id: rid,
    subjectKind: ev.subjectKind,
    subjectId: new StringRecordId(ev.subjectId),
    event: ev.event,
    createdAt: now,
    // undefined → dropped from the payload → NONE (option<...> rejects NULL).
    ...(ev.actor !== undefined ? { actor: ev.actor } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(ev.decisionId !== undefined ? { decisionId: ev.decisionId } : {}),
    ...(ev.modality !== undefined ? { modality: ev.modality } : {}),
    ...(ev.representationKind !== undefined ? { representationKind: ev.representationKind } : {}),
    ...(ev.meta !== undefined ? { meta: ev.meta } : {}),
  };
}

/** The 'auto' delta an event maps to, gated on its own raw id (1:1);
 *  null for events with no rollup counter (`retrieved`). */
function autoDeltaFor(
  ev: OutcomeEventInput,
  rid: StringRecordId,
  now: Date,
): OutcomeTxDeltaRow | null {
  const spec = AUTO_STAT[ev.event];
  if (!spec) return null;
  return {
    rawId: rid,
    row: deltaRow(
      {
        subjectKind: ev.subjectKind,
        subjectId: ev.subjectId,
        counter: spec.counter,
        delta: 1,
        ...(spec.used ? { lastUsedAt: now } : {}),
        ...(spec.verified ? { lastVerifiedUseAt: now } : {}),
      },
      now,
    ),
  };
}

export function buildOutcomeTxPayload(args: {
  events: OutcomeEventInput[];
  statDeltas: 'auto' | StatDelta[];
  now: Date;
  requestScope: string;
  batchSeq: number;
  requestId?: string | undefined;
}): OutcomeTxPayload | null {
  const { events, statDeltas, now, requestScope, batchSeq, requestId } = args;
  const rawIds: StringRecordId[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const deltas: OutcomeTxDeltaRow[] = [];
  const idBySubject = new Map<string, StringRecordId>();
  for (const ev of events) {
    const hex = outcomeEventId(outcomeDedupeKey(ev), requestScope, batchSeq);
    const rid = new StringRecordId(`memory_outcome:${hex}`);
    rawIds.push(rid);
    const subjectKey = `${ev.subjectKind}|${ev.subjectId}`;
    if (!idBySubject.has(subjectKey)) idBySubject.set(subjectKey, rid);
    rows.push(eventRow(ev, rid, { now, requestId }));
    if (statDeltas === 'auto') {
      const delta = autoDeltaFor(ev, rid, now);
      if (delta) deltas.push(delta);
    }
  }
  if (statDeltas !== 'auto') {
    for (const d of statDeltas) {
      const rid = idBySubject.get(`${d.subjectKind}|${d.subjectId}`);
      deltas.push({ ...(rid ? { rawId: rid } : {}), row: deltaRow(d, now) });
    }
  }
  if (rows.length === 0 && deltas.length === 0) return null;
  return { rawIds, rows, deltas };
}

/**
 * ONE BEGIN…COMMIT dispatch of the assembled payload (runTransaction —
 * the confirmed single-query() idiom; a mid-batch failure rolls the raw
 * append AND the stat fold back together, closing the 0107 divergence
 * window where one side landed without the other). The caller owns the
 * single OCC retry; the payload is reused verbatim so the retry
 * recomputes nothing.
 */
export async function runOutcomeTx(
  db: Surreal,
  payload: OutcomeTxPayload,
): Promise<{ total: number; skipped: number }> {
  return runTransaction(db, (tx) => {
    tx.bind('rawIds', payload.rawIds).bind('deltas', payload.deltas);
    tx.add(OUTCOME_TX_PRESELECT);
    if (payload.rows.length > 0) {
      tx.add(OUTCOME_TX_RAW_INSERT).bind('rows', payload.rows);
    }
    tx.add(OUTCOME_TX_DELTA_GATE);
    tx.add(OUTCOME_TX_STAT_FOLD);
    tx.add(OUTCOME_TX_RETURN);
  });
}
