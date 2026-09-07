import type { EvidenceCitation } from './synthesize.types';

/**
 * Scene citations (RETRIEVAL_SCENE_LANE) — the pure resolver that turns
 * the generator's raw `citedSceneIds` output into verified scene-arm
 * EvidenceCitations. No IO, no DI, no env: the caller supplies the
 * scenesById map and emits metrics from the returned counts. The
 * belief-citations.ts / fragment-citations.ts sibling, one lane over.
 *
 * WHY A SEPARATE ARM AND NOT `citations[]`: consumers of `citations`
 * read `c.factId` (answer-cache admit, multi-hop, agent-qa, the 0113
 * capability gate, the 0115 grounding gate) — a scene reference there
 * would be a type lie. Scene citations ride the same optional
 * `evidenceCitations` array the episode / fragment / belief arms
 * established, under the ONE-OF invariant: `sceneId` and nothing else.
 *
 * THE ANTI-HALLUCINATION + SECURITY FENCE: `scenesById` contains ONLY
 * the scenes actually rendered into the prompt's episodic section —
 * rows that already passed the lane's fence stack on their way in
 * (SceneLaneService: tenant → scoped-user + 0117 per-member → PII →
 * scope tags → live world → sceneVisibleToUser re-check). Any sceneId
 * the generator emits that is NOT in that map is dropped (and counted),
 * so a scene citation can never name a scene the caller couldn't read,
 * whether the id was hallucinated or probed.
 *
 * RENDERED-EXCERPT-ONLY: the citation's `excerpt` is copied from the
 * rendered set — the exact (≤600-char) gist excerpt the generator saw —
 * never generator-authored text, so a wrong or invented quote can never
 * ship as a citation.
 *
 * NO `capability` STAMP (the belief-arm precedent): a scene gist is
 * distilled TEXT, so it neither satisfies nor triggers the 0113
 * non-text capability gate (resolveEvidenceCapability sees only the
 * text baseline).
 *
 * NOT A CITATION-REQUIREMENT SUBSTITUTE: see verdict.ts — a supported
 * answer whose ONLY citations are scene-arm does NOT satisfy
 * FOVEA_REQUIRE_CITATIONS. A scene gist is an LLM-authored abstractive
 * summary once SCENES_LLM_ENRICHMENT is on, unlike the verbatim episode
 * span, the media-derived fragment text, or the supersede-chained
 * belief statement. Scene citations exist to make a scene-grounded
 * answer ATTRIBUTABLE (unrollable: scene → member turns → episodes),
 * not to clear a gate that means "grounded in the record".
 */

/** One rendered episodic line's scene, as the resolver may cite it. */
export interface CitableScene {
  /** memory_episode record id, exactly as rendered in the line header. */
  sceneId: string;
  /** Deterministic (or LLM-refined) scene label — the human handle. */
  sceneLabel: string;
  /** The RENDERED gist excerpt — the only citable text. */
  excerpt: string;
  /** ISO start of the scene's time span, when known. */
  occurredAt?: string | undefined;
}

/** Per-citation resolution outcomes (the metric label values). */
export interface SceneCitationCounts {
  /** sceneId was rendered → a scene-arm citation shipped. */
  cited: number;
  /** sceneId not in the rendered set (or malformed entry) →
   *  dropped, never surfaced. */
  dropped_unknown: number;
}

/** Ceiling on resolved scene citations per answer (the l3-citations
 *  EVIDENCE_CITATION_CAP idiom — bounded output). */
const SCENE_CITATION_CAP = 16;

/**
 * Resolve the generator's raw citedSceneIds against the rendered-set
 * map. Deduped by sceneId; capped at 16. Input is `unknown[]` by
 * design — the LLM output is parsed defensively here, not trusted at
 * the call site (a `{sceneId}` object entry is tolerated alongside the
 * schema's plain string).
 */
export function resolveSceneCitations(
  citedSceneIds: ReadonlyArray<unknown>,
  scenesById: ReadonlyMap<string, CitableScene>,
): { citations: EvidenceCitation[]; counts: SceneCitationCounts } {
  const counts: SceneCitationCounts = { cited: 0, dropped_unknown: 0 };
  const citations: EvidenceCitation[] = [];
  const seen = new Set<string>();
  for (const raw of citedSceneIds) {
    if (citations.length >= SCENE_CITATION_CAP) break;
    const sceneId = parseEntry(raw);
    if (!sceneId) {
      counts.dropped_unknown += 1;
      continue;
    }
    const scene = scenesById.get(sceneId);
    if (!scene) {
      counts.dropped_unknown += 1;
      continue;
    }
    if (seen.has(sceneId)) continue;
    seen.add(sceneId);
    // ONE-OF invariant (EvidenceCitation): the scene arm only — never an
    // episodeId, fragmentId or beliefId on the same citation.
    citations.push({
      sceneId: scene.sceneId,
      excerpt: scene.excerpt,
      ...(scene.occurredAt !== undefined ? { occurredAt: scene.occurredAt } : {}),
    });
    counts.cited += 1;
  }
  return { citations, counts };
}

/** Metrics port for the counting wrapper (keeps this module pure). */
export interface SceneCitationMetrics {
  countSceneCitation(outcome: 'cited' | 'dropped_unknown', n?: number): void;
}

/**
 * Service-facing wrapper (the resolveAndCountBeliefCitations sibling):
 * resolve + emit the per-outcome telemetry. An absent fence map means
 * the lane was off for the request OR nothing was rendered (the map is
 * only populated by the lane's rendered set) — [] either way, the
 * byte-identical default path.
 */
export function resolveAndCountSceneCitations(opts: {
  citedSceneIds: ReadonlyArray<unknown> | undefined;
  scenesById: ReadonlyMap<string, CitableScene> | undefined;
  metrics?: SceneCitationMetrics | undefined;
}): EvidenceCitation[] {
  if (!opts.scenesById) return [];
  const { citations, counts } = resolveSceneCitations(opts.citedSceneIds ?? [], opts.scenesById);
  for (const outcome of ['cited', 'dropped_unknown'] as const) {
    if (counts[outcome] > 0) opts.metrics?.countSceneCitation(outcome, counts[outcome]);
  }
  return citations;
}

/** Defensive shape check on one generator-emitted entry; a malformed row
 *  (no non-empty string id) resolves to null and counts as dropped. */
function parseEntry(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'object' && raw !== null) {
    const id = (raw as { sceneId?: unknown }).sceneId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}
