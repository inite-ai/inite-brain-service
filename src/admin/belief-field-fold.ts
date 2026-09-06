import type { Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import type { BeliefDb, BeliefPromotionResult, FoldedBelief } from './belief-promotion.service';

/**
 * Belief field-fold machinery (#135 seam 2, SCENES_BELIEF_FIELD_FOLD):
 * the deterministic lexical rule that decides when two free-text field
 * names denote the same attribute (fieldsFold / resolveFieldFold — the
 * incoming-name router the promotion fold calls BEFORE the group key is
 * built), and the ORPHAN ABSORB sweep that retires beliefs already
 * stored under a foldable VARIANT of a canonical field. Split out of
 * belief-promotion.service.ts (the god-file ceiling); the service
 * re-exports the public helpers, so the import surface is unchanged.
 */

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Generic-modifier stoplist for the field-fold rule (#135 seam 2): the
 * ONLY extra tokens a longer field name may carry and still fold onto a
 * shorter one. Deliberately tiny and conservative — 'car ownership'
 * folds onto 'car' (ownership is generic), 'car registration' does NOT
 * (registration names a DIFFERENT attribute), and 'queue backend' does
 * NOT fold onto 'queue' (backend is specific) — a known limitation we
 * accept over the false-fold risk.
 */
export const FIELD_FOLD_GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'ownership',
  'status',
  'state',
  'current',
  'of',
  'the',
]);

/** Normalize a free-text field name: lowercase, strip punctuation, tokenize. */
function fieldTokens(field: string): Set<string> {
  return new Set(
    field
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t !== ''),
  );
}

/**
 * Pure (#135 seam 2): may these two free-text field names denote the
 * same attribute? True ONLY when one token SET is a subset of the other
 * AND every extra token of the longer name is a generic modifier from
 * FIELD_FOLD_GENERIC_TOKENS. Deterministic and lexical — NO embeddings,
 * NO LLM, no stemming ('deploy' ≠ 'deployment' — accepted limitation).
 */
export function fieldsFold(a: string, b: string): boolean {
  const ta = fieldTokens(a);
  const tb = fieldTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!large.has(t)) return false;
  for (const t of large) if (!small.has(t) && !FIELD_FOLD_GENERIC_TOKENS.has(t)) return false;
  return true;
}

/**
 * Pure (#135 seam 2): resolve an incoming field name against the known
 * fields of the same (userId, subject). An exact string match short-
 * circuits (already the canonical name); exactly ONE foldable candidate
 * folds — the EXISTING name wins (stability); MORE than one is
 * ambiguous — fold NOTHING, keep the incoming name (the caller warns
 * loudly: skip loudly, never flip-flop).
 */
export function resolveFieldFold(
  incoming: string,
  knownFields: readonly string[],
): { field: string; folded: boolean; ambiguous: boolean; candidates: string[] } {
  const distinct = [...new Set(knownFields)];
  if (distinct.includes(incoming)) {
    return { field: incoming, folded: false, ambiguous: false, candidates: [] };
  }
  const candidates = distinct.filter((existing) => fieldsFold(incoming, existing));
  if (candidates.length === 1) {
    return { field: candidates[0]!, folded: true, ambiguous: false, candidates };
  }
  if (candidates.length > 1) {
    return { field: incoming, folded: false, ambiguous: true, candidates };
  }
  return { field: incoming, folded: false, ambiguous: false, candidates: [] };
}

/** Active sibling row read by the orphan sweep (fold on only). */
interface ActiveSiblingBeliefRow {
  id: unknown;
  field: unknown;
  value: unknown;
  priorValue?: unknown;
  revision?: unknown;
  validFrom?: unknown;
}

/**
 * ORPHAN ABSORB (#135 seam 2 follow-up, SCENES_BELIEF_FIELD_FOLD —
 * called ONLY with the flag on; off = zero extra queries, byte-
 * identical). After a canonical (userId, subject, field) upsert,
 * supersede ACTIVE beliefs of the same (userId, subject) whose field
 * folds to the canonical one but is stored under a variant name —
 * leftovers of earlier batches the incoming-name fold can never retire,
 * which otherwise keep serving a stale value next to the canonical
 * belief (the s08 field-drift eval).
 *
 * MARK, NEVER DELETE: serving and the read API only read
 * status='active', the row keeps its provenance (sourceSceneIds), the
 * scenes' consolidatedInto refs stay resolvable, and the GDPR cascades
 * erase by userId regardless of status — so the supersede stamp is the
 * minimal mechanism that stops serving (a DELETE would destroy the
 * audit trail for no additional correctness). No contradicted_by /
 * derived_from edges: absorption is key deduplication, not a value
 * contradiction or derivation — supersededBy is the canonical trail.
 *
 * 3.2.4 PLANNER DISCIPLINE (the 0093/0120 idiom): the sweep is one
 * plain SELECT (reads are safe — only DELETE/UPDATE WHERE over indexed
 * fields hit the silent-no-op planner class) and every write is
 * primary-key addressed (UPDATE $id) — immune by construction.
 *
 * DETERMINISTIC + IDEMPOTENT: the canonical belief always wins with its
 * OWN value (an orphan's valid-time recency does not rescue it — naming
 * canon beats recency, deterministically); an absorbed orphan's value
 * contributes ONLY as priorValue and only when the canonical row has
 * none. A superseded orphan leaves both the serving set and the fold-
 * candidate set, so a re-run finds nothing to absorb and a re-coined
 * variant name simply folds onto the canonical field — one-way
 * convergence, never flip-flop. Fields in runGroupKeys (the CURRENT
 * run's folded + conflict groups) are live attribute names and are
 * never absorbed — parallel groups the fold deliberately kept must not
 * be eaten by upsert order. Orphans spanning MORE than one distinct
 * field are skipped loudly (the resolveFieldFold ambiguity doctrine:
 * fieldsFold is not transitive, so merging both would equate fields the
 * rule holds distinct).
 */
