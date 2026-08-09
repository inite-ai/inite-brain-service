import { getRequestContext } from '../common/request-context';
import {
  envFlagEnabled,
  envFlagNotDisabled,
} from '../common/env-validation';
import {
  resolveStageBudgets,
  type StageBudgets,
} from './internals/stage-budget';
import {
  resolveExpansionConfig,
  type ExpansionConfig,
} from './internals/edge-expansion';

/**
 * RetrievalProfile — the per-tenant configuration object that replaced
 * the genre flags (owner directive 2026-08-03, S3 of
 * docs/roadmap/next-session-platform-2026-08.md).
 *
 * The engine is genre-dependent: the segment lane helps diaries and
 * ruins assistant chats; date arithmetic helps LongMemEval and hurts
 * LoCoMo. That is real behavior variation — and it is CONFIGURATION per
 * tenant, not a process-global fork. The profile is resolved exactly
 * once per request (ApiKeyGuard, next to brainAuth) and passed down;
 * nothing below the resolution point reads process.env for these
 * dimensions. Env keeps one job: the default profile at boot, plus
 * optional per-tenant overrides (RETRIEVAL_PROFILE_OVERRIDES).
 */

export type RetrievalGenre = 'dialogue' | 'assistant_chat' | 'documents';

/**
 * How verbatim L0 evidence (episode quotes / provenance excerpts /
 * segments) reaches answers:
 *  - 'off'               — never; facts only.
 *  - 'shape_conditioned' — episode quotes + provenance excerpts only
 *                          when the question asks for conversational
 *                          content (verbatim shape). The engine default.
 *  - 'always'            — all three verbatim lanes run unconditionally
 *                          as a prompt appendix (diary-genre profile;
 *                          the old lane flags ON).
 *  - 'fused'             — audit W4 #18: segments become first-class
 *                          SearchHits — retrieved inside the search
 *                          pipeline (dense+BM25 through the same convex
 *                          fusion), scored, reranked, and CITABLE next
 *                          to facts, instead of an unscored prompt
 *                          appendix. The two episode quote lanes stay
 *                          shape-conditioned; the appendix segment lane
 *                          is off (segments arrive as hits).
 *  - 'routed'            — per-QUERY dispatch between the two measured
 *                          regimes (V6 three-block pairs,
 *                          validate-2026-08-results): fused-capped vs
 *                          shape_conditioned ran SSA +7.1pp /
 *                          SSU −10.0pp / TR −8.3pp (pooled −5.0pp at
 *                          n=239) — the split lives INSIDE a tenant's
 *                          traffic and the ONLY winning class is
 *                          verbatim-shaped asks. Those take the fused
 *                          path; everything else stays
 *                          shape_conditioned. Resolution is
 *                          resolveVerbatimMode() in verbatim-routing.ts
 *                          — every consumer must branch on the RESOLVED
 *                          mode, never on 'routed' itself.
 */
export type VerbatimEvidenceMode =
  | 'off'
  | 'shape_conditioned'
  | 'always'
  | 'fused'
  | 'routed';

/**
 * How derived INSIGHT rows — aspect aggregates
 * (source.recorder='aggregate-composer-v1') and promotion/compaction
 * summaries (predicate 'summary_*') — reach answers:
 *  - 'off'    — insight rows are ordinary knowledge_fact rows and ride
 *               the fact legs (byte-identical to the pre-V8 engine).
 *  - 'routed' — the qualified insight lane (V8 §1). The NAIVE version
 *               is a measured null (validate-2026-08-results: MS tie,
 *               BEAM −2.0pp, summarization 3↓/0↑ — aggregates compete
 *               inside the fact budget and displace the atomic facts
 *               the generator needed). Under 'routed' the fact legs
 *               EXCLUDE insight rows; instead, summarization /
 *               progressive-narrative / enumeration questions (the
 *               summary and enumeration lanes) retrieve them as their
 *               own pseudo-fact pool — dense+BM25 through the same
 *               convex fusion — entering the prompt under a SEPARATE
 *               budget slot (INSIGHT_TOP_K, not factBudget), so
 *               insights never displace atomic facts. Pointwise asks
 *               skip the slot entirely.
 *  - 'query_arc' — V10 §4: same dispatch and slot as 'routed', but the
 *               section is ASSEMBLED at read time instead of retrieved
 *               from stored insight rows: the topic phrase extracted
 *               from the question scans the atomic fact record
 *               (dense+BM25 against the TOPIC, coverage-first — the
 *               mention-scan doctrine over knowledge_fact) and the most
 *               topical beats are emitted as one chronological dated
 *               record. Write-time arcs measured null-to-negative
 *               (v9arcs): coverage thin by construction (only
 *               fact-dense entities clear the composer floor) and
 *               stored topics are decided blind to the questions.
 *               Fact legs exclude stored insight rows exactly as under
 *               'routed', so worlds permanently carrying
 *               aggregates/arcs read clean.
 */
