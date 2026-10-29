import type { ConfigCatalogSpec } from '../config-catalog.data';

/** Rows 1–554 of the catalogue, in order (see config-catalog.data.ts). */
export const CATALOG_PART_01: ConfigCatalogSpec[] = [
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
    key: 'EXTRACTION_BATCH_WINDOW_SECONDS',
    category: 'extractor',
    defaultValue: '20',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'How long captures gather before one extract_documents pass reads them: every write of one window asks for the same job.',
  },
  {
    key: 'EXTRACTION_SOURCE',
    category: 'extractor',
    defaultValue: 'server',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Who reads captured documents into facts. `server` (default): the background extract_documents pass calls the configured extraction model. `harness`: the server spends no model key on extraction — the pass leaves documents pending (no triage, no read) and the connected agent reads them with its own model through the MCP tools take_extraction_work / submit_extraction, whose replies go through the same grounding, staging and commit. Every other server-side chat call (judges, scene summaries, synthesize), Jev decisions and the Cohere reranker are refused before the network, and OPENAI_API_KEY may be unset with EMBEDDER_PROVIDER=bge-m3.',
  },
  {
    key: 'EXTRACTION_CONVERSATION_SETTLE_SECONDS',
    category: 'extractor',
    defaultValue: '120',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "A conversation's turns are read once no turn has arrived on it for this long — the whole stretch in one extraction call instead of a call per turn. Standalone documents do not wait.",
  },
  {
    key: 'EXTRACTION_CONVERSATION_MAX_WAIT_SECONDS',
    category: 'extractor',
    defaultValue: '600',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Upper bound on the settle wait: a conversation that never goes quiet is read once its oldest unread turn has waited this long (or once its unread turns fill one group).',
  },
  {
    key: 'EXTRACTION_GROUP_MAX_CHARS',
    category: 'extractor',
    defaultValue: '12000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Characters of turn text one extraction call reads. A longer stretch is split; a single turn or document over it is read alone, chunk by chunk.',
  },
  {
    key: 'EXTRACTION_PASS_CONCURRENCY',
    category: 'extractor',
    defaultValue: '4',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Memory scopes (users, and the tenant's shared memory) one extract_documents pass reads at once. Within a scope groups are read one after another, what something asked for first, then in the order they were said — each committed before the next is read, and each read against what was said before it. The LLM concurrency cap (OPENAI_CONCURRENCY) still bounds the calls.",
  },
  {
    key: 'EXTRACTION_TRIAGE_FLOOR',
    category: 'extractor',
    defaultValue: '0.5',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Probability at or above which a D1 triage question (durable, change, correction, instruction, identity) counts as yes when deciding how deep captured text is read (documents/read-depth.ts): only a change, correction, instruction or identity, notable text, or text naming an entity in use is read when it arrives (in full); the rest is kept raw — served from its turns — and read when an answer cites it, a correction lands beside it, or the nightly idle budget (EXTRACTION_IDLE_BUDGET_DOCS) reaches it. Default = the decision boundary; to be fitted on labelled corpora to the declared gate recall.',
  },
  {
    key: 'EXTRACTION_IDLE_BUDGET_DOCS',
    category: 'extractor',
    defaultValue: '64',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Deferred documents the nightly idle pass reads per tenant, one sample each, most salient first (by the triage stamps). Text is read on demand: only what is urgent, notable, in use or asked for is read when it arrives; routine text is kept raw — served from its turns — until an answer cites it, a correction lands beside it, or this budget reaches it. 0 = read only on demand.',
  },
  {
    key: 'EXTRACTION_GROUP_MAX_DOCS',
    category: 'extractor',
    defaultValue: '16',
    runtimeMutable: true,
    isBooleanFlag: false,
    description: 'Turns one extraction call reads at most.',
  },
  {
    key: 'EXTRACTOR_SC_PASSES',
    category: 'extractor',
    defaultValue: '3',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Self-consistency passes per extraction: N samples of the same prompt, unioned by semantic cluster with per-fact agreement/entropy. 3 (default since 2026-09-20; measured memory-fitness 32/32, state-transitions 11/12, T0 = baseline) — the write is the one stochastic step never re-run, so it gets the votes; 1 = a single sample (cheaper, misses ~15% of edges run to run).',
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
    key: 'BGE_M3_CONCURRENCY',
    category: 'embedder',
    defaultValue: '2',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'BGE_M3_WORKER',
    category: 'embedder',
    defaultValue: '1',
    runtimeMutable: false,
    isBooleanFlag: true,
    description:
      'With EMBEDDER_PROVIDER=bge-m3: ONNX inference runs in a dedicated worker_thread so the main event loop keeps serving HTTP while embeds compute. 0 = in-thread inference — the event loop stops for every embed (hundreds of ms per call on a small host; an ingest embeds a batch), which is what production ran until 2026-09.',
  },
  {
    key: 'BGE_M3_REMOTE_API_KEY',
    category: 'embedder',
    defaultValue: '',
    runtimeMutable: false,
    isBooleanFlag: false,
    secret: true,
    description:
      'With EMBEDDER_PROVIDER=bge-m3: the key for the same model served over HTTP (BGE_M3_REMOTE_URL). Set ⇒ the remote serves first — concurrent embeds coalesce into one request — and the local model stays loaded as the fallback, taking over for 60 s after any remote failure. Measured on the 2-vCPU droplet: 100 texts in 0.8 s remote vs 51 s local under ingest load; a single query embed 0.2–0.47 s, level with local; $0.01 per million tokens. Same space: cosine 0.985–0.989 with the local q8 vectors, retrieval order preserved, so no reindex is required. Unset ⇒ local only, and nothing leaves the host.',
  },
  {
    key: 'BGE_M3_REMOTE_URL',
    category: 'embedder',
    defaultValue: 'https://openrouter.ai/api/v1/embeddings',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'OpenAI-compatible embeddings endpoint for the remote bge-m3 runtime. Only read when BGE_M3_REMOTE_API_KEY is set.',
  },
  {
    key: 'BGE_M3_REMOTE_MODEL',
    category: 'embedder',
    defaultValue: 'baai/bge-m3',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Model id at BGE_M3_REMOTE_URL. It must BE bge-m3 — the vectors land in the bge-m3 space, and a response that is not 1024 finite numbers is refused, but a different 1024-wide model would pass that check and silently mix spaces.',
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
  {
    key: 'OUTCOME_TX_WRITES',
    category: 'audit',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Transactional idempotent outcome writes: raw append + stat fold in ONE BEGIN/COMMIT with deterministic record ids + INSERT IGNORE, an in-tx pre-select gates the stat deltas so a replayed batch folds nothing twice, and an OCC abort gets exactly one retry. Off = the legacy two-statement write shape, byte-identical.',
  },
  {
    key: 'OUTCOME_DECISION_CAPTURE',
    category: 'audit',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Decision-context telemetry (0119): content-free memory_decision rows at the abstain gate and the L3 escalation trigger, plus the decisionId join columns on memory_outcome / focus_signal_sample and the nightly decision prune leg. Independent master — not coupled to OUTCOME_TELEMETRY_ENABLED. On by default since the read side landed (GET /v1/admin/memory/decisions + /stats); rows are content-free, one per decision seam per request, bounded by the nightly prune.',
  },
  {
    key: 'OUTCOME_DECISION_RETENTION_DAYS',
    category: 'audit',
    defaultValue: '30',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Days memory_decision rows are kept; the 03:41 UTC prune cron deletes older rows in bounded batches (third leg, gated on OUTCOME_DECISION_CAPTURE).',
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
    key: 'CHAT_ROUTE_NLI_MODEL',
    category: 'router',
    defaultValue: 'Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'HuggingFace repo of the zero-shot NLI intent model (transformers.js ONNX export, must cover English + Russian). Xenova/distilbert-base-multilingual-cased-finetuned-mnli, Xenova/mDeBERTa-v3-base-mnli-xnli and Xenova/xlm-roberta-large-xnli answer HTTP 401 on the Hub and never warm. A gated/removed repo shows as degraded on /v1/admin/health/components with the reason.',
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
];
