import { createHash } from 'node:crypto';
import type { Logger } from '@nestjs/common';
import { RecordId, StringRecordId, type Surreal } from 'surrealdb';
import { isReadConflict, isUniqueViolation, runTransaction } from '../db/surreal.service';
import type { BeliefDb, BeliefPromotionResult, FoldedBelief } from './belief-promotion.service';

/**
 * The belief WRITE path — what belief-promotion.service.ts does once the
 * fold has a verdict and the active head is known (god-file split, the
 * 800-line ceiling): the deterministic revision ids, the corroboration
 * update (counters, watermark, chain-derived corrections) and the
 * compare-and-set revision transaction. The decision of WHICH path a
 * verdict takes (create / corroborate / stale / revise) stays with
 * `upsertBelief` in the service; this module is the two writes it ends
 * in. Pure of flags and of the fold.
 */

/**
 * A stored datetime as epoch ms, or NaN when absent / unparseable. The WS
 * driver hands datetimes over as Date instances; fixtures may hand ISO
 * strings — both accepted, never String(Date) (the query_arc lesson).
 */
export function epochMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (v === undefined || v === null || v === '') return Number.NaN;
  return new Date(String(v)).getTime();
}

/**
 * Pure: deterministic record-id tail over (userId|subject|field|
 * revision) — the composer's sceneIdTail idiom. Paired with INSERT
 * IGNORE it makes every create replay-idempotent, and it enforces
 * (userId, subject, field, revision) uniqueness in CODE — a compound
 * UNIQUE index is exactly the 3.2.4 planner trap 0120 avoids.
 */
export function beliefIdTail(
  key: { userId: string; subject: string; field: string },
  revision: number,
): string {
  return createHash('sha256')
    .update(`${key.userId}\x00${key.subject}\x00${key.field}\x00${revision}`)
    .digest('hex')
    .slice(0, 24);
}

/** Full record-id string for a folded belief at a given revision. */
export function beliefRecordString(
  belief: Pick<FoldedBelief, 'userId' | 'subject' | 'field'>,
  revision: number,
): string {
  return `semantic_belief:${beliefIdTail(belief, revision)}`;
}

/** Active-belief head read back for the upsert decision. */
export interface ActiveBeliefRow {
  id: unknown;
  revision: number;
  value: string;
  priorValue?: unknown;
  validFrom: unknown;
  /** 0137 evidence watermark; NONE on a legacy row (falls back to validFrom). */
  latestEvidenceAt?: unknown;
  sourceSceneIds?: unknown;
  conversationIds?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * CORROBORATION — the only in-place update the substrate allows:
 * provenance union + counters, the watermark (advanced, never rewound),
 * and — from the full evidence chain — the two corrections that do not
 * change what the belief says: when the same value BEGAN, and what it
 * displaced. Never value / statement.
 *
 * validFrom moves FORWARD only on the strength of an interlude the head
 * never saw: another value held AFTER the recorded beginning, so the
 * state was interrupted and began again at the chain's run (a chain that
 * merely starts later says nothing about the beginning — kept). It moves
 * BACKWARD only while the row is revision 1: with a predecessor, that
 * predecessor's validUntil bounds this row — kept, at debug.
 */
