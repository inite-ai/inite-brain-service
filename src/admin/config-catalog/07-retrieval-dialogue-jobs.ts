import type { ConfigCatalogSpec } from '../config-catalog.data';

/** Rows 3706–4368 of the catalogue, in order (see config-catalog.data.ts). */
export const CATALOG_PART_07: ConfigCatalogSpec[] = [
  {
    key: 'BELIEFS_SERVING_LANE',
    category: 'pipeline',
    // Read at call time (common/beliefs-flags.ts) — never captured in a
    // constructor — so a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Belief serving lane (repeals the 0120 shadow doctrine behind this default-off flag): synthesize retrieves the caller's ACTIVE semantic_belief rows matching the query (BM25 over the 0126 statement index + a dense leg that stays empty while embedding is write-dead) and renders them as a current-state prompt section for BOTH generator and verifier; the generator schema gains citedBeliefIds and cited ids resolve through the rendered-set fence into belief-arm evidenceCitations (so a belief-grounded answer passes FOVEA_REQUIRE_CITATIONS and carries unrollable provenance); 0107 outcome rows land under subjectKind 'belief'. SCOPED-USER-ONLY: the lane fires only when synthesize is called with a userId — an unscoped/M2M request serves NO belief lines (stricter than GET /v1/beliefs by design: blending one user's state into an unscoped answer is a cross-user leak). Off (default) → no query, no section, no schema field — prompts and serving byte-identical.",
  },
  {
    key: 'BELIEFS_FACT_DAMPING',
    category: 'pipeline',
    // Read at call time (common/beliefs-flags.ts) — never captured in a
    // constructor — so a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Belief-aware fact damping (PR-B, the serving-lane companion pass): after the update-story/grounding-quote suffix maps, the prompt-side pass suffixes " (superseded by current belief: <field> = <value>)" onto — and STABLY demotes below the non-contradicted lines (a stable partition, never a re-sort) — every fact line that a lane-matched CURRENT belief contradicts: same free-text (subject, field) key as the fact’s (canonicalName, predicate) after trim/case normalization with a DIFFERENT normalized value (equal value ⇒ untouched; conservative exact matching, never fuzzy; belief lines themselves untouched). ONE canonical computation feeds the generator, the verifier and the fragment-zoom re-verify (three-consumer parity by construction); the V13 refine round re-applies the pass to its refined evidence against the same matched beliefs. Outcomes land on brain_belief_damping_total{outcome}. Requires BELIEFS_SERVING_LANE (a no-op without the lane’s matched beliefs — boot validation warns on the inconsistent pair). Off (default) → byte-identical.',
  },
  {
    key: 'BELIEFS_LANE_DATE_DISAMBIGUATION',
    category: 'pipeline',
    // Read at call time (common/beliefs-flags.ts) — never captured in a
    // constructor — so a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Belief-lane date disambiguation (memory-fitness D4: the generator’s date block teaches "(as of YYYY-MM-DD)" as an answer-bearing EVENT-date stamp, but a belief line’s day is the belief REVISION’s validFrom — so "when did X happen" questions served the revision date instead of the event fact’s date). When on, BeliefLaneService renders ", belief current since <day>" in place of ", as of <day>" — ONE render site, so the generator, the verifier and the fragment-zoom re-verify all read the same disambiguated lines (three-consumer parity by construction) — and both generator belief-section header variants state that a belief-line date is when the belief last changed, never the asked-about event’s date (take event dates from the facts). A no-op without BELIEFS_SERVING_LANE (no lane → no belief lines). Off (default) → byte-identical lines and prompts.',
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
    key: 'PROVENANCE_EPISODE_NEIGHBOURS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, read side: the one-hop GET /v1/facts/:id/provenance read widens to the ±radius sibling turns of the SAME conversation around each primary grounding turn (radius = PROVENANCE_EPISODE_NEIGHBOUR_RADIUS, clamped 1..3) — a mention-extracted fact stamps exactly ONE turn, so a verbatim constraint in the neighbouring paraphrased turn is otherwise unreachable from the fact. Neighbours are fetched through the shared episode read port with the IDENTICAL fences as the primary fetch (PII gate + fail-closed user pin keyed to the same userId + scope-tag fence) and carry relation:'neighbour' on the wire; primary episodes keep their exact shape and always serve — neighbours only fill the remaining PROVENANCE_CLOSURE_MAX_EPISODES budget, admitted chronologically. Off (default) → no window query is issued and the response is byte-identical (no relation key).",
  },
  {
    key: 'PROVENANCE_EPISODE_NEIGHBOUR_RADIUS',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Sibling-turn radius of the PROVENANCE_EPISODE_NEIGHBOURS widening — turns fetched BEFORE and AFTER each primary grounding turn within the same conversation. Clamped to 1..3; unset/invalid → 1. The served union stays bounded by PROVENANCE_CLOSURE_MAX_EPISODES regardless of the radius.',
  },
  {
    key: 'PROJECTIONS_API_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Raw-substrate driver v1, surface 3: derived surfaces as first-class records (migration 0076) — GET /v1/projections lists every derived world with status/watermark/builder/stats plus the live read pin; POST /v1/projections/:name/rebuild (brain:admin) is the public verb over the maintenance batch engine (v1 rebuilds "facts" via the session-window deriver). The registry observes builder lifecycles (building/built/live/residual/failed); gc deletes rows for reaped worlds. On by default. Off → routes answer 404.',
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
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Rolling user profile v1 (docs/user-profile-api.md): GET /v1/users/:userId/profile — a deterministic query-time assembly of the active facts visible in one end-user's scope (ingested user-stamped facts + the pinned derived world's typed atoms), grouped by predicate/aspect, persona_attr-first, capped per aspect and globally, rendered as prompt-injectable profileText. No LLM calls. User-bound tokens read only their own profile (403 on mismatch); PII-fenced predicates require brain:read_pii. On by default — no LLM calls, no configuration, nothing to set up. Off → routes answer 404.",
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
    key: 'INGEST_PREDICATE_INDEX_TEXT',
    category: 'embedder',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Humanized predicate in the fact embedding basis (code-memory battery k07): append the predicate as natural words (`rate_limit` → "rate limit"; pack `<packId>__` prefix stripped; skipped when the words are already tokens of the text) to the embedded `predicate: object`, so the vector matches queries that phrase the predicate in natural language. Worst-hit were harvested literal facts (rate_limit / service_port / http_status / …) whose objects are bare values. Parity with the lexical leg: migration 0007 searchHaystack already carries the underscore→space form for BM25. Write-time only — changes the embedding basis for NEW facts; existing rows are not re-embedded (re-ingest to benefit).',
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
    key: 'EXTRACTOR_LITERAL_HARVEST',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Deterministic literal-harvest lane (memory-fitness lever #1, Design A): a fixed set of regex rules over the input harvests technical literals the closed-vocab LLM extraction drops — service ports, rate limits ("50 requests per minute"), HTTP status codes, ALL_CAPS / dotted / camelCase identifiers, naming-convention prefixes ("LSYNC_") — as span-grounded facts (valueSpan is an exact input substring by construction), attributed by clause overlap with speaker fallback, deduped against the LLM facts, capped at 6 per turn, and unioned into the result AFTER denoise. Pure code: no second LLM path, no prompt change. Pairs with the six technical-literal core predicates (rate_limit, service_port, naming_prefix, identifier, http_status, duration_limit). Off (default) → byte-identical extraction. Requires re-ingest.',
  },
  {
    key: 'EXTRACTOR_STATE_VERB_HARVEST',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Deterministic state-verb harvest lane (state-transition battery follow-up) — sibling of EXTRACTOR_LITERAL_HARVEST: a fixed past-tense transition lexicon (acquire: bought/joined/signed up for/…; dispose: sold/quit/returned/cancelled/…; change: moved to/switched to/replaced/…) harvests COMPLETED state transitions the closed-vocab LLM extraction drops ("quit the chess club", "returned the standing desk") as span-grounded `state_change` facts (the object is the verbatim verb phrase, so valueSpan is an exact input substring by construction), attributed by clause overlap with speaker fallback, guarded against intentions and negations ("thinking about selling", "haven\'t sold", "will quit" harvest nothing), deduped against LLM + literal-harvest facts, capped at 6 per turn, and unioned into the result AFTER the literal lane. Pure code: no second LLM path, no prompt change. Pairs with the `state_change` core predicate (append_only — the timeline of transitions is the point). Off (default) → byte-identical extraction. Requires re-ingest.',
  },
  {
    key: 'EXTRACTOR_TRANSITION_CLASSIFIER',
    category: 'extractor',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'Language-agnostic state-transition classifier lane (semantic stage of the state-transition battery follow-up, generalizing EXTRACTOR_STATE_VERB_HARVEST to out-of-lexicon verbs and Russian): compromise-based English morphology plus a bounded Russian past-tense matcher find candidate verb clauses (past-tense, non-negated, non-hypothetical, with a complement), then embedding-prototype matching classifies each clause as completed_acquire / completed_dispose / completed_change / intention / unrelated by max-cosine against a fixed EN+RU prototype bank (BGE-M3 is multilingual, so the classifier generalizes across input languages by construction). Accepted clauses (completed_* above the calibrated score floor + runner-up margin — see eval:transition-calibration) land as span-grounded `state_change` facts with the same holder binding as the lexicon lane; a sentence the lexicon lane already harvested is deferred whole, so the two lanes compose without double emission. Designed and calibrated for EMBEDDER_PROVIDER=bge-m3; with the OpenAI embedder the thresholds are uncalibrated. Off (default) → byte-identical extraction, the embedder is never called. Requires re-ingest.',
  },
  {
    key: 'STATS_VIEWS_ENABLED',
    category: 'misc',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Tenant counter reads (StatsService.overview Usage page, admin dashboard per-tenant counters) come from the 0088 incrementally-maintained count() rollup tables (stats_entity_total / stats_fact_by_status / stats_community_total) instead of live GROUP aggregates. Counts only — SurrealDB incremental view maintenance is exact for count() but has known upstream bugs for median/stddev-class aggregates. The view path bypasses the 30s LRU (the view IS the cache); moving-window counts (facts last 7d, dead-letter/forgotten last 24h) stay live in both paths. A failing view read (pre-0088 tenant) logs once per tenant and falls back to live counting. On by default — the fallback makes it safe on any tenant, so the switch was only costing the fast path. Off → byte-identical pre-0088 behavior.',
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
  {
    key: 'PREDICATE_SEMANTICS_MODEL',
    category: 'registry',
    // Captured in the judge's constructor — a live flip needs a restart.
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Model for the predicate CARDINALITY judge: when the extractor coins a predicate the registry has never seen, one small strict-JSON call decides whether it is `single_active` (a state with one true value at a time — deploy_target, pilot_launch_date, payout_cutoff: a new value RETIRES the old one) or `append_only` (an event / preference / multi-valued field, where history is the point). Before this pass existed every coined predicate was append_only, which means no conflict is possible at ingest — the prior value stayed active forever beside the new one, so supersession and the competing-facts surface only ever worked for the ~15 seeded single_active predicates. Ambiguity, a missing OPENAI_API_KEY, a throw or an unparseable answer all resolve to append_only (the historical behaviour), so the pass only ever ADDS supersession where the judge is confident. Runs ONCE per novel predicate per tenant — the row is then cached in the registry — and never re-classifies an aliased, seeded or operator-edited predicate. Empty (default) = OPENAI_CHAT_MODEL.',
  },
  {
    key: 'PREDICATE_SEMANTICS_CONCURRENCY',
    category: 'registry',
    defaultValue: '4',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Max concurrent predicate-cardinality judge calls (PREDICATE_SEMANTICS_MODEL). The calls sit on the ingest write path, so this bounds how much a cold tenant — which coins most of its vocabulary in the first few documents — can fan out.',
  },
  {
    key: 'PREDICATE_IDENTITY_MODEL',
    category: 'registry',
    // Captured in the judge's constructor — a live flip needs a restart.
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Model for the predicate IDENTITY judge, used by the consolidation pass (POST /v1/admin/predicates/consolidate) to decide whether two names in a tenant\u2019s vocabulary denote the same attribute. Empty (default) = OPENAI_CHAT_MODEL.',
  },
  {
    key: 'PREDICATE_IDENTITY_CONCURRENCY',
    category: 'registry',
    defaultValue: '4',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Max concurrent predicate-identity judge calls. These run inside the consolidation PASS (POST /v1/admin/predicates/consolidate), never on the ingest write path \u2014 one call per coined predicate whose blocking set is non-empty.',
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
];
