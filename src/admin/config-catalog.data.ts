/* eslint-disable max-lines -- one declarative catalogue literal; splitting it would only scatter the sections */
import type { ConfigEntry } from './config-inspector.service';

/** One catalogue row — a ConfigEntry before the live value is projected. */
export type ConfigCatalogSpec = Omit<ConfigEntry, 'currentValue'> & {
  defaultValue: string | null;
};

/**
 * Catalogue of operator-visible env knobs — ONE big declarative literal
 * by design (curated descriptions + correct restart-required flags; see
 * ConfigInspectorService). NEW knobs: add an entry here, keep the
 * section comments. Extracted from the service purely for file-size
 * reasons; the service projects live values over it.
 */
export const CONFIG_CATALOG: ConfigCatalogSpec[] = [
  // ── Extractor ────────────────────────────────────────────
  {
    key: 'EXTRACTOR_SKIP_LLM_ENABLED',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Opt-in gate that allows the local pre-pass to skip the extractor LLM call when intent + mentions + collapse-patterns all hit.',
  },
  {
    key: 'EXTRACTOR_SC_PASSES',
    category: 'extractor',
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Self-consistency N-pass count for semantic-entropy gating. 1 = single pass; raise (e.g. 3) for high-stakes corpora.',
  },
  {
    key: 'EXTRACTOR_LOCAL_NER_ENABLED',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description: 'Local @xenova/transformers NER pass before the LLM.',
  },
  {
    key: 'EXTRACTOR_LOCAL_NER_MIN_SCORE',
    category: 'extractor',
    defaultValue: '0.7',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'EXTRACTOR_LOCAL_NER_MODEL',
    category: 'extractor',
    defaultValue: 'Xenova/bert-base-multilingual-cased-ner-hrl',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'EXTRACTOR_LOCAL_NER_WORKER',
    category: 'extractor',
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Run the local NER ONNX pipeline in a dedicated worker_thread so inference never blocks the event loop. 0 = in-thread.',
  },
  {
    key: 'EXTRACTOR_LOCAL_NER_TIMEOUT_MS',
    category: 'extractor',
    defaultValue: '3000',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Per-call budget for the NER worker RPC; a stalled call degrades to "no local entities" and latches worker retries for 5 minutes.',
  },
  {
    key: 'EXTRACTOR_LOCAL_PREDICATE_THRESHOLD',
    category: 'extractor',
    defaultValue: '0.55',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'EXTRACTOR_CACHE_ENABLED',
    category: 'extractor',
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'EXTRACTOR_CACHE_SIZE',
    category: 'extractor',
    defaultValue: '256',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  // ── Embedder ────────────────────────────────────────────
  {
    key: 'EMBEDDER_PROVIDER',
    category: 'embedder',
    defaultValue: 'openai',
    runtimeMutable: false,
    isBooleanFlag: false,
    description: 'openai | bge-m3. Requires reindex after flip.',
  },
  {
    key: 'BGE_M3_MODEL_ID',
    category: 'embedder',
    defaultValue: 'Xenova/bge-m3',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'BGE_M3_DIMENSIONS',
    category: 'embedder',
    defaultValue: '1024',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'BGE_M3_CONCURRENCY',
    category: 'embedder',
    defaultValue: '2',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  // ── Dreams ────────────────────────────────────────────
  {
    key: 'DREAMS_ENABLED',
    category: 'dreams',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description: 'Master switch for the 04:00 UTC cron. Read once at boot.',
  },
  {
    key: 'DREAMS_DEDUP_ENABLED',
    category: 'dreams',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'DREAMS_RESOLVE_ENABLED',
    category: 'dreams',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'DREAMS_RUN_SUMMARIZE',
    category: 'dreams',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'DREAMS_LLM_SUMMARY_ENABLED',
    category: 'dreams',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'DREAMS_DEDUP_COSINE_THRESHOLD',
    category: 'dreams',
    defaultValue: '0.92',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'DREAMS_DEDUP_MAX_PAIRS',
    category: 'dreams',
    defaultValue: '50',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'DREAMS_DEDUP_MAX_SEEDS',
    category: 'dreams',
    defaultValue: '500',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Cap on name-fact seeds per dedup run (newest first). Bounds the per-seed neighbour queries.',
  },
  {
    key: 'DREAMS_RESOLVE_MIN_AGE_DAYS',
    category: 'dreams',
    defaultValue: '7',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'DREAMS_RESOLVE_MAX_PAIRS',
    category: 'dreams',
    defaultValue: '20',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  // ── Compaction ────────────────────────────────────────────
  {
    key: 'COMPACTION_HOT_RETENTION_DAYS',
    category: 'compaction',
    defaultValue: '90',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'COMPACTION_SUMMARIES',
    category: 'compaction',
    defaultValue: 'false',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'COMPACTION_TENANT_OVERRIDES',
    category: 'compaction',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Per-tenant retention/promotion schedule (Brain v2 PR8, docs/roadmap/brain-v2-resolution-2026-08.md): JSON object mapping companyId → { hotRetentionDays?, promotionAgeDays?, promotionMinGroup?, promotionMinEpisodes? } (positive ints; promotionMinEpisodes ≥ 0). Overrides the process-global COMPACTION_HOT_RETENTION_DAYS / COMPACTION_PROMOTION_AGE_DAYS / COMPACTION_PROMOTION_MIN_GROUP / COMPACTION_PROMOTION_MIN_EPISODES for that tenant only. RETRIEVAL_PROFILE_OVERRIDES idiom: boot-validated shape (warn, never throw), malformed entries fail open to the process defaults per tenant; read at call time, so the cron picks up changes without a restart.',
  },
  // ── Audit / changefeed ────────────────────────────────────
  {
    key: 'AUDIT_CHANGEFEED_ENABLED',
    category: 'audit',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description: 'Master switch for the every-minute changefeed → audit_event consumer.',
  },
  {
    key: 'AUDIT_CHANGEFEED_BATCH',
    category: 'audit',
    defaultValue: '500',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  // Outcome telemetry (0107) — filed under 'audit' (the nearest existing
  // category for an append-only event trail + its retention knob).
  {
    key: 'OUTCOME_TELEMETRY_ENABLED',
    category: 'audit',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Master switch for outcome telemetry (0107): writers append memory_outcome events + fold the memory_outcome_stat rollup; nightly raw-log prune runs.',
  },
  {
    key: 'OUTCOME_RETRIEVED_EVENTS',
    category: 'audit',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Extra gate on the high-volume `retrieved` outcome stream (one event per surfaced fact per search) on top of OUTCOME_TELEMETRY_ENABLED.',
  },
  {
    key: 'OUTCOME_EVENT_RETENTION_DAYS',
    category: 'audit',
    defaultValue: '30',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Days the raw memory_outcome event log is kept; the 03:41 UTC prune cron deletes older rows. The memory_outcome_stat rollup is never pruned.',
  },
  // Tool observations (0111) — filed under 'audit' like the 0107 pair
  // (append-only telemetry trail + retention knob).
  {
    key: 'TOOL_OBSERVATIONS_ENABLED',
    category: 'audit',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Master switch for tool observations (0111): the per-request MCP build applies the content-free observation wrapper, the pack-tool proxy stamps identity rows, ingest accepts toolObservationRef, and the nightly prune leg runs. Off = wrapper not applied (byte-identical).',
  },
  {
    key: 'TOOL_OBSERVATION_CONTENT',
    category: 'audit',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Opt-in gate for the one content-bearing tool_observation column (contentExcerpt, sanitized, ≤512 chars) on top of TOOL_OBSERVATIONS_ENABLED. Off = rows are digest-only (content-free contract).',
  },
  {
    key: 'TOOL_OBSERVATION_RETENTION_DAYS',
    category: 'audit',
    defaultValue: '30',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Days raw tool_observation rows are kept; the 03:41 UTC prune cron deletes older rows in bounded batches.',
  },
  // ── Router ────────────────────────────────────────────────
  {
    key: 'CHAT_ROUTE_CACHE_ENABLED',
    category: 'router',
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'CHAT_ROUTE_CACHE_SIZE',
    category: 'router',
    defaultValue: '256',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'CHAT_ROUTE_HINT_MAX',
    category: 'router',
    defaultValue: '3',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'CHAT_ROUTE_HINT_SIMILARITY',
    category: 'router',
    defaultValue: '0.55',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'CHAT_ROUTE_INTENT_CONFIDENCE_FLOOR',
    category: 'router',
    defaultValue: '0.85',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'CHAT_ROUTE_NLI_ENABLED',
    category: 'router',
    // Code default is ON (`get('CHAT_ROUTE_NLI_ENABLED', 'true') !==
    // 'false'` in IntentClassifierService) and captured in the
    // constructor — the previous '0'/runtime-mutable entry was drift.
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'CHAT_ROUTE_NLI_ASK_THRESHOLD',
    category: 'router',
    defaultValue: '0.6',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'CHAT_ROUTE_NLI_WORKER',
    category: 'router',
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Run NLI intent inference in a dedicated worker_thread so the ~100-200ms ONNX pass never blocks the event loop. 0 = in-thread (benchmarks/constrained envs).',
  },
  {
    key: 'CHAT_ROUTE_NLI_TIMEOUT_MS',
    category: 'router',
    defaultValue: '3000',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Per-call deadline for the NLI worker RPC. On timeout the router keeps the punctuation fallback and the classifier latches off for 5 minutes.',
  },
  // ── Search ────────────────────────────────────────────
  {
    key: 'SEARCH_PPR_ENABLED',
    category: 'search',
    // Code default is OFF (retrieval-profile.ts pprEnabled): on
    // small per-tenant graphs PPR amplifies hub effects
    // pathologically — measured. The catalog claimed '1' until the
    // 2026-08 graph audit.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
  },
  {
    key: 'SEARCH_PPR_AUTO_THRESHOLD',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'SEARCH_RERANK_SKIP_MARGIN',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'SEARCH_RERANK_TRUST_BAND',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Fused-score band width the rerank stages (cross-encoder and ' +
      'LLM) may reorder WITHIN. A fused-score gap wider than the band ' +
      '— trust priors above all, since SEARCH_TRUST_BETA rides the ' +
      'fused score — survives every rerank stage instead of being ' +
      'silently erased by reranker priority (audit 2026-08-21 P1). ' +
      '0 (default) disables the band; a non-zero band reshapes ' +
      'ranking even without trust, so enable after a benchmark/' +
      'canary and always alongside SEARCH_TRUST_BETA — 0.1 is the ' +
      'measured contract the fact-trust e2e pins.',
  },
  {
    key: 'SEARCH_TOKEN_COUNT_OFFLOAD',
    category: 'search',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Batch tokenBudget tiktoken counting out to the job worker pool (25ms acquire timeout; any failure falls back to the in-thread count).',
  },
  {
    key: 'SEARCH_TOKEN_OFFLOAD_MIN_HITS',
    category: 'search',
    defaultValue: '24',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Hit-count threshold below which tokenBudget counting stays in-thread — the postMessage round-trip only pays off on large lists.',
  },
  {
    key: 'MULTI_HOP_EDGE_EXPANSION_ENABLED',
    category: 'multihop',
    // Code default is OFF ("so the existing eval baseline doesn't
    // shift" — multi-hop-chain.service.ts). The catalog claimed
    // '1' until the 2026-08 graph audit.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
  },
  // ── Calibration ────────────────────────────────────────────
  {
    key: 'CALIBRATION_NIGHTLY_REFIT',
    category: 'calibration',
    defaultValue: 'true',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'CALIBRATION_USE_GOLD_SET',
    category: 'calibration',
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'FOVEA_FOCUS_CAPTURE',
    category: 'calibration',
    defaultValue: '0',
    // Read at call time (FocusSignalService.captureEnabled / the admin
    // 404 guard) — never captured in a constructor — so a flip takes
    // effect without restart.
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Fovea optics (Optics-1): capture the per-query focus signal at the synthesize verdict point and expose the admin fit/measure surface. Serving-neutral — nothing consumes the calibrated signal yet. Off = byte-identical serving.',
  },
  {
    key: 'FOVEA_ADAPTIVE_L3',
    category: 'calibration',
    // Read at call time (FocusSignalService.adaptiveL3Enabled → fovea-flags)
    // on the synthesize L3 seam — never captured in a constructor — so a
    // flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Fovea optics (Optics-2): make the L3 escalation trigger + session-count adaptive to the calibrated focus confidence, replacing the static coverage floor and scaling #sessions to the deficit (bounded by RETRIEVAL_L3_MAX_SESSIONS). Requires a persisted per-class calibration model (FOVEA_FOCUS_CAPTURE + fit); with none — or the flag off — serving is byte-identical to the static L3. Off = static.',
  },
  {
    key: 'FOVEA_ADAPTIVE_L3_THRESHOLD',
    category: 'calibration',
    // Read at call time (FocusSignalService.adaptiveL3EscalateThreshold →
    // fovea-flags) per request; runtime-mutable.
    defaultValue: '0.5',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Fovea optics (Optics-2): escalate to L3 when calibrated focus confidence < this threshold in (0,1], and scale #sessions ∝ the deficit below it (capped at RETRIEVAL_L3_MAX_SESSIONS). Ignored unless FOVEA_ADAPTIVE_L3 is on with a usable model. Default 0.5.',
  },
  {
    key: 'FOVEA_ADAPTIVE_ABSTAIN',
    category: 'calibration',
    // Read at call time (FocusSignalService.adaptiveAbstainEnabled →
    // fovea-flags) on the synthesize coverage-abstention seam — never
    // captured in a constructor — so a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Fovea optics (Optics §4.2): make the pre-generation memory-coverage abstention decision adaptive to the calibrated PRE-ANSWER focus confidence — abstain (NOT_IN_MEMORY) when confidence < threshold — replacing the static coverage floor. Only applies where RETRIEVAL_ABSTENTION_CALIBRATION=coverage. Requires a persisted per-class PRE-ANSWER calibration model (FOVEA_FOCUS_CAPTURE + fit); with none — or the flag off — serving is byte-identical to the static coverage abstention. Off = static.',
  },
  {
    key: 'FOVEA_ADAPTIVE_ABSTAIN_THRESHOLD',
    category: 'calibration',
    // Read at call time (FocusSignalService.adaptiveAbstainThreshold →
    // fovea-flags) per request; runtime-mutable.
    defaultValue: '0.5',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Fovea optics (Optics §4.2): abstain (return NOT_IN_MEMORY) when the calibrated pre-answer focus confidence < this threshold in (0,1]. Ignored unless FOVEA_ADAPTIVE_ABSTAIN is on with a usable pre-answer model. Default 0.5.',
  },
  {
    key: 'FOVEA_LENS_SUPPRESS',
    category: 'calibration',
    // Read at call time (LensSuppressionService.suppressEnabled → fovea-flags)
    // on the synthesize seam before the answer cache — never captured in a
    // constructor — so a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Fovea optics (Optics §4.3): subtractive lens-suppression governor — for the query class, REMOVE off-task / trap-inducing lanes from the effective active set (never add, never reorder) before retrieval and before the answer-cache key is computed. Requires a persisted per-class lens_suppression model (admin fit); with none — or the flag off, or a low-confidence class match — routing is byte-identical to the static lane set. Off = static.',
  },
  {
    key: 'FOVEA_LENS_SUPPRESS_MIN_COSINE',
    category: 'calibration',
    // Read at call time (LensSuppressionService.minCosine → fovea-flags) per
    // request; runtime-mutable.
    defaultValue: '0.5',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Fovea optics (Optics §4.3): suppress lanes only when the nearest class centroid cosine similarity to the query embedding is >= this floor in [-1,1]; below it the class match is uncertain and routing is left unchanged. Ignored unless FOVEA_LENS_SUPPRESS is on with a usable model. Default 0.5.',
  },
  {
    key: 'FOVEA_PLAUSIBILITY_CHECK',
    category: 'calibration',
    // Read at call time (fovea-flags.plausibilityCheckEnabled) on the
    // synthesize verdict seam — never captured in a constructor — so a flip
    // takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Fovea optics (verifier answer-integrity arm, Part A): after a `supported` verifier verdict, run ONE extra LLM plausibility judge over the CITED premises — does the premise contradict general world knowledge, or is it a counterfactual/sandbox premise applied out of its original context (belief distortion) — and DOWNGRADE an implausible answer to an abstain (NOT_IN_MEMORY / low_coverage). Adds one LLM call per supported answer WHEN ON. Off = NO extra call, byte-identical serving.',
  },
  {
    key: 'FOVEA_REQUIRE_CITATIONS',
    category: 'calibration',
    // Read at call time (fovea-flags.requireCitationsEnabled) on the
    // synthesize verdict seam — never captured in a constructor — so a flip
    // takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Fovea optics (verifier answer-integrity arm, Part C): treat a `supported` verdict whose answer carries ZERO citations as low_coverage/abstain instead of serving an uncited "supported" answer (audit F2(b)). LIVE-behavior change when enabled — prod answers can shift, so default off until the owner enables + validates. Off = byte-identical serving.',
  },
  {
    key: 'FOVEA_L3_EPISODE_CITATIONS',
    category: 'calibration',
    // Read at call time (fovea-flags.l3EpisodeCitationsEnabled) on the L3
    // escalation seam — never captured in a constructor — so a flip takes
    // effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Fovea serving-integrity: L3 evidence citations — the L3 escalation transcript renders per-turn [episode:...] headers and transcript-grounded claims are cited as {episodeId, quote} pairs, resolved into span-verified evidence citations over the stored turn text (episodeId-only when the quote cannot be verified; episodeIds not rendered into the transcript are dropped). An episode-cited answer satisfies FOVEA_REQUIRE_CITATIONS; the answer cache still never admits an episode-only-cited answer. Off = L3 prompt/schema/transcript byte-identical, no evidenceCitations emitted.',
  },
  {
    key: 'FOVEA_EVIDENCE_CAPABILITY',
    category: 'calibration',
    // Read at call time (fovea-flags.evidenceCapabilityEnabled) on the
    // finalizeAndAdmit gate-resolution seam — never captured in a
    // constructor — so a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Fovea serving-integrity: evidence-capability verdict gate (0113). A `supported` answer citing a fact whose predicate declares requiredEvidenceCapability != 'text' (knowledge_predicate column; absent = text = unconstrained) is DOWNGRADED to an abstain with reason 'evidence_capability_unmet' unless cited evidence of that capability exists. v1 is fail-closed abstain-or-pass plumbing: every citation today is text, so claims requiring visual/audio/document_region evidence can no longer verify on text alone — confirmation arrives with the media verifiers (M-track). Off = no registry lookup, byte-identical serving.",
  },
  {
    key: 'FOVEA_ATTENTION_HINTS',
    category: 'calibration',
    // Read at call time (fovea-flags.attentionHintsEnabled) on the L3
    // escalation anchor seam — never captured in a constructor — so a flip
    // takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Fovea optics: pack attention hints as an ordering-only L3 anchor boost. On a fired escalation with fact anchors, the installed packs' memoryModel.attentionHints are resolved against the query (case-folded LITERAL cue match, never a regex) and anchors whose originating fact carries a preferred predicate get their normalized score multiplied by 1+weight, clamped to [1,2]. Ordering-only — session density stays the primary rank key, no anchor is added or dropped, garbage hints resolve to a structural no-op. The memory-model reader is consulted lazily, never when off. Off = reader unconsulted, anchor ranking byte-identical.",
  },
  // ── Scenes (Brain v2) ──
  {
    key: 'SCENES_SEGMENTATION_ENABLED',
    category: 'scenes',
    // Read at call time (scene-flags.sceneSegmentationEnabled) by the
    // admin controller 404 guard + the composer's defensive early return
    // — never captured in a constructor — so a flip takes effect without
    // restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Scenes shadow substrate (Brain v2 PR1, migration 0106): enable the batch scene composer + POST /v1/admin/maintenance/scenes. Shadow — no serving path reads memory_episode. Off = route 404s, no scene row is ever written, byte-identical prod.',
  },
  {
    key: 'SCENES_TOPIC_BOUNDARY',
    category: 'scenes',
    // Read at call time (scene-flags.sceneTopicBoundaryEnabled) per
    // composer run — never captured in a constructor — runtime-mutable.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Scenes: within-session topic-boundary refinement — ONE embedding batch per conversation (the surface’s only paid step; no LLM anywhere) and a cosine split below SCENES_TOPIC_MIN_COSINE. Off = session-gap + max-turns segmentation only, embedder-free.',
  },
  {
    key: 'SCENES_TOPIC_MIN_COSINE',
    category: 'scenes',
    // Read at call time (scene-flags.sceneTopicMinCosine) per composer
    // run — never captured in a constructor — runtime-mutable.
    defaultValue: '0.55',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Scenes: split between turns when cosine(mean of the last 3 member embeddings, next turn) < this floor, in [-1,1]. Ignored unless SCENES_TOPIC_BOUNDARY is on. Default 0.55.',
  },
  {
    key: 'SCENES_MAX_TURNS',
    category: 'scenes',
    // Read at call time (scene-flags.sceneMaxTurns) per composer run —
    // never captured in a constructor — runtime-mutable.
    defaultValue: '40',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Scenes: force a scene boundary once a scene reaches this many turns, regardless of topic continuity. Positive integer; default 40.',
  },
  {
    key: 'SCENES_LLM_ENRICHMENT',
    category: 'scenes',
    // Read at call time (scene-flags.sceneLlmEnrichmentEnabled) by the
    // admin 404 guard, the enricher's defensive early return and the
    // composer's post-swap hook — never captured in a constructor — so a
    // flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Scenes LLM enrichment (Brain v2 PR2): after the composer swap (and via POST /v1/admin/maintenance/scenes/enrich), ONE structured LLM call per scene of the current segmenter version — abstractive gist replaces the deterministic one, full memoryValue vector (scorerVersion scene-scorer-llm-v1), stateDeltas, unexpectedDetails, gistPromptVersion scene-gist-v1. Degrade-never-fail per scene. Off = no LLM call ever runs, enrich route 404s, byte-identical to PR1.',
  },
  {
    key: 'SCENES_FACT_BACKLINK',
    category: 'scenes',
    // Read at call time (scene-flags.sceneFactBacklinkEnabled) by the
    // admin 404 guard, the backlink service's defensive early return and
    // the composer's post-run hook — never captured in a constructor — so
    // a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Scenes fact backlink (Brain v2 PR2): stamp knowledge_fact rows whose source.episodeIds intersect a scene’s membership with source.memoryEpisodeIds (idempotent array::union) + source.sceneLinkVersion — facts become pointers into the episodic plane. FLEXIBLE source ride, no migration; nothing on the serving path reads the keys (additively visible where `source` is already returned). Off = no fact row is ever touched, backlink route 404s.',
  },
  {
    key: 'SCENES_VERSION_FINGERPRINT',
    category: 'scenes',
    // Read at call time (scene-flags.sceneVersionFingerprintEnabled) once
    // per composer/enricher/backlinker run (SceneVersionService.resolve) —
    // never captured in a constructor — so a flip takes effect without
    // restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Scenes: fingerprint the segmenter config into the effective version — scene-segmenter-v1+<8-hex sha256 over impl|scorer|maxTurns|topicBoundary[|minCosine|space]> — so a config change forks a NEW coexisting scene id-space (ids, stamps, registry keys, swap WHERE and backlink stamps all follow) instead of overwriting the old world in place; abandoned worlds are purged via DELETE /scenes/versions/:v. Off = the literal scene-segmenter-v1 constant: byte-identical ids, stamps and registry keys.',
  },
  // ── Multilingual (Tier 1, migration 0100) ───────────
  {
    key: 'MULTILINGUAL_LANG_ATTRIBUTION',
    category: 'pipeline',
    // Read at call time (the language detector, fact-resolver buildResolveCall,
    // and resolveSearchTuning) — never captured in a constructor — so a flip
    // takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Confidence-aware language attribution: the pure detector returns `und` (not `en`) for short / stopword-less / numeric objects, and the fact resolver stamps langConfidence + langSource (detected | inherited | explicit) + detectorVersion + sourceLang (the SOURCE turn's language, distinct from the object's own `lang`), inheriting the source-turn language onto an undetectable short object. Behaviour-neutral telemetry (brain_lang_attribution_total / _confidence) is emitted only while on. Off (default) → the Phase-4 `en` fallback and NO new columns written — byte-identical.",
  },
  {
    key: 'MULTILINGUAL_SOFT_LANG_FILTER',
    category: 'pipeline',
    // Read at call time (resolveSearchTuning per request, user-profile
    // getProfile) — never constructor-captured — so a flip takes effect
    // without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Soft same-language filter: replaces the hard `lang = q OR lang IS NONE` exclusion at both read sites (search where-builder + user-profile) with a same-language RANKING boost — a cross-lingual fact is demoted, never hidden. In search it is gated on a high-confidence detected query language (an explicit dto.queryLang / caller-supplied profile lang counts as confident); below the confidence floor no boost AND no exclusion. Off (default) → the hard filter is byte-identical.',
  },
  // ── Multilingual (Tier 3, migration 0102) ───────────
  {
    key: 'MULTILINGUAL_ENTITY_REVERSIBLE',
    category: 'pipeline',
    // Read per-call in EntityResolverService.isReversible() +
    // EntityUpsertService (process.env), never constructor-captured — a flip
    // takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Reversible entity resolution: a WEAK inline-resolution match (embedding-only, no exact-canonical / externalRef signal) is NOT auto-merged — it becomes a reviewable entity_merge_log candidate (migration 0102) and a fresh entity is minted, so the fuse is deferred to explicit review. STRONG matches (exact canonical / externalRef) still auto-reuse but write an auditable merge row, so any wrong fuse can be found by target entity and split. Off (default) → the resolver reuses immediately with no log — byte-identical.',
  },
  {
    key: 'MULTILINGUAL_CJK_SEGMENTATION',
    category: 'pipeline',
    // Resolved into the RetrievalProfile (cjkSegmentation) by
    // resolveRetrievalProfile — read per request, never constructor-captured.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'CJK segmentation for the mention-scan topic: segment the topic with the Intl.Segmenter built-in (ICU-backed word boundaries — no new dependency) so CJK / other non-space-delimited scripts yield real terms instead of being split to nothing by the ASCII/Cyrillic character class. Resolved into the RetrievalProfile and threaded to the mention-scan lane. Off (default) → the legacy split — byte-identical.',
  },
  // ── Multilingual (Tier 4) ───────────────────────────
  {
    key: 'MULTILINGUAL_LANE_ROUTING',
    category: 'pipeline',
    // Resolved into the RetrievalProfile (multilingualLaneRouting) by
    // resolveRetrievalProfile — read per request, never constructor-captured.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Language-agnostic lane classifier: a nearest-centroid classifier over a small in-repo multilingual exemplar set (reusing the shared cosine primitive) AUGMENTS the English-regex answer router for queries it returns null/generic for, so a non-English temporal/enumeration/preference/summary question can still reach its typed lane. Abstain-safe (a low-confidence or ambiguous match declines to the generic path) and only ever ADDS a route where the regex router found none. Resolved into the RetrievalProfile and threaded to the synthesize boundary. Off (default) → the regex router is byte-identical.',
  },
  {
    key: 'MULTILINGUAL_TEMPORAL',
    category: 'pipeline',
    // Read per-call on the ingest path (MentionPersistService.persistFacts via
    // process.env), never constructor-captured — a flip takes effect on the
    // next ingest without restart (re-ingest to backfill).
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Locale-time decomposition for event-time extraction: (1) ar/hi/ko relative-expression recognition (chrono has no parser for those scripts — they otherwise fall to the English parser and silently miss), (2) locale-aware digit parsing (native ٣/५ digits), and (3) the atUtcMidnight day-shift fix — a relative event ("yesterday", "3 days ago") near a UTC day boundary is anchored to the speaker’s LOCAL calendar day via the session timezone (dto.timezone), then stored as language-neutral ISO-8601. An unknown timezone degrades to UTC-day behavior (never rejects the ingest). Off (default) → byte-identical UTC-day chrono behavior.',
  },
  {
    key: 'MULTILINGUAL_CONFLICT',
    category: 'pipeline',
    // Resolved into the RetrievalProfile (multilingualConflict) by
    // resolveRetrievalProfile — read per request, never constructor-captured.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Typed conflict detection: detectEvidenceConflicts compares NORMALIZED TYPED VALUES (numbers/booleans, digit-script- and case-folded, locale number parsing) instead of surface strings, so a cross-lingual numeric/boolean disagreement on a typed slot ("70 kg" vs "75 kg") is caught even on derived rows without a COMPETING status, and cosmetic differences (digit script, case) no longer false-flag. Presentation of already-flagged COMPETING facts only — never the write-side adjudicator; model-based multilingual NLI (semantic string equivalence like "tea" ≡ "чай") is deliberately deferred (needs a model). Resolved into the RetrievalProfile. Off (default) → byte-identical string-equality behavior.',
  },
  // ── Multilingual (Tier 5, migration 0103) ───────────
  {
    key: 'MULTILINGUAL_CALIBRATION',
    category: 'pipeline',
    // Read at fit / load time via fovea-flags.multilingualCalibrationEnabled()
    // (a per-call function body const, never constructor-captured) — a flip
    // takes effect on the next fit/load without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Hierarchical per-language focus calibration: the §4.2 per-class isotonic calibrator (focus-signal.ts) gains a LANGUAGE key with an exact (class × language) → (class × script/family) → (class) → global fallback, fitting a per-language / per-script map only when the bucket clears the same min-sample floor (so a sparse language never earns a noisy calibrator and degrades up the hierarchy). Focus-signal capture stamps the detected query language + script on each sample (migration 0103 optional columns). Serving-neutral — nothing on the answer path reads the calibration yet (Optics-2/3). Off (default) → the language dimension is never written or consulted and the global per-class calibration is byte-identical.',
  },
  {
    key: 'MULTILINGUAL_ANSWER_GUARD',
    category: 'pipeline',
    // Resolved into the RetrievalProfile (answerLangGuard) by
    // resolveRetrievalProfile — read per request, never constructor-captured.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Answer-language guard: the answer-language target follows a strict fallback ORDER — explicit answerLang → user/session locale (dto.queryLang) → confidently-detected query language (Tier 1 confidence floor) → no forced language — so on mixed retrieval the FACTS never decide the answer language. After generation the answer's own language is detected and, on a cross-script mismatch with the target, ONE bounded corrective regeneration runs with a reinforced language directive (temperature already 0); a still-mismatched answer is flagged (metrics) and served best-effort. Resolved into the RetrievalProfile. Off (default) → resolveAnswerLang byte-identical and no output-language check runs.",
  },
  {
    key: 'INGEST_CONFUSABLES_CHECK',
    category: 'pipeline',
    // Read per-call in EntityUpsertService (process.env), never
    // constructor-captured — a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Unicode identifier policy: on an entity-name ingest, compute a curated UTS-39-style confusables skeleton (a small vendored Latin↔Cyrillic↔Greek homoglyph map + zero-width strip — NOT the full UTS-39 table) plus a mixed-script check as a RISK SIGNAL ONLY. A homoglyph/mixed-script name is logged for review; it NEVER auto-blocks and NEVER auto-merges, and the original surface is always preserved. Off (default) → no skeleton computed, no flagging — byte-identical.',
  },
  // ── Embedding space (Tier 2, migration 0101) ────────
  {
    key: 'EMBEDDING_SPACE_TRACKING',
    category: 'embedder',
    // Read at call time inside the reindex engine (spaceStampId), never
    // constructor-captured — a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Stamp `embeddingSpaceId` (canonical `provider:model:dim:norm`, e.g. openai:text-embedding-3-small:1536:l2) on the active reindex rewrite so each row declares which vector space it lives in. Off (default) → the reindex UPDATE is the pre-Tier-2 `SET embedding = $embedding` and the column is never written — byte-identical.',
  },
  {
    key: 'EMBEDDING_SPACE_STRICT',
    category: 'embedder',
    // Read per-call in EmbedderService.serveProvider(), not the constructor.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Strict-space serving guard: when on, EmbedderService refuses (503) to serve a query embedded in a space INCOMPATIBLE (different dim / model / norm) with the primary configured space — the warmup-window failover from bge-m3 (1024) to the OpenAI fallback (1536) is the canonical case — instead of silently cross-space-comparing against the target rows. Off (default) → the existing warmup failover is byte-identical.',
  },
  {
    key: 'EMBEDDING_SPACE_DUAL_WRITE',
    category: 'embedder',
    // Read per-call in EmbeddingSpaceService, not the constructor.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Zero-downtime migration phase 1: arm shadow dual-write so a begun migration keeps the target space warm (new writes produced in BOTH the active and target space) while the reindex backfills history. Off (default) → no target-space write is armed and beginMigration refuses.',
  },
  {
    key: 'EMBEDDING_SPACE_ACTIVE',
    category: 'embedder',
    // Read per-call in EmbeddingSpaceService, not the constructor.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Zero-downtime migration phase 3: per-tenant active-space selection + ATOMIC cutover. When on, reads resolve the tenant’s active space from embedding_space_state and the admin cutover flips it all-or-nothing after reindex. Off (default) → reads use the current provider space and the cutover surface refuses — byte-identical serving.',
  },
  // ── Cost ────────────────────────────────────────────
  {
    key: 'COST_CHAT_PROMPT_USD_PER_MTOK',
    category: 'cost',
    defaultValue: '0.15',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'COST_CHAT_COMPLETION_USD_PER_MTOK',
    category: 'cost',
    defaultValue: '0.6',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'COST_EMBED_USD_PER_MTOK',
    category: 'cost',
    defaultValue: '0.02',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  // ── Throttle ────────────────────────────────────────────
  {
    key: 'THROTTLE_TTL_MS',
    category: 'throttle',
    defaultValue: '60000',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'THROTTLE_LIMIT',
    category: 'throttle',
    defaultValue: '120',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'THROTTLE_EXPENSIVE_TTL_MS',
    category: 'throttle',
    defaultValue: '60000',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'THROTTLE_EXPENSIVE_LIMIT',
    category: 'throttle',
    defaultValue: '10',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  // ── Jobs / trace persistence ────────────────────────
  {
    key: 'JOB_RUN_PERSIST',
    category: 'jobs',
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'DEBUG_TRACE_PERSIST',
    category: 'jobs',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
  },
  {
    key: 'DEBUG_TRACE_DB_CAPACITY',
    category: 'jobs',
    defaultValue: '1000',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  // ── Auth / OpenAI ────────────────────────────────────────
  {
    key: 'JWKS_URL',
    category: 'auth',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'OPENAI_API_KEY',
    category: 'auth',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    secret: true,
  },
  {
    key: 'OPENAI_CHAT_MODEL',
    category: 'auth',
    defaultValue: 'gpt-4o-mini',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'OPENAI_EMBEDDING_MODEL',
    category: 'auth',
    defaultValue: 'text-embedding-3-small',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'OPENAI_TIMEOUT_MS',
    category: 'auth',
    defaultValue: '30000',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'OPENAI_MAX_RETRIES',
    category: 'auth',
    defaultValue: '3',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'OPENAI_CONCURRENCY',
    category: 'auth',
    defaultValue: '6',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  // ── Conflict resolution weights ────────────────────────
  {
    key: 'CONFLICT_WEIGHT_AUTHORITY',
    category: 'conflict',
    defaultValue: '0.1',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'CONFLICT_WEIGHT_CONFIDENCE',
    category: 'conflict',
    defaultValue: '0.3',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'CONFLICT_WEIGHT_RECENCY',
    category: 'conflict',
    defaultValue: '0.2',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'CONFLICT_WEIGHT_SOURCE_TRUST',
    category: 'conflict',
    defaultValue: '0.4',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'CONFLICT_MARGIN_SUPERSEDE',
    category: 'conflict',
    defaultValue: '0.15',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'CONFLICT_REJECT_THRESHOLD',
    category: 'conflict',
    defaultValue: '0.3',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'CONFLICT_SIMILARITY_THRESHOLD',
    category: 'conflict',
    defaultValue: '0.85',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  // ── ABAC (migrations 0056/0057) ──────────────────────────
  {
    key: 'ABAC_ENABLED',
    category: 'auth',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Master switch for attribute-based access control. Off = the policy resolver never runs; keys behave byte-identically to pre-ABAC.',
  },
  {
    key: 'ABAC_FORCE_REPORT_ONLY',
    category: 'auth',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Emergency demote-all: every enforce set behaves report_only (logged, never blocks). Rollback lever for a bad policy.',
  },
  {
    key: 'ABAC_DB_FENCE_ENABLED',
    category: 'auth',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'DB-level PERMISSIONS PII fence (0057). Inert for the system-user pool — the app-layer JS filter is the enforcing gate.',
  },
  {
    key: 'SCOPE_TAGS_ENABLED',
    category: 'auth',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'G6 hierarchical scope-tag fence (migration 0093). When on, the scope-tag visibility evaluator runs as an ADDITIONAL AND-fence alongside the untouched migration-0055 userId filter at every per-user read seam (episode L0 reads, fact search legs, get-fact/provenance) — a row must pass BOTH. Composed with AND it can only narrow, never open, what userId filtering already returns; for current single-tag data (every row scope is [] or [user:<id>]) the two fences keep provably identical row sets, so enabling it changes nothing (the parity property that makes it safe to ship on). Fail-closed: a record scope with an unparseable or unknown-namespace tag is hidden from a scoped principal. Off (default) → the scope column is written by backfill/ingest but never read for filtering; enforcement is byte-identical pre-0093. Steps 3-5 (ABAC widen / share-up staging / revocation tokens) are a follow-up.',
  },
  {
    key: 'PRIVACY_SEGMENT_USER_FENCE',
    category: 'auth',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Per-member user-scope fence for verbatim windows (migration 0117). Mixed-user episode_segment windows fold userId=NONE (tenant-global), so the legacy gate served an A+B window — verbatim text included — to EVERY user-scoped caller in the tenant. When on, all four segment read seams (segment lane transcript + anchors, fused search leg, mention scan) admit a user-scoped caller to a userId-NONE window only when its persisted userIds member set is [] (purely global) or CONTAINS the caller (window membership: co-present verbatim is re-disclosure, not disclosure). Tenant-global (M2M) callers unchanged. WARNING: OFF + any segment-serving mode ON (verbatimEvidence/timelineEvidence/l3SegmentAnchor, e.g. RETRIEVAL_GENRE=dialogue or SEARCH_SEGMENT_LANE_ENABLED) = cross-user verbatim disclosure. FAIL-CLOSED on legacy rows: userIds IS NONE (pre-0117) is hidden from user-scoped callers — run POST /v1/admin/maintenance/segments/backfill-user-ids once per tenant BEFORE the first enable on an existing deployment (order: migrate → backfill → flip). Default off in code for byte-identity only; will default ON in a future release.',
  },
  {
    key: 'PRIVACY_COMPOSER_USER_SCOPE',
    category: 'auth',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'User-scope rule for the write-time insight composers (aggregates, arcs — shared kernel). Composed summary rows were stamped with NO userId, so one user’s personal facts folded into tenant-global summary_*/aggregate_* rows readable by every user. When on, each valid proposal folds its member facts’ distinct userIds (the deriver drop idiom): 0 users → global (unchanged); exactly 1 → row stamped userId + scope (the 0055/0093 read fences then apply); ≥2 → proposal dropped, warned and counted. WARNING: OFF = composer runs keep writing single-user-derived content as tenant-global rows; no backfill exists — re-run the composers after enabling to rebuild the derived set under the rule. Default off in code for byte-identity only; will default ON in a future release.',
  },
  {
    key: 'SOURCE_META_STRICT',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'On = ingest 400s on an invalid source.meta entry instead of dropping it (a silently-dropped data_class would widen access).',
  },
  {
    key: 'POLICY_META_UNION_ENABLED',
    category: 'auth',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Effective-meta union: a corroborated fact inherits its confirming documents’ meta for DENY evaluation (union = most restrictive).',
  },
  // ── Evidence plane (Brain v2.1) ──
  {
    key: 'EVIDENCE_SUBSTRATE_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Master switch for the multimodal evidence substrate writers (evidence_asset / evidence_fragment / derived_representation, migration 0109). Off = EvidenceStoreService refuses every write (503) and no row is ever written; GDPR cascade + retention sweep run regardless so rows written while on stay erasable.',
  },
  {
    key: 'EVIDENCE_FS_ROOT',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Directory root for the fs:// evidence storage adapter (<root>/<companyId>/<hash[0..1]>/<hash>). NO default on purpose — unset means the adapter throws a clear unconfigured error instead of silently accumulating tenant media in an unmanaged path.',
  },
  {
    key: 'EVIDENCE_MAX_BYTES',
    category: 'pipeline',
    defaultValue: '1073741824',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Sanity cap on the DECLARED byteLength of a registered evidence asset (default 1 GiB). A claim bound, not a transfer limit — this release ships no upload endpoint.',
  },
  {
    key: 'EVIDENCE_GROUNDING_STAMP',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, claim-state write side: after fn::resolve_fact returns, stamp knowledge_fact.groundingStatus ('grounded'|'ungrounded') computed from the presence of observational source (episode: ids in source.episodeIds, non-empty source.evidence[], or source.conversationId) — the stampFactScope post-resolve idiom, best-effort, warn-never-fail. Absent field = legacy row (pre-flag), never backfilled. Off (default) → no extra UPDATE is issued, rows are byte-identical.",
  },
  {
    key: 'EVIDENCE_FAIL_CLOSED_CAPTURE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, fail-closed mention capture: ingestMention requires the L0 episode write (EPISODE_SUBSTRATE_ENABLED) to succeed and stamps the captured episode id into every extracted fact's source.episodeIds — no extraction without a stored observation. Requires EPISODE_SUBSTRATE_ENABLED (env-validation warns on the inconsistent pair). Off (default) → capture stays non-fatal advisory, byte-identical.",
  },
  {
    key: 'EVIDENCE_UNGROUNDED_EXCLUDE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, consolidation gate: the promotion runner excludes ungrounded members (knowledge_fact.groundingStatus='ungrounded') from summary groups — an unfounded claim must not consolidate into long-term memory. Legacy rows (absent field) still promote. Off (default) → member selection byte-identical.",
  },
  {
    key: 'EVIDENCE_UNGROUNDED_SERVING_GATE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, strict serving: on a supported verdict, batch-check the cited facts' groundingStatus; when every citation is ungrounded the answer abstains under reason 'ungrounded_evidence' (the evidence_capability_unmet fourth-branch idiom, 0113). Mixed or legacy support serves. Resolution failure fails open with a warn. Off (default) → no fetch, byte-identical.",
  },
  // ── Document pipeline (migrations 0048–0050) ─────────────
  {
    key: 'DOCUMENT_INGEST_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Master switch for POST /v1/ingest/document + the /v1/documents/* surface. Off = every route 503s.',
  },
  {
    key: 'DOCUMENT_MULTI_INDEXER_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Dedicated per-pack indexer runs + relevance router + async fan-out + external work items. Off = only the generalist union pass runs.',
  },
  {
    key: 'PACK_SEED_INGEST_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Ingest a pack’s seedDocuments through the document pipeline on install (pack_seed_ingest job). Requires DOCUMENT_INGEST_ENABLED; when either is off the install response reports a skip — install never fails because of seeds.',
  },
  {
    key: 'INDEXER_EXTERNAL_PENDING_TTL_DAYS',
    category: 'pipeline',
    defaultValue: '7',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'How long an unclaimed external work item (pending external indexer_run, GET /v1/indexer/work) stays pollable before the nightly sweep expires it. Claimed work rides INDEXER_RUN_STALE_MINUTES via heartbeat.',
  },
  {
    key: 'INDEXER_WEBHOOK_PUSH_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Signed work_available webhook hints to external packs declaring indexer.external.callbackUrl. Best-effort (retries + per-URL breaker); polling stays the source of truth.',
  },
  // ── MCP pack tools (migration 0068) ───────────────────────
  {
    key: 'MCP_PACK_TOOLS_ENABLED',
    category: 'misc',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Master switch for pack-declared MCP tools (installed packs with a consented mcpTools section). Off = the MCP surface is exactly the static tool families.',
  },
  {
    key: 'MCP_PACK_QUERY_TOOLS_ENABLED',
    category: 'misc',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Declarative query tools (search / facts_by_predicate over the pack’s own predicates). Default ON under the master flag; only reachable when MCP_PACK_TOOLS_ENABLED=1.',
  },
  {
    key: 'MCP_PACK_EXTERNAL_TOOLS_ENABLED',
    category: 'misc',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'HMAC-signed HTTPS proxy tools to publisher endpoints (opaque installId on the wire, never companyId). Off = external tool specs are ignored even when consented.',
  },
  {
    key: 'MCP_PACK_TOOLS_ALLOW_HTTP',
    category: 'misc',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Dev/test ONLY: permit plain-http + loopback/private external tool endpoints (disables the SSRF egress guard). Never enable in production.',
  },
  {
    key: 'MCP_PACK_TOOLS_CACHE_TTL_MS',
    category: 'misc',
    defaultValue: '30000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'TTL of the per-tenant pack-tool binding cache on the MCP hot path. Install/uninstall invalidate immediately; the TTL covers out-of-band domain_pack edits.',
  },
  // ── Search: retrieval-evolution stages (migrations 0052–0055) ──
  {
    key: 'SEARCH_HNSW_ENABLED',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Switch the KNN vector leg on. Tenants without a built index fall back to the full scan; build via POST /v1/admin/maintenance/hnsw.',
  },
  {
    key: 'SEARCH_USAGE_RECORDING_ENABLED',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description: 'Record lastReadAt on retrieved facts (feeds recency decay).',
  },
  {
    key: 'SEARCH_USAGE_DECAY_ENABLED',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Count recency decay from lastReadAt, not only recordedAt (needs recording on for data). Legacy self-reinforcing signal — retrieval alone restarts the decay clock; prefer RETRIEVAL_VERIFIED_USE_DECAY (see 0107).',
  },
  {
    key: 'SEARCH_USAGE_RANKING_ENABLED',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'G8 trace-derived ranking (Spectron "eight signals"): fold fact_usage.readCount into ranking as a bounded, saturating multiplier (× (1 + SEARCH_USAGE_BETA·squash(readCount))). ORDERING DEPENDENCY: enable SEARCH_USAGE_RECORDING_ENABLED first, or readCount never accrues and the signal is inert. Also needs SEARCH_USAGE_BETA > 0 (default 0 = no effect even when on). Legacy self-reinforcing signal — readCount grows on every surfacing; prefer RETRIEVAL_VERIFIED_USE_RANKING (see 0107).',
  },
  {
    key: 'RETRIEVAL_VERIFIED_USE_DECAY',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Verified-use successor decay (profile field verifiedUseDecay; 0107 outcome telemetry, Brain v2 gap #7): attach memory_outcome_stat.lastVerifiedUseAt to fused candidates so the decay clock restarts at the last VERIFIED use (verifier-supported / user-confirmed) — not at mere retrieval. With SEARCH_USAGE_DECAY_ENABLED off and this on, surfacing a fact never extends its life; both on = max of both anchors. Needs OUTCOME_TELEMETRY_ENABLED writers to have accrued stats. Default off = byte-identical.',
  },
  {
    key: 'RETRIEVAL_VERIFIED_USE_RANKING',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Verified-use successor ranking (profile field verifiedUseRanking; 0107): attach verifiedUseScore (memory_outcome_stat verifiedUseCount + confirmedCount) and fold it into ranking as a bounded saturating multiplier (× (1 + SEARCH_VERIFIED_USE_BETA·squash(score))) — the G8 shape over a VERIFIED signal instead of the self-reinforcing readCount. Needs SEARCH_VERIFIED_USE_BETA > 0 and OUTCOME_TELEMETRY_ENABLED writers for data. Default off = byte-identical.',
  },
  {
    key: 'RETRIEVAL_TENANT_DECAY',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Tenant-aware read-time decay (profile field tenantDecayPolicy): scoring resolves decay half-lives through the per-tenant knowledge_predicate registry lookup already warmed for the row fence (zero extra IO) instead of the legacy code-seed policyFor — an operator-set decayHalfLifeDays on a tenant predicate actually shapes read-time decay. Registry absent / predicate miss falls back to the seed / 60-day default = legacy-identical. Default off = byte-identical.',
  },
  {
    key: 'SEARCH_VERIFIED_USE_BETA',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Strength of the verified-use ranking factor: factor = 1 + β·squash(verifiedUseScore), same multiplicative shape as SEARCH_USAGE_BETA. 0 (default) = off (factor 1.0, byte-identical ranking). Only takes effect with RETRIEVAL_VERIFIED_USE_RANKING on and outcome telemetry having accrued verified events. Start small, e.g. 0.1.',
  },
  {
    key: 'SEARCH_VERIFIED_USE_SATURATION',
    category: 'search',
    defaultValue: '10',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'verifiedUseScore at which the verified-use squash saturates (~1.0), so the boost ceiling is 1 + SEARCH_VERIFIED_USE_BETA. log1p-shaped. Positive integer; default 10 — verified outcomes are far rarer than raw reads, so the knee sits lower than SEARCH_USAGE_SATURATION.',
  },
  {
    key: 'SEARCH_USAGE_BETA',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Strength of the G8 usage ranking factor: usageFactor = 1 + β·squash(readCount), same multiplicative shape as SEARCH_TRUST_BETA. 0 (default) = off (factor 1.0, byte-identical ranking). Only takes effect with SEARCH_USAGE_RANKING_ENABLED on and recording having accrued reads. Start small, e.g. 0.1.',
  },
  {
    key: 'SEARCH_USAGE_SATURATION',
    category: 'search',
    defaultValue: '20',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'readCount at which the G8 usage squash saturates (~1.0), so the boost ceiling is 1 + SEARCH_USAGE_BETA. log1p-shaped: early reads move the factor most, a hot fact never dominates. Positive integer; default 20.',
  },
  {
    key: 'SEARCH_EDGE_EXPANSION_TOP_SEEDS',
    category: 'search',
    defaultValue: '3',
    runtimeMutable: true,
    isBooleanFlag: false,
    description: 'How many top-ranked seeds edge-expansion walks from.',
  },
  {
    key: 'SEARCH_EDGE_EXPANSION_MAX_NEIGHBOURS',
    category: 'search',
    defaultValue: '5',
    runtimeMutable: true,
    isBooleanFlag: false,
    description: 'Max neighbours pulled per seed during edge-expansion.',
  },
  {
    key: 'SEARCH_EDGE_EXPANSION_ALPHA',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Inherited-score multiplier for an edge-expanded neighbour; 0 (the default since 2026-08-15) disables edge expansion entirely — the LoCoMo dev-5 ablation on the one edge-bearing eval world measured NULL (ON 75.3 vs OFF 74.8, n=762 paired McNemar, p=0.61, inside the same-config replication noise floor), so the default search path stops paying two graph round-trips. Set 0.4 (the historical value; keep ≤0.4 so a neighbour never outranks its seed) to re-enable per tenant.',
  },
  {
    key: 'SEARCH_CHATTER_PENALTY',
    category: 'search',
    defaultValue: '1.0',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Sub-1.0 ranking multiplier on low-value "said" chatter facts so substantive facts of the same entity are not buried. 1.0 = off; a demotion needs a value in (0,1), e.g. 0.35.',
  },
  {
    key: 'SEARCH_FACT_CENTRIC_BUDGET',
    category: 'search',
    defaultValue: '48',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Global fact budget for fact-centric selection — total facts kept across all entities (also the per-entity render cap). Default-profile input (RetrievalProfile.factBudget); per-tenant override via RETRIEVAL_PROFILE_OVERRIDES.',
  },
  // ── Retrieval profile (per-tenant genre configuration) ────────
  {
    key: 'RETRIEVAL_GENRE',
    category: 'pipeline',
    defaultValue: 'assistant_chat',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Default-profile genre tag: dialogue | assistant_chat | documents. Each genre carries a PRESET of tuned defaults for the measured levers (src/search/genre-presets.ts — e.g. dialogue: verbatim 'always' + date anchoring 'none'; assistant_chat: scene traces + verifier abstention; documents: none — unmeasured axis). A preset value applies only where the corresponding env key is unset: explicit env key > genre preset > code default, and a per-company overlay field (RETRIEVAL_PROFILE_OVERRIDES) beats all three; an overlay that changes genre re-derives that genre's preset-backed base first.",
  },
  {
    key: 'RETRIEVAL_VERBATIM_EVIDENCE',
    category: 'pipeline',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'How verbatim L0 evidence reaches answers: off | shape_conditioned (engine default — quotes only when the question asks for conversational content) | always (all three verbatim lanes unconditional as a prompt appendix; diary-genre profile) | fused (segments become scored, reranked, citable SearchHits inside the search pipeline instead of an appendix) | routed (per-query dispatch: verbatim-shaped questions — the one class where fused measured positive, SSA +7.1pp vs SSU −10.0/TR −8.3 — take the fused path, everything else stays shape_conditioned). Unset → derived from the legacy lane flags.',
  },
  {
    key: 'RETRIEVAL_DATE_ANCHORING',
    category: 'pipeline',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'How the generator\'s "today" anchors: none (session-date-convention golds) | session_date (only when the caller sends asOf) | absolute (asOf, else wall clock — the engine default). Unset → derived from SYNTHESIZE_DATE_CONTEXT.',
  },
  {
    key: 'RETRIEVAL_ENTITY_EXPANSION',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Entity-expansion second retrieval (profile field entityExpansion): after the first legs+fusion pass, the top discovered entity names the query never mentioned anchor one more legs+fusion pass before scoring — the SmartSearch multi-session lever. Costs one extra embedding + two leg queries per search. Default off; enable per genre after measuring.',
  },
  {
    key: 'RETRIEVAL_TEMPORAL_MODE',
    category: 'pipeline',
    defaultValue: 'filter',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'How an explicit asOf shapes retrieval: filter (bitemporal closure excludes facts not valid at asOf — strict point-in-time, the default) | overlap_boost (validity closure relaxed; facts outside the interval survive with an exponential distance decay on their score — soft recall, a slightly-wrong asOf degrades instead of emptying results).',
  },
  {
    key: 'RETRIEVAL_INSIGHT_EVIDENCE',
    category: 'pipeline',
    defaultValue: 'off',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "How derived insight rows — aspect aggregates (source.recorder='aggregate-composer-v1') and promotion/compaction summaries (predicate summary_*) — reach answers: off (they ride the fact legs as ordinary rows — pre-V8 behavior; the naive always-on composition measured MS tie / BEAM −2.0pp with summarization down, because aggregates displace atomic facts inside the fact budget) | routed (fact legs exclude insight rows; summarization/progressive-narrative/enumeration questions retrieve them as their own dense+BM25 convex-fused pool under a separate prompt slot — INSIGHT_TOP_K, not factBudget; pointwise asks skip the slot) | query_arc (V10 §4: same dispatch and slot, but the section is ASSEMBLED at read time — the topic phrase extracted from the question scans the atomic fact record dense+BM25 coverage-first, the most topical beats emit as one chronological dated record; write-time arcs measured null-to-negative in v9arcs because stored topics are decided blind to the questions and only fact-dense entities clear the composer floor. Fact legs exclude stored insight rows exactly as under routed).",
  },
  {
    key: 'RETRIEVAL_SALIENCE_SCORING',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'V8 §4 importance scoring (profile field salienceScoring): fold the deriver-stamped source.salience (0-3, written under DERIVER_SALIENCE_STAMP) into ranking as a multiplicative factor — weights [0.8, 1.0, 1.1, 1.25] per grade. Rows without a stamp (legacy worlds, live ingest, segments) sit on the neutral grade 1 and are unaffected; off → byte-identical ranking. Enable only against a salience-stamped derived world.',
  },
  {
    key: 'RETRIEVAL_TIMELINE_EVIDENCE',
    category: 'pipeline',
    defaultValue: 'off',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Timeline evidence for mention-order questions: off (pre-V8 — the appendix segment lane runs only under verbatimEvidence='always') | routed (ordering/sequence-shaped questions — the order-lexicon — also get the chronological segment appendix: the mention record in occurredAt order. Event-time extraction collapses a session's mentions onto one validFrom date, so mention order is unrecoverable from facts alone — the measured BEAM event_ordering failure. Skipped when the query's resolved verbatim mode is fused, to avoid duplicating segments already arriving as hits) | scan (V9 §2: the mention record is built by the topic-scan lane instead of the top-K appendix — topic phrase extracted from the question, segment record scanned per session with BM25+embedding against the TOPIC, one dated line per session-mention in occurredAt order; coverage bounded by session count, not top-K — the V8 diagnosis was coverage, not order).",
  },
  {
    key: 'RETRIEVAL_COVERAGE_SCAN_MODE',
    category: 'pipeline',
    defaultValue: 'brute',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Dense-leg execution mode of the two coverage-first scan lanes — mention-scan over episode_segment (timelineEvidence='scan') and query_arc over knowledge_fact (insightEvidence='query_arc'): brute (exact filtered top-k via a full-table cosine ORDER BY — correct at eval scale by design, the default; identical legacy semantics) | hnsw (approximate KNN <|k,ef|> against the per-tenant HNSW indexes — segment_embedding_hnsw / fact_embedding_hnsw, built via POST /v1/admin/maintenance/hnsw — with overfetch compensating SurrealDB's post-KNN WHERE filtering; falls back to the brute scan on error OR an empty post-filter pool, so tenants without the indexes behave identically). The V11 scale gate: promotion of the scan lanes to default-on for large tenants goes through this leg plus the parity check (scripts/scan-hnsw-parity.ts, recall ≥ 0.98) first.",
  },
  {
    key: 'RETRIEVAL_COVERAGE_LEX_MODE',
    category: 'pipeline',
    defaultValue: 'phrase',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Lexical-leg (BM25) query shape of the two coverage-first scan lanes — mention-scan over episode_segment and query_arc over knowledge_fact: phrase (one matcher per indexed field fed the whole extracted topic phrase — the legacy default; the matches operator @N@ is AND-semantics over analyzed tokens on SurrealDB 3.x, so a 2-5 token topic must appear IN FULL and the lexical leg rarely fires, leaving the hybrid pool dense-driven — the V11 audit A2 finding) | or_terms (per-term matchers over the stripped topic terms OR-ed with unique match refs, bounded at 8 terms; a row mentioning ANY topic word is a lexical hit, scored as the sum over terms of the best per-field BM25 so multi-term rows rank higher). Also overlayable per tenant via RETRIEVAL_PROFILE_OVERRIDES (coverageLexMode). Measured-behavior change: flip after the eval pair, not by default.',
  },
  {
    key: 'RETRIEVAL_VERIFIER_MODEL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Model override for the verifier/auditor LLM call only — the generator keeps the synthesis model. Empty (default) = the verifier inherits the synthesis model, byte-identical legacy behavior. The V11 §2 strong-judge arm: under abstentionCalibration='verifier' the abstention decision quality is bounded by the audit model's judgment, so a tenant can pay for a stronger judge (e.g. gpt-5-mini) on exactly one call per answer without touching generation cost. Also overlayable per tenant via RETRIEVAL_PROFILE_OVERRIDES (verifierModel).",
  },
  {
    key: 'RETRIEVAL_SCAN_HNSW_EF',
    category: 'pipeline',
    defaultValue: '400',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'HNSW ef (candidate list size) for the coverage scan legs under RETRIEVAL_COVERAGE_SCAN_MODE=hnsw. Clamped up to the overfetched k at query time — ef below k is never useful in HNSW — so the default only matters if raised ABOVE the overfetched k for extra recall at latency cost.',
  },
  {
    key: 'RETRIEVAL_SCAN_HNSW_OVERFETCH',
    category: 'pipeline',
    defaultValue: '4',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Overfetch multiplier for the coverage scan legs' approximate KNN: SurrealDB applies WHERE gates AFTER the neighbor walk, so the walk requests k×overfetch candidates to survive gate filtering (pii/user scope on both lanes; the query_arc lane doubles the multiplier internally for its heavier gate stack — atomic/status/world gates — matching the ×8 precedent of INGEST_INLINE_RESOLUTION_HNSW_OVERFETCH). Capped at 4000 candidates per leg.",
  },
  {
    key: 'RETRIEVAL_UPDATE_STORY',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "V10 §2 update-story rendering (profile field updateStoryRendering): evidence facts that superseded an older value get a compact history suffix on their prompt line — '[previously: <value> — until <date>]' — built from the reverse supersededBy links (indexed since 0059; ≤3 chain generations, ≤3 entries per line). Restores the update STORY that knowledge_update golds ask for WITHOUT re-including superseded rows in retrieval — the v9lifecycle diagnosis: the bitemporal closure hid the old value at asOf and made the row worse. Prompt-side only: retrieval, ranking and citations untouched; the generator and the verifier read the same augmented lines. Off = byte-identical prompt.",
  },
  {
    key: 'RETRIEVAL_ORDERING_FRAME',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "V10 §3 ordering frame (profile field orderingFrame): when the mention record fired for an ordering-shaped question (timelineEvidence resolved active), the generator gets a dedicated order-of-mention frame — short aspect labels in the record's order, honor the requested N, collapse repeated aspects — INSTEAD of the enumeration frame, whose 'enumerate every matching item with its date' fights both the exact-N constraint and aspect granularity (the measured v9scan null: 40/40 EO predictions changed, score didn't). Also collapses near-duplicate aspect mentions inside the mention record itself (containment ≥0.7 on informative tokens, earliest line kept). Off = byte-identical prompt and record.",
  },
  {
    key: 'RETRIEVAL_ABSTENTION_CALIBRATION',
    category: 'pipeline',
    defaultValue: 'off',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "V9 §4 memory-coverage abstention (profile field abstentionCalibration): off (abstention decided solely by the generator's judgment — pre-V9) | coverage (in strict/lenient guardrails, evidence must clear the coverage floor — best fact score ≥ RETRIEVAL_ABSTENTION_MIN_SCORE and fact count ≥ RETRIEVAL_ABSTENTION_MIN_EVIDENCE — before generation; below it synthesize returns an explicit not-in-my-memory answer with reason low_coverage. Calibration finding: retrieval-level floors cannot detect ANSWER-absence on topically-adjacent questions — useful only for genuinely off-topic queries) | verifier (answer-level coverage: in lenient guardrails an unsupported/partial verifier verdict returns the explicit not-in-my-memory decline instead of ungrounded text; zero extra cost — the verifier already runs there) | minicheck (V11 §2 arm b: the same lenient answer-level gate, but the consistency judgment comes from a LOCAL Bespoke-MiniCheck NLI over Ollama — MINICHECK_URL / MINICHECK_MODEL — replacing the LLM verifier call on this path; zero marginal API cost). 'answer' guardrails are always exempt: that mode is a caller-level never-abstain contract.",
  },
  {
    key: 'RETRIEVAL_DIGEST_EVIDENCE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "V12 §2 read side (profile field digestEvidence): surface the rolling conversation digests (conversation_digest, written under DERIVER_DIGEST) into the prompt's insight slot — merged AHEAD of retrieved insight lines under the same budget, so the generator, the verifier and the NLI judge all see the dated narrative arc (evidence parity by construction). Newest 4 digests by lastEventAt, derived-world pin respected. Off = byte-identical; empty against worlds derived without DERIVER_DIGEST. Digests are tenant-global derived state — the per-user/PII policy story is the V11 brief item 10 prerequisite before any default-on.",
  },
  {
    key: 'DERIVER_DATE_RESOLVE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'V12 §3 event-dating rules for the session deriver (the graphiti anti-collapse port): occurred_on must date the EVENT, never the conversation — relative expressions resolve by calendar arithmetic from the session date, the session date is only valid for same-day events, month/year-only knowledge resolves to the period start, and a genuinely undeterminable date stays null instead of defaulting. Targets the measured off-by-days answer class (validFrom = session-date collapse). Prompt change: confirms only on a FRESH derivedVersion; off = byte-identical prompt.',
  },
  {
    key: 'DERIVER_DATE_AUDIT',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'V13 date audit: a dedicated after-emission turn re-derives occurred_on for every proposition against the transcript + session date (resolve relative time by calendar arithmetic; session date only for same-day events; explicit null clears fabricated defaults). The post-pass shape of the failed in-prompt rules — DERIVER_DATE_RESOLVE measured a byte-equal date distribution and a null pair (armH), while salience succeeded only as a post-pass after ITS in-prompt version failed. One extra deriver-model call per session; failure degrades to un-audited dates. Fresh derivedVersion required.',
  },
  {
    key: 'DERIVER_ASPECT_ROLLUPS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "V13 A2 aspect rollups (July program §6.3 item 4, the MIRIX-shaped write-time composition): after a conversation derives, this run's landed rows group per (entity, aspect) and ≥3-member groups compose into one chronological list-fact written as predicate '<aspect>_rollup' (never competing in member slots; provenance rollup:true + memberCount; validFrom = newest member; 2400-char cap keeps the chronological prefix and states the cut). Mechanical and LLM-free — deterministic under re-derive; no extra LLM calls (one embeddings batch + one resolver round-trip per conversation). Targets the measured largest miss bucket: MH-enumeration golds where every item exists atomically but no atom holds the list. Fresh derivedVersion required.",
  },
  {
    key: 'RETRIEVAL_MENTION_DATES',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'V12 §1 read side (profile field mentionDates): append "(mentioned YYYY-MM-DD)" to fact lines whose DERIVER_MENTION_STAMP anchor (source.mentionedAt) disagrees with validFrom by calendar day — the generator sees when a fact was said next to when it claims to hold, instead of only the (possibly collapsed) validity date. Generator and verifier read the same lines, so evidence parity is free. Unstamped facts and same-day anchors render nothing; against worlds derived without the stamp the flag is byte-identical off.',
  },
  {
    key: 'RETRIEVAL_ENUM_STRICT',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      '§8 item 3 over-enumeration contract (profile field enumStrict): appends a scope-discipline clause to the enumeration lane frame — include ONLY items the facts tie to the asked scope (person, activity kind, time window); an unsupported extra is as wrong as a missing item. The measured judge-sink class is the gold list plus thematically adjacent extras. Off = the historical exhaustive-only frame, byte-identical.',
  },
  {
    key: 'DERIVER_TURN_HEADERS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "V13 structural event-time grounding (the graphiti reference_time prompt shape; research brief memory-research-2026-08.md Tier 1.2): the deriver transcript renders per-turn timestamp headers — `[N] (YYYY-MM-DD HH:MM) speaker: text` — instead of bare `[N] speaker: text` under one session-date line, plus a system section resolving occurred_on against the TURN's own timestamp. The session-date fallback for undated events is kept verbatim (armK: stripping it measured −4.9 — session-date defaults are the benchmark answer convention). turns[] already carries episode indices, so mention stamping is unchanged. Prompt change ⇒ fresh derivedVersion; off = byte-identical prompt.",
  },
  {
    key: 'DERIVER_COMPOSE_PASS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'V13 cross-session composition (the PREMem write-time shape, EMNLP 2025 Findings 2509.10852; on-genre ablation +3-7pp with gains concentrated on multi-hop): after a conversation derives, ONE extra LLM call over its landed atoms emits multi-atom compositions — accumulations (complete cross-session lists), transformations with both dates, specifications, explicitly-supported connections — written as ordinary derived rows with source.composed=true, provenance = union of member grounding turns, validFrom = occurred_on else newest member. Targets the measured largest multi-hop miss class ("every atom exists, no atom states the combination") where the mechanical rollup (armL) measured negative. Member indices are validated against the atom pool — a hallucinated member list cannot invent provenance. Landed count reported separately (result.composed) for volume-parity gates. Fresh derivedVersion required.',
  },
  {
    key: 'DERIVER_SCENE_TRACE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "V13 dual-trace encoding (arXiv 2604.12948 port; their controlled pair: +20.2pp LongMemEval-S, temporal +40pp, knowledge-update +25pp): every derived proposition also carries `scene` — one clause of the concrete situation it was learned in — stamped as source.scene (FLEXIBLE ride, 200-char cap) and folded into the row's EMBEDDING text (fact + scene is the index entry; the stored object stays the bare proposition). Encoding specificity is the mechanism: situational questions find facts whose bare text never matches them. Read-side rendering separately gated (RETRIEVAL_SCENE_TRACES). Schema + prompt change ⇒ fresh derivedVersion; off = byte-identical call.",
  },
  {
    key: 'RETRIEVAL_SCENE_TRACES',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'V13 read side of DERIVER_SCENE_TRACE (profile field sceneTraces): fact lines carry a "(context: …)" suffix from the stamped source.scene, so the generator and verifier see the situational anchor next to the proposition. Unstamped rows render as before; against worlds derived without the stamp the flag is byte-identical off.',
  },
  {
    key: 'DERIVER_TYPED_ATOMS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Multiworld §10 typed single-pass derive: the ONE extraction pass also tags every proposition with kind ∈ {fact, assistant_contribution, persona_attr, event} (schema enum + prompt section; the assistant_contribution rules subsume DERIVER_ASSISTANT_CONTENT), stamped as source.kind (FLEXIBLE ride, no migration; off-enum values dropped). Worlds become TYPED LANES over one atom stream — the ablation-grade multi-view pattern (Hindsight/MemIR/O-Mem), never N× derive. Prompt + schema change ⇒ fresh derivedVersion; off = byte-identical call.',
  },
  {
    key: 'DERIVER_SPANS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'G3 char-span provenance (sota-gap-build-2026-08): the deriver also emits per-grounding-turn verbatim `quotes` (parallel to `turns`; schema + prompt section — the LLM cannot emit reliable offsets, so it quotes and the server anchors). The row builder verifies each quote mechanically against the STORED (PII-redacted) episode text and stamps W3C-annotation-style spans {episodeId, start, end, exact, prefix, suffix} — offsets in Unicode code points over NFC — as source.charSpans (FLEXIBLE ride, no migration). Unverifiable/ambiguous quotes drop silently; the fact always lands. Read side: GET /v1/facts/:id/provenance attaches span {start, end, exact} + textTruncated per grounding episode (offsets reference the FULL stored text, not the 600-char capped view). Prompt + schema change ⇒ fresh derivedVersion; off = byte-identical call.',
  },
  {
    key: 'RETRIEVAL_RAW_WINDOW',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "V13 hybrid substrate read side (profile field rawWindow; the MemMachine contextualized-matching shape — facts as index, raw turns as content; controlled ablation: fact-only substrates lose −22pp): the top fact hits' grounding turns (source.episodeIds) expand into a bounded window of surrounding raw turns — RETRIEVAL_RAW_WINDOW_SPAN neighbors each side, chronological, deduped — rendered as transcript evidence. Generator and verifier see the same lines (evidence parity). Off = byte-identical; empty against worlds without episode substrate.",
  },
  {
    key: 'RETRIEVAL_RAW_WINDOW_SPAN',
    category: 'pipeline',
    defaultValue: '2',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Half-span of the raw-turn window (neighbors each side of a grounding turn) under RETRIEVAL_RAW_WINDOW. Only read on that path.',
  },
  {
    key: 'RETRIEVAL_ASSISTANT_LANE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Multiworld §10 assistant verbatim lane (profile field assistantLane): BM25 over the L0 episode substrate restricted to turns SPOKEN BY the assistant role (case-insensitive speaker suffix, RETRIEVAL_ASSISTANT_LANE_MATCH), rendered as transcript quotes. The SSA miss class is structural — assistant contributions are never extracted into facts, so fact-anchored lanes (source excerpts, raw windows: 32.1 vs 42.9 base on SSA) cannot reach the gold turn; this lane reaches it by ROLE, no facts involved. Off = byte-identical; empty for corpora without an assistant-role speaker (e.g. LoCoMo personas).',
  },
  {
    key: 'RETRIEVAL_ASSISTANT_LANE_TOPK',
    category: 'pipeline',
    defaultValue: '6',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Assistant-turn quotes per prompt under RETRIEVAL_ASSISTANT_LANE. Only read on that path.',
  },
  {
    key: 'RETRIEVAL_ASSISTANT_LANE_MATCH',
    category: 'pipeline',
    defaultValue: 'assistant',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Case-insensitive speaker SUFFIX identifying the assistant role under RETRIEVAL_ASSISTANT_LANE (suffix because eval-harness speakers are '<convSlug>__<role>' while production tenants stamp bare role names). Malformed values fall back to 'assistant'.",
  },
  {
    key: 'RETRIEVAL_FACTS_AS_KEYS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Multiworld §10 facts-as-keys (profile field factsAsKeys; the LongMemEval design-study shape — facts as additional index KEYS +9.4% recall, facts as replacement VALUES hurt): each top evidence fact line carries ONE verbatim quote of its first grounding turn (" [source YYYY-MM-DD speaker: …]", 240-char cap) — the fact acts as the key, the raw turn is the served content. Generator and verifier read the same augmented lines (evidence parity). Off = byte-identical.',
  },
  {
    key: 'RETRIEVAL_FACTS_AS_KEYS_CAP',
    category: 'pipeline',
    defaultValue: '8',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Top evidence facts that carry a grounding quote under RETRIEVAL_FACTS_AS_KEYS. Only read on that path.',
  },
  {
    key: 'RETRIEVAL_TIME_FILTER',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'V13 time-constrained retrieval (profile field timeFilter; the TSM shape — temporal filter/rerank over event-time-stamped facts, their ablation: −6pp temporal when removed): when the query names an absolute period (an explicit day, month, year or between-range — code-parsed, no LLM call), facts whose validity/mention anchors overlap the period rank above out-of-period facts at equal fused score. Rank-only multiplicative demotion (floor 0.25, the overlap_boost idiom) — nothing is dropped, raw/episodic evidence untouched. No parseable period in the query = byte-identical ranking.',
  },
  {
    key: 'RETRIEVAL_DATE_MATH',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "V13 deterministic date arithmetic (profile field dateMath; PRIMETIME: mini-class models measure 14-40% on raw date offsets with errors >100 days): a computed date table renders after the fact block — each distinct evidence date with its weekday and the gap to the previous dated line (event-to-event deltas). The measured anti-pattern '[elapsed: N days before today]' (distance-to-today frame, LME temporal diagnosis) is NOT reintroduced — deltas are between evidence dates only. Generator and verifier see the same block. Off = byte-identical.",
  },
  {
    key: 'RETRIEVAL_ANSWER_CONDITIONING',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'V13 G2 per-shape answer conditioning (profile field answerConditioning; the discriminator §10 gold-in-window 22% class, ceiling ≈ +4.9pp; Penfield prompt-alone evidence +10.7): a question-shape instruction selected by code-side detectors — chained evidence-first reasoning for why/how/connection shapes, exhaustive facet coverage for aggregation shapes, exact-token verbatim for quote shapes. Composes with (does not replace) the lane frames; armG covered only the date slice of this and measured null. Off = byte-identical prompt.',
  },
  {
    key: 'RETRIEVAL_DIGEST_LANES',
    category: 'pipeline',
    defaultValue: 'all',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "V13 digest gate-shaping (profile field digestLanes): which routed lanes the conversation-digest lines render into under RETRIEVAL_DIGEST_EVIDENCE. 'all' = the V12 behavior (every prompt — measured +5.0 strict BEAM but abstention −7.5 and summarization-nugget −1.9 from bleed). 'summary_ku' = only summary- and recency-routed questions (the lanes that took the strict gains). Unrouted questions render no digest under 'summary_ku'.",
  },
  {
    key: 'RETRIEVAL_NOISE_FILTER',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'V13 noise filter (profile field noiseFilter; the unported LIGHT component 4, their ablation: −2.2% at 100K / −8.3% at 10M when removed): injected context lines — transcript excerpts, insight lines, digest lines — are scored against the query by the LOCAL cross-encoder and lines far below the top score are dropped before prompt assembly. The fact block is never filtered; the top lines always survive; cross-encoder disabled = filter inert. Off = byte-identical.',
  },
  {
    key: 'RETRIEVAL_SEARCH_LOOP',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "V13 constrained search loop (profile field searchLoop; the MemMachine/Letta multiple-memory-searches shape — NOT the rejected free agent loop, which measured −4.6 as E11): the generator may return a structured refine request ({refineQuery}) instead of an answer when the evidence does not answer the question; the engine runs ONE extra retrieval with the refined query, merges it through the evidence union, rebuilds the prompt and forces an answer (the refine affordance is absent from the second call's schema — a hard one-round cap). Off = byte-identical single-shot generation.",
  },
  {
    key: 'RETRIEVAL_L3_ESCALATION',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'G2 confidence-gated L3 escalation (profile field l3Escalation; sota-gap-build-2026-08 — Self-Route/Self-RAG shape): when the fact-grounded answer fails the verifier (unsupported/partial) or fires abstain-intent AND retrieval coverage is below floor AND (a search-loop refine already ran OR searchLoop is off) AND at least one retrieved fact names a session, the engine escalates UP to ONE full-raw-session large-context generation (top RETRIEVAL_L3_MAX_SESSIONS sessions by fact-hit density, PII/user-fenced), re-runs the SAME verifier, and returns the L3 answer only if the verifier now passes — else it falls through to the normal abstention path. Monotone single-shot ladder (each tier entered at most once, no re-entry); the anchor requirement stops empty-memory queries burning full-context calls. brain_l3_escalation_total{outcome} traces it; the flip rate is the canary. Off = byte-identical (the fact-only verdict stands).',
  },
  {
    key: 'RETRIEVAL_L3_MAX_SESSIONS',
    category: 'pipeline',
    defaultValue: '3',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Max full sessions lifted into the L3 large-context prompt under RETRIEVAL_L3_ESCALATION (top-N conversations by fact-hit density; temporal-class questions prefer sessions overlapping the query date window). Only read on that path.',
  },
  {
    key: 'RETRIEVAL_L3_TOKEN_CAP',
    category: 'pipeline',
    defaultValue: '60000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Token cap for the assembled L3 large-context prompt under RETRIEVAL_L3_ESCALATION (estimated from assembled length). Over the cap the lane degrades to widened L2 raw-turn windows around the anchor turns rather than truncating a session mid-way (metric outcome over_budget_degraded). Only read on that path.',
  },
  {
    key: 'RETRIEVAL_L3_DIRECT_ANCHOR',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'L3 anchor independence (profile field l3DirectAnchor): auxiliary anchor source consulted ONLY when zero retrieved facts name a session (the skipped_no_anchor residual — L3 is most needed exactly where extraction missed the info, which is when no fact anchor exists). BM25 episode hits on the query text (PII/user-fenced, top 20) anchor their conversations; the merged aux anchors then feed the UNCHANGED ranking/caps/ladder. skipped_no_anchor then means "every enabled anchor source came up empty". brain_l3_anchor_source_total{source} traces which source fed each fired escalation. Off (with the sibling aux flags off) = byte-identical skipped_no_anchor.',
  },
  {
    key: 'RETRIEVAL_L3_SEGMENT_ANCHOR',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'L3 anchor independence (profile field l3SegmentAnchor): auxiliary anchor source consulted ONLY when zero retrieved facts name a session. Dense+BM25 RRF-fused episode_segment hits (top 12, NO rerank — anchors need recall, not precision) anchor their conversations; merged anchors feed the unchanged L3 ranking/caps/ladder. Degrades to no contribution on any failure. Off = this source contributes nothing.',
  },
  {
    key: 'RETRIEVAL_L3_TEMPORAL_ANCHOR',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'L3 anchor independence (profile field l3TemporalAnchor): auxiliary anchor source consulted ONLY when zero retrieved facts name a session. When the query names an absolute period (code-parsed, the RETRIEVAL_TIME_FILTER parser — no LLM), the conversations active in that period (top 10 by turn count, PII/user-fenced GROUP BY) anchor, scored by turn count. A query with no parseable period contributes nothing. Off = this source contributes nothing.',
  },
  {
    key: 'MINICHECK_URL',
    category: 'pipeline',
    defaultValue: 'http://127.0.0.1:11434',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Ollama base URL for the local Bespoke-MiniCheck NLI used by RETRIEVAL_ABSTENTION_CALIBRATION=minicheck. Only read on that path — no other mode touches it.',
  },
  {
    key: 'MINICHECK_MODEL',
    category: 'pipeline',
    defaultValue: 'bespoke-minicheck',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Ollama model tag for the minicheck abstention judge (`ollama pull bespoke-minicheck`, ~4.7GB, SOTA on the LLM-AggreFact grounded-factuality leaderboard). Only read under RETRIEVAL_ABSTENTION_CALIBRATION=minicheck.',
  },
  {
    key: 'RETRIEVAL_ABSTENTION_MIN_SCORE',
    category: 'pipeline',
    defaultValue: '0.35',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Coverage floor for RETRIEVAL_ABSTENTION_CALIBRATION=coverage: minimum best per-fact ranking score (the fused×decay×confidence product) the evidence must reach for the question to count as answerable. 0 disables the score floor.',
  },
  {
    key: 'RETRIEVAL_ABSTENTION_MIN_EVIDENCE',
    category: 'pipeline',
    defaultValue: '2',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Coverage floor for RETRIEVAL_ABSTENTION_CALIBRATION=coverage: minimum fact count across the retrieved evidence. 1 effectively disables the count floor (empty evidence already returns no_results).',
  },
  {
    key: 'RETRIEVAL_VERIFIER_TOPIC_COVERAGE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "V10 §5 verifier topic-coverage (profile field verifierTopicCoverage): the corrective-RAG auditor additionally (a) treats asserted CONNECTIONS between facts — causal/motivational/attributive links — as claims needing their own evidence, and (b) outputs a questionAnswered judgment: does the evidence actually answer the query, or merely share its topic. In lenient guardrails under abstentionCalibration='verifier', supported-but-not-answering declines like unsupported (the V9 residual: 13/40 abstention misses were fabrications assembled from real facts, each claim individually grounded, the causal link invented). Strict/answer guardrails keep pre-V10 semantics. Off = byte-identical verifier prompt and schema.",
  },
  {
    key: 'RETRIEVAL_PROFILE_OVERRIDES',
    category: 'pipeline',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Per-tenant retrieval-profile overrides: JSON object mapping companyId → partial profile. Every field of the RetrievalProfile is overridable — the authoritative field list is the wire contract (src/contracts/admin/retrieval-profile.schema.ts, pinned key-for-key against the profile by the contracts gate) rather than a copy here that drifts. Precedence: overlay field > explicit env > genre preset > code default; an overlay `genre` re-derives that genre’s preset base first (see genre-presets.ts). Resolved once per request in the auth guard.',
  },
  {
    key: 'SYNTHESIZE_EXTRA_EVIDENCE_CAP',
    category: 'pipeline',
    defaultValue: '40',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Max pre-retrieved extra facts (multi-hop evidence union) appended to the generator prompt after the re-search results.',
  },
  {
    key: 'SYNTHESIZE_DATE_CONTEXT',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Prepend an anchored "Today: <date>" (dto.asOf, else now) plus a date-arithmetic instruction to the answer generator, so relative time expressions resolve against fact date stamps instead of being guessed. DEFAULT ON (2026-08 engine wave — the trace-verified temporal failure was relative-date questions with no anchor); set 0 for genres where the golds follow a session-date convention (LoCoMo eval profile).',
  },
  {
    key: 'EPISODE_SUBSTRATE_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'L0 episode substrate (memory-substrate-redesign P1): store every ingested dialogue turn verbatim (P0-redacted, piiClass-tagged) BEFORE extraction — lossless, idempotent (INSERT IGNORE on conversationId+messageId), LLM- and embedder-free. Extraction failures stop losing turns; future derivers re-derive from here.',
  },
  {
    key: 'SEARCH_EPISODIC_LANE_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Episodic retrieval lane (memory-substrate P2): BM25 top-k over the L0 episode substrate rendered as dated, chronological transcript quotes in their own generator-prompt section — the lossless fallback when extraction missed or fragmented a fact. Callers without brain:read_pii only see piiClass-clean episodes.',
  },
  {
    key: 'SEARCH_EPISODIC_LANE_TOPK',
    category: 'pipeline',
    defaultValue: '8',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Transcript quotes per synthesis prompt from the episodic lane — verbatim turns are token-heavy, keep the cap low.',
  },
  {
    key: 'SYNTHESIZE_SOURCE_EXCERPTS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Provenance lane (road-to-90 A1): quote the verbatim source turns of the selected evidence facts (knowledge_fact.source.episodeIds → episode) in the synthesis prompt — restores the concrete detail a derivation summarized away. Same PII gate and degradation contract as the episodic lane.',
  },
  {
    key: 'SYNTHESIZE_SOURCE_EXCERPTS_CAP',
    category: 'pipeline',
    defaultValue: '16',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Episode quotes per synthesis prompt from the provenance lane; first-seen (≈ evidence relevance order) wins under the cap.',
  },
  {
    key: 'SEARCH_SEGMENT_LANE_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'L0 segment lane (memory-rebuild R1): retrieve verbatim multi-turn segments (episode_segment, built by POST /v1/admin/maintenance/segments) via dense+BM25 RRF as retrieval units in their own right, rendered as transcript excerpts in the synthesis prompt. PII-gated like the episodic lane.',
  },
  {
    key: 'SEARCH_SEGMENT_LANE_TOPK',
    category: 'pipeline',
    defaultValue: '5',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Segments per synthesis prompt from the segment lane — segments are multi-turn and token-heavy, keep the cap low.',
  },
  {
    key: 'SEARCH_SEGMENT_LANE_RERANK',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Precision-trim the fused segment pool with the listwise reranker before the top-k cut.',
  },
  {
    key: 'SEARCH_FACT_RERANK',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'July A3: cross-encoder rescoring of the fused FACT pool before the fact-centric budget cut. The entity-bucket cross-encoder pass reorders buckets, but the global fact window slices by fused score alone — the measured dominant LoCoMo miss class (gold sitting in the derived facts, lost to selection). Rescoring the top SEARCH_FACT_RERANK_WINDOW facts with the joint encoder fills the budget by relevance. Rank-preserving score remap: window/tail boundary and the top-1 score value are unchanged, so abstention gates read the same numbers. Default off pending a paired leg.',
  },
  {
    key: 'SEARCH_FACT_RERANK_WINDOW',
    category: 'pipeline',
    defaultValue: '64',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Fact-pool slice the fact-level cross-encoder rescoring pass covers (top-N by fused score). Local ONNX scoring is sequential — raise SEARCH_STAGE_BUDGET_CROSS_ENCODER_MS together with this window or the pass falls back to fused order.',
  },
  {
    key: 'AGENT_QA_TOOLS_V2',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Agent-QA V2 tool set (memory-rebuild R3): masked search_memory (facts already shown are never repeated — each call must surface new evidence), timeline (chronological topic scan for enumeration/counting), grep_episodes (literal transcript search), plus date-arithmetic loop prompt. Off = the original single-tool loop, byte-identical.',
  },
  {
    key: 'AGENT_QA_ROUTE_MODE',
    category: 'pipeline',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Agent-QA routing (memory-rebuild R3b): 'escalate' answers one-shot (multi-hop search + synthesis) first and runs the ReAct loop ONLY when the one-shot answer is null, hedging, or citation-free — the loop replacing one-shot wholesale measured −4.6pp. Unset = pure loop.",
  },
  {
    key: 'RETRIEVAL_DERIVED_VERSION',
    category: 'search',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Derived-namespace pin (substrate P3): read only facts stamped with this derivedVersion (e.g. wd-v2, written by POST /v1/admin/maintenance/derive). Unset = legacy namespace only (facts without a version). Switching the value switches the whole retrieval world atomically.',
  },
  {
    key: 'RETRIEVAL_DERIVED_VERSIONS',
    category: 'search',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Multiworld §10 READ union: comma-separated derivedVersion list — the read path serves the SET of worlds (WHERE derivedVersion INSIDE […]), rows competing in the same legs and fusion. The tenant's own resolved world (registry live row / RETRIEVAL_DERIVED_VERSION) is always INCLUDED in the union, never displaced. Write/maintenance surfaces (derive, dreams, compaction, communities) stay single-world; the derive rewrite guard and GC keep every union member (audit 2026-08-21). CONSTRAINT: union members must be COMPLEMENTARY worlds (typed lanes over one substrate) — unioning two full snapshots of the same contract duplicates semantically-equal rows under different ids (dedup is by record id only) and they eat the shared budget; per-world descriptors/budgets are deferred until the first union pair measures. Unset = single-pin behavior, byte-identical.",
  },
  {
    key: 'SYNTHESIZE_ANSWER_ROUTER_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Typed Answer Dispatch T1 (docs/roadmap/typed-answer-dispatch-2026-07.md): lexical router recognizes temporal-distance questions and switches synthesis into compute-then-answer — each dated fact gets a precomputed [elapsed: N days ≈ W weeks ≈ M months] annotation vs asOf and the date anchor is forced. Fail-open: unrouted queries take the legacy path byte-identically. Genre-profile flag: OFF for LoCoMo-convention corpora (session-date golds), ON for true-date-arithmetic corpora (LongMemEval/BEAM).',
  },
  {
    key: 'EPISODES_API_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Raw-substrate driver v1 (docs/roadmap/raw-substrate-driver-2026-08.md): public read API over the L0 episode substrate — GET /v1/episodes (keyset cursor over occurredAt+id, filters conversationId/speaker/since/until) and GET /v1/episodes/export (NDJSON stream, paged internally). Lets any consumer build its own projection without touching SurrealDB. PII fence follows the read-lane precedent: without brain:read_pii only rows with empty piiClass are visible. Off (default) → routes answer 404.',
  },
  {
    key: 'FACTS_API_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Fact read + provenance API ("show me why I remember this"): GET /v1/facts/:id serves the fact as stored (aspect/statement/confidence/validFrom, source attribution, retracted flag, derivedVersion) and GET /v1/facts/:id/provenance serves its verbatim grounding turns (source.episodeIds via the shared episode read port, text capped at 600 chars). Every miss is a 404 — tenant fence, fail-closed user scope (another user\'s fact is indistinguishable from absent), registry-backed row policy on scope-fenced predicates; episode text respects brain:read_pii. POST /v1/facts/:id/retract is deliberately NOT gated by this flag (write/GDPR path). Off (default) → read routes answer 404.',
  },
  {
    key: 'PROVENANCE_SUMMARY_EPISODE_STAMP',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, write side (Brain v2 gap #5): every summary-producing writer — promotion runner, compaction rollups, recompose rewrites, arc/aggregate composers — stamps the union of its members' source.episodeIds onto the summary row's source (window-deriver idiom: 'episode:'-prefixed, deduped, member order preserved, capped at 64), so a summary keeps a direct line to the verbatim turns behind its members. No backfill: the recursive closure reads member stamps through derivedFrom, and recompose re-stamps incrementally as summaries recompute. Off (default) → every summary write is byte-identical (no episodeIds key, no SET fragment).",
  },
  {
    key: 'PROVENANCE_RECURSIVE_CLOSURE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Evidence plane, read side (Brain v2 gap #6): GET /v1/facts/:id/provenance of a fact WITH derivedFrom walks the support graph breadth-first (bounded by PROVENANCE_CLOSURE_MAX_DEPTH/_FACTS/_EPISODES) and serves the union of grounding episodes across the closure plus optional derivedFacts (factId/predicate/depth/status — compacted/retracted members still witness, status reported not hidden) and closure ({depth, factCount, truncated, filtered}) fields. Every member passes the same fences as the root (user scope, scope tags, row policy); an invisible member is a SILENT drop marked filtered:true — the root keeps its exact 404 semantics. Off (default) → the one-hop response is byte-identical (optional fields absent).',
  },
  {
    key: 'PROVENANCE_CLOSURE_MAX_DEPTH',
    category: 'pipeline',
    defaultValue: '5',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Depth cap of the PROVENANCE_RECURSIVE_CLOSURE walk — max derivedFrom hops from the root (root = 0). Clamped to 1..10; unset/invalid → 5. Unvisited children past the cap mark the closure truncated.',
  },
  {
    key: 'PROVENANCE_CLOSURE_MAX_FACTS',
    category: 'pipeline',
    defaultValue: '256',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Fact budget of the PROVENANCE_RECURSIVE_CLOSURE walk — total supporting facts admitted across all depths. Clamped to 1..1024; unset/invalid → 256. Children past the cap mark the closure truncated (fan-out cap).',
  },
  {
    key: 'PROVENANCE_CLOSURE_MAX_EPISODES',
    category: 'pipeline',
    defaultValue: '200',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Episode budget of the PROVENANCE_RECURSIVE_CLOSURE walk — distinct grounding episodes harvested across the closure. Clamped to 1..500; unset/invalid → 200. Ids past the cap mark the closure truncated.',
  },
  {
    key: 'PROVENANCE_SUPPORT_EDGES',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Typed support graph, write side (Drift-5, migration 0116): writers emit canonical memory_support edges — scene-backlink adds fact-supported_by->scene edges alongside the legacy source.memoryEpisodeIds stamps, the conflict resolver records loser-contradicted_by->winner on SUPERSEDED and mutual pairs on COMPETING (capped 20), and promotion/compaction/recompose mirror derivedFrom as summary-derived_from->member edges (recompose deletes-then-reinserts its summary's edges to track rewrites). Idempotent via UNIQUE(in,out,kind) + INSERT RELATION IGNORE. GDPR cascades erase edges regardless of this flag. Off (default) → no edge is ever written, every writer's queries byte-identical.",
  },
  {
    key: 'PROVENANCE_SUPPORT_GRAPH_READ',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Typed support graph, read side (Drift-5): the provenance closure walk (PROVENANCE_RECURSIVE_CLOSURE) additionally follows derived_from edges as children (same visited set, same depth/fact/episode caps) and returns the supported_by/contradicted_by/derived_from edges it crossed in a new optional supportEdges response field; a root with typed edges but an empty derivedFrom array now walks too. Members pass the same per-row fences; edge targets are classified via EvidenceRef prefixes. Off (default) → the walk and the provenance response are byte-identical (field absent, not empty).',
  },
  {
    key: 'PROJECTIONS_API_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Raw-substrate driver v1, surface 3: derived surfaces as first-class records (migration 0076) — GET /v1/projections lists every derived world with status/watermark/builder/stats plus the live read pin; POST /v1/projections/:name/rebuild (brain:admin) is the public verb over the maintenance batch engine (v1 rebuilds "facts" via the session-window deriver). The registry observes builder lifecycles (building/built/live/residual/failed); gc deletes rows for reaped worlds. Off (default) → routes answer 404.',
  },
  {
    key: 'EPISODE_SUBSCRIPTIONS_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Raw-substrate driver v1, surface 4 (migration 0077): new-episode webhook push for external projection builders. POST/GET/DELETE /v1/episodes/subscriptions registers HTTPS endpoints (per-subscription HMAC secret returned once); a per-minute dispatcher polls each tenant watermark over recordedAt (deliberately NOT changefeed-driven — 0073 keeps the episode table feed-free for GDPR) and POSTs metadata-only batches (ids/attribution/timestamps, never text) signed X-Brain-Signature: sha256=<hmac>. At-least-once delivery, CAS watermark advance, circuit breaker, auto-deactivate at 100 consecutive failures. Enable on ONE role (worker) in prod. Off (default) → routes 404, dispatcher inert.',
  },
  {
    key: 'USER_PROFILE_API_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Rolling user profile v1 (docs/user-profile-api.md): GET /v1/users/:userId/profile — a deterministic query-time assembly of the active facts visible in one end-user's scope (ingested user-stamped facts + the pinned derived world's typed atoms), grouped by predicate/aspect, persona_attr-first, capped per aspect and globally, rendered as prompt-injectable profileText. No LLM calls. User-bound tokens read only their own profile (403 on mismatch); PII-fenced predicates require brain:read_pii. Off (default) → routes answer 404.",
  },
  {
    key: 'SYNTHESIZE_INSTRUCTION_LANE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "T7 instruction lane: standing user instructions ('always format code with syntax highlighting when I ask about implementation') captured as preference facts are pulled by an UNCONDITIONAL fixed probe and rendered as a dedicated standing-instructions section with an apply-on-match frame. Unconditional because instruction-following questions are deliberately neutral — no lexical route can fire, and relevance-gating filters exactly these out (LIGHT's measured ceiling). Requires the answer router.",
  },
  {
    key: 'SYNTHESIZE_LANE_WIDE_PROBE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'T6/T2 wide probe: summary/enumeration-routed questions run a second retrieval with a pseudo-relevance-feedback query (original query + dominant aspect predicates + top entity names from the base hits — deterministic, no LLM). Lesson of the null render-frame legs: a whole-project narrative needs recall breadth the top-K similarity slice cannot cover. Extra facts merge through the evidence union under SYNTHESIZE_EXTRA_EVIDENCE_CAP. Requires the answer router.',
  },
  {
    key: 'SYNTHESIZE_WIDE_PROBE_LIMIT',
    category: 'pipeline',
    defaultValue: '12',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Hit limit for the T6/T2 wide-probe second retrieval (SYNTHESIZE_LANE_WIDE_PROBE).',
  },
  {
    key: 'SYNTHESIZE_ANSWER_CACHE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "G1 answer-reuse cache (docs/roadmap/sota-gap-build-2026-08.md): EXACT normalized-match serving of verified grounded answers (answer_cache, migration 0091) — no embeddings in v1, zero false-hit surface by construction. Key = SHA256 over tenant|user|resolved-profile+knobs hash|model|prompt version|derived-world read pin|normalized query; any lever difference is a different key. Admission is write-through from synthesize ONLY on a verifier-supported, cited answer (abstentions/partial/zero-citation answers are never cached). Serving is CHECK-ON-READ gated: the cited facts are re-read through the same user-scope and row-policy fences as the fact read path, and the entry serves only while every cited fact is still active and inside its validity window — any failure invalidates the entry with a cause (brain_answer_cache_total{outcome='rejected_stale'}) and falls through to fresh synthesis. explain:true requests bypass. Off (default) → byte-identical synthesize path.",
  },
  {
    key: 'SYNTHESIZE_ANSWER_CACHE_TTL_HOURS',
    category: 'pipeline',
    defaultValue: '24',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "TTL backstop for SYNTHESIZE_ANSWER_CACHE entries, in hours (positive integer, default 24). An expired entry is a plain miss and is overwritten in place by the next admission; check-on-read remains the correctness backbone. It is ALSO the operator-set new-entity staleness bound: the additive-write freshness probe only scans an answer's CITED entities, so a newly-relevant fact on a BRAND-NEW entity (one the original retrieval never touched) cannot be probed without re-retrieval — that residual is bounded, for every cached answer, ONLY by this TTL. Lower it to tighten the new-entity window; there is no claim of full freshness beyond it.",
  },
  {
    key: 'SYNTHESIZE_ANSWER_CACHE_ENUM_TTL_HOURS',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Shorter TTL (hours, positive integer, default 1) for OPEN-ENUMERATION answers in SYNTHESIZE_ANSWER_CACHE — the 'list all X' / counting / ordering shapes. The additive-write freshness probe (audit F1) invalidates a cached answer when a newer fact lands on one of its CITED entities, but an enumeration's new item often lands on an entity that was not yet cited, which the entity-scoped probe cannot see; the short TTL bounds how long such a now-incomplete list keeps serving. An answer is treated as enumeration-shaped when the query matches the enumeration lexicon OR — language-agnostically — the answer cites at least SYNTHESIZE_ANSWER_CACHE_ENUM_MIN_CITATIONS facts. Applied as min(this, SYNTHESIZE_ANSWER_CACHE_TTL_HOURS) so it is never longer than the regular TTL.",
  },
  {
    key: 'SYNTHESIZE_ANSWER_CACHE_ENUM_MIN_CITATIONS',
    category: 'pipeline',
    defaultValue: '5',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Language-agnostic enum guard for SYNTHESIZE_ANSWER_CACHE (positive integer, default 5). The query-shape enum detector keys on English 'list all X' / counting phrasing, so a non-English enumeration would miss the shorter enum TTL despite carrying the same new-entity exposure. This threshold adds a language-independent answer-shape signal: an admitted answer that cites at least this many facts is treated as enumeration-shaped (open list) whatever the query language, and drops to SYNTHESIZE_ANSWER_CACHE_ENUM_TTL_HOURS. Raise it to short-TTL only very broad answers; a small factoid answer (few citations) always keeps the regular TTL.",
  },
  {
    key: 'BRAIN_TENANT_OVERRIDE_ENABLED',
    category: 'auth',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Unlock the platform-operator cross-tenant path: a key holding the dedicated brain:platform_admin scope may address a tenant other than its own — via the X-Brain-Tenant header (guard) or a tenant/companyId body/query field on admin endpoints (resolvePlatformTenant). BOTH the scope and this gate are required; with either missing, a plain brain:admin key can only ever operate on its own tenant (a foreign tenant is a 403). Built for eval harnesses needing per-question tenant isolation (LongMemEval/BEAM: one haystack per tenant) without minting hundreds of keys. Never enable in multi-tenant prod without a policy review.',
  },
  {
    key: 'INGEST_EPISODE_ONLY',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Mention ingest captures the raw episode and returns before LLM extraction — the derived world is then built in batch by POST /v1/admin/maintenance/derive. LLM-free ingest for eval harnesses and bulk backfills; requires EPISODE_SUBSTRATE_ENABLED.',
  },
  {
    key: 'INGEST_SANITIZE_UNICODE',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'G9 ingest-time Unicode sanitization (docs/roadmap/sota-gap-build-2026-08.md): NFC-normalize and strip bidi controls, zero-width/word-joiners, and nonprinting C0/C1 controls (keeping \\n \\t) from free-text ingest bodies BEFORE storage — conversation mention turns, direct fact predicate/object, document bodies, and external candidate submissions. Closes the memory-injection smuggling vector the MCP pack surface already defends (sanitizePackText); read per-request so a flip takes effect live. Off (default) → stored text is byte-identical to the wire payload.',
  },
  {
    key: 'INGEST_CONTEXTUAL_FACT_EMBEDDING',
    category: 'embedder',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Contextual fact embedding: embed mention-extracted facts with a speaker+date context stamp so the vector matches context-referencing queries (Anthropic Contextual Retrieval, fact-level). Changes the embedding basis — requires re-ingest.',
  },
  {
    key: 'INGEST_EVENT_TIME_EXTRACTION',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Event-time extraction: when a mention clause carries a relative temporal expression ("yesterday", "last year", "3 weeks ago", RU "вчера"/"три недели назад"), resolve the occurrence date against the message time and use it for the fact\'s validFrom instead of the message time. Multilingual via chrono-node, dispatched by the clause\'s detected language (en/ru/fr/de/es/pt/…), English fallback; no LLM call. Unresolvable clauses fall back to message time. Requires re-ingest.',
  },
  {
    key: 'DERIVER_ASSISTANT_CONTENT',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'E3a (engine wave 2026-08): the session-window deriver also emits propositions for content a participant CONTRIBUTED — recommendations, answers, instructions given — under the "assistance" aspect, subject = the contributing participant. The base contract is user-fact-shaped, so assistant-side content structurally never became a proposition (the measured SSA failure at the substrate level; the read-side verbatim lane routes around it, this closes the source). Default off; confirm on a FRESH derivedVersion — worlds derived under different prompts must not share a version. Requires re-derive.',
  },
  {
    key: 'DERIVER_COMPLETION_PASS',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'V7 deriver-recall: after the base proposition pass the session-window deriver runs a second "what was missed" call — the model sees its own proposition list and returns ONLY additional durable propositions (up to 20), unioned with text-level dedup. The base contract caps at 40 propositions and a single pass under-extracts dense sessions (extraction recall has been the measured LoCoMo bottleneck since 2026-07). ~2x deriver spend on ingest. Default off; confirm on a FRESH derivedVersion — worlds derived under different pass counts must not share a version. Requires re-derive.',
  },
  {
    key: 'DERIVER_SALIENCE_STAMP',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      "Importance scoring, write side (V8 §4 → V9 §5 volume-neutral rebuild): after the proposition passes, a SEPARATE cheap grading turn scores each emitted proposition's salience 0-3 (0 incidental, 1 routine, 2 notable, 3 identity-central) against a mass rubric (~10/60/25/5), and the write stamps it as source.salience — no schema migration, no resolver change (source is FLEXIBLE). The V8 in-prompt section primed over-emission (+54-74% propositions, write-parity gate FAIL) and inflated grades; grading AFTER emission is volume-neutral by construction. Read-side use is separately gated by RETRIEVAL_SALIENCE_SCORING; unstamped rows read as neutral. Default off; confirm on a FRESH derivedVersion. Requires re-derive.",
  },
  {
    key: 'DERIVER_DIGEST',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'V12 §2 rolling conversation digest (the graphiti saga port; LIGHT ablation: the scratchpad is the load-bearing component at 100K, +160% on summarization): the deriver folds each session chronologically into one bounded narrative digest per conversation (conversation_digest, migration 0086) — the dated story of how topics evolved, which summarization golds ask for and fact extraction keeps thinnest. Merge contract: durable facts only, contradictions keep both beats with dates, unchanged when nothing new, no meta-language, ≤250 words (2400-char hard cap). Two watermarks: lastIngestAt (monotonic fold time) + lastEventAt (max folded occurredAt, advance-only). One extra deriver-model call per session; replace-per-namespace on re-derive. Read-side use is separately gated (RETRIEVAL_DIGEST_EVIDENCE, ships with the V12 leg). Default off — byte-identical derive. Requires re-derive.',
  },
  {
    key: 'DERIVER_MENTION_STAMP',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      "V12 §1 mention anchoring (the graphiti reference_time port): each derived fact is stamped with the event time of its FIRST grounding turn — source.mentionedAt (that turn's occurredAt, not the session date) and source.turnIndex (within-session ordinal). Pure metadata on the FLEXIBLE source object: no prompt change, no migration, no resolver-arity change, byte-identical off. This is what makes mention ORDER recoverable from facts — extraction otherwise collapses a session's mentions onto one validFrom (the measured event_ordering failure, 5% strict). Read-side consumers ship with the V12 ordering leg; unstamped rows read as before. Requires re-derive on a FRESH derivedVersion.",
  },
  {
    key: 'DERIVER_SLOT_SIMILARITY',
    category: 'extractor',
    defaultValue: '0.9',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      "V10 §1: the bitemporal_event competing pool's own cosine gate (0084) — derive-time slot resolution only; live-ingest 'bitemporal' keeps CONFLICT_SIMILARITY_THRESHOLD. The shared 0.85 measured clustering whole TOPICS on dev-chat derive (v9lifecycle superseded-pair audit: a more specific loser replaced by a less specific same-aspect winner), so the slot gate defaults tighter (0.9). Set 0.85 to reproduce the V9 behavior exactly. Requires re-derive to take effect.",
  },
  {
    key: 'DERIVER_SLOT_SEMANTICS',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      "V9 §1 derived-world lifecycle: value-bearing aspects (identity, residence, work, education, health, possessions, preferences) resolve as 'bitemporal_event' (migration 0083) — the competing pool is cosine-gated (CONFLICT_SIMILARITY_THRESHOLD) AND interval-overlapping so only value-variants of one claim meet; recency is EVENT-TIME (validFrom, not the batch's shared recordedAt); a strictly later validFrom supersedes (knowledge update), an equal validFrom stays COMPETING (contradiction-lane signal), an earlier one slots in as history. Event-like aspects stay append_only. Default off (byte-identical writes); lifecycle-on worlds take a FRESH derivedVersion. Requires re-derive.",
  },
  {
    key: 'EXTRACTION_OBJECT_NORMALIZE',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Object normalization (E3b, engine wave 2026-08): the span-grounded extractor also proposes "object" — the minimal clean phrase naming the value ("camped in the mountains with my kids" → "the mountains"); the server admits it only when every word already appears in the grounded span, else falls back to the raw span. Fixes the measured aggregation failure (values scattered across verbal phrasings cannot converge for "list all X"). valueSpan is kept on the fact for audit. Inactive under EXTRACTOR_DIALOGUE_PROFILE (that profile normalizes via its own contract). Default off pending a paid confirm leg — extraction prompt changes have regressed before. Requires re-ingest.',
  },
  // ── Dialogue memory mode ────────────────────────────────────────
  // All default-off and all requiring a re-ingest: they change what gets
  // WRITTEN, so toggling them only affects facts extracted afterwards.
  {
    key: 'EXTRACTOR_DIALOGUE_PROFILE',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Dialogue extraction profile: drop the closed CRM predicate vocabulary from the extraction call and let the model coin a SPECIFIC predicate per clause, keeping normalized (non-verbatim) values, attributing facts to the actor rather than the speaker, and enumerating lists. A closed label set as output contract is what drives the catch-all collapse ("conservative bias"); the vocabulary belongs downstream in canonicalization, not in the extractor. Measured +2.8pp on LoCoMo dev-5. Also bypasses the span-grounding drop (values are normalized by design) and skips the specificity-collapsing refinement passes. Requires re-ingest.',
  },
  {
    key: 'EXTRACTOR_ROUTING_ENABLED',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Facet routing (dialogue profile only): a turn containing a list (3+ items) or a proper name also gets a SPECIALIST extraction pass whose only contract is that one thing, unioned with the general pass. Strictly additive recall — the general pass still runs and the union deduplicates. The router is a local heuristic, not an LLM call. Costs one extra extraction call per detected facet. Requires re-ingest.',
  },
  {
    key: 'STATS_VIEWS_ENABLED',
    category: 'misc',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Tenant counter reads (StatsService.overview Usage page, admin dashboard per-tenant counters) come from the 0088 incrementally-maintained count() rollup tables (stats_entity_total / stats_fact_by_status / stats_community_total) instead of live GROUP aggregates. Counts only — SurrealDB incremental view maintenance is exact for count() but has known upstream bugs for median/stddev-class aggregates. The view path bypasses the 30s LRU (the view IS the cache); moving-window counts (facts last 7d, dead-letter/forgotten last 24h) stay live in both paths. A failing view read (pre-0088 tenant) logs once per tenant and falls back to live counting. Off (default) → byte-identical pre-0088 behavior.',
  },
  {
    key: 'LIVE_SUBSCRIPTIONS_ENABLED',
    category: 'misc',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      "Realtime fact subscriptions (SSE at /v1/live/facts). A dedicated per-tenant connection OUTSIDE both pools holds a LIVE SELECT on knowledge_fact, with the 30-day changefeed as the gap-replay bridge on reconnect and the per-row ABAC/scope gate applied to every pushed event using the SUBSCRIBER's scopes. Single-pod prototype: multi-pod fan-out needs per-tenant leader election, not yet built. Off → no socket is opened and the endpoint answers 503.",
  },
  {
    key: 'INGEST_BATCH_EDGES',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Batched edge persistence: collapse the per-edge RELATE round-trips of a mention into TWO queries (one multi-statement existence check, then one multi-statement RELATE for only the missing edges); re-ingest with all edges present is a single round-trip. Same observable outcome as the per-edge loop (idempotent RELATE on UNIQUE(in,out,kind)); a concurrent-writer race falls back to the per-edge primitive. Read at boot.',
  },
  {
    key: 'INGEST_INLINE_RESOLUTION_HNSW',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      "Route the inline entity-resolution name-candidate scan through the native HNSW index (<|k,ef|>) instead of a per-ingest full cosine scan of every 'name' fact. Over-fetches (candidateK × INGEST_INLINE_RESOLUTION_HNSW_OVERFETCH, default 8, capped 1000) since KNN pre-filters before the name/type WHERE. Tenants without a built index fall back to the full scan (build via POST /v1/admin/maintenance/hnsw). CORRECTNESS-SENSITIVE — a missed approximate candidate creates a DUPLICATE entity; run the dedup recall eval and verify parity vs full scan before enabling. Only active when INGEST_INLINE_RESOLUTION_ENABLED is also on. Read at boot.",
  },
  {
    key: 'SEARCH_COMBINED_VECTOR_GRAPH',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      "Combined vector+graph retrieval: fold each fact's entity neighbourhood (->knowledge_edge->) into the vector KNN query as a co-equal projection, so candidate generation is ONE SurrealQL round-trip instead of a vector query plus a separate edge-expansion lookup (SurrealDB's native hybrid-retrieval strength). Edge-expansion reuses the prefetched neighbours and only queries uncovered seeds. Off = byte-identical (empty projection + legacy lookup). Read at boot.",
  },
  {
    key: 'SEARCH_HIGHLIGHT_ENABLED',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      "BM25 match snippets: project search::highlight('<em>','</em>',1) from the lexical leg (the FULLTEXT indexes already carry HIGHLIGHTS but it was never queried) and surface a `highlight` field on lexically-matched facts. Off = no highlight field (byte-identical payload). Read at boot.",
  },
  // ── Dreams: corroboration + communities ──────────────────
  {
    key: 'DREAMS_CORROBORATE_ENABLED',
    category: 'dreams',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Fuzzy cross-source corroboration (cosine-close facts confirm each other). Bounded by DREAMS_CORROBORATE_MAX_PAIRS per run.',
  },
  {
    key: 'DREAMS_CORROBORATE_MAX_LLM_CALLS',
    category: 'dreams',
    defaultValue: '40',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Hard ceiling on judge LLM calls per corroborate run (default 2× MAX_PAIRS). different/unsure verdicts never count toward MAX_PAIRS, so this is what actually bounds spend.',
  },
  {
    key: 'DREAMS_COMMUNITIES_ENABLED',
    category: 'dreams',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description: 'Build + persist entity-community summaries during dreams.',
  },
  {
    key: 'COMMUNITIES_LP_OFFLOAD_MIN_EDGES',
    category: 'dreams',
    defaultValue: '2000',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Edge count from which community label propagation runs on the job worker pool instead of the main thread (needs JOB_WORKER_POOL_SIZE > 0; pool failures fall back in-thread). 0 = never offload.',
  },
  {
    key: 'COMMUNITIES_MIN_SIZE',
    category: 'dreams',
    defaultValue: '3',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Minimum member count for a detected community to be persisted (and summarized). Smaller clusters are dropped as noise.',
  },
  {
    key: 'COMMUNITIES_MAX_ITERATIONS',
    category: 'dreams',
    defaultValue: '10',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Label-propagation sweep cap for community detection. The algorithm usually converges in 3-5 sweeps; the cap bounds pathological oscillation.',
  },
  {
    key: 'COMMUNITIES_SUMMARY_MAX_MEMBERS',
    category: 'dreams',
    defaultValue: '10',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'How many member entities (by degree) are sampled into the LLM community-summary prompt.',
  },
  // ── Compaction: promotion ────────────────────────────────
  {
    key: 'COMPACTION_PROMOTION_ENABLED',
    category: 'compaction',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Promote old corroborated append_only fact groups into a durable summary. Bounded by COMPACTION_PROMOTION_MAX_GROUPS per run.',
  },
  {
    key: 'COMPACTION_PROMOTION_MIN_EPISODES',
    category: 'compaction',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Corroboration floor of the promotion consolidation gate (Brain v2 PR8): minimum DISTINCT evidence contexts — union of the member facts’ source.episodeIds and source.conversationId — a group must span before it may fold into a summary. Five facts from one conversation are one witness, not five. 0 (default) = floor off, promotion byte-identical. Per-tenant override via COMPACTION_TENANT_OVERRIDES (promotionMinEpisodes).',
  },
  {
    key: 'COMPACTION_PROMOTION_CONFLICT_GUARD',
    category: 'compaction',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Competing-evidence guard of the promotion consolidation gate (Brain v2 PR8): before folding a group, count sibling status=competing rows on the same (entity, predicate, user-scope); any hit ABORTS the group loudly (logger.warn "contested group NOT promoted") — a contested group must never fold silently into one summary. Off (default) = byte-identical promotion, no extra query.',
  },
  // ── Strategy-memory lane (G4) ────────────────────────────
  {
    key: 'STRATEGY_MEMORY_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      "Strategy-memory lane master switch (migration 0092, ReasoningBank shape): a SEPARATE strategy_memory store of distilled how-to-answer lessons — advice, never evidence, structurally isolated from every fact lane. On → the 'strategy' lane joins the profile lane set (requires the answer router), the /v1/admin/strategy endpoints answer, and the lifecycle cron may run. Serving additionally requires STRATEGY_RETRIEVAL_ENABLED. Off (default) → endpoints 404, lane absent, cron inert.",
  },
  {
    key: 'STRATEGY_RETRIEVAL_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Read-side serving switch of the strategy-memory lane: on (with the master flag) the evidence collector retrieves k=1 (hard cap 2) active strategy items above STRATEGY_SIMILARITY_FLOOR and renders them as a fenced ADVISORY section for the GENERATOR ONLY — the verifier never sees them (documented parity exception: guidance, not evidence). Off (default) → distill/list/curate still work, nothing is served.',
  },
  {
    key: 'STRATEGY_SIMILARITY_FLOOR',
    category: 'pipeline',
    defaultValue: '0.4',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Cosine-similarity floor for strategy-memory serving: the k=1 retrieval returns nothing when the best active item scores below this (an irrelevant best-match must serve no advice). JS-side brute cosine over the small curated table — no HNSW.',
  },
  {
    key: 'STRATEGY_DISTILL_CRON_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Nightly strategy-memory lifecycle sweep at 03:52 UTC (G7 host slot, requires STRATEGY_MEMORY_ENABLED): auto-deprecates items whose evidence.nContradict ≥ 2 or that went 90 days without validation (Memp/ExpeL lifecycle). Distillation itself stays operator-invoked via POST /v1/admin/strategy/distill in v1.',
  },
  {
    key: 'STRATEGY_TRAJECTORIES_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Experience-memory extension of the strategy lane (migration 0098, bet #3 Part 3): store TOOL TRAJECTORIES + verified outcomes alongside the advice string. On (with STRATEGY_MEMORY_ENABLED) → the POST /v1/admin/strategy/trajectory capture endpoint answers (a completed tool-run + outcome distills into a trajectory-bearing item via the same Mem0 dedup), and served items render their past tool path into the GENERATOR advisory. Args/results are stored as one-way DIGESTS, never raw (no secrets/PII). The G4 verifier-parity exception is INVIOLABLE — a trajectory reaches the generator only, never the verifier or citations; it is more trap-exposed than the advice string, so enabling should ride §4.3 lens-suppression + the verifier answer-integrity arm. Off (default) → capture 404s, no trajectory column is written or read (byte-identical to pre-0098).',
  },
  // ── Jobs ─────────────────────────────────────────────────
  {
    key: 'JOBS_QUEUE_MODE',
    category: 'jobs',
    defaultValue: 'enqueue',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Where background jobs run: enqueue (durable worker loop, default) vs inline (in-process).',
  },
  {
    key: 'WORKER_LOOP_MAX_CONCURRENT',
    category: 'jobs',
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Max in-flight dispatches per jobType in the queue poller; 1 = original serial loop. Per-type override: WORKER_LOOP_MAX_CONCURRENT_<JOBTYPE>.',
  },
  {
    key: 'WORKER_LOOP_TENANT_MAX_CONCURRENT',
    category: 'jobs',
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Max in-flight dispatches per (jobType, tenant) — extra concurrency slots go to other tenants first.',
  },
  {
    key: 'WORKER_LOOP_GLOBAL_MAX_CONCURRENT',
    category: 'jobs',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: false,
    description: 'Cap on in-flight dispatches across all jobTypes in this process; 0 = uncapped.',
  },
  // ── Registry mirroring (pull-only, migration 0064) ───────
  {
    key: 'REGISTRY_UPSTREAM_URL',
    category: 'registry',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Base URL of the upstream Brain instance whose pack registry this one mirrors. Unset = mirroring off (no job registered); restart required to turn on/off.',
  },
  {
    key: 'REGISTRY_UPSTREAM_TOKEN',
    category: 'registry',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      'Bearer token sent on upstream /v1/registry reads (brain:read key on the upstream). Optional.',
  },
  {
    key: 'REGISTRY_MIRROR_INTERVAL_HOURS',
    category: 'registry',
    defaultValue: '24',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Mirror sync cadence in hours. The hourly :26 UTC cron collapses ticks inside one interval bucket via dedup key.',
  },
  // ── Marketplace billing (paid packs, migration 0066) ─────
  {
    key: 'DOMAIN_PACK_BILLING_ENABLED',
    category: 'billing',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Paid-pack marketplace integration with the central billing service. Off (default) = self-hosted posture: paid metadata is ignored, every pack installs free.',
  },
  {
    key: 'BILLING_SERVICE_URL',
    category: 'billing',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Base URL of the billing service (e.g. https://billing.inite.ai). Required while the billing flag is on — validated at boot.',
  },
  {
    key: 'BILLING_SERVICE_API_KEY',
    category: 'billing',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      'Service API key (x-api-key header) identifying brain as a registered Service in the billing admin.',
  },
  {
    key: 'BILLING_TIMEOUT_MS',
    category: 'billing',
    defaultValue: '5000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Per-request budget for billing HTTP calls; reads (entitlements, product list) get one retry on timeout/network/5xx.',
  },
  {
    key: 'BILLING_ENTITLEMENT_CACHE_TTL_MS',
    category: 'billing',
    defaultValue: '60000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'In-memory TTL for per-company entitlement lookups. Never served stale: expired cache + billing down fails paid installs CLOSED (503).',
  },
  {
    key: 'PROCESS_ROLE',
    category: 'jobs',
    defaultValue: 'all',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Boot-only role split: all (default, single do-everything process), api (applies WORKER_LOOP_ENABLED=0 + JOB_WORKER_POOL_SIZE=0 unless set explicitly), worker (applies CHAT_ROUTE_NLI_ENABLED=false unless set). api/worker require JOBS_QUEUE_MODE=enqueue — validated at boot. See docs/operations.md "Splitting API and worker roles".',
  },
];
