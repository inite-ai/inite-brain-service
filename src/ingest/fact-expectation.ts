import type { Logger } from '@nestjs/common';
import { StringRecordId, type Surreal } from 'surrealdb';
import { traceArtifact } from '../common/debug-trace';
import type { ResolveOutcome } from './conflict-resolver';
import { idTailOf } from './ingest-utils';
import { MAX_EXPECTATION_DAYS } from './event-time';

/**
 * The knowledge_fact a resolve landed on, for the expectation stamp
 * (0166): the new row for an insert, a supersede or a competing claim;
 * the corroborated row for a restatement (its own `factId` is the
 * 'corroborating' audit record, which no read serves). Null when nothing
 * landed — a rejected or skipped claim.
 */
export function expectationTarget(result: ResolveOutcome | null | undefined): string | null {
  if (!result) return null;
  const id =
    result.outcome === 'CORROBORATED'
      ? result.corroboratedFactId
      : result.outcome === 'INSERTED' ||
          result.outcome === 'INSERTED_HISTORICAL' ||
          result.outcome === 'SUPERSEDED' ||
          result.outcome === 'COMPETING'
        ? result.factId
        : null;
  if (id === undefined || id === null || id === '') return null;
  return `knowledge_fact:${idTailOf(String(id))}`;
}

/** An open row stating the same value as the one just written. */
export interface SameValueRow {
  validFrom?: unknown;
  expectedUntil?: unknown;
}

/**
 * The expectation every open row stating a value should carry once that
 * value was stated at `statedAt` — the rows being the ones that say the
 * same thing about the same subject (the new row among them). A
 * statement that brings its own expectation sets it. One that brings none
 * gives the state the span it was given the last time — its latest
 * expectation minus that row's start — counted again from the statement,
 * so "still sick" on day 10 is not "expected over by day 7". Undefined —
 * leave the rows as they are — when nobody gave the state an expectation,
 * or when the move would not push it later. A statement older than a row
 * already on file (a re-read of an old document) moves nothing: the rows
 * keep the latest expectation they have, and its own row takes that one.
 */
export function restatedExpectation(
  rows: SameValueRow[],
  statedAt: Date,
  own: Date | undefined,
): Date | undefined {
  const at = statedAt.getTime();
  if (Number.isNaN(at)) return undefined;
  let latest: { from: number; until: number } | undefined;
  for (const r of rows) {
    const from = toMs(r.validFrom);
    const until = toMs(r.expectedUntil);
    if (from === undefined || until === undefined) continue;
    if (!latest || until > latest.until) latest = { from, until };
  }
  // Older news: the rows keep the latest expectation on file, and the
  // row this statement just wrote joins it.
  if (rows.some((r) => (toMs(r.validFrom) ?? -Infinity) > at)) {
    return latest ? new Date(latest.until) : undefined;
  }
  if (own) return own;
  if (!latest) return undefined;
  const span = latest.until - latest.from;
  if (span <= 0 || span > MAX_EXPECTATION_DAYS * 86_400_000) return undefined;
  const next = at + span;
  return next > latest.until ? new Date(next) : undefined;
}

/**
 * The expectation of a temporary state (0166), onto the row a resolve
 * landed on and every other open row stating the same value of the same
 * slot for the same subject and user. Those rows are one state said
 * several times: a restatement lands as a corroboration on a single-value
 * slot and as a second row on an append-only one, and either way the
 * state was just confirmed — no row of it may keep reading "expected over
 * by D; not confirmed since". What they get is restatedExpectation's: the
 * statement's own, else the span the state was given before, counted from
 * the statement — the fallback runs only for a corroboration, so a fact
 * without an expectation costs no round trip at all. A row already closed
 * in valid time keeps none; its end is known.
 *
 * Best-effort like the other post-resolve stamps (grounding-stamp.ts): a
 * failed stamp leaves the rows as they were, which reads exactly as
 * before 0166.
 */
export async function stampExpectation(args: {
  db: Pick<Surreal, 'query'>;
  p: { expectedUntil?: Date | undefined; validFrom: Date };
  result: ResolveOutcome | null | undefined;
  logger: Pick<Logger, 'warn'>;
}): Promise<void> {
  const { db, p, result, logger } = args;
  const target = expectationTarget(result);
  if (!target) return;
  // Zero round trips for the bulk: a statement without an expectation of
  // its own can only move one by restating a corroborated value. An
  // append-only restatement lands as a new row and is covered by the
  // extractor — it reads the state's "(expected until …)" on KNOWN FACTS
  // and states it again with a new expectedEnd (prompts.ts MEMORY).
  if (!p.expectedUntil && result?.outcome !== 'CORROBORATED') return;
  try {
    const [, rows] = await db.query<[unknown, Array<{ id: unknown } & SameValueRow>]>(
      `LET $t = (SELECT entityId, predicate, predicateAlias, object, userId FROM ONLY $id);
       SELECT id, validFrom, expectedUntil FROM knowledge_fact
        WHERE entityId = $t.entityId AND object = $t.object
          AND (predicateAlias ?? predicate) = ($t.predicateAlias ?? $t.predicate)
          AND userId = $t.userId
          AND status IN ['active', 'competing'] AND retractedAt IS NONE
          AND validUntil IS NONE;`,
      { id: new StringRecordId(target) },
    );
    const same = rows ?? [];
    if (same.length === 0) return;
    const at = restatedExpectation(same, p.validFrom, p.expectedUntil);
    if (!at) return;
    await db.query(`UPDATE knowledge_fact SET expectedUntil = $at WHERE id IN $ids`, {
      at,
      ids: same.map((r) => new StringRecordId(String(r.id))),
    });
    traceArtifact('ingest.fact.expectation', {
      factId: target,
      expectedUntil: at.toISOString().slice(0, 10),
      rows: same.length,
      own: p.expectedUntil !== undefined,
    });
  } catch (e) {
    logger.warn(`expectation stamp failed (non-fatal): ${(e as Error).message}`);
  }
}

/** The marker every expectation suffix opens with — the generator prompt
 *  adds its rule only when a line carries one (synthesize/generator-prompt.ts). */
export const EXPECTATION_MARK = '(temporary — expected ';

/**
 * A temporary state's expectation (0166) as a suffix, judged against
 * `at` (asOf, else now): still ahead → "expected until D"; passed →
 * "expected over by D; not confirmed since". A restatement moves the
 * expectation (fact-resolver stampExpectation), so a passed one really
 * means nothing has said the state still holds. Empty when the fact
 * carries none.
 */
export function formatExpectation(expectedUntil?: unknown, at?: string): string {
  const t = toMs(expectedUntil);
  if (t === undefined || t === 0) return '';
  const day = new Date(t).toISOString().slice(0, 10);
  const ref = at ? Date.parse(at) : Date.now();
  const lapsed = t <= (Number.isNaN(ref) ? Date.now() : ref);
  return lapsed
    ? ` ${EXPECTATION_MARK}over by ${day}; not confirmed since)`
    : ` ${EXPECTATION_MARK}until ${day})`;
}

function toMs(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(t) ? undefined : t;
}
