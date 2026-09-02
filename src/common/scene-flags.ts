import { envFlagEnabled } from './env-validation';

/**
 * Scenes (Brain v2 PR1) master flag — SCENES_SEGMENTATION_ENABLED.
 *
 * When on, the admin scene-composer surface (POST
 * /v1/admin/maintenance/scenes) batch-derives the shadow memory_episode
 * substrate (migration 0106) from raw L0 episodes. The env read lives here
 * in the common layer, NOT inside the engine dirs (engine-gates S5.2).
 * Read at call time so a flip is runtime-mutable (no restart). Default off
 * ⇒ the admin route 404s and NO memory_episode row is ever written —
 * byte-identical prod (shadow substrate: nothing on the serving path reads
 * these tables even when on). SCENES_ family sits off the ENGINE flag
 * budget by design (a shadow-substrate builder, not an engine fork).
 */
export function sceneSegmentationEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_SEGMENTATION_ENABLED);
}

/**
 * Scenes topic-boundary flag — SCENES_TOPIC_BOUNDARY.
 *
 * When on, the composer spends ONE embedding batch per conversation (its
 * only paid step — no LLM anywhere in v1) and the segmenter additionally
 * splits WITHIN a session where cosine(mean of the last 3 turns, next
 * turn) drops below the SCENES_TOPIC_MIN_COSINE floor. The env read lives
 * here in the common layer, NOT inside the engine dirs (engine-gates
 * S5.2). Read at call time so a flip is runtime-mutable. Default off ⇒
 * session-gap + max-turns segmentation only, embedder-free — and with the
 * master flag off the whole surface is byte-identical prod.
 */
export function sceneTopicBoundaryEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_TOPIC_BOUNDARY);
}

/** Default cosine floor for the topic-boundary split (Brain v2 PR1). */
const DEFAULT_TOPIC_MIN_COSINE = 0.55;

/**
 * Topic-boundary cosine floor (SCENES_TOPIC_MIN_COSINE): split between
 * turns when cosine(mean of the last 3 member embeddings, next turn's
 * embedding) < this value. A non-boolean knob resolved here in the common
 * layer so the segmenter takes a resolved number (engine-gates S5.2); read
 * at call time so a change is runtime-mutable. Cosine lives in [-1,1], so
 * the full range is accepted; unset, blank, or out of range → the 0.55
 * default. Ignored unless SCENES_TOPIC_BOUNDARY is on.
 */
export function sceneTopicMinCosine(): number {
  const raw = process.env.SCENES_TOPIC_MIN_COSINE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TOPIC_MIN_COSINE;
  const v = Number(raw);
  return Number.isFinite(v) && v >= -1 && v <= 1 ? v : DEFAULT_TOPIC_MIN_COSINE;
}

/**
 * Scenes LLM enrichment flag — SCENES_LLM_ENRICHMENT (Brain v2 PR2).
 *
 * When on, an OPTIONAL pass runs AFTER the composer's atomic swap (and is
 * also triggerable standalone via POST /v1/admin/maintenance/scenes/enrich):
 * ONE structured LLM call per scene of the current segmenter version,
 * replacing the deterministic gist with an abstractive one and filling the
 * FULL memoryValue vector (scorerVersion 'scene-scorer-llm-v1'), stateDeltas
 * and unexpectedDetails. The env read lives here in the common layer, NOT
 * inside the engine dirs (engine-gates S5.2). Read at call time so a flip is
 * runtime-mutable. Default off ⇒ NO LLM call is ever made and scenes keep
 * their deterministic gist/score — byte-identical to PR1 behavior. Enrichment
 * degrades, never fails: a bad reply for one scene logs a warning and leaves
 * that scene untouched.
 */
export function sceneLlmEnrichmentEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_LLM_ENRICHMENT);
}

/**
 * Scenes fact-backlink flag — SCENES_FACT_BACKLINK (Brain v2 PR2).
 *
 * When on, a batch pass (end of the composer run + standalone POST
 * /v1/admin/maintenance/scenes/backlink) stamps each knowledge_fact whose
 * source.episodeIds intersect a scene's membership with
 * source.memoryEpisodeIds (idempotent array::union) + source.sceneLinkVersion
 * — facts become pointers into the episodic plane. FLEXIBLE `source` ride, no
 * migration. The env read lives here in the common layer, NOT inside the
 * engine dirs (engine-gates S5.2). Read at call time so a flip is
 * runtime-mutable. Default off ⇒ no fact row is ever touched. Serving stays
 * byte-identical even when on — nothing READS source.memoryEpisodeIds; the
 * keys are merely visible wherever `source` is already returned verbatim
 * (facts read/provenance API) — an additive payload change, not a behavioral
 * one.
 */
