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
 * Scene evidence-links flag — SCENES_EVIDENCE_LINKS (MM-zoom PR1).
 *
 * When on, a batch pass (end of the composer run + standalone POST
 * /v1/admin/maintenance/scenes/evidence-links) writes typed
 * scene-reconstructed_from->evidence_fragment|evidence_asset edges into
 * memory_support (0116; the reserved kind activated by 0123) from the
 * union of member episodes' source.evidenceRefs — scenes become zoomable
 * into the multimodal evidence substrate (0109). Replay-idempotent
 * (INSERT RELATION IGNORE over UNIQUE(in, out, kind)); episodes without
 * evidence refs are a graceful no-op (the metadata-ingest path is the
 * producer). The env read lives here in the common layer, NOT inside the
 * engine dirs (engine-gates S5.2). Read at call time so a flip is
 * runtime-mutable. Default off ⇒ no edge is ever written, the admin
 * route 404s and the composer's post-swap hook is skipped —
 * byte-identical prod. The GDPR cascades erase the edges REGARDLESS of
 * this flag (the EVIDENCE_SUBSTRATE_ENABLED precedent).
 */
export function sceneEvidenceLinksEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_EVIDENCE_LINKS);
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
 * Scenes belief negation-deltas flag — SCENES_BELIEF_NEGATION_DELTAS
 * (#135 seam 1). When on, the promotion fold ADMITS a stateDelta whose
 * `to` is empty but whose `from` is NON-empty — a state REMOVAL
 * (sold/quit/ended, the owns:true→false transition) — as a contribution
 * carrying the canonical negation sentinel value 'none'
 * (BELIEF_NEGATION_VALUE) with priorValue = the delta's `from`; the
 * ordinary supersede chain then revises the belief naturally ('none' vs
 * the current value). A delta with BOTH ends empty stays dropped —
 * nothing to negate. The env read lives here in the common layer, NOT
 * inside the engine dirs (engine-gates S5.2). Read at call time so a
 * flip is runtime-mutable. Default off ⇒ empty-`to` deltas are dropped
 * exactly as before — byte-identical fold output and prompts.
 */
export function sceneBeliefNegationDeltasEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_BELIEF_NEGATION_DELTAS);
}

/**
 * Scenes belief field-fold flag — SCENES_BELIEF_FIELD_FOLD (#135 seam
 * 2). The LLM enricher re-coins free-text field names per scene ('car'
 * vs 'car ownership'), so exact-string (subject, field) grouping lands
 * follow-up deltas in a fresh group and creates a PARALLEL belief
 * instead of revising the existing one. When on, the promotion pass
 * folds an incoming field name onto an existing one (existing ACTIVE
 * beliefs of the same (userId, subject) + fields already admitted in
 * the same batch) under a deterministic lexical rule — token-set subset
 * whose extra tokens are all generic modifiers (fieldsFold — NO
 * embeddings, NO LLM); the EXISTING name wins (stability), and more
 * than one match folds NOTHING and warns loudly (the skip-loudly,
 * never-flip-flop doctrine). The env read lives here in the common
 * layer, NOT inside the engine dirs (engine-gates S5.2). Read at call
 * time so a flip is runtime-mutable. Default off ⇒ exact-string
 * grouping and zero extra queries — byte-identical fold output.
 */
export function sceneBeliefFieldFoldEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_BELIEF_FIELD_FOLD);
}

/**
 * Pack-projected state-delta promotion — SCENES_PACK_DELTA_PROMOTION.
 *
 * When on, the belief promotion pass ALSO admits scenes of the
 * pack-projection worlds (`segmenterVersion` LIKE `pack:<packId>+<fp>`,
 * written by BOTH pack projection producers — SceneCandidateWriterService
 * on the document path and MentionProjectionService on the capture path —
 * under PACK_MEMORY_PROJECTIONS_ENABLED), not only the composer's current
 * effective segmenter version. Pack scenes carry no `enrichmentVersion`
 * (their stateDeltas come from the pack's own reading, not the LLM
 * enricher), so the widened leg drops that requirement for `pack:` worlds
 * ONLY.
 *
 * Everything downstream is unchanged: the #387 single-user fence still
 * applies (a tenant-global document's scenes carry no userIds and are
 * skipped fail-closed), the field is the pack-namespaced
 * `<packId>__<local>` (packDeltaField) so packs can never merge, and the
 * belief's promoterVersion carries the pack world as provenance.
 *
 * NOTE: document scenes carry NO conversationIds, so a non-zero
 * SCENES_BELIEF_MIN_SCENES (a DISTINCT-CONVERSATION floor) excludes
 * document-projected beliefs by construction; a capture-origin scene does
 * carry its turn's conversation.
 *
 * The env read lives here in the common layer, NOT inside the engine dirs
 * (engine-gates S5.2). Read ONCE per promotion run so a mid-run flip can
 * never mix worlds (the Drift-3 contract). Default off ⇒ the promoter's
 * selection query, parameters and per-belief stamps are byte-identical to
 * the pre-flag pass — no pack scene is ever seen.
 */
export function scenePackDeltaPromotionEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_PACK_DELTA_PROMOTION);
}