export async function corroborateBelief({
  db,
  head,
  headId,
  headValidFrom,
  headWatermark,
  belief,
  result,
  logger,
}: {
  db: BeliefDb;
  head: ActiveBeliefRow;
  headId: string;
  headValidFrom: number;
  headWatermark: number;
  belief: FoldedBelief;
  result: BeliefPromotionResult;
  logger: Logger;
}): Promise<void> {
  const knownScenes = (Array.isArray(head.sourceSceneIds) ? head.sourceSceneIds : []).map(String);
  const knownConvs = (Array.isArray(head.conversationIds) ? head.conversationIds : []).map(String);
  const mergedScenes = [...new Set([...knownScenes, ...belief.sceneIds])];
  const mergedConvs = [...new Set([...knownConvs, ...belief.conversationIds])];
  const newScenes = belief.sceneIds.filter((s) => !knownScenes.includes(s));
  const set: string[] = [];
  const params: Record<string, unknown> = { id: new StringRecordId(headId) };
  if (newScenes.length > 0) {
    set.push(
      'sourceSceneIds = $scenes',
      'conversationIds = $convs',
      'corroborationCount = $n',
      'conversationCount = $m',
    );
    params.scenes = mergedScenes.map((s) => new StringRecordId(s));
    params.convs = mergedConvs;
    params.n = mergedScenes.length;
    params.m = mergedConvs.length;
  }
  // The watermark advances to the latest evidence seen; a legacy row
  // without one is stamped at max(validFrom, this evidence).
  const nextWatermark = Math.max(
    Number.isFinite(headWatermark) ? headWatermark : 0,
    belief.evidenceAt.getTime(),
  );
  if (!Number.isFinite(epochMs(head.latestEvidenceAt)) || nextWatermark > headWatermark) {
    set.push('latestEvidenceAt = $evidenceAt');
    params.evidenceAt = new Date(nextWatermark);
  }
  let realigned = false;
  const chainBegan = belief.validFrom.getTime();
  if (Number.isFinite(headValidFrom) && chainBegan !== headValidFrom) {
    const interludeAfterHead =
      belief.displacedAt !== undefined && belief.displacedAt.getTime() > headValidFrom;
    const earlierAndUnbounded = chainBegan < headValidFrom && head.revision === 1;
    if ((chainBegan > headValidFrom && interludeAfterHead) || earlierAndUnbounded) {
      set.push('validFrom = $validFrom');
      params.validFrom = belief.validFrom;
      realigned = true;
    } else {
      logger.debug(
        `belief promotion: (${belief.subject}, ${belief.field}) chain begins ` +
          `${belief.validFrom.toISOString()} against revision ${head.revision}'s ` +
          `${new Date(headValidFrom).toISOString()} — no interlude after it / ` +
          `predecessor bounds it, kept`,
      );
    }
  }
  // What the state displaced, from the chain ALONE (an interlude the
  // head never recorded) — never a delta's self-reported `from`, and
  // never over a priorValue the row already has.
  const headPrior = str(head.priorValue);
  if (belief.displacedValue !== '' && belief.displacedValue !== belief.value && headPrior === '') {
    set.push('priorValue = $prior');
    params.prior = belief.displacedValue;
    realigned = true;
  }
  if (set.length === 0) return;
  await db.query(`UPDATE $id SET ${set.join(', ')}, updatedAt = time::now()`, params);
  if (newScenes.length > 0) result.beliefsCorroborated += 1;
  if (realigned) result.beliefsRealigned += 1;
}

/** The revision transaction's own aborts, verbatim. */
const REVISION_ABORTS = [
  'belief revision slot already holds another value',
  'belief head moved',
] as const;

/**
 * Contract: exactly these failures mean "another writer won this
 * revision" — a datastore read conflict, a unique violation, or one of
 * the transaction's own aborts. Everything else is a fault in the write
 * path and must reach the caller as an error.
 */
function isRevisionLost(e: unknown): boolean {
  if (isReadConflict(e) || isUniqueViolation(e)) return true;
  if (!(e instanceof Error)) return false;
  return REVISION_ABORTS.some((abort) => e.message.includes(abort));
}