export function sceneFactBacklinkEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_FACT_BACKLINK);
}

/**
 * Scenes version-fingerprint flag — SCENES_VERSION_FINGERPRINT (Drift-3).
 *
 * When on, SceneVersionService resolves the EFFECTIVE segmenter version as
 * `scene-segmenter-v1+<fp>` where <fp> is an 8-hex-char sha256 over the
 * resolved segmenter config (impl, scorer, maxTurns, topicBoundary, and —
 * only when the boundary is on — minCosine + the embedding-space id).
 * Scene record ids, the segmenterVersion stamps on scene AND member rows,
 * the projection-registry key, the composer's swap WHERE, the enricher's
 * and backlinker's scene selection and the backlink source.sceneLinkVersion
 * stamp all follow the effective string — so changing any config knob
 * forks a NEW coexisting id-space instead of overwriting the old world in
 * place (abandoned worlds are purged via DELETE /scenes/versions/:v). The
 * env read lives here in the common layer, NOT inside the engine dirs
 * (engine-gates S5.2). Read once per composer/enricher/backlinker run
 * (SceneVersionService.resolve) so a flip is runtime-mutable and a mid-run
 * flip can never mix id-spaces. Default off ⇒ the effective version is
 * exactly the literal SEGMENTER_VERSION constant — byte-identical
 * ids/stamps/registry keys.
 */
export function sceneVersionFingerprintEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_VERSION_FINGERPRINT);
}

/**
 * Scenes belief-promotion flag — SCENES_BELIEF_PROMOTION (Belief-A).
 *
 * When on, the admin promotion surface (POST
 * /v1/admin/maintenance/scenes/beliefs) folds ENRICHED scenes of the
 * current effective segmenter version (stateDeltas / memoryValue / gist,
 * migration 0118) into the shadow semantic_belief substrate (migration
 * 0120), keyed by free-text (subject, field). The env read lives here in
 * the common layer, NOT inside the engine dirs (engine-gates S5.2). Read
 * at call time so a flip is runtime-mutable. Default off ⇒ the admin
 * route 404s and the promotion service returns without a single query —
 * NO semantic_belief row is ever written, byte-identical prod (shadow
 * substrate: no serving path reads the table even when on). SCENES_
 * family sits off the ENGINE flag budget by design.
 */
export function sceneBeliefPromotionEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_BELIEF_PROMOTION);
}

/**
 * Scenes belief LLM-synthesis flag — SCENES_BELIEF_LLM_SYNTHESIS
 * (Belief-A). When on AND an OpenAI key is configured, the promotion
 * pass makes ONE structured LLM call per belief WRITE (create/revise —
 * never for a pure corroboration update) to phrase the `statement` text;
 * any failure degrades to the deterministic template (statementSource
 * 'template'), never fails the write. The env read lives here in the
 * common layer (engine-gates S5.2); read at call time so a flip is
 * runtime-mutable. Default off ⇒ NO LLM call is ever made and every
 * statement is the deterministic template — the fold works identically.
 */
export function sceneBeliefLlmSynthesisEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_BELIEF_LLM_SYNTHESIS);
}

/**
 * Belief corroboration floor (SCENES_BELIEF_MIN_SCENES): promote a
 * (subject, field) group only when its winning value is corroborated by
 * scenes from at least this many DISTINCT CONVERSATIONS (the #377
 * promotion-floor idiom; the knob keeps the family's SCENES_ naming —
 * the unit is distinct conversations, the anti-single-mention lever).
 * 0 = floor off (default): every folded group promotes. A non-boolean
 * knob resolved here in the common layer (engine-gates S5.2); read at
 * call time so a change is runtime-mutable. Must be a non-negative
 * integer; unset, blank, or invalid → 0.
 */
export function sceneBeliefMinScenes(): number {
  const raw = process.env.SCENES_BELIEF_MIN_SCENES;
  if (raw === undefined || raw.trim() === '') return 0;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

/** Default hard cap on turns per scene (Brain v2 PR1). */
const DEFAULT_MAX_TURNS = 40;

/**
 * Scene size cap (SCENES_MAX_TURNS): force a boundary once a scene reaches
 * this many turns, regardless of topic continuity — a bound on gist length
 * and on the eventual consolidation unit. A non-boolean knob resolved here
 * in the common layer so the segmenter takes a resolved number
 * (engine-gates S5.2); read at call time so a change is runtime-mutable.
 * Must be a positive integer; unset, blank, or invalid → the 40 default.
 */
export function sceneMaxTurns(): number {
  const raw = process.env.SCENES_MAX_TURNS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_TURNS;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_TURNS;
}
