/**
 * Pure read-path helpers extracted from EntitiesService.
 *
 * These functions carry no DB handle and no I/O — they are the
 * deterministic logic that used to live inline inside the
 * `withScopedCompany` closures (entity-id normalisation, the PII scope
 * gate, and the bitemporal "active fact" WHERE-clause builder). Pulling
 * them out makes the rules unit-testable without a live SurrealDB, and
 * removes the copy-paste of the bitemporal clause set between
 * `getProfile` and `freshnessWatermark`.
 */
import { PREDICATE_POLICIES } from '../ingest/conflict-resolver';
import { BrainScope } from '../auth/api-key.types';

/**
 * Split a raw entity reference into the bare record id and the full
 * `table:id` form. Accepts either `knowledge_entity:foo` or bare `foo`
 * and is idempotent — passing an already-prefixed id does not double it.
 */
export function normalizeEntityId(raw: string): { id: string; full: string } {
  const id = raw.startsWith('knowledge_entity:')
    ? raw.slice('knowledge_entity:'.length)
    : raw;
  return { id, full: `knowledge_entity:${id}` };
}

/**
 * DB-side equivalent of the row filter's predicate scope gate
 * (makeRowPolicyFilter) for the watermark probe, which never
 * materialises rows: the set of known predicates the caller may NOT
 * see, pushed into a `predicate NOT IN $blocked` clause. Derived from
 * the same seed policy table so the two gates stay in lockstep for
 * CORE predicates — a predicate is blocked here iff it is invisible
 * there. Known limitation: tenant-authored registry predicates with
 * requiresScope are not in this static list, so they influence the
 * watermark timestamps (never row content — the row surfaces apply the
 * registry-aware filter).
 */
export function blockedPredicates(scopes: BrainScope[]): string[] {
  return Object.entries(PREDICATE_POLICIES)
    .filter(([, p]) => p.requiresScope && !scopes.includes(p.requiresScope))
    .map(([predicate]) => predicate);
}

/**
 * Bitemporal "active fact" predicates for a `knowledge_fact` read.
 *
 * Without `asOf`, "active" means the full believed-and-valid-now
 * closure — the same set search's where-builder applies. The previous
 * `retractedAt IS NONE`-only shape leaked three classes of rows into
 * profile/summarize/why surfaces: naturally-superseded facts (a
 * supersede sets NO retractedAt — migration 0014 convention), expired
 * facts (validUntil in the past), and compacted skeletons. Two
 * consumers had grown local JS re-filters to patch around it; raw
 * profile consumers got the leak. The future-gap supersede rule is
 * mirrored from where-builder: a superseded fact whose interval still
 * covers now (its successor is future-dated) IS the current value.
 *
 * With `asOf`, it is the four-axis cutoff — recorded by then, not yet
 * retracted as of then, and valid across the event-time window — so the
 * composite (entityId, status, recordedAt) index does the work instead of
 * pulling rows just to drop them in JS.
 *
 * With `recordedAt` (transaction-time travel), the closure replays what
 * the graph BELIEVED at tx-time T: recorded by T, not yet retracted as
 * of T, and — since a supersede has no timestamp of its own — a fact
 * whose successor was recorded after T counts as still believed active,
 * with its validity window read from the pre-supersede snapshot
 * (`priorValidUntil`, written by fn::resolve_fact since migration 0021).
 * The validity window is evaluated at `asOf` when given, else at T
 * itself (belief at T about the world at T). Known approximation: an
 * explicit retract mutates `validUntil` in place with no snapshot, so a
 * fact retracted after T keeps the retract-written window rather than
 * the exact one believed at T.
 *
 * 'corroborating' rows (migration 0047) are audit records of a second
 * claim — the incumbent (which carries the corroboration counter) is
 * the fact to surface; all branches hide the duplicates. 'compacted'
 * skeletons are hidden in all branches, matching where-builder.
 *
 * Returns only the bitemporal clauses + their params; callers prepend the
 * `entityId = …` clause and its `$rid` param.
 */
export function activeFactWhere(
  asOf: Date | null,
  recordedAt?: Date | null,
): {
  clauses: string[];
  params: Record<string, unknown>;
} {
  if (recordedAt) {
    const evalAt = asOf ?? recordedAt;
    return {
      clauses: [
        `recordedAt <= $txAt`,
        `(retractedAt IS NONE OR retractedAt > $txAt)`,
        `validFrom <= $evalAt`,
        // Supersede-aware window: a successor recorded after T had not
        // happened yet at T — the fact was believed active with its
        // priorValidUntil window. Once the successor is recorded (<= T),
        // the supersede-written validUntil applies; this doubles as the
        // future-gap rule (a superseded fact whose window still covers
        // the evaluation moment IS the value believed then).
        `((supersededBy IS NOT NONE AND supersededBy.recordedAt > $txAt` +
          ` AND (priorValidUntil IS NONE OR priorValidUntil > $evalAt))` +
          ` OR ((supersededBy IS NONE OR supersededBy.recordedAt <= $txAt)` +
          ` AND (validUntil IS NONE OR validUntil > $evalAt)))`,
        `status != 'compacted'`,
        `status != 'corroborating'`,
      ],
      params: { txAt: recordedAt, evalAt },
    };
  }
  if (asOf) {
    return {
      clauses: [
        `recordedAt <= $asOf`,
        `(retractedAt IS NONE OR retractedAt > $asOf)`,
        `validFrom <= $asOf`,
        `(validUntil IS NONE OR validUntil > $asOf)`,
        `status != 'compacted'`,
        `status != 'corroborating'`,
      ],
      params: { asOf },
    };
  }
  return {
    clauses: [
      `retractedAt IS NONE`,
      `validFrom <= time::now()`,
      `(validUntil IS NONE OR validUntil > time::now())`,
      `status != 'compacted'`,
      `status != 'corroborating'`,
      `(status != 'superseded' OR validUntil > time::now())`,
    ],
    params: {},
  };
}
