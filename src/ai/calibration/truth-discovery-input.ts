/**
 * Database rows → the truth-discovery estimator's input (#847). Pure, so
 * every rule that decides what competes is unit-tested without a store.
 */
import type { TruthAnchor, TruthFact } from './truth-discovery';

/**
 * Prior strength in pseudo-votes. Chosen by `pnpm eval:truth-discovery`
 * on tune seeds and reported on eval seeds it never saw: accuracy was flat
 * from 1 to 16 and calibration best at 16.
 */
export const TRUTH_PRIOR_STRENGTH = 16;

/** Stamped on `truth.model` and `source_trust.method`: what made the number. */
export const TRUTH_MODEL = 'dawid_skene/1';
export const TRUTH_METHOD = 'dawid_skene';

export interface TruthFactRow {
  id: unknown;
  entityId: unknown;
  predicate: string;
  predicateAlias?: string | null;
  object: unknown;
  validFrom: string | Date | null;
  validUntil: string | Date | null;
  /** A corroborating row's incumbent's end: the claim it restates holds while that does. */
  corroboratedUntil?: string | Date | null;
  status: string;
  userId?: string | null;
  scope?: string[] | null;
  derivedVersion?: string | null;
  vertical: string | null;
  recorder: string | null;
  originKey: string | null;
}

export interface TruthFeedbackRow {
  factId: unknown;
  actor: string | null;
  verdict: string;
}

/**
 * The slot a fact competes in: entity, canonical predicate, and the scope
 * it was written under (user, team tags, derived world). A personal fact
 * never votes against a tenant-wide one, two users never vote on each
 * other's slots, and a pinned derived world never mixes with the legacy one.
 */
export function slotOf(row: TruthFactRow): string {
  const scope = [...(row.scope ?? [])].map(String).sort().join(',');
  return [
    String(row.entityId),
    row.predicateAlias ?? row.predicate,
    row.userId ?? '',
    scope,
    row.derivedVersion ?? '',
  ].join('\u0000');
}

/** `fn::source_key_of` (0022) in TypeScript: `vertical:recorder`. */
export function sourceKeyOf(row: { vertical: string | null; recorder: string | null }): string {
  return `${row.vertical}:${row.recorder ?? '_'}`;
}

/** A restatement differing only in case or spacing is the same claim. */
export function normaliseClaim(object: unknown): string {
  const text = typeof object === 'string' ? object : JSON.stringify(object);
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Facts that can compete: a single-valued predicate (an `append_only` slot
 * holds many values at once, so different values are not rivals), a known
 * source, a valid time. Compacted rows still say what their source claimed.
 */
export function toTruthFacts(
  rows: readonly TruthFactRow[],
  singleValued: ReadonlySet<string>,
): TruthFact[] {
  const out: TruthFact[] = [];
  for (const r of rows) {
    const predicate = r.predicateAlias ?? r.predicate;
    if (!singleValued.has(predicate) || r.vertical === null || r.validFrom === null) continue;
    const sourceKey = sourceKeyOf(r);
    const from = new Date(r.validFrom).getTime();
    if (Number.isNaN(from)) continue;
    // A corroborating row (0047) is a restatement of its incumbent and is
    // never closed itself: it holds exactly as long as the incumbent does,
    // or a later value would read as its rival.
    const end = r.status === 'corroborating' ? (r.corroboratedUntil ?? r.validUntil) : r.validUntil;
    const until = end === null || end === undefined ? null : new Date(end).getTime();
    out.push({
      factId: String(r.id),
      slot: slotOf(r),
      claim: normaliseClaim(r.object),
      sourceKey,
      domain: predicate,
      origin: r.originKey ?? sourceKey,
      validFrom: from,
      validUntil: until !== null && Number.isNaN(until) ? null : until,
      ...(r.status === 'retracted' ? { retracted: true } : {}),
    });
  }
  return out;
}

/**
 * Feedback verdicts → anchors. 'helpful' confirms the fact's value,
 * 'incorrect' rejects it; 'not_helpful' is about relevance and says
 * nothing about truth.
 *
 * Anti-farming, as the win/loss refit had it: one actor's verdict counts
 * once per (source, domain, verdict). Otherwise a single key rejecting
 * every fact of a source would clamp them all and drag its accuracy down.
 * Distinct actors each count.
 */
export function toTruthAnchors(
  rows: readonly TruthFeedbackRow[],
  facts: readonly TruthFact[],
): TruthAnchor[] {
  const factById = new Map(facts.map((f) => [f.factId, f]));
  const seen = new Set<string>();
  const out: TruthAnchor[] = [];
  for (const r of rows) {
    if (r.verdict !== 'helpful' && r.verdict !== 'incorrect') continue;
    const fact = factById.get(String(r.factId));
    if (!fact) continue;
    const key = `${r.actor ?? '_'}\u0000${fact.sourceKey}\u0000${fact.domain}\u0000${r.verdict}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ factId: fact.factId, correct: r.verdict === 'helpful' });
  }
  return out;
}
