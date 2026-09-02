import type { EvidenceCitation } from './synthesize.types';

/**
 * Belief citations (BELIEFS_SERVING_LANE) — the pure resolver that turns
 * the generator's raw `citedBeliefIds` output into verified belief-arm
 * EvidenceCitations. No IO, no DI, no env: the caller supplies the
 * beliefsById map and emits metrics from the returned counts. The
 * fragment-citations.ts sibling, one lane over. Citations ride the
 * MASTER flag (no separate switch): the citation is what makes a
 * belief-grounded answer pass FOVEA_REQUIRE_CITATIONS, and it is the
 * unrollable provenance handle (sourceSceneIds → scenes → episodes).
 *
 * THE ANTI-HALLUCINATION + SECURITY FENCE: `beliefsById` contains ONLY
 * the beliefs actually rendered into the prompt's current-state section
 * — rows that already passed the lane's fence stack on their way in
 * (BeliefLaneService: tenant → scoped-user → status='active' →
 * beliefVisible re-check). Any beliefId the generator emits that is NOT
 * in that map is dropped (and counted), so a belief citation can never
 * name a belief the caller couldn't read, whether the id was
 * hallucinated or probed.
 *
 * RENDERED-EXCERPT-ONLY: the citation's `excerpt` is copied from the
 * rendered set — the exact (≤600-char) statement excerpt the generator
 * saw — never generator-authored text, so a wrong or invented quote can
 * never ship as a citation.
 */

/** One rendered current-state line's belief, as the resolver may cite it. */
export interface CitableBelief {
  /** semantic_belief record id, exactly as rendered in the line header. */
  beliefId: string;
  /** Free-text subject key (0120 — deliberately not entity-resolved). */
  subject: string;
  /** Free-text field key. */
  field: string;
  /** The held current value. */
  value: string;
  /** The RENDERED statement excerpt — the only citable text. */
  excerpt: string;
  /** ISO validFrom of the active revision, when known. */
  occurredAt?: string | undefined;
}

/** Per-citation resolution outcomes (the metric label values). */
export interface BeliefCitationCounts {
  /** beliefId was rendered → a belief-arm citation shipped. */
  cited: number;
  /** beliefId not in the rendered set (or malformed entry) →
   *  dropped, never surfaced. */
  dropped_unknown: number;
}

/** Ceiling on resolved belief citations per answer (the l3-citations
 *  EVIDENCE_CITATION_CAP idiom — bounded output). */
const BELIEF_CITATION_CAP = 16;

/**
 * Resolve the generator's raw citedBeliefIds against the rendered-set
 * map. Deduped by beliefId; capped at 16. Input is `unknown[]` by
 * design — the LLM output is parsed defensively here, not trusted at the
 * call site (a `{beliefId}` object entry is tolerated alongside the
 * schema's plain string).
 */
export function resolveBeliefCitations(
  citedBeliefIds: ReadonlyArray<unknown>,
  beliefsById: ReadonlyMap<string, CitableBelief>,
): { citations: EvidenceCitation[]; counts: BeliefCitationCounts } {
  const counts: BeliefCitationCounts = { cited: 0, dropped_unknown: 0 };
  const citations: EvidenceCitation[] = [];
  const seen = new Set<string>();
  for (const raw of citedBeliefIds) {
    if (citations.length >= BELIEF_CITATION_CAP) break;
    const beliefId = parseEntry(raw);
    if (!beliefId) {
      counts.dropped_unknown += 1;
      continue;
    }
    const belief = beliefsById.get(beliefId);
    if (!belief) {
      counts.dropped_unknown += 1;
      continue;
    }
    if (seen.has(beliefId)) continue;
    seen.add(beliefId);
    // ONE-OF invariant (EvidenceCitation): the belief arm only — never
    // an episodeId or a fragmentId on the same citation. No `capability`
    // stamp either (the episode-arm precedent): a belief line is
    // distilled TEXT, so it neither satisfies nor triggers the 0113
    // non-text capability gate (resolveEvidenceCapability sees only the
    // text baseline).
    citations.push({
      beliefId: belief.beliefId,
      excerpt: belief.excerpt,
      ...(belief.occurredAt !== undefined ? { occurredAt: belief.occurredAt } : {}),
    });
    counts.cited += 1;
  }
  return { citations, counts };
}

/** Metrics port for the counting wrapper (keeps this module pure). */
export interface BeliefCitationMetrics {
  countBeliefCitation(outcome: 'cited' | 'dropped_unknown', n?: number): void;
}

/**
 * Service-facing wrapper (the resolveAndCountFragmentCitations sibling):
 * resolve + emit the per-outcome telemetry. An absent fence map means
 * the flag was off for the request OR nothing was rendered (the map is
 * only populated by the lane's rendered set) — [] either way, the
 * byte-identical default path.
 */
export function resolveAndCountBeliefCitations(opts: {
  citedBeliefIds: ReadonlyArray<unknown> | undefined;
  beliefsById: ReadonlyMap<string, CitableBelief> | undefined;
  metrics?: BeliefCitationMetrics | undefined;
}): EvidenceCitation[] {
  if (!opts.beliefsById) return [];
  const { citations, counts } = resolveBeliefCitations(opts.citedBeliefIds ?? [], opts.beliefsById);
  for (const outcome of ['cited', 'dropped_unknown'] as const) {
    if (counts[outcome] > 0) opts.metrics?.countBeliefCitation(outcome, counts[outcome]);
  }
  return citations;
}

/** Defensive shape check on one generator-emitted entry; a malformed row
 *  (no non-empty string id) resolves to null and counts as dropped. */
function parseEntry(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'object' && raw !== null) {
    const id = (raw as { beliefId?: unknown }).beliefId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}
