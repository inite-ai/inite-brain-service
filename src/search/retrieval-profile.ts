import { getRequestContext } from '../common/request-context';
import {
  envFlagEnabled,
  envFlagNotDisabled,
} from '../common/env-validation';

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
 * segments) reaches the synthesis prompt:
 *  - 'off'               — never; facts only.
 *  - 'shape_conditioned' — episode quotes + provenance excerpts only
 *                          when the question asks for conversational
 *                          content (verbatim shape). The engine default.
 *  - 'always'            — all three verbatim lanes run unconditionally
 *                          (diary-genre profile; the old lane flags ON).
 */
export type VerbatimEvidenceMode = 'off' | 'shape_conditioned' | 'always';

/**
 * How the generator's "today" is anchored:
 *  - 'none'         — no date context (LoCoMo-convention golds, where
 *                     real date arithmetic measurably hurts).
 *  - 'session_date' — anchor only when the caller supplies asOf.
 *  - 'absolute'     — asOf, else wall clock. The engine default.
 */
export type DateAnchoring = 'none' | 'session_date' | 'absolute';

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
      ] as const) ?? (legacyVerbatimAlways ? 'always' : 'shape_conditioned'),
    dateAnchoring:
      enumEnv(env, 'RETRIEVAL_DATE_ANCHORING', [
        'none',
        'session_date',
        'absolute',
      ] as const) ??
      (envFlagNotDisabled(env.SYNTHESIZE_DATE_CONTEXT) ? 'absolute' : 'none'),
    factBudget: positiveIntEnv(env, 'SEARCH_FACT_CENTRIC_BUDGET', 48),
    quotesPerPrompt: positiveIntEnv(env, 'SEARCH_EPISODIC_LANE_TOPK', 8),
    sourceExcerptsCap: positiveIntEnv(env, 'SYNTHESIZE_SOURCE_EXCERPTS_CAP', 16),
    segmentTopK: positiveIntEnv(env, 'SEARCH_SEGMENT_LANE_TOPK', 5),
    segmentRerank: envFlagEnabled(env.SEARCH_SEGMENT_LANE_RERANK),
    extraEvidenceCap: positiveIntEnv(env, 'SYNTHESIZE_EXTRA_EVIDENCE_CAP', 40),
    wideProbe: envFlagEnabled(env.SYNTHESIZE_LANE_WIDE_PROBE),
    wideProbeLimit: positiveIntEnv(env, 'SYNTHESIZE_WIDE_PROBE_LIMIT', 12),
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
    ['off', 'shape_conditioned', 'always'].includes(o.verbatimEvidence)
  ) {
    merged.verbatimEvidence = o.verbatimEvidence as VerbatimEvidenceMode;
  }
  if (
    typeof o.dateAnchoring === 'string' &&
    ['none', 'session_date', 'absolute'].includes(o.dateAnchoring)
  ) {
    merged.dateAnchoring = o.dateAnchoring as DateAnchoring;
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
  for (const key of ['segmentRerank', 'wideProbe'] as const) {
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