export type InsightEvidenceMode = 'off' | 'routed' | 'query_arc';

/**
 * Timeline evidence for mention-order questions (V8 §2):
 *  - 'off'    — pre-V8 behavior (the appendix segment lane runs only
 *               under verbatimEvidence='always').
 *  - 'routed' — ordering/sequence-shaped questions (the order-lexicon;
 *               detectOrderingShape) ALSO get the chronological segment
 *               appendix — the mention record in occurredAt order.
 *               Rationale (the measured BEAM event_ordering failure,
 *               2.5-5%): event-time extraction collapses a session's
 *               mentions onto one validFrom date, so mention order is
 *               unrecoverable from facts; the segments preserve it
 *               (SegTreeMem's ablation: the win is preserving temporal
 *               order in what the model sees). Skipped when the query's
 *               resolved verbatim mode is 'fused' (segments already
 *               arrive as hits — appending would duplicate).
 *  - 'scan'   — V9 §2: like 'routed', but the mention record is built
 *               by the topic-scan lane (mention-scan.service.ts)
 *               instead of the top-K segment appendix: the topic
 *               phrase is extracted from the question, the segment
 *               record is scanned per session (BM25 + embedding
 *               against the TOPIC, not the whole question), and ONE
 *               dated line per session-mention is emitted in
 *               occurredAt order — coverage bounded by session count,
 *               not top-K (the measured event_ordering failure is
 *               COVERAGE: golds enumerate a topic across ALL sessions;
 *               top-K similarity windows cannot).
 */
export type TimelineEvidenceMode = 'off' | 'routed' | 'scan';

/**
 * Memory-coverage abstention (V9 §4):
 *  - 'off'      — abstention is decided solely by the generator's own
 *                 judgment (pre-V9 behavior).
 *  - 'coverage' — before generation, the retrieved evidence must clear
 *                 a coverage floor (best fact score ≥
 *                 abstentionMinTopScore AND fact count ≥
 *                 abstentionMinEvidence); below it synthesize returns
 *                 an explicit not-in-my-memory answer. Applies only in
 *                 strict/lenient guardrails — 'answer' mode is a
 *                 caller-level never-abstain contract and is exempt.
 *                 NOTE (V9 calibration finding): retrieval-level floors
 *                 cannot detect ANSWER-absence on topically-adjacent
 *                 questions — both the composite score and raw cosine
 *                 measured non-discriminative on BEAM abstention
 *                 (p50 0.171 vs 0.175; 0.589 vs 0.603). Useful only
 *                 for genuinely off-topic queries.
 *  - 'verifier' — answer-level coverage: in lenient guardrails, when
 *                 the verifier judges the generated answer
 *                 unsupported/partial against the evidence bundle, the
 *                 caller gets the explicit not-in-my-memory decline
 *                 instead of ungrounded text. Costs nothing — the
 *                 verifier already runs in lenient mode. 'answer' mode
 *                 stays exempt (verifier is skipped there), so
 *                 never-abstain QA traffic is structurally untouched.
 */
export type AbstentionCalibrationMode = 'off' | 'coverage' | 'verifier';

/**
 * How the generator's "today" is anchored:
 *  - 'none'         — no date context (LoCoMo-convention golds, where
 *                     real date arithmetic measurably hurts).
 *  - 'session_date' — anchor only when the caller supplies asOf.
 *  - 'absolute'     — asOf, else wall clock. The engine default.
 */
export type DateAnchoring = 'none' | 'session_date' | 'absolute';

