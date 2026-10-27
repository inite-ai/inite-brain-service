import type { ConfigCatalogSpec } from '../config-catalog.data';

/** Rows 1230–1647 of the catalogue, in order (see config-catalog.data.ts). */
export const CATALOG_PART_03: ConfigCatalogSpec[] = [
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
    description:
      'Required at boot (validateEnv) whatever EMBEDDER_PROVIDER says. EMBEDDER_PROVIDER=bge-m3 removes the key’s EMBEDDING role only; extraction, generation, verification, the window deriver, the chat router and the multi-hop planner each build an OpenAI client eagerly in their constructor, so there is no key-less deployment today.',
  },
  {
    key: 'OPENAI_CHAT_MODEL',
    category: 'auth',
    defaultValue: 'gpt-6-luna',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'The chat model behind extraction, generation, the deriver, scenes, beliefs, the router and every judge that does not name its own — NOT the verifier, which pins its own (RETRIEVAL_VERIFIER_MODEL). Default = the cost tier of the newest generation (gpt-6-luna, $0.10 / $0.50 per 1M). It replaced gpt-5.6-luna on 2026-09-24, measured on the prod-parity stand: gpt-5.6-luna everywhere scored memory-fitness 31/32 and state-transitions 10/12; gpt-6-luna everywhere 30/32 and 11/12; gpt-6-luna with the audit left on the older model 32/32 and 11/12. Every call goes through the shared reasoning guard (chatCallParams): a gpt-5.x / gpt-6 / o-series model rejects `temperature`, so the guard drops it and sets reasoning effort — `low` by default, `none` for one-token classifiers. Before gpt-5.6-luna it was gpt-4o-mini, which flip-flopped on identical entity pairs between runs.',
  },
  {
    key: 'ENTITY_JUDGE_MODEL',
    category: 'auth',
    defaultValue: 'gpt-5.6-luna',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'The model behind the same-entity judge (inline entity resolution at ingest and the dreams dedup). Its own default, not OPENAI_CHAT_MODEL: measured on identical cross-script pairs gpt-4o-mini flip-flopped between runs while a current model answered consistently, and the judge is one call per new entity with a neighbour, so it gets the cheapest current-generation model. Reasoning models are called through the shared guard at low effort.',
  },
  {
    key: 'TYPESAFE_API_KEY',
    category: 'auth',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    secret: true,
    description:
      'Key for the System One decision plane (TypeSafe Jev, POST /v1/systemone). Without it every decision lane is off and each judge runs on the chat model exactly as before — the plane can never degrade a judgement into a default verdict. Jev bills input only ($0.042 / 1M, output free) and answers every question of a request in parallel, which is why a lane on this plane may ask ten typed questions where the chat model was asked one.',
  },
  {
    key: 'TYPESAFE_BASE_URL',
    category: 'auth',
    defaultValue: 'https://api.typesafe.ai',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Where the decision plane sends `POST <base>/v1/systemone`. Two places serve the same protocol: the vendor (default) and OpenRouter — set `https://openrouter.ai/api` and put the OpenRouter key in TYPESAFE_API_KEY to bill decisions to that account instead of a second vendor account. OpenRouter maps a bare model id (`jev-latest`, `jev-1.13`) into its `typesafe/` namespace and returns the same answer shape plus `usage.cost`, which lands on the call span as `gen_ai.usage.cost`.',
  },
  {
    key: 'TYPESAFE_MODEL',
    category: 'auth',
    defaultValue: 'jev-latest',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'The System One model id. `jev-latest` tracks the current stable release; pin an exact version (e.g. jev-1.13.0) when a measurement has to stay reproducible.',
  },
  {
    key: 'TYPESAFE_TIMEOUT_MS',
    category: 'auth',
    defaultValue: '10000',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Per-decision timeout. A decision is a sub-second call by design, so this is a failure bound, not a budget: on a timeout the lane falls back to the chat-model path it had.',
  },
  {
    key: 'TYPESAFE_MAX_RETRIES',
    category: 'auth',
    defaultValue: '3',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Retries for 429 (rate limit) and 529 (overloaded) with exponential backoff. 401/422 are never retried — an invalid key or a malformed question does not become valid by asking again.',
  },
  {
    key: 'TYPESAFE_CONCURRENCY',
    category: 'auth',
    defaultValue: '16',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'In-flight decisions cap. Higher than the OpenAI one because a decision is ~0.1 s and the published limits are 1,200 requests/minute and 250k tokens/second.',
  },
  {
    key: 'DECISIONS_LANES',
    category: 'auth',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Comma-separated lanes served by the decision plane, or `all`. Known lanes: entity_judge, verifier, predicate_identity, predicate_semantics, reranker, chat_router, dream_resolver, dream_corroborate, extraction_check (every extracted fact checked against the text and its context before it is written — a confident "not stated" drops it). Empty (default) = every lane stays on the chat model. Opted in one at a time on purpose: whether a lane is better on the decision plane is a measurement per lane AND per language — the model documents non-English as weaker, and this graph is multilingual.',
  },
  {
    key: 'DECISIONS_CONFIDENCE_FLOOR',
    category: 'auth',
    defaultValue: '0.7',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'How certain a decision must be before the lane acts on it. Below the floor the lane escalates to the reasoning model it used before — that escalation is what makes a cheap first pass safe. A noul answer is measured by its distance from the coin flip (0.95 → 0.9), a choice or score by the concentration the model reports. Override per lane with DECISIONS_CONFIDENCE_FLOOR_<LANE>.',
  },
  {
    key: 'OPENAI_OFFLINE_SERVICE_TIER',
    category: 'auth',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Processing tier for the calls nobody is waiting on — the background extraction of captured documents, scene building, belief promotion, the composers, the dream jobs, strategy distillation, code indexing. `flex` is the SAME model at the Batch price (half) in exchange for slower service and an occasional 429 when capacity is short, which is not charged; `auto` falls back to standard on a retry. Unset (default) = the standard tier and a byte-identical request. The request path — search, synthesis, and an explicit sync ingest — never asks for it: there latency is the product. Probed 2026-09-23: gpt-5.6-luna, gpt-6-luna and gpt-6-sol all accept it.',
  },
  {
    key: 'OPENAI_BASE_URL',
    category: 'auth',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Primary chat provider endpoint (OpenAI-compatible). Unset = OpenAI itself. Pair with OPENAI_MODEL_PREFIX when the endpoint serves the models under a vendor namespace (OpenRouter: `openai/`).',
  },
  {
    key: 'OPENAI_MODEL_PREFIX',
    category: 'auth',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Namespace prepended to every chat model id on the primary provider (`openai/` on OpenRouter). Unset = the ids as configured.',
  },
  {
    key: 'OPENAI_FALLBACK_BASE_URL',
    category: 'auth',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Chat fallback provider (OpenAI-compatible, e.g. https://openrouter.ai/api/v1). A call the primary refuses for a reason about the account or the provider — 429 insufficient_quota, 401/403, 5xx past the SDK retries — is re-sent here with the model id namespaced (OPENAI_FALLBACK_MODEL_PREFIX); after a quota refusal the primary is skipped for 10 minutes. A refusal about the request itself (400, a plain rate limit) is not failed over. Unset (with the key) = no fallback, the plain SDK client.',
  },
  {
    key: 'OPENAI_FALLBACK_API_KEY',
    category: 'auth',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    secret: true,
    description: 'API key for OPENAI_FALLBACK_BASE_URL.',
  },
  {
    key: 'OPENAI_FALLBACK_MODEL_PREFIX',
    category: 'auth',
    defaultValue: 'openai/',
    runtimeMutable: false,
    isBooleanFlag: false,
    description: 'Namespace of the chat model ids on the fallback provider.',
  },
  {
    key: 'OPENAI_TIMEOUT_MS',
    category: 'auth',
    defaultValue: '30000',
    runtimeMutable: false,
    isBooleanFlag: false,
  },
  {
    key: 'OPENAI_OFFLINE_TIMEOUT_MS',
    category: 'auth',
    defaultValue: '180000',
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
  {
    key: 'CONFLICT_DIRECT_FACT_SLOT',
    category: 'conflict',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Direct-fact conflict semantics. When on, the typed direct ingest path (record_fact / POST /v1/ingest/fact) promotes an unknown-predicate fact — one that resolves to the registry '__default__' append_only fallback — to 'bitemporal', so two direct writes on the same (entity, predicate) slot with contradicting objects form a conflict (close-scored → COMPETING for get_competing_facts, clear winner → SUPERSEDED) instead of both landing INSERTED forever. Mention-extracted bulk and the DEFAULT_FALLBACK policy itself are untouched; known predicates keep their registry semantics. Off (default) = append_only passthrough, byte-identical.",
  },
  {
    key: 'CONFLICT_MENTION_FACT_SLOT',
    category: 'conflict',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Mention-path conflict semantics. When on, a mention/extraction-path fact whose registry policy is 'single_active' — the branch that supersedes unconditionally and can never surface a COMPETING pair — is promoted to 'bitemporal', so two conversations asserting contradictory values of one (userId, entity, predicate) slot form a conflict (close-scored → COMPETING, both sides linked and served; clear winner → SUPERSEDED; equal value from a different origin → CORROBORATED) instead of the second silently replacing the first. Candidates stay per-user scope-local (0055). The append_only open-vocabulary bulk, DEFAULT_FALLBACK, and the direct typed path are untouched. Off (default) = registry passthrough, byte-identical.",
  },
  {
    key: 'CONFLICT_SLOT_CANONICALIZATION',
    category: 'conflict',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Write-side slot canonicalization. The conflict machinery pairs only identical (userId, entity, predicate) slots, but the extractor legitimately splits one contradicted attribute across two predicates — 'lease runs until December 2026' is a duration phrase (duration_limit, append_only) while 'lease ends in September 2026' is a lifecycle claim (status, single_active) — so no collision structurally exists and CONFLICT_MENTION_FACT_SLOT is starved (state-transitions s07). When on, a mention-path fact whose predicate sits in a small declared alias table (duration_limit → status) AND whose object carries an explicit calendar anchor (full month name + 4-digit year, or an ISO date) resolves in the canonical single-value slot instead, re-embedded with the canonical slot text, so both arms of the contradiction meet in one slot and the normal single_active/bitemporal machinery adjudicates (with CONFLICT_MENTION_FACT_SLOT also on: close-scored → COMPETING, both sides served). Purely deterministic (static table + regex, no DB read, no fuzzy matching, no LLM), order-free and idempotent. Bare unit durations ('30 days' — the technical-literal harvest bulk), facts with an EDC predicateAlias, the direct typed path, and every other predicate are untouched. Off (default) = extracted-predicate passthrough, byte-identical. Requires re-ingest to affect existing rows.",
  },
  {
    key: 'CONFLICT_TEMPORAL_TIEBREAKER',
    category: 'conflict',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Succession tiebreaker for the bitemporal close-margin doctrine (migration 0129). The conflict-slot promotions plus the slot-exact cosine floor route single-value slots into the margin doctrine, where batch-shaped corpora score every write identically (margin ~0) and every same-slot pairing lands COMPETING — genuine temporal updates included, so honest serving abstains on settled current values (memory-fitness regression, run mfmtqn2jiq). Score margin cannot tell an UPDATE from a CONTRADICTION, and measured live neither can validFrom separation (contradiction arms sit 6-15 days apart, the killing update pairing 25 minutes) or origin identity (one recorder per corpus). When on, a close-margin 'bitemporal' write attesting succession — mention path: a deterministic word-bounded cue regex over the object ('is now X', 'moves from A to B', 'instead of', 'no longer', 'switched to' — no LLM); direct path: a typed re-write of a single-value slot is a self-update by the act, unless the claim cites an external artifact (document/url evidence) — closes pool members whose validFrom is strictly earlier by more than CONFLICT_TEMPORAL_TIEBREAK_WINDOW_MS as superseded history (natural-supersede sentinel; audit trail in conflictTrace.temporalTiebreak) instead of flipping them to COMPETING. Exactly these calls also re-admit stuck COMPETING rows to the pool (the 0085-F3 doctrine — a stuck pair was measured permanent otherwise) and close an exact same-origin restatement as corroborating (no count inflation). Everyone else — cue-less contradiction arms ('actually ends in September 2026'), same-stamp pairs, within-window members, missing validFrom, artifact-backed incumbents (the D6 payout-cutoff shape, protected on both sides) — keeps the close-margin → COMPETING doctrine, 0085-partition style. Off (default) = the fn's new option args are never bound, byte-identical.",
  },
  {
    key: 'CONFLICT_TEMPORAL_TIEBREAK_WINDOW_MS',
    category: 'conflict',
    defaultValue: '0',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Ambiguity window (ms) for CONFLICT_TEMPORAL_TIEBREAKER: a cue-bearing close-margin write only closes pool members whose validFrom is strictly earlier by MORE than this window. Default 0 = strict event order — the ambiguity the window protects is same-report claims, and those share the exact event-time stamp, which strict comparison already keeps COMPETING; measured on the regression corpus, the real update chain steps in 25-minute increments, so any window ≥ 25 min re-breaks the fix (the 24h first guess failed both acceptance cases). Clamped to [0, 365d]; negative or non-numeric input clamps to 0.',
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
      'G6 hierarchical scope-tag fence (migration 0093). When on, the scope-tag visibility evaluator runs as an ADDITIONAL AND-fence alongside the untouched migration-0055 userId filter at every per-user read seam (episode L0 reads, fact search legs, get-fact/provenance) — a row must pass BOTH. Composed with AND it can only narrow, never open, what userId filtering already returns; for current single-tag data (every row scope is [] or [user:<id>]) the two fences keep provably identical row sets, so enabling it changes nothing (the parity property that makes it safe to ship on). Fail-closed: a record scope with an unparseable or unknown-namespace tag is hidden from a scoped principal. Off (default) → the scope column is written by backfill/ingest but never read for filtering; enforcement is byte-identical pre-0093. W5 (step 3) added the READ half of group tags: a user-bound principal is fenced by the tags they HOLD (their own, plus every `team:` group the membership plane expanded for them — resolved once per request by the guard), and tenant-wide authority (an M2M credential, a background job) is the tenant boundary itself and carries no scope clause at all. Group tags only exist when SOURCE_PRINCIPALS wrote them, so with that off this is still the single-tag parity above. Steps 4-5 (share-up staging beyond one group per row) remain a follow-up.',
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
    key: 'READ_SURFACE_USER_SCOPE',
    category: 'auth',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Per-user read scope on the two read surfaces that predate migration 0055 and hardcode `userId IS NONE`: the entity timeline (GET /v1/entities/:id/timeline, get_entity_timeline) and the competing-facts listing (get_competing_facts). When on and the caller supplies a userId (pinned to a user-bound token’s end-user via pinUserScope — 403 on mismatch), the fence widens to the search-lane union `(userId IS NONE OR userId = $scopeUserId)`: tenant-global rows plus that one user’s personal ones, never a third user’s. On by default since 2026-09-12: off, both surfaces answer EMPTY for any deployment that writes per-user memory — the memory-fitness battery scored 0/3 on evolution history (\u201cno events matched either value\u201d) and could not see a `competing` pair that was sitting on the entity, because the rows were user-scoped and the fence was not. Clearing it (=0) — or calling with no userId — keeps the exact historical tenant-global-only clause, byte-identical.',
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
      'On = ingest 400s on an invalid source.meta entry instead of dropping it (a silently-dropped data_class would widen access). Polices CALLER-supplied meta only: brain-synthesised document-header provenance rides the internal channel (src/documents/document-meta.ts) and is exempt by construction.',
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
];
