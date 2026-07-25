import type { SearchHit } from '../search/search.types';
import { traceArtifact } from '../common/debug-trace';
import { envFlagEnabled } from '../common/env-validation';

/**
 * SYNTHESIZE_DATE_CONTEXT resolver: the ISO date the generator should
 * treat as "today" (dto.asOf, else now), or undefined when the flag is
 * off. Lives here to keep the synthesize() complexity budget flat.
 */
export function resolveDateContext(asOf: string | undefined): string | undefined {
  if (!envFlagEnabled(process.env.SYNTHESIZE_DATE_CONTEXT)) return undefined;
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
 * Flag-side wrapper: resolves the cap knob and reports the merge size.
 * Returns null when there is nothing to merge so the caller's hot path
 * stays branch-light (complexity budget).
 */
export function applyEvidenceUnion(
  base: SearchHit[],
  extraHits: SearchHit[] | undefined,
): SearchHit[] {
  if (!extraHits || extraHits.length === 0) return base;
  const rawCap = parseInt(process.env.SYNTHESIZE_EXTRA_EVIDENCE_CAP ?? '', 10);
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : 40;
  const results = mergeExtraHits(base, extraHits, cap);
  const count = (hits: SearchHit[]): number =>
    hits.reduce((a, h) => a + h.facts.length, 0);
  traceArtifact('synthesize.evidence_union', {
    baseHits: base.length,
    mergedHits: results.length,
    extraFacts: count(results) - count(base),
  });
  return results;
}

export function mergeExtraHits(
  base: SearchHit[],
  extra: SearchHit[],
  cap: number,
): SearchHit[] {
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
