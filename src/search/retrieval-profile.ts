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
 *                          regimes (V6 legs, validate-2026-08-results):
 *                          fused won +7.1pp on session-shaped asks
 *                          (SSA) and lost −7.1pp at 2.7× tokens on
 *                          timeline-shaped ones (TR) — the genre split
 *                          lives INSIDE a tenant's traffic. Timeline-
 *                          shaped queries (answer-router lexicon) take
 *                          the shape_conditioned path; everything else
 *                          takes fused. Resolution is
 *                          resolveVerbatimMode() in answer-router.ts —
 *                          every consumer must branch on the RESOLVED
 *                          mode, never on 'routed' itself.
 */
export type VerbatimEvidenceMode =
  | 'off'
  | 'shape_conditioned'
  | 'always'
  | 'fused'
  | 'routed';

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
  if (
    typeof o.genre === 'string' &&
    ['dialogue', 'assistant_chat', 'documents'].includes(o.genre)
  ) {
    merged.genre = o.genre as RetrievalGenre;
  }
  if (
    typeof o.verbatimEvidence === 'string' &&
    ['off', 'shape_conditioned', 'always', 'fused', 'routed'].includes(
      o.verbatimEvidence,
    )
  ) {
    merged.verbatimEvidence = o.verbatimEvidence as VerbatimEvidenceMode;
  }
  if (
    typeof o.dateAnchoring === 'string' &&
    ['none', 'session_date', 'absolute'].includes(o.dateAnchoring)
  ) {
    merged.dateAnchoring = o.dateAnchoring as DateAnchoring;
  }
  if (
    typeof o.temporalMode === 'string' &&
    ['filter', 'overlap_boost'].includes(o.temporalMode)
  ) {
    merged.temporalMode = o.temporalMode as TemporalMode;
  }
  for (const key of [
    'factBudget',
    'quotesPerPrompt',
    'sourceExcerptsCap',
    'segmentTopK',
    'extraEvidenceCap',
    'wideProbeLimit',
  ] as const) {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      merged[key] = Math.floor(v);
    }
  }
  for (const key of [
    'segmentRerank',
    'wideProbe',
    'entityExpansion',
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
