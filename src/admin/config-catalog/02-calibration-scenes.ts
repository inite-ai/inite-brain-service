import type { ConfigCatalogSpec } from '../config-catalog.data';

/** Rows 555–1229 of the catalogue, in order (see config-catalog.data.ts). */
export const CATALOG_PART_02: ConfigCatalogSpec[] = [
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
    key: 'SCENES_SCHEDULED_MAINTENANCE',
    category: 'scenes',
    // Read at call time (scene-flags.sceneScheduledMaintenanceEnabled) by
    // the cron entry point and by the ingest dirty-mark seam — never
    // captured in a constructor — so a flip takes effect without restart.
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Scheduled scene maintenance (migration 0130): every ten minutes a pass runs the scene chain (compose → enrich → backlink → evidence links → beliefs) per tenant over DIRTY conversations that have SETTLED — the ingest seam marks a conversation when turns land (bumping the mark on every turn), the pass takes only marks older than SCENES_MAINTENANCE_SETTLE_MS, so an active session is left alone until it goes quiet and the paid enrichment is spent once per finished scene; the mark is cleared after a successful swap, so the run is proportional to what moved instead of the O(all conversations) full rebuild, and a quiet tenant costs one indexed read per tick. Was nightly at 04:20 UTC and shipped OFF: every scene and belief on the prod tenant existed only for conversations an operator had curled by hand. Bounded by SCENES_MAINTENANCE_MAX_CONVERSATIONS per tenant per run and SCENES_MAINTENANCE_TIME_BUDGET_MS overall, distributed-lease guarded (one pod, never overlapping itself), per-tenant error isolated. `=0` = the cron returns before a single query, no dirty mark is ever written, the admin routes stay the only trigger.',
  },
  {
    key: 'SCENES_MAINTENANCE_MAX_CONVERSATIONS',
    category: 'scenes',
    // Read at call time (scene-flags.sceneMaintenanceMaxConversations)
    // once per nightly run — never captured in a constructor —
    // runtime-mutable.
    defaultValue: '200',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Scheduled scene maintenance: max DIRTY conversations composed per tenant per nightly run, oldest mark first. The cost fence — the post-swap chain spends ~1 LLM call per NEW scene (SCENES_LLM_ENRICHMENT) and 1 embedding batch per composed conversation (SCENES_TOPIC_BOUNDARY). Unconsumed marks survive to the next run, so a backlog drains across nights. Positive integer; default 200.',
  },
  {
    key: 'SCENES_MAINTENANCE_TIME_BUDGET_MS',
    category: 'scenes',
    // Read at call time (scene-flags.sceneMaintenanceTimeBudgetMs) once
    // per nightly run — never captured in a constructor —
    // runtime-mutable.
    defaultValue: '1800000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Scheduled scene maintenance: whole-run wall-clock budget in ms. Once elapsed the pass stops starting NEW tenants (the tenant in flight always finishes — no compose is aborted mid-swap) and the roster resumes next night with the marks intact. Guarantees the pass cannot still be running when the next night’s crons fire. Positive integer; default 1800000 (30 min).',
  },
  {
    key: 'SCENES_MAINTENANCE_SETTLE_MS',
    category: 'scenes',
    defaultValue: '600000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Quiet period before the scheduled scene pass composes a dirty conversation (milliseconds, default 10 min): a conversation whose latest turn landed more recently than this is not on the page yet. The session gap is the scene boundary anyway, so composing a session while it is still being written would only re-enrich its moving tail on every tick. 0 = compose on the next tick regardless (the e2e fixtures).',
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
      'Scenes fact backlink (Brain v2 PR2): reconcile each knowledge_fact’s source.memoryEpisodeIds to exactly the scenes of the effective version whose membership intersects its source.episodeIds (stale pointers to purged or rebuilt scenes are removed) + source.sceneLinkVersion — facts become pointers into the episodic plane. FLEXIBLE source ride, no migration; nothing on the serving path reads the keys (additively visible where `source` is already returned). Off = no fact row is ever touched, backlink route 404s.',
  },
  {
    key: 'SCENES_GIST_EMBEDDING',
    category: 'scenes',
    // Read at call time (scene-flags.sceneGistEmbeddingEnabled) by the
    // admin 404 guard, the encoder pass's defensive early return and the
    // composer's post-swap hook — never captured in a constructor — so a
    // flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Scene gist embeddings (Brain v2 PR3): the producer the 0106 `gistEmbedding` column never had. After the composer swap (and via POST /v1/admin/maintenance/scenes/embed-gists) an encoder pass embeds the CANONICAL `gist` text of scenes in the current effective world that carry no vector yet — ONE bounded embedMany batch per run, capped at 200 scenes — and writes the vector by primary-key-addressed UPDATE, plus the `embeddingSpaceId` stamp when EMBEDDING_SPACE_TRACKING is on (exactly the fact-side reindex convention, so space migration treats scenes like every other embedded surface). `gist` and NOT `enrichedGist`: it is the one canonical, post-compose-immutable gist column, the one the 0106 BM25 index covers, the one the scene lane renders and the one the reindex engine already declares as this table’s embed source — so the single seam covers deterministic AND LLM-enriched worlds. Unblocks the scene lane’s dense leg (RETRIEVAL_SCENE_LANE), which is BM25-only while no vector exists. Off = the embedder is never called, no scene row is touched, the route 404s and the composer hook is skipped — byte-identical prod. An embed failure is soft: the run reports it and never fails the compose that spawned it.',
  },
  {
    key: 'SCENES_ENTITY_LINKS',
    category: 'scenes',
    // Read at call time (scene-flags.sceneEntityLinksEnabled) by the
    // enricher, ONCE per run (the Drift-3 contract) — never captured in a
    // constructor — so a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Scene entity links (Brain v2 PR3): the enrichment pass RESOLVES the LLM’s free-text `entityMentions` (parsed since PR2 and deliberately discarded — the 0106 column promises knowledge_entity RECORD refs) into real records through the platform’s own deterministic resolution — exact canonicalName/alias match, plus the INGEST_ARTICLE_NORMALIZATION leading-article variants and the INGEST_CODE_ALIAS_RESOLUTION path↔symbol convention when those flags are on — and persists them in `entityIds`. RESOLVE-ONLY: a scene NEVER mints an entity, never stamps an alias, never writes a merge-log row, and an unresolved mention is dropped — a scene is a reconstruction, not a source of truth. Fenced by the #387 single-user rule: a single-user scene may link its own user’s entities plus tenant-global ones, and a mixed-user / tenant-global / legacy scene links tenant-global entities ONLY, so a foreign user’s entity can never land on a scene; merged-away entities are excluded. At most 12 mentions are attempted per scene (so at most 12 links), and the resolved set fully REPLACES the column, so re-enrichment is idempotent. `relationIds` stays unwritten — the pipeline has no knowledge_edge producer and inventing edges from a mention list would assert evidence the scene never gave. Requires SCENES_LLM_ENRICHMENT. Off = zero resolution queries, a byte-identical scene SELECT projection and UPDATE statement, and no entityIds write.',
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
  {
    key: 'PACK_MEMORY_PROJECTIONS_ENABLED',
    category: 'scenes',
    // Read at call time (pack-projection-flags.packMemoryProjectionsEnabled)
    // by the external-submission validator, the commit-side projection
    // hook and the capture-path producer — never captured in a
    // constructor — so a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Pack memory projections (migration 0110), TWO producers. DOCUMENT origin: external candidate submissions may carry scenes/stateDeltas validated against the submitting pack’s manifest memoryModel (sceneSchemas / stateModels), staged as candidate kinds scene/state_delta and projected at commit time. CAPTURE origin: a mention turn is matched against the installed packs’ declared sceneSchemas.cues (literal substrings, model-free — no LLM, no embedding) and declared stateModels.states, projected inline at ingest. Both write shadow memory_episode rows under segmenterVersion pack:<packId>+<fp> (registry scenes:<packId>; purge via DELETE /scenes/versions/:v); capture-origin rows also carry a memory_episode_member edge to their L0 turn (the GDPR erasure anchor — the capture producer requires EPISODE_SUBSTRATE_ENABLED and skips a turn it could not capture). Off = submissions carrying either array are rejected 400, no such candidate row is written, no projection runs on either path — byte-identical. The GDPR forget cascades for projected rows run regardless.',
  },
  {
    key: 'PACK_SOURCE_VERSION_STALENESS',
    category: 'scenes',
    // Read at call time (pack-projection-flags.packSourceVersionStaleness-
    // Enabled) by the external-submission validator and the drift sweep —
    // never captured in a constructor — so a flip takes effect without
    // restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Source-version stamps + drift-based staleness. An external candidate submission may carry sourceVersion = {system, ref, version, readAt} naming the revision of the EXTERNAL system of record it read (git commit, DMS revision, EHR study). The stamp rides candidate provenance into every committed fact’s source.sourceVersion, so a derivable claim reads “at commit abc123, X is Y” instead of the timeless — and eventually false — “X is Y”. The same submission then sweeps: facts of the pack’s DERIVABLE predicate class whose stamp names an older revision of the SAME system+ref are marked with the existing 0072 staleAt/staleReason (reason source_version_drift) as candidates for re-verification, and facts back at the current revision have that mark cleared. Which predicates are derivable is DECLARED by the pack — memoryModel.verificationRules entries with requires=source_version_match and appliesTo=[localIds] — never inferred from predicate names: an interpretation (decided/because/gotcha/invariant) is a statement about the past and never drifts. No git ever runs server-side; the current revision is told to the server by the indexer that holds the working tree. Marking only, the 0072 contract — a drifted fact keeps serving, and the recompose pass is fenced to source.kind=compaction-summary so it never picks these up. Off = a submitted sourceVersion is rejected 400, no candidate payload or fact source gains the key, and no sweep query runs — byte-identical.',
  },
  {
    key: 'SCENES_BELIEF_PROMOTION',
    category: 'scenes',
    // Read at call time (scene-flags.sceneBeliefPromotionEnabled) by the
    // admin 404 guard + the promotion service's defensive early return —
    // never captured in a constructor — so a flip takes effect without
    // restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Belief promotion (Belief-A, migration 0120): POST /v1/admin/maintenance/scenes/beliefs folds ENRICHED scenes of the current effective segmenter version (stateDeltas/memoryValue/gist, 0118) into the shadow semantic_belief substrate keyed by free-text (subject, field) — supersede-chain revisions, inline sourceSceneIds provenance, consolidatedInto/baselineRef stamps on consumed scenes, optional memory_support mirror under PROVENANCE_SUPPORT_EDGES. Mixed-user/legacy scenes are skipped fail-closed (#387). Off = route 404s, zero queries, no belief row is ever written — byte-identical prod (shadow: no serving path reads the table).',
  },
  {
    key: 'SCENES_BELIEF_MIN_SCENES',
    category: 'scenes',
    // Read at call time (scene-flags.sceneBeliefMinScenes) once per
    // promotion run — never captured in a constructor — runtime-mutable.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Belief promotion corroboration floor (#377 promotion-floor idiom): promote a (subject, field) group only when its winning value is corroborated by scenes from at least this many DISTINCT CONVERSATIONS. Non-negative integer; 0 (default) = floor off.',
  },
  {
    key: 'SCENES_BELIEF_LLM_SYNTHESIS',
    category: 'scenes',
    // Read at call time (scene-flags.sceneBeliefLlmSynthesisEnabled) per
    // belief write — never captured in a constructor — runtime-mutable.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Belief promotion statement synthesis: ONE structured LLM call per belief create/revise phrasing the statement text (statementSource llm); any failure degrades to the deterministic template — the fold never depends on the model. Off = no LLM call ever runs, every statement is the deterministic template (statementSource template).',
  },
  {
    key: 'SCENES_BELIEF_NEGATION_DELTAS',
    category: 'scenes',
    // Read at call time (scene-flags.sceneBeliefNegationDeltasEnabled)
    // once per promotion run for the fold + per belief write for the
    // synthesis-prompt clause — never captured in a constructor — so a
    // flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Belief promotion negation deltas (#135 seam 1): admit a stateDelta with empty `to` and NON-empty `from` — a state REMOVAL (sold/quit/ended, the owns:true→false transition) — as a fold contribution with the canonical sentinel value none and priorValue = the delta’s from; the ordinary supersede chain then revises the belief (none vs the current value). Deltas with both ends empty stay dropped. Off = empty-to deltas are dropped exactly as before — byte-identical fold output and synthesis prompt.',
  },
  {
    key: 'SCENES_BELIEF_FIELD_FOLD',
    category: 'scenes',
    // Read at call time (scene-flags.sceneBeliefFieldFoldEnabled) once
    // per promotion run — never captured in a constructor — so a flip
    // takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Belief promotion slot resolution (0147): resolve each enricher-written field name through the SAME predicate registry the fact plane uses, and group beliefs on the resulting slot rather than on the free-text name. A belief then carries predicateId/predicateAlias and its identity is `(predicateAlias ?? predicateId)` — the same expression a fact resolves through — so one vocabulary serves both planes, PredicateConsolidationService folds both, and the BELIEFS_FACT_DAMPING join becomes id-to-id. It also keeps ONE active row per slot: a second one (a belief written under a different name for the same attribute) is stamped superseded into the head, which keeps its own value, and donates priorValue only when the head records none. REPLACED a lexical token-subset rule over a hand-written six-word stoplist of generic modifiers, which on a live tenant folded 0 of its 12 field names and missed all three pairs it existed to catch. Off = exact-string (subject, field) grouping and no registry calls — the pre-0147 behaviour, under which a belief simply has no cross-plane identity.',
  },
  {
    key: 'SCENES_VALUE_GATE_ENABLED',
    category: 'scenes',
    // Read at call time (scene-flags.sceneValueGateEnabled) ONCE per
    // promotion run — never captured in a constructor — so a flip takes
    // effect without restart and can never gate half a batch.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Memory-value promotion gate: the first real consumer of the 0106 scene VALUE VECTOR. The vector (novelty, contradiction, stateChange, identity, explicitness, estimatedUtility) is written by the composer’s deterministic scorer and by the MEASURED scene-scorer-v1 (SCENES_PREDICTION_BASELINE), but only `explicitness` was ever read (as belief confidence) — five of six dimensions were a write with no reader. On, belief promotion refuses a scene whose deltas carry nothing durable: a scene promotes unless novelty AND contradiction AND stateChange are all PRESENT and all below SCENES_VALUE_GATE_MIN. The policy is asymmetric on purpose — "promote unless demonstrably NOISE", never "promote only if demonstrably valuable" — so an UNDEFINED dimension short-circuits to promote (an unknown baseline is not a confident zero, the read-side half of the scene-scorer-v1 rule) and an unscored world (pack-projection scenes, legacy rows, enrichment off) promotes exactly as with the gate off. A scene with HIGH contradiction is the one whose deltas most deserve promotion — it changes the world model — so one high dimension is always enough. explicitness / identity / estimatedUtility are deliberately NOT gated on: the first is already the confidence signal, the second answers "about whom" rather than "worth remembering", and the third is the model’s self-report of the very question the gate decides. Refusals are counted (skippedLowValue in the run summary and the API response) and logged per scene with the dimensions that produced them. Off = the value dimensions are not even projected — byte-identical selection query, fold and rows.',
  },
  {
    key: 'SCENES_VALUE_GATE_MIN',
    category: 'scenes',
    // Read at call time (scene-flags.sceneValueGateMin) once per
    // promotion run — never captured in a constructor — runtime-mutable.
    defaultValue: '0.05',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Memory-value gate noise floor: a scene promotes unless novelty AND contradiction AND stateChange are all present and all BELOW this value. A number in [0,1]; unset/invalid → 0.05, deliberately near the bottom of the range so the gate only refuses scenes every producer scores at essentially zero. 0 makes the gate a no-op (every present dimension is ≥ 0) — the documented way to switch SCENES_VALUE_GATE_ENABLED on and watch skippedLowValue before committing to a threshold. Ignored unless that flag is on.',
  },
  {
    key: 'SCENES_PACK_DELTA_PROMOTION',
    category: 'scenes',
    // Read at call time (scene-flags.scenePackDeltaPromotionEnabled) ONCE
    // per promotion run — never captured in a constructor — so a flip
    // takes effect without restart and can never mix worlds mid-run.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Pack-projected state-delta promotion: the belief pass (SCENES_BELIEF_PROMOTION) additionally admits scenes of the pack-projection worlds (segmenterVersion pack:<packId>+<fp>, written by the 0110 projectors — the document scene-candidate writer and the capture-path mention producer — under PACK_MEMORY_PROJECTIONS_ENABLED). Their stateDeltas carry field = <packId>__<stateModel.field or stateModelId>, so a document ingested — or a turn captured — for a tenant with an installed pack finally reaches the belief plane; the pack namespace keeps two packs sharing a local attribute name in SEPARATE belief groups. Pack scenes carry no enrichmentVersion (their deltas come from the pack’s own reading, not the LLM enricher), so the widened leg drops that requirement for pack: worlds only. Unchanged: the #387 single-user fence (a tenant-global document has no userIds and is skipped fail-closed), the conflict guard, the supersede chain. The belief promoterVersion carries the pack world as provenance. NOTE: document scenes carry no conversationIds, so a non-zero SCENES_BELIEF_MIN_SCENES (a distinct-CONVERSATION floor) excludes document-projected beliefs by construction. Off = the selection query, its parameters and every stamp are byte-identical to the pre-flag pass — no pack scene is ever seen.',
  },
  {
    key: 'SCENES_PREDICTION_BASELINE',
    category: 'scenes',
    // Read at call time (scene-flags.scenePredictionBaselineEnabled) once
    // per enrichment run — never captured in a constructor — so a flip
    // takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Scene prediction baseline: makes scene surprise MEASURED instead of guessed. On, the enrichment pass (1) loads the scene user’s ACTIVE semantic_belief rows (0120) for the subjects the scene is about — ONE bounded SELECT per run — and stamps them onto the scene as baselineRef {beliefs, stampedAt, baselineVersion} (0106 FLEXIBLE, no migration); (2) renders that snapshot as an explicit “what the system believed BEFORE this scene” block and changes the instruction so contradiction/unexpectedDetails are reported as DEVIATION from that model rather than free-floating saliency (prompt version scene-gist-v2); (3) runs a deterministic no-model-call scorer (scene-scorer-v1) over the same baseline plus the scene’s stateDeltas and OVERRIDES contradiction / stateChange / identity in enrichedMemoryValue (scorerVersion composite scene-scorer-llm-v1+scene-scorer-v1) — a dimension it cannot measure keeps the model’s guess, since an unknown baseline is not a confident zero. Scenes failing the #387 single-user fence get no baseline — never scored against another user’s beliefs. Requires SCENES_LLM_ENRICHMENT. Off = zero extra queries, the byte-identical scene-gist-v1 prompt and enrichmentVersion composite, no baselineRef write.',
  },
  {
    key: 'SCENES_EVIDENCE_LINKS',
    category: 'scenes',
    // Read at call time (scene-flags.sceneEvidenceLinksEnabled) by the
    // admin 404 guard, the linker's defensive early return and the
    // composer's post-swap hook — never captured in a constructor — so a
    // flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Scene evidence links (MM-zoom PR1, migration 0123): after the composer swap (and via POST /v1/admin/maintenance/scenes/evidence-links), write typed scene-reconstructed_from->evidence_fragment|evidence_asset memory_support edges from the union of member episodes source.evidenceRefs — scenes become zoomable into the multimodal evidence substrate (0109). Replay-idempotent (INSERT RELATION IGNORE over UNIQUE(in,out,kind)); a world without evidence refs is a graceful no-op. Off = no edge is ever written, route 404s, composer hook skipped — byte-identical prod. GDPR cascades erase the edges regardless.',
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
  {
    key: 'MULTILINGUAL_LANG_FILTER_CONFIDENCE_GATE',
    category: 'pipeline',
    // Read at call time (resolveSearchTuning per request) — never
    // constructor-captured — so a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Confidence gate on the HARD same-language search exclusion: the `lang = q OR lang IS NONE` WHERE filter (and its cross-lingual backoff pass) fires only when the detected query language cleared the same high-confidence floor the Tier-1 soft boost trusts. Below the floor — including the detector\'s zero-evidence `en` fallback on stopword-less identifier queries like "acme-api webhooks rate limit" — the pass is single and unfiltered, so a fact mislabeled with another language is never hidden from a query that expressed no language at all (the code-memory k07 miss). An explicit dto.queryLang carries confidence 1 and always filters. Off (default) → any non-`und` detection filters, byte-identical.',
  },
  {
    key: 'MULTILINGUAL_LANG_STAMP_CONFIDENCE_GATE',
    category: 'pipeline',
    // Read per-call on the write paths (langStampConfidenceGateEnabled in
    // the language detector, consumed by fact-resolver buildResolveCall +
    // derive-row-builder) — never constructor-captured — so a flip takes
    // effect on the next ingest/derive without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Write-side mirror of MULTILINGUAL_LANG_FILTER_CONFIDENCE_GATE (migration 0127): a language DETECTION below the same shared high-confidence floor (0.5) is NOT stamped as the row\'s authoritative `lang` column — the hard same-language search filter\'s input — so a one-stopword mislabel ("120 requests per minute" → it@0.33 off the lone Italian "per", the k07 write-side root) stops polluting facts for every future lang-aware consumer. Applies to live fact ingest (fact-resolver) and derived rows (derive-row-builder). Only `lang` is withheld: the detected script stays, and on the fact-resolver path the attribution metadata records what the detector said (detectedLang + langConfidence + detectorVersion, langSource=detected) even while MULTILINGUAL_LANG_ATTRIBUTION is off — withholding is never silent. Inherited/explicit language paths are untouched (a weak detection does NOT divert to sourceLang inheritance — that stays strictly for detector-`und` objects). Off (default) → any non-`und` detection stamps, byte-identical.',
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
  // ── Multilingual (Tier 5) ───────────
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
  {
    key: 'INGEST_CODE_ALIAS_RESOLUTION',
    category: 'pipeline',
    // Read per-call in EntityUpsertService (process.env), never
    // constructor-captured — a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Alias-aware entity resolution for code identifiers (the code-memory battery k10 identity class): a module mentioned by FILE PATH ("src/gateway/webhook-dispatcher.ts") and by the SYMBOL it defines ("WebhookDispatcher") resolves to ONE entity. The path↔symbol mapping is derived DETERMINISTICALLY from filesystem naming conventions (basename minus extension, kebab/snake/dot parts PascalCased) — no embeddings, no LLM. Conservative by construction: only source-code extensions, only >= 2-hump PascalCase symbols (README.md and single capitalized words never alias), only a UNIQUE exact-normalized match is reused, and only at creation time — existing twins are never merged retroactively. Tenant-global scope only (userId IS NONE fence, same as the canonical-name match). Off (default) → byte-identical, per-phrasing twins form as before.',
  },
  {
    key: 'INGEST_ARTICLE_NORMALIZATION',
    category: 'pipeline',
    // Read per-call in EntityUpsertService (process.env), never
    // constructor-captured — a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Article-insensitive entity reuse (the state-transitions s07 entity-split class): the extractor coins one referent with and without a leading English article across turns ("the office lease" vs "office lease"), splitting it into two entities — every slot-keyed consumer (conflict formation, timelines, competing pairs) then goes blind to the collision. On, the canonical-name lookup is widened to the leading-article VARIANTS of the name (stripped + the/a/an re-prefixed) after the exact match misses; only a UNIQUE variant match is reused, stored canonicalName is never rewritten, and the same tenant-global userId IS NONE fence applies. Off (default) → byte-identical, per-article twins form as before.',
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
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Strict-space serving guard: when on, EmbedderService refuses (503) to serve a query embedded in a space INCOMPATIBLE (different dim / model / norm) with the primary configured space — the warmup-window failover from bge-m3 (1024) to the OpenAI fallback (1536) is the canonical case — instead of silently cross-space-comparing against the target rows. On by default since the 2026-09-08 runtime audit made it the P1 fix for search taking foreign vectors during warmup. Set `0` to restore the old unsafe read path; writes stay guarded either way.',
  },
  {
    key: 'EMBEDDING_SPACE_DUAL_WRITE',
    category: 'embedder',
    // Read per-call in EmbeddingSpaceService, not the constructor.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Zero-downtime migration phase 1: unlock POST /v1/admin/embedding-space/begin, which records dual-write arming in embedding_space_state. NOT YET WIRED: no write site consults targetSpaceFor(), and no table has a second vector column for a target-space vector to land in, so arming this records state and produces NO second vector — turning it on changes no behaviour at all. Off (default) → beginMigration refuses (400). The per-write-site wiring is programme item E7/E8 in docs/roadmap/embedding-spaces-2026-09.md; do not run the documented migration against a corpus until it lands.',
  },
  {
    key: 'EMBEDDING_SPACE_ACTIVE',
    category: 'embedder',
    // Read per-call in EmbeddingSpaceService, not the constructor.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Zero-downtime migration phase 3: unlock POST /v1/admin/embedding-space/cutover, which atomically flips activeSpace in embedding_space_state. NOT YET WIRED: no read path consults activeSpaceFor(), so the cutover flips a field nothing reads — an operator can run begin → reindex → cutover to completion and change NOTHING about what is served. Off (default) → the cutover surface refuses (400), which is the honest state. Wiring the resolver into the 13 cosine sites, the 4 KNN sites and the resolve_fact dedup gate is programme item E9 in docs/roadmap/embedding-spaces-2026-09.md.',
  },
  // ── Cost ────────────────────────────────────────────
  {
    key: 'COST_CHAT_PROMPT_USD_PER_MTOK',
    category: 'cost',
    defaultValue: '0.2',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'COST_CHAT_COMPLETION_USD_PER_MTOK',
    category: 'cost',
    defaultValue: '1.2',
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
];