/**
 * How an explicit `asOf` shapes retrieval (audit W4 #17 — temporal used
 * to be a hard filter ONLY, so a bad asOf was a recall cliff):
 *  - 'filter'        — bitemporal closure excludes facts not valid at
 *                      asOf. Strict point-in-time semantics; the engine
 *                      default.
 *  - 'overlap_boost' — the validity closure is relaxed for asOf reads;
 *                      instead, facts whose validity interval contains
 *                      asOf keep full score and facts outside it decay
 *                      exponentially with distance (Hindsight-style
 *                      overlap + distance decay). Soft recall, fuzzier
 *                      point-in-time compliance.
 */
export type TemporalMode = 'filter' | 'overlap_boost';

/** One id per dispatch lane; the Lane registry must cover all of them. */
export type LaneId =
  | 'temporal'
  | 'enumeration'
  | 'contradiction'
  | 'preference'
  | 'recency'
  | 'summary'
  | 'instruction';

export const ALL_LANES: readonly LaneId[] = [
  'temporal',
  'enumeration',
  'contradiction',
  'preference',
  'recency',
  'summary',
  'instruction',
];

export interface RetrievalProfile {
  genre: RetrievalGenre;
  verbatimEvidence: VerbatimEvidenceMode;
  insightEvidence: InsightEvidenceMode;
  timelineEvidence: TimelineEvidenceMode;
  dateAnchoring: DateAnchoring;
  temporalMode: TemporalMode;
  /** Global fact budget for fact-centric selection. */
  factBudget: number;
  /** Episode quotes per prompt (episodic lane BM25 top-k). */
  quotesPerPrompt: number;
  /** Provenance excerpts per prompt (source.episodeIds follow-up). */
  sourceExcerptsCap: number;
  /** Verbatim multi-turn segments per prompt. */
  segmentTopK: number;
  /** Listwise rerank over the fused segment pool before the top-k cut. */
  segmentRerank: boolean;
  /** Extra pre-retrieved facts folded into evidence (union cap). */
  extraEvidenceCap: number;
  /** PRF second retrieval for summary/enumeration-routed questions. */
  wideProbe: boolean;
  wideProbeLimit: number;
  /**
   * Entity-expansion second retrieval inside the search pipeline
   * (audit W4 #19): the top entities the first pass discovered — and
   * the query never named — anchor a second legs+fusion pass before
   * scoring. SmartSearch's multi-session lever; off by default until
   * measured per genre.
   */
  entityExpansion: boolean;
  /**
   * V8 §4 importance scoring: fold the deriver-stamped source.salience
   * (0-3, DERIVER_SALIENCE_STAMP) into ranking as a multiplicative
   * factor. Unstamped rows sit on the neutral grade; off →
   * byte-identical ranking.
   */
  salienceScoring: boolean;
  /**
   * V10 §3 ordering frame: when the mention record fired
   * (timelineEvidence resolved active for an ordering-shaped
   * question), the generator gets a dedicated order-of-mention frame
   * — short aspect labels in the record's order, honor the requested
   * N — INSTEAD of the enumeration frame, whose "enumerate every
   * matching item with its date" fights both exact-N and aspect
   * granularity (the measured v9scan null). Also collapses
   * near-duplicate aspect mentions inside the record itself. Off =
   * byte-identical prompt.
   */
  orderingFrame: boolean;
  /** V9 §4 memory-coverage abstention; off = byte-identical. */
  abstentionCalibration: AbstentionCalibrationMode;
  /**
   * V10 §5 verifier topic-coverage: the auditor additionally judges
   * (a) relationship claims — an asserted causal/attributive link
   * between individually-supported facts is itself a claim needing
   * direct evidence — and (b) whether the evidence actually ANSWERS
   * the query (`questionAnswered`), not merely shares its topic. In
   * lenient guardrails under abstentionCalibration='verifier', a
   * supported-but-not-answering verdict declines like unsupported
   * (the V9 residual: 13/40 abstention misses were fabrications
   * assembled from real facts, each claim individually grounded).
   * Strict/answer guardrails are untouched. Off = byte-identical
   * verifier prompt and schema.
   */
  verifierTopicCoverage: boolean;
  /** Coverage floor: minimum best fact score (see abstention.ts). */
  abstentionMinTopScore: number;
  /** Coverage floor: minimum evidence fact count. */
  abstentionMinEvidence: number;
  /** Active dispatch lanes; empty set = no typed dispatch. */
  lanes: ReadonlySet<LaneId>;
}

function positiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  dflt: number,
): number {
  const v = parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/** Non-negative float knob with a default (coverage floors are 0-ok,
 *  so unset/blank must NOT collapse to Number('')===0 — check first). */
function nonNegativeFloatEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  dflt: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function enumEnv<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const v = (env[name] ?? '').trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/**
 * The boot-default profile, from env. The enum dimensions have
 * first-class keys (RETRIEVAL_GENRE / RETRIEVAL_VERBATIM_EVIDENCE /
 * RETRIEVAL_DATE_ANCHORING); when unset they derive from the legacy
 * per-lane keys so existing deployments resolve to the same behavior.
 * This function is the ONLY place those env keys are read.
 */
export function resolveRetrievalProfile(
  env: NodeJS.ProcessEnv = process.env,
): RetrievalProfile {
  const routerOn = envFlagEnabled(env.SYNTHESIZE_ANSWER_ROUTER_ENABLED);
  const lanes = new Set<LaneId>();
  if (routerOn) {
    for (const lane of ALL_LANES) {
      if (lane === 'instruction') {
        if (envFlagEnabled(env.SYNTHESIZE_INSTRUCTION_LANE)) lanes.add(lane);
      } else {
        lanes.add(lane);
      }
    }
  }
  const legacyVerbatimAlways =
    envFlagEnabled(env.SEARCH_EPISODIC_LANE_ENABLED) ||
    envFlagEnabled(env.SYNTHESIZE_SOURCE_EXCERPTS) ||
    envFlagEnabled(env.SEARCH_SEGMENT_LANE_ENABLED);
  return {
    genre:
      enumEnv(env, 'RETRIEVAL_GENRE', [
        'dialogue',
        'assistant_chat',
        'documents',
      ] as const) ?? 'assistant_chat',
    verbatimEvidence:
      enumEnv(env, 'RETRIEVAL_VERBATIM_EVIDENCE', [
        'off',
        'shape_conditioned',
        'always',
        'fused',
        'routed',
      ] as const) ?? (legacyVerbatimAlways ? 'always' : 'shape_conditioned'),
    insightEvidence:
      enumEnv(env, 'RETRIEVAL_INSIGHT_EVIDENCE', [
        'off',
        'routed',
        'query_arc',
      ] as const) ?? 'off',
    timelineEvidence:
      enumEnv(env, 'RETRIEVAL_TIMELINE_EVIDENCE', [
        'off',
        'routed',
        'scan',
      ] as const) ?? 'off',
    dateAnchoring:
      enumEnv(env, 'RETRIEVAL_DATE_ANCHORING', [
        'none',
        'session_date',
        'absolute',
      ] as const) ??
      (envFlagNotDisabled(env.SYNTHESIZE_DATE_CONTEXT) ? 'absolute' : 'none'),
    temporalMode:
      enumEnv(env, 'RETRIEVAL_TEMPORAL_MODE', [
        'filter',
        'overlap_boost',
      ] as const) ?? 'filter',
    factBudget: positiveIntEnv(env, 'SEARCH_FACT_CENTRIC_BUDGET', 48),
    quotesPerPrompt: positiveIntEnv(env, 'SEARCH_EPISODIC_LANE_TOPK', 8),
    sourceExcerptsCap: positiveIntEnv(env, 'SYNTHESIZE_SOURCE_EXCERPTS_CAP', 16),
    segmentTopK: positiveIntEnv(env, 'SEARCH_SEGMENT_LANE_TOPK', 5),
    segmentRerank: envFlagEnabled(env.SEARCH_SEGMENT_LANE_RERANK),
    extraEvidenceCap: positiveIntEnv(env, 'SYNTHESIZE_EXTRA_EVIDENCE_CAP', 40),
    wideProbe: envFlagEnabled(env.SYNTHESIZE_LANE_WIDE_PROBE),
    wideProbeLimit: positiveIntEnv(env, 'SYNTHESIZE_WIDE_PROBE_LIMIT', 12),
    entityExpansion: envFlagEnabled(env.RETRIEVAL_ENTITY_EXPANSION),
    salienceScoring: envFlagEnabled(env.RETRIEVAL_SALIENCE_SCORING),
    orderingFrame: envFlagEnabled(env.RETRIEVAL_ORDERING_FRAME),
    abstentionCalibration:
      enumEnv(env, 'RETRIEVAL_ABSTENTION_CALIBRATION', [
        'off',
        'coverage',
        'verifier',
      ] as const) ?? 'off',
    verifierTopicCoverage: envFlagEnabled(env.RETRIEVAL_VERIFIER_TOPIC_COVERAGE),
    abstentionMinTopScore: nonNegativeFloatEnv(
      env,
      'RETRIEVAL_ABSTENTION_MIN_SCORE',
      0.35,
    ),
    abstentionMinEvidence: positiveIntEnv(
      env,
      'RETRIEVAL_ABSTENTION_MIN_EVIDENCE',
      2,
    ),
    lanes,
  };
}

const LANE_ID_SET = new Set<string>(ALL_LANES);

/**
 * Per-tenant profile resolution: the boot default overlaid with the
 * tenant's entry in RETRIEVAL_PROFILE_OVERRIDES (a JSON object mapping
 * companyId → partial profile; `lanes` as an array of LaneIds).
 * Unknown fields and malformed overrides are ignored per-tenant — the
 * JSON shape itself is boot-validated in env-validation.
 */
export function resolveRetrievalProfileFor(
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): RetrievalProfile {
  const base = resolveRetrievalProfile(env);
  const raw = env.RETRIEVAL_PROFILE_OVERRIDES;
  if (!raw || !raw.trim()) return base;
  let overrides: Record<string, Record<string, unknown>>;
  try {
    overrides = JSON.parse(raw);
  } catch {
    return base;
  }
  const o = overrides?.[companyId];
  if (!o || typeof o !== 'object') return base;
  const merged: RetrievalProfile = { ...base };
  // Data-driven like the numeric/boolean loops below — every enum
  // field overlays through one loop (a per-field if-ladder pushed the
  // function over the complexity budget when the V8 points landed).
  const enumOverlays: ReadonlyArray<
    [keyof RetrievalProfile, readonly string[]]
  > = [
    ['genre', ['dialogue', 'assistant_chat', 'documents']],
    [
      'verbatimEvidence',
      ['off', 'shape_conditioned', 'always', 'fused', 'routed'],
    ],
    ['insightEvidence', ['off', 'routed', 'query_arc']],
    ['timelineEvidence', ['off', 'routed', 'scan']],
    ['dateAnchoring', ['none', 'session_date', 'absolute']],
    ['temporalMode', ['filter', 'overlap_boost']],
    ['abstentionCalibration', ['off', 'coverage', 'verifier']],
  ];
  for (const [key, allowed] of enumOverlays) {
    const v = o[key];
    if (typeof v === 'string' && allowed.includes(v)) {
      (merged as unknown as Record<string, unknown>)[key] = v;
    }
  }
  for (const key of [
    'factBudget',
    'quotesPerPrompt',
    'sourceExcerptsCap',
    'segmentTopK',
    'extraEvidenceCap',
    'wideProbeLimit',
    'abstentionMinEvidence',
  ] as const) {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      merged[key] = Math.floor(v);
    }
  }
  // Float knobs (coverage score floor lives in (0,1) — flooring would
  // destroy it, so it overlays outside the int loop; 0 is a valid
  // "disable this floor" value).
  {
    const v = o.abstentionMinTopScore;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      merged.abstentionMinTopScore = v;
    }
  }
  for (const key of [
    'segmentRerank',
    'wideProbe',
    'entityExpansion',
    'salienceScoring',
    'orderingFrame',
    'verifierTopicCoverage',
  ] as const) {
    if (typeof o[key] === 'boolean') merged[key] = o[key] as boolean;
  }
  if (Array.isArray(o.lanes)) {
    merged.lanes = new Set(
      o.lanes.filter((l): l is LaneId => LANE_ID_SET.has(String(l))),
    );
  }
  return merged;
}