/**
 * Scenes prediction-baseline flag — SCENES_PREDICTION_BASELINE.
 *
 * The scene plane had NO prediction machinery: `memoryValue.contradiction`
 * and `unexpectedDetails` were LLM saliency guesses made against nothing —
 * the enricher was never shown any prior state to be surprised AGAINST —
 * and `baselineRef` (0106) was written only by belief promotion, only on a
 * revision, AFTER the fact. The roadmap names the hole: "the missing edge
 * is PREDICTION as a read-side control signal (surprise currently exists
 * only at write time)".
 *
 * When on, the enrichment pass gains ONE coherent behavior in three parts:
 *  1. EXPECTATION SNAPSHOT — before scoring a scene it loads the scene
 *     user's ACTIVE semantic_belief rows (0120) for the subjects the scene
 *     is about (ONE bounded SELECT per run, capped) and stamps them onto
 *     the scene as `baselineRef` = {beliefs, stampedAt, baselineVersion};
 *  2. PREDICTION ERROR IN THE PROMPT — that snapshot is rendered as an
 *     explicit "what the system believed BEFORE this scene" block and the
 *     instruction changes so `contradiction` / `unexpectedDetails` are
 *     reported as DEVIATION FROM THAT MODEL, not free-floating saliency
 *     (fresh prompt version scene-gist-v2);
 *  3. DETERMINISTIC SCORER — a no-model-call scorer (scene-scorer-v1)
 *     measures contradiction / stateChange / identity from the SAME
 *     baseline plus the scene's stateDeltas and OVERRIDES the model's
 *     guesses for exactly those dimensions in `enrichedMemoryValue`
 *     (scorerVersion composite scene-scorer-llm-v1+scene-scorer-v1).
 *     A dimension it cannot measure stays the model's guess — an unknown
 *     baseline is never turned into a confident zero.
 *
 * Scenes that fail the #387 single-user fence (mixed-user, tenant-global,
 * legacy pre-0117 userIds) get NO baseline at all — a scene is never
 * scored against another user's beliefs.
 *
 * The env read lives here in the common layer, NOT inside the engine dirs
 * (engine-gates S5.2). Read ONCE per enrichment run (the Drift-3 contract)
 * so a mid-run flip can never mix prompt versions inside one world.
 * Default off ⇒ ZERO extra queries, the byte-identical scene-gist-v1
 * prompt and enrichmentVersion composite, no baselineRef write, and the
 * model's memoryValue verbatim. Requires SCENES_LLM_ENRICHMENT — the
 * baseline is an input to the enrichment call. SCENES_ family sits off the
 * ENGINE flag budget by design.
 */
export function scenePredictionBaselineEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_PREDICTION_BASELINE);
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

/**
 * Scheduled scene-maintenance flag — SCENES_SCHEDULED_MAINTENANCE.
 *
 * The scene chain (compose → enrich → backlink → evidence links →
 * beliefs) had NO scheduled runner: every SCENES_* flag could be on in
 * prod and the whole episodic/semantic plane would still only exist for
 * conversations an operator had curled by hand. When this flag is on,
 * SceneMaintenanceService's nightly cron (04:20 UTC) walks the tenant
 * roster and runs that chain over the DIRTY conversations only, and the
 * ingest seam (EpisodeStoreService.captureTurn) starts marking
 * conversations dirty (migration 0130) as turns land.
 *
 * The env read lives here in the common layer, NOT inside the engine dirs
 * (engine-gates S5.2). Read at call time so a flip is runtime-mutable.
 * Default off ⇒ the cron returns before a single query, NO dirty mark is
 * ever written and the admin routes behave exactly as before —
 * byte-identical prod. Requires SCENES_SEGMENTATION_ENABLED to do
 * anything: both the cron and the mark seam check the master flag too, so
 * marks cannot pile up for a composer that is switched off.
 */
export function sceneScheduledMaintenanceEnabled(): boolean {
  return envFlagEnabled(process.env.SCENES_SCHEDULED_MAINTENANCE);
}

/** Default per-tenant, per-run conversation budget for the nightly pass. */
const DEFAULT_MAINTENANCE_MAX_CONVERSATIONS = 200;

/**
 * Per-tenant conversation budget (SCENES_MAINTENANCE_MAX_CONVERSATIONS):
 * the nightly pass composes at most this many DIRTY conversations for one
 * tenant per run, oldest mark first. NOT optional — the post-swap chain
 * spends one LLM call per new scene and one embedding batch per composed
 * conversation, so an unbounded run lets one large tenant's backlog
 * monopolize both the night and the token budget. Unconsumed marks survive
 * to the next run, so a backlog drains over successive nights instead of
 * being dropped. A non-boolean knob resolved here in the common layer
 * (engine-gates S5.2); read at call time so a change is runtime-mutable.
 * Must be a positive integer; unset, blank, or invalid → 200.
 */
export function sceneMaintenanceMaxConversations(): number {
  const raw = process.env.SCENES_MAINTENANCE_MAX_CONVERSATIONS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAINTENANCE_MAX_CONVERSATIONS;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAINTENANCE_MAX_CONVERSATIONS;
}

/** Default wall-clock budget for ONE nightly maintenance run (30 min). */
const DEFAULT_MAINTENANCE_TIME_BUDGET_MS = 30 * 60 * 1000;

/**
 * Whole-run wall-clock budget (SCENES_MAINTENANCE_TIME_BUDGET_MS): the
 * nightly pass stops starting new tenants once this much time has elapsed
 * since the run began (the tenant already in flight always finishes — the
 * budget bounds the roster walk, it does not abort a compose mid-swap).
 * The roster resumes from the top next night and the unconsumed dirty
 * marks are still there, so nothing is lost; the cap only guarantees the
 * pass cannot still be running when the next night's crons fire. A
 * non-boolean knob resolved here in the common layer (engine-gates S5.2);
 * read at call time so a change is runtime-mutable. Must be a positive
 * integer number of milliseconds; unset, blank, or invalid → 1_800_000.
 */
export function sceneMaintenanceTimeBudgetMs(): number {
  const raw = process.env.SCENES_MAINTENANCE_TIME_BUDGET_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAINTENANCE_TIME_BUDGET_MS;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAINTENANCE_TIME_BUDGET_MS;
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
