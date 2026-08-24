import type { SearchHit } from '../search/search.types';
import type { DateAnchoring } from '../search/retrieval-profile';
import { traceArtifact } from '../common/debug-trace';

/**
 * Date-anchoring resolver: the ISO date the generator should treat as
 * "today", or undefined when the profile disables anchoring. 'absolute'
 * is the engine default — the trace-verified LME temporal failure was
 * relative-date questions with NO anchor at all, and rendering absolute
 * dates is most of the field's TR win (SmartSearch 82.7 TR from plain
 * timestamps + reranking). Genre note: LoCoMo golds follow the
 * session-date convention where real date arithmetic measurably hurt
 * (E-series leg) — that tenant profile sets dateAnchoring 'none'.
 */
export function resolveDateContext(
  anchoring: DateAnchoring,
  asOf: string | undefined,
): string | undefined {
  if (anchoring === 'none') return undefined;
  if (anchoring === 'session_date') return asOf?.slice(0, 10);
  return (asOf ?? new Date().toISOString()).slice(0, 10);
}

/**
 * Evidence union for synthesis (Phase A of the typed-memory roadmap,
 * docs/roadmap/locomo-sota-architecture-2026-07.md).
 *
 * The multi-hop chain retrieves hits per hop, then synthesis re-searches
 * anchored to the ≤limit FINAL entities — evidence from entities the
 * chain filtered out never reached the generator, even though the hops
 * paid to retrieve it. This merges those pre-retrieved facts into the
 * re-search results: base hits stay first (question-relevance order, the
 * primary context), unseen extra facts append best-score-first under a
 * hard cap so the prompt stays bounded.
 */
/**
 * Cap-applying wrapper: reports the merge size. The cap is the
 * profile's extraEvidenceCap, passed by the caller.
 */
export function applyEvidenceUnion(
  base: SearchHit[],
  extraHits: SearchHit[] | undefined,
  cap: number,
): SearchHit[] {
  if (!extraHits || extraHits.length === 0) return base;
  const results = mergeExtraHits(base, extraHits, cap);
  const count = (hits: SearchHit[]): number => hits.reduce((a, h) => a + h.facts.length, 0);
  traceArtifact('synthesize.evidence_union', {
    baseHits: base.length,
    mergedHits: results.length,
    extraFacts: count(results) - count(base),
  });
  return results;
}

export function mergeExtraHits(base: SearchHit[], extra: SearchHit[], cap: number): SearchHit[] {
  const seen = new Set<string>();
  for (const h of base) for (const f of h.facts) seen.add(f.factId);

  const pool: Array<{ hit: SearchHit; fact: SearchHit['facts'][number] }> = [];
  for (const hit of extra) {
    for (const fact of hit.facts) {
      if (seen.has(fact.factId)) continue;
      seen.add(fact.factId);
      pool.push({ hit, fact });
    }
  }
  if (pool.length === 0 || cap <= 0) return base;
  pool.sort((a, b) => (b.fact.score ?? 0) - (a.fact.score ?? 0));
  const chosen = pool.slice(0, cap);

  // Clone before appending — base hits are also returned to the caller
  // as SynthesizeResult.results and must not be mutated in place.
  const out = base.map((h) => ({ ...h, facts: [...h.facts] }));
  const byEntity = new Map(out.map((h) => [h.entityId, h]));
  for (const { hit, fact } of chosen) {
    let target = byEntity.get(hit.entityId);
    if (!target) {
      target = { ...hit, facts: [] };
      byEntity.set(hit.entityId, target);
      out.push(target);
    }
    target.facts.push(fact);
  }
  return out;
}