/**
 * The active request's resolved profile (stamped by ApiKeyGuard), or
 * the boot default outside a request (cron, MCP stdio without guard,
 * unit fixtures). Callers below the boundary take the profile as an
 * argument; this getter exists for the entry points that adapt the
 * old no-argument call sites.
 */
export function getActiveRetrievalProfile(): RetrievalProfile {
  return getRequestContext()?.retrievalProfile ?? resolveRetrievalProfile();
}

/**
 * SearchTuning — every numeric/infra knob the search pipeline reads,
 * resolved HERE and only here (S5.2: this module is the one place under
 * the profile boundary allowed to touch process.env). Unlike the
 * RetrievalProfile — genre semantics, per-tenant — these are
 * deployment-wide tuning values. Resolved per request (search() stamps
 * one snapshot into the PipelineContext), so a live env flip lands on
 * the next request: no constructor capture, no false runtimeMutable
 * claims (audit W6 #28).
 */
export interface SearchTuning {
  /** SEARCH_USAGE_RECORDING_ENABLED — stamp surfaced facts (0053). */
  usageRecording: boolean;
  /** SEARCH_USAGE_DECAY_ENABLED — decay from lastReadAt. */
  usageDecay: boolean;
  /** SEARCH_PPR_ENABLED / SEARCH_PPR_AUTO_THRESHOLD. */
  pprEnabled: boolean;
  pprAutoThreshold: number;
  /** Source-reputation ranking knobs (Phase 5); 0 = factor 1.0. */
  trustBeta: number;
  corroborationGamma: number;
  authorityDelta: number;
  /** Chatter demotion in (0,1); 1 = off. */
  chatterPenalty: number;
  /** Cross-encoder windows + margin-skip. */
  crossEncoderLocalWindow: number;
  crossEncoderWindow: number;
  rerankSkipMargin: number;
  stageBudgets: StageBudgets;
  /** Token-count worker offload (response shaping). */
  tokenCountOffload: boolean;
  tokenOffloadMinHits: number;
  /** Leg construction knobs. */
  combinedVectorGraph: boolean;
  hnswEnabled: boolean;
  hnswEf: number;
  hnswOverfetch: number;
  highlightEnabled: boolean;
  edgeExpansion: ExpansionConfig;
}

function tuningInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const v = parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Optional non-negative float knob; unset/invalid → 0 (feature off). */
function nonNegativeFloat(env: NodeJS.ProcessEnv, name: string): number {
  const v = Number(env[name] ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Penalty multiplier; OFF is 1.0. Returns the value only when it's a
 * real demotion in (0,1); unset / invalid / ≥1 → 1.0 (no penalty).
 */
function unitPenalty(env: NodeJS.ProcessEnv, name: string): number {
  const raw = env[name];
  if (raw === undefined) return 1;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 1;
}

export function resolveSearchTuning(
  env: NodeJS.ProcessEnv = process.env,
): SearchTuning {
  return {
    usageRecording: envFlagEnabled(env.SEARCH_USAGE_RECORDING_ENABLED),
    usageDecay: envFlagEnabled(env.SEARCH_USAGE_DECAY_ENABLED),
    pprEnabled: envFlagEnabled(env.SEARCH_PPR_ENABLED),
    pprAutoThreshold: tuningInt(env, 'SEARCH_PPR_AUTO_THRESHOLD', 0),
    trustBeta: nonNegativeFloat(env, 'SEARCH_TRUST_BETA'),
    corroborationGamma: nonNegativeFloat(env, 'SEARCH_CORROBORATION_GAMMA'),
    authorityDelta: nonNegativeFloat(env, 'SEARCH_AUTHORITY_DELTA'),
    chatterPenalty: unitPenalty(env, 'SEARCH_CHATTER_PENALTY'),
    crossEncoderLocalWindow: tuningInt(
      env,
      'SEARCH_CROSS_ENCODER_LOCAL_WINDOW',
      20,
    ),
    crossEncoderWindow: tuningInt(env, 'SEARCH_CROSS_ENCODER_WINDOW', 50),
    rerankSkipMargin: nonNegativeFloat(env, 'SEARCH_RERANK_SKIP_MARGIN'),
    stageBudgets: resolveStageBudgets(env),
    tokenCountOffload: envFlagEnabled(env.SEARCH_TOKEN_COUNT_OFFLOAD ?? '1'),
    tokenOffloadMinHits: tuningInt(env, 'SEARCH_TOKEN_OFFLOAD_MIN_HITS', 24),
    combinedVectorGraph: envFlagEnabled(env.SEARCH_COMBINED_VECTOR_GRAPH),
    hnswEnabled: envFlagEnabled(env.SEARCH_HNSW_ENABLED),
    hnswEf: tuningInt(env, 'SEARCH_HNSW_EF', 100),
    hnswOverfetch: tuningInt(env, 'SEARCH_HNSW_OVERFETCH', 4),
    highlightEnabled: envFlagEnabled(env.SEARCH_HIGHLIGHT_ENABLED),
    edgeExpansion: resolveExpansionConfig(env),
  };
}