export async function absorbFoldableOrphans({
  db,
  belief,
  runGroupKeys,
  result,
  logger,
}: {
  db: BeliefDb;
  belief: FoldedBelief;
  runGroupKeys: ReadonlySet<string>;
  result: BeliefPromotionResult;
  logger: Logger;
}): Promise<void> {
  const [rows] = await db.query<[ActiveSiblingBeliefRow[]]>(
    `SELECT id, field, value, priorValue, revision, validFrom
       FROM semantic_belief
      WHERE userId = $u AND subject = $s AND status = 'active'`,
    { u: belief.userId, s: belief.subject },
  );
  const actives = rows ?? [];
  // The canonical head this group just upserted. Absent only in a
  // pathological replay window (INSERT IGNORE collided with an already
  // superseded id) — nothing to absorb INTO, so do nothing.
  const canonical = actives.find((r) => str(r.field) === belief.field);
  if (canonical === undefined) return;
  const revisionOf = (r: ActiveSiblingBeliefRow): number =>
    typeof r.revision === 'number' && Number.isFinite(r.revision) ? r.revision : 0;
  const orphans = actives
    .filter((r) => {
      const variant = str(r.field);
      return (
        variant !== '' &&
        variant !== belief.field &&
        // Same-run groups are LIVE attribute names — never absorbed.
        !runGroupKeys.has(`${belief.userId}\x00${belief.subject}\x00${variant}`) &&
        fieldsFold(variant, belief.field)
      );
    })
    // Chain head first (highest revision) — the priorValue donor; the
    // id tiebreak keeps the order total for equal revisions.
    .sort((a, b) => revisionOf(b) - revisionOf(a) || String(a.id).localeCompare(String(b.id)));
  if (orphans.length === 0) return;

  const orphanFields = [...new Set(orphans.map((r) => str(r.field)))].sort();
  if (orphanFields.length > 1) {
    result.fieldOrphanAmbiguous += 1;
    logger.warn(
      `belief promotion orphan-absorb ambiguity: (${belief.subject}, ${belief.field}) for ` +
        `user ${belief.userId} has ${orphanFields.length} distinct foldable variant fields ` +
        `[${orphanFields.join(' | ')}] — NOT absorbed (skip loudly, never flip-flop)`,
    );
    return;
  }

  const canonicalId = String(canonical.id);
  for (const orphan of orphans) {
    await db.query(
      `UPDATE $id SET status = 'superseded', supersededBy = $winner,
                      validUntil = $until, updatedAt = time::now()`,
      {
        id: new StringRecordId(String(orphan.id)),
        winner: new StringRecordId(canonicalId),
        until: canonical.validFrom,
      },
    );
    result.fieldOrphansAbsorbed += 1;
    logger.warn(
      `belief promotion orphan absorb: belief (${belief.subject}, '${str(orphan.field)}') ` +
        `revision ${revisionOf(orphan)} superseded into canonical field '${belief.field}' ` +
        `for user ${belief.userId} — SCENES_BELIEF_FIELD_FOLD`,
    );
  }

  // priorValue backfill — the ONLY way an orphan's value survives: when
  // the canonical row has no prior of its own, the absorbed chain
  // head's value becomes it (never when equal to the canonical value —
  // a self-prior is meaningless). The statement is NOT rewritten (the
  // 0120 doctrine: never in-place for value/statement).
  if (str(canonical.priorValue) === '') {
    const donorValue = str(orphans[0]!.value);
    if (donorValue !== '' && donorValue !== str(canonical.value)) {
      await db.query(`UPDATE $id SET priorValue = $prior, updatedAt = time::now()`, {
        id: new StringRecordId(canonicalId),
        prior: donorValue,
      });
    }
  }
}