/**
 * The ONE write that changes what a belief says, as a compare-and-set
 * transaction (BEGIN … COMMIT, runTransaction):
 *   1. the revision SLOT is read — deterministic id over (key,
 *      revision) — and a row already there with ANOTHER value aborts
 *      (a concurrent run took this number first; INSERT IGNORE alone
 *      would have let this run believe it wrote its value);
 *   2. INSERT IGNORE the revision (a replay of the SAME value no-ops);
 *   3. on a revise, the displaced head is stamped superseded ONLY IF it
 *      is still the active head at the revision AND the watermark this
 *      run read (`WHERE status = 'active' AND revision = $headRevision
 *      AND (latestEvidenceAt IS NONE OR latestEvidenceAt = $wm)`); zero
 *      rows stamped means the head moved under us — abort, which also
 *      rolls the INSERT back (verified on 3.2.4: THROW inside the
 *      transaction cancels every prior statement). The watermark belongs
 *      in the predicate because a corroboration changes neither status
 *      nor revision: without it a revise decided against a January
 *      watermark still committed over a head another run had already
 *      confirmed into March.
 * The statement text is composed by the caller BEFORE this call (the
 * optional LLM call must not sit inside a database transaction).
 *
 * Returns false when the revision was LOST to a concurrent writer —
 * nothing written, the caller re-reads and decides again. Every other
 * failure (a schema rejection, a dead connection) is a broken write path
 * and is rethrown: a write that cannot work must not read as harmless
 * contention forever.
 */
export async function commitRevision({
  db,
  belief,
  revision,
  promoterVersion,
  statement,
  displaced,
  logger,
}: {
  db: BeliefDb;
  belief: FoldedBelief;
  revision: number;
  promoterVersion: string;
  statement: { text: string; source: 'template' | 'llm' };
  displaced?:
    | {
        id: string;
        revision: number;
        until: Date;
        /** The head's stored `latestEvidenceAt` as the caller read it;
         *  omitted for a legacy row that carried none. */
        watermark?: Date | undefined;
      }
    | undefined;
  logger: Logger;
}): Promise<boolean> {
  const newId = new RecordId('semantic_belief', beliefIdTail(belief, revision));
  const row = {
    id: newId,
    userId: belief.userId,
    subject: belief.subject,
    field: belief.field,
    value: belief.value,
    ...(belief.priorValue !== '' ? { priorValue: belief.priorValue } : {}),
    statement: statement.text,
    statementSource: statement.source,
    confidence: belief.confidence,
    revision,
    status: 'active',
    validFrom: belief.validFrom,
    latestEvidenceAt: belief.evidenceAt,
    sourceSceneIds: belief.sceneIds.map((s) => new StringRecordId(s)),
    conversationIds: belief.conversationIds,
    corroborationCount: belief.sceneIds.length,
    conversationCount: belief.conversationIds.length,
    promoterVersion,
  };
  try {
    await runTransaction(db as unknown as Surreal, (tx) => {
      tx.bind('newId', newId).bind('value', belief.value).bind('rows', [row]);
      tx.add(`LET $held = (SELECT id, value AS held FROM $newId)`);
      tx.add(
        `IF array::len($held) > 0 AND $held[0].held != $value ` +
          `{ THROW 'belief revision slot already holds another value' }`,
      );
      tx.add(`INSERT IGNORE INTO semantic_belief $rows`);
      if (displaced) {
        tx.bind('headId', new StringRecordId(displaced.id))
          .bind('headRevision', displaced.revision)
          .bind('until', displaced.until)
          .bind('wm', displaced.watermark ?? null);
        tx.add(
          `LET $stamped = (UPDATE $headId SET status = 'superseded', supersededBy = $newId, ` +
            `validUntil = $until, updatedAt = time::now() ` +
            `WHERE status = 'active' AND revision = $headRevision ` +
            `AND (latestEvidenceAt IS NONE OR latestEvidenceAt = $wm) RETURN AFTER)`,
        );
        tx.add(`IF array::len($stamped) = 0 { THROW 'belief head moved' }`);
      }
      tx.add(`RETURN true`);
    });
    return true;
  } catch (e) {
    if (!isRevisionLost(e)) throw e;
    logger.warn(
      `belief promotion contended: (${belief.subject}, ${belief.field}) revision ${revision} ` +
        `for user ${belief.userId} lost to a concurrent writer — nothing written, the next ` +
        `run recomputes the key (${(e as Error).message?.slice(0, 160)})`,
    );
    return false;
  }
}
