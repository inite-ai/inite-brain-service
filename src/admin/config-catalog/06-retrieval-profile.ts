import type { ConfigCatalogSpec } from '../config-catalog.data';

/** Rows 3013–3705 of the catalogue, in order (see config-catalog.data.ts). */
export const CATALOG_PART_06: ConfigCatalogSpec[] = [
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
    // Genre-dependent: this is what the DEFAULT genre (assistant_chat)
    // resolves. `dialogue` presets 'always'. Pinned by the
    // resolved-default gate in config-catalog-truth.unit-spec.
    defaultValue: 'shape_conditioned',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'How verbatim L0 evidence reaches answers: off | shape_conditioned (engine default — quotes only when the question asks for conversational content) | always (all three verbatim lanes unconditional as a prompt appendix; diary-genre profile) | fused (segments become scored, reranked, citable SearchHits inside the search pipeline instead of an appendix) | routed (per-query dispatch: verbatim-shaped questions — the one class where fused measured positive, SSA +7.1pp vs SSU −10.0/TR −8.3 — take the fused path, everything else stays shape_conditioned). Unset → derived from the legacy lane flags.',
  },
  {
    key: 'RETRIEVAL_DATE_ANCHORING',
    category: 'pipeline',
    // Genre-dependent: the DEFAULT genre (assistant_chat) resolves
    // 'absolute'; `dialogue` presets 'none'.
    defaultValue: 'absolute',
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
    key: 'RETRIEVAL_VERIFIER_EFFORT',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "How hard the auditor may think: none | low | medium | high | xhigh. Unset (default) = the shared guard's `low`. It exists because the audit is the one call where MORE deliberation measured worse — gpt-6-luna at `low` spends reasoning tokens where gpt-5.6-luna spends none and reads the same evidence more strictly — so the audit model and its effort have to be chosen together. Measured 2026-09-24: auditing with gpt-6-luna at `none` scored state-transitions 10/12 against 11/12 with the pinned older model, i.e. dropping the effort does not buy the newer generation back.",
  },
  {
    key: 'RETRIEVAL_VERIFIER_MODEL',
    category: 'pipeline',
    defaultValue: 'gpt-5.6-luna',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Model for the verifier/auditor LLM call only — the generator keeps the synthesis model. Unset (default) = gpt-5.6-luna, the generation BEFORE the synthesis default, pinned deliberately: measured 2026-09-24 on the prod-parity stand, auditing with gpt-6-luna cost two memory-fitness points and both losses were abstentions on answers the evidence did support (it spends reasoning tokens at `low` effort where the older model spends none, and reads the same evidence more strictly). The V11 §2 strong-judge arm: under abstentionCalibration='verifier' the abstention decision quality is bounded by the audit model's judgment, so a tenant can pay for a stronger judge (e.g. gpt-5-mini) on exactly one call per answer without touching generation cost. Also overlayable per tenant via RETRIEVAL_PROFILE_OVERRIDES (verifierModel).",
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
      "Overfetch multiplier for the coverage scan legs' approximate KNN: SurrealDB applies WHERE gates AFTER the neighbor walk, so the walk requests k×overfetch candidates to survive gate filtering (pii/user scope on both lanes; the query_arc lane doubles the multiplier internally for its heavier gate stack — atomic/status/world gates). Capped at 4000 candidates per leg.",
  },
  {
    key: 'RETRIEVAL_UPDATE_STORY',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "V10 §2 update-story rendering (profile field updateStoryRendering): evidence facts that superseded an older value get a compact history suffix on their prompt line — '(previously: <value> — until <date>)' — built from the reverse supersededBy links (indexed since 0059; ≤3 chain generations, ≤3 entries per line). Restores the update STORY that knowledge_update golds ask for WITHOUT re-including superseded rows in retrieval — the v9lifecycle diagnosis: the bitemporal closure hid the old value at asOf and made the row worse. Prompt-side only: retrieval, ranking and citations untouched; the generator and the verifier read the same augmented lines. Off = byte-identical prompt.",
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
    // 'verifier' out of the box: the assistant_chat preset (the DEFAULT
    // genre) sets it. The entry said 'off', which is how a live stand
    // reported its abstention mode as off while it was running the
    // verifier gate. `dialogue`/`documents` resolve 'off'.
    defaultValue: 'verifier',
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
    // ON out of the box: the assistant_chat preset (the DEFAULT genre)
    // sets it, and this entry said '0' for as long as the preset has
    // existed — the admin screen reported a lever off while every stock
    // deployment ran it. `dialogue`/`documents` resolve '0'.
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'V13 read side of DERIVER_SCENE_TRACE (profile field sceneTraces): fact lines carry a "(context: …)" suffix from the stamped source.scene, so the generator and verifier see the situational anchor next to the proposition. Unstamped rows render as before; against worlds derived without the stamp the flag is byte-identical off. NOTE: defaultValue is the env fallback only — the assistant_chat genre preset (the default RETRIEVAL_GENRE) presets sceneTraces ON, so tenants on that genre render scene traces unless the env pins =0.',
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
      'Multiworld §10 facts-as-keys (profile field factsAsKeys; the LongMemEval design-study shape — facts as additional index KEYS +9.4% recall, facts as replacement VALUES hurt): each top evidence fact line carries ONE verbatim quote of its first grounding turn (" (source YYYY-MM-DD speaker: …)", 240-char cap) — the fact acts as the key, the raw turn is the served content. Generator and verifier read the same augmented lines (evidence parity). Off = byte-identical.',
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
    key: 'RETRIEVAL_FRAGMENT_LANE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "MM-zoom PR2 fragment retrieval lane (profile field fragmentLane): dense+BM25 (0124 lowercase FULLTEXT) over derived_representation.content — captions/OCR/ASR/text renders of registered media observations (0109) — rendered as a media-evidence prompt section that BOTH the generator and the verifier read (parity; the verifier takes the same lines as capabilityEvidenceLines). Full media fence stack inside the lane: tenant scope, asset-join user fence (fragment→asset ownership), fail-closed media PII gate on the fragment's piiClasses, 0112 modality consent (absent or stale checksum ⇒ lane EMPTY), availability != 'gone'; any error degrades to an empty section. Off = byte-identical prompts.",
  },
  {
    key: 'RETRIEVAL_SCENE_LANE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Scene retrieval lane (profile field sceneLane) — the FIRST serving reader of the episodic plane. BM25 (the 0106 scene_gist_search lowercase FULLTEXT index, V11 A2 or_terms disjunction) over memory_episode.gist, rendered as an episodic 'what happened, together, when' prompt section that BOTH the generator and the verifier read (parity), each line headed by its [memory_episode:...] id and carrying the scene's UTC time span plus — the payload's first consumer — unexpectedDetails as a notable-details clause (cap 2 scenes; a scene is the largest retrieval unit). Fence stack inside the lane: tenant scope, SCOPED-USER-ONLY (an unscoped/M2M caller gets NOTHING — a scene gist quotes verbatim member text), the 0117 per-member gate (own rows, plus userId-NONE rows whose userIds is [] or CONTAINS the caller, FAILING CLOSED on userIds IS NONE — not keyed to PRIVACY_SEGMENT_USER_FENCE, this lane has no legacy behavior to preserve), text PII gate (piiClass IS NONE without brain:read_pii), 0093 scope tags, and the version world the projection registry marks 'live'; any error degrades to an empty section. Scene-arm evidenceCitations ride this flag and are deliberately NOT accepted by FOVEA_REQUIRE_CITATIONS (a gist is a summary, not the record). OPERATOR NOTE: the lane serves only a 'live' scene world, and the composer promotes to 'live' only when this flag is on at build time — enabling it on a tenant whose scenes were built while it was off requires one composer re-run. Off (default) = no query, no section, byte-identical prompts.",
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
      'L3 anchor independence (profile field l3DirectAnchor): query-side anchor source consulted on every fired escalation beside the fact anchors (a fact naming a session is no proof that session holds the answer — the facts were retrieved by the same miss that made the escalation necessary). Recall-first BM25 episode hits on the query text (any of its words — lex-leg or_terms; PII/user-fenced, top 20) anchor their conversations; the merged aux anchors then feed the UNCHANGED ranking/caps/ladder. skipped_no_anchor then means "every enabled anchor source came up empty". brain_l3_anchor_source_total{source} traces which source fed each fired escalation. Off (with the sibling aux flags off) = byte-identical skipped_no_anchor.',
  },
  {
    key: 'RETRIEVAL_L3_SEGMENT_ANCHOR',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'L3 anchor independence (profile field l3SegmentAnchor): query-side anchor source consulted on every fired escalation beside the fact anchors. Dense + recall-first BM25 (or_terms) RRF-fused episode_segment hits (the windows the scheduled scene pass composes for every dirty conversation) (top 12, NO rerank — anchors need recall, not precision) anchor their conversations; merged anchors feed the unchanged L3 ranking/caps/ladder. Degrades to no contribution on any failure. Off = this source contributes nothing.',
  },
  {
    key: 'RETRIEVAL_L3_TEMPORAL_ANCHOR',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'L3 anchor independence (profile field l3TemporalAnchor): query-side anchor source consulted on every fired escalation beside the fact anchors. When the query names an absolute period (code-parsed, the RETRIEVAL_TIME_FILTER parser — no LLM), the conversations active in that period (top 10 by turn count, PII/user-fenced GROUP BY) anchor, scored by turn count. A query with no parseable period contributes nothing. Off = this source contributes nothing.',
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
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'L0 episode substrate (memory-substrate-redesign P1): store every ingested dialogue turn verbatim (P0-redacted, piiClass-tagged) BEFORE extraction — lossless, idempotent (INSERT IGNORE on conversationId+messageId), LLM- and embedder-free. Extraction failures stop losing turns; future derivers re-derive from here. On by default: the retained turn is what makes a memory inspectable and the derived world rebuildable. Off = turns are not stored and those two properties are gone; the cost of on is storage, not behaviour.',
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
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Raw-substrate driver v1 (docs/roadmap/raw-substrate-driver-2026-08.md): public read API over the L0 episode substrate — GET /v1/episodes (keyset cursor over occurredAt+id, filters conversationId/speaker/since/until) and GET /v1/episodes/export (NDJSON stream, paged internally). Lets any consumer build its own projection without touching SurrealDB. PII fence follows the read-lane precedent: without brain:read_pii only rows with empty piiClass are visible. On by default. Off → routes answer 404.',
  },
  {
    key: 'FACTS_API_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Fact read + provenance API ("show me why I remember this"): GET /v1/facts/:id serves the fact as stored (aspect/statement/confidence/validFrom, source attribution, retracted flag, derivedVersion) and GET /v1/facts/:id/provenance serves its verbatim grounding turns (source.episodeIds via the shared episode read port, text capped at 600 chars). Every miss is a 404 — tenant fence, fail-closed user scope (another user\'s fact is indistinguishable from absent), registry-backed row policy on scope-fenced predicates; episode text respects brain:read_pii. POST /v1/facts/:id/retract is deliberately NOT gated by this flag (write/GDPR path). On by default — it also governs whether the MCP fact-read tools are registered. Off → read routes answer 404 and the tools are absent.',
  },
  {
    key: 'BELIEFS_API_ENABLED',
    category: 'pipeline',
    // Read at call time (BeliefsController.assertEnabled) — never
    // captured in a constructor — so a flip takes effect without restart.
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Belief read API (Belief-B): GET /v1/beliefs/:id serves one semantic_belief revision as stored (free-text subject/field key, value/priorValue, statement, confidence, revision/status/supersededBy supersede chain, validFrom/validUntil, inline sourceSceneIds provenance, corroboration counters, promoterVersion) and GET /v1/beliefs lists by subject/field/status/userId with a capped page (default 25, max 100). Read-only — the Belief-A promotion pass (SCENES_BELIEF_PROMOTION) stays the only writer. Every miss is a 404 — tenant fence + fail-closed single-user scope (#387: a belief is always one user's; a user-bound token sees only its own, an unstamped row serves to no one); beliefs carry no piiClass and no registry predicate, so no PII/row-policy fence applies. On by default. Off → routes answer 404.",
  },
  {
    key: 'SCENES_API_ENABLED',
    category: 'pipeline',
    // Read at call time (ScenesController.assertEnabled) — never
    // captured in a constructor — so a flip takes effect without restart.
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Scene read API: GET /v1/scenes/:id serves one memory_episode scene as stored (label, canonical and enriched gist, time span, member episodes in order, conversation ids, knowledge-graph backlinks, consolidated facts, unexpected details, enrichment-owned state deltas, per-dimension memory value, confidence, segmenter world) and GET /v1/scenes lists the CURRENT world — the version the projection registry marks live, else the newest built one — newest scene first, filtered by conversationId / entityId / since / until / userId with a capped page (default 25, max 100). Read-only: the composer (SCENES_SEGMENTATION_ENABLED) stays the only writer. Before this surface the episodic plane had no reader outside the answer lane, so a belief's sourceSceneIds pointed at records nothing could open and the product UI could show no scene at all. Fences: tenant; user scope via pinUserScope (a user-bound token sees its own scenes plus tenant-global ones whose persisted member set is empty or contains it — the scene lane's 0117 gate; an unscoped M2M caller sees tenant-global scenes only and scopes to a user with ?userId= — the episode read port's contract, a gist quotes verbatim turns; an unstamped row serves to no one, fail-closed); text PII (piiClass IS NONE without brain:read_pii); 0093 scope tags. Every miss is a 404. `=0` → both routes 404 indistinguishably from an absent route.",
  },
];
