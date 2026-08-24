import { getRequestContext } from '../common/request-context';
import { envFlagEnabled, envFlagNotDisabled } from '../common/env-validation';
import { resolveStageBudgets, type StageBudgets } from './internals/stage-budget';
import { resolveExpansionConfig, type ExpansionConfig } from './internals/edge-expansion';
import { GENRE_PRESETS } from './genre-presets';

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
 *
 * Between the env layer and the code defaults sits the GENRE PRESET
 * layer (genre-presets.ts): each genre ships tuned defaults for the
 * measured levers, applied per field only where the corresponding env
 * key is unset — explicit env key > genre preset > code default, and a
 * per-company overlay field beats all three.
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
export type VerbatimEvidenceMode = 'off' | 'shape_conditioned' | 'always' | 'fused' | 'routed';

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
 * Dense-leg execution mode of the two coverage-first scan lanes
 * (mention-scan over episode_segment, query_arc over knowledge_fact):
 *  - 'brute' — exact filtered top-k via a full-table cosine ORDER BY.
 *              Correct at eval scale by design (coverage was the
 *              measured failure) and the engine default.
 *  - 'hnsw'  — approximate KNN (`<|k,ef|>`) against the per-tenant
 *              HNSW indexes, with overfetch compensating the post-KNN
 *              gate filtering (SurrealDB applies WHERE after the
 *              approximate neighbor walk). Falls back to the brute
 *              scan on error OR an empty post-filter pool, so tenants
 *              without the indexes built behave identically. The
 *              promotion gate for large tenants (V11 agenda: default-on
 *              goes through a vector-index leg first).
 */
export type CoverageScanMode = 'brute' | 'hnsw';

/**
 * Lexical-leg query shape of the coverage scan lanes (V11 audit A2):
 *  - 'phrase'   — one matcher per indexed field fed the whole topic
 *                 phrase. The matches operator (`@N@`) is AND-semantics
 *                 over the analyzed tokens on SurrealDB 3.x — EVERY
 *                 topic token must appear in the row — so multi-word
 *                 topics rarely fire and the lexical half of "hybrid"
 *                 is mostly decorative. The legacy default.
 *  - 'or_terms' — per-term matchers over topicTerms (bounded, unique
 *                 match refs) OR-ed together; a row mentioning ANY
 *                 topic word is a lexical hit, scored as the sum over
 *                 terms of the best per-field BM25 (disjunctive BM25 —
 *                 multi-term rows rank higher). Empirics on the 3.2.1
 *                 stand: unmatched refs score 0.0, duplicate refs bind
 *                 scoring to the LAST matcher (hence unique refs).
 */
export type CoverageLexMode = 'phrase' | 'or_terms';

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
 *  - 'minicheck' — V11 §2 arm (b): the same lenient answer-level gate,
 *                 but the consistency judgment comes from a LOCAL
 *                 Bespoke-MiniCheck NLI over Ollama (MINICHECK_URL /
 *                 MINICHECK_MODEL) instead of the LLM verifier — zero
 *                 marginal API cost. Strict/answer guardrails keep the
 *                 LLM verifier path untouched.
 */
export type AbstentionCalibrationMode = 'off' | 'coverage' | 'verifier' | 'minicheck';

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

/** Digest-evidence lane targeting (see RetrievalProfile.digestLanes). */
export type DigestLaneMode = 'all' | 'summary_ku';

/** One id per dispatch lane; the Lane registry must cover all of them. */
export type LaneId =
  | 'temporal'
  | 'enumeration'
  | 'contradiction'
  | 'preference'
  | 'recency'
  | 'summary'
  | 'instruction'
  | 'strategy';

export const ALL_LANES: readonly LaneId[] = [
  'temporal',
  'enumeration',
  'contradiction',
  'preference',
  'recency',
  'summary',
  'instruction',
  'strategy',
];

export interface RetrievalProfile {
  genre: RetrievalGenre;
  verbatimEvidence: VerbatimEvidenceMode;
  insightEvidence: InsightEvidenceMode;
  timelineEvidence: TimelineEvidenceMode;
  /**
   * Dense-leg mode of the coverage scan lanes (see CoverageScanMode).
   * 'brute' = the legacy exact scan; 'hnsw' requires the tenant's
   * HNSW indexes (admin maintenance) and passes the parity gate
   * (scripts/scan-hnsw-parity.ts, recall ≥ 0.98) before being flipped.
   */
  coverageScanMode: CoverageScanMode;
  /** Lexical-leg query shape of the scan lanes (see CoverageLexMode);
   *  'phrase' = the legacy AND-semantics matcher. */
  coverageLexMode: CoverageLexMode;
  /**
   * Multilingual Tier 3 (MULTILINGUAL_CJK_SEGMENTATION). Segment the
   * mention-scan topic with Intl.Segmenter so CJK / non-space-delimited
   * scripts yield real terms instead of being split to nothing by the
   * ASCII/Cyrillic character class. Off (default) ⇒ the legacy split,
   * byte-identical. Resolved here (the one env-reading module below the
   * boundary) and threaded to the mention-scan lane.
   */
  cjkSegmentation: boolean;
  /** HNSW ef candidate-list size for the scan legs (clamped up to the
   *  overfetched k at query time — ef below k is never useful). */
  scanHnswEf: number;
  /** Overfetch multiplier compensating post-KNN gate filtering; the
   *  query_arc lane doubles it internally (heavier gate stack). */
  scanHnswOverfetch: number;
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
  /**
   * Cross-encoder rescoring of the fused FACT pool before the
   * fact-centric budget cut (July A3): the top
   * SEARCH_FACT_RERANK_WINDOW facts by fused score are reordered by
   * the joint encoder, so the budget window fills by relevance rather
   * than lexical luck. Off by default until measured per genre.
   */
  factRerank: boolean;
  /**
   * V12 read side of DERIVER_MENTION_STAMP: fact lines carry a
   * "(mentioned YYYY-MM-DD)" suffix when the stamped mention date
   * disagrees with validFrom by calendar day — the generator sees the
   * session-anchored date next to the (possibly collapsed) validity
   * date. Unstamped rows render as before.
   */
  mentionDates: boolean;
  /**
   * V13 read side of DERIVER_SCENE_TRACE: fact lines carry a
   * "(context: …)" suffix from the stamped source.scene — the
   * situational anchor the dual-trace encoding wrote. Unstamped rows
   * render as before; against worlds derived without the stamp the
   * flag is byte-identical off.
   */
  sceneTraces: boolean;
  /**
   * §8 item 3 over-enumeration contract: enumeration-lane answers
   * commit to ONLY the items the facts tie to the asked scope — the
   * measured judge-sink class is the gold list PLUS thematically
   * adjacent extras. Off = the historical exhaustive-only frame.
   */
  enumStrict: boolean;
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
   * V10 §2 update-story rendering: evidence facts that superseded an
   * older value get a compact history suffix on their prompt line —
   * "previously: <value> — until <date>" — built from the reverse
   * supersededBy links. Restores the update STORY the KU golds ask
   * for WITHOUT re-including superseded rows in retrieval (the
   * v9lifecycle diagnosis: the bitemporal closure hid the old value
   * and made the row worse). Prompt-side only; retrieval, ranking and
   * citations untouched; generator and verifier see the same lines.
   */
  updateStoryRendering: boolean;
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
  /**
   * V11 §2 arm (a): model override for the verifier/auditor call ONLY
   * (the generator keeps the synthesis model). Empty = inherit the
   * synthesis model — byte-identical behavior. Targets the
   * abstentionCalibration='verifier' residual: the SAME audit prompt
   * on a stronger judge model, priced per tenant.
   */
  verifierModel: string;
  /**
   * V12 §2 read side: surface the rolling conversation digests
   * (conversation_digest, written under DERIVER_DIGEST) into the
   * insight slot — merged AHEAD of retrieved insight lines, same
   * budget. Off = byte-identical; pointless (empty) against worlds
   * derived without the digest flag.
   */
  digestEvidence: boolean;
  /**
   * V13 digest gate-shaping: which routed lanes the digest lines
   * render into. 'all' = the V12 behavior (every prompt). 'summary_ku'
   * = only summary- and recency/knowledge-update-shaped questions —
   * the lanes that took the measured strict gains — so the narrative
   * block stops bleeding into abstention and extraction prompts.
   */
  digestLanes: DigestLaneMode;
  /**
   * V13 hybrid substrate (facts-as-index): the top fact hits' grounding
   * turns expand into a bounded raw-turn window (neighbors on both
   * sides) rendered as transcript evidence — the answer reads source
   * text, not only extracted propositions. Off = byte-identical.
   */
  rawWindow: boolean;
  /** Raw-turn window half-span (turns each side of a grounding turn). */
  rawWindowSpan: number;
  /**
   * Multiworld §10 assistant verbatim lane: BM25 over L0 restricted to
   * assistant-role turns, in the transcript slot. The SSA class is
   * structural — assistant content is never extracted into facts, so
   * every fact-anchored lane (excerpts, raw windows — the latter
   * measured 32.1 vs 42.9 base on SSA) misses it; this lane reaches
   * the gold turn by ROLE, no facts involved. Off = byte-identical.
   */
  assistantLane: boolean;
  /** Assistant-turn quotes per prompt. */
  assistantLaneTopK: number;
  /** Case-insensitive speaker SUFFIX identifying the assistant role
   *  (harness speakers are `<convSlug>__<role>`). */
  assistantLaneMatch: string;
  /**
   * Multiworld §10 facts-as-keys: each top evidence fact line carries
   * ONE verbatim quote of its first grounding turn — the fact acts as
   * the index KEY, the raw turn is served content (the LongMemEval
   * design-study shape: facts as additional keys +9.4% recall; facts
   * as replacement values hurt). Generator and verifier read the same
   * augmented lines (evidence parity). Off = byte-identical.
   */
  factsAsKeys: boolean;
  /** Top evidence facts that carry a grounding quote. */
  factsAsKeysCap: number;
  /**
   * V13 time-constrained retrieval (TSM shape): when the query names an
   * absolute period (a day, month, year or range — code-parsed, no
   * LLM), facts overlapping the period rank above out-of-period facts
   * at equal similarity. Rank-only demotion — nothing is dropped.
   */
  timeFilter: boolean;
  /**
   * V13 deterministic date arithmetic: a computed date table (weekday
   * + gap to the previous dated evidence) renders next to the facts so
   * the generator never does raw calendar math (mini-class models
   * measure 14-40% on it). Event-to-event deltas only — the measured
   * anti-pattern "[elapsed: N days before today]" is not reintroduced.
   */
  dateMath: boolean;
  /**
   * V13 G2 answer conditioning: a per-question-shape instruction
   * block (chained reasoning for why/how, exhaustive coverage for
   * aggregation shapes, exact-token for verbatim shapes) selected by
   * the code-side shape detectors. Off = byte-identical prompt.
   */
  answerConditioning: boolean;
  /**
   * V13 noise filter (the unported LIGHT component): injected context
   * lines (transcript/insight/digest) are relevance-gated against the
   * query by the local cross-encoder before prompt assembly; the fact
   * block is never filtered. Off = byte-identical.
   */
  noiseFilter: boolean;
  /**
   * V13 constrained search loop (the MemMachine/Letta shape, NOT the
   * rejected free agent loop): the generator may return one structured
   * refine-request instead of an answer; the engine runs ONE extra
   * retrieval with the refined query, merges evidence, and forces an
   * answer. Hard cap of one extra round. Off = byte-identical.
   */
  searchLoop: boolean;
  /**
   * G2 (docs/roadmap/sota-gap-build-2026-08.md) confidence-gated L3
   * escalation: when the extracted-fact answer fails the verifier (or
   * fires abstain-intent) with coverage below floor AND at least one
   * retrieved fact names a session, the engine escalates UP to a
   * single full-raw-session large-context generation, re-verifies it,
   * and returns the L3 answer only if the verifier now passes. Monotone
   * single-shot ladder (each tier entered at most once); off =
   * byte-identical (the fact-only verdict stands). The two escalation
   * signals already exist in the stack and today terminate in
   * abstain/re-search — this wires them one layer up.
   */
  l3Escalation: boolean;
  /** G2: max full sessions lifted into the L3 large-context prompt. */
  l3MaxSessions: number;
  /** G2: token cap for the assembled L3 context; over it the lane
   *  degrades to widened L2 windows rather than truncating a session. */
  l3TokenCap: number;
  /** Coverage floor: minimum best fact score (see abstention.ts). */
  abstentionMinTopScore: number;
  /** Coverage floor: minimum evidence fact count. */
  abstentionMinEvidence: number;
  /** Active dispatch lanes; empty set = no typed dispatch. */
  lanes: ReadonlySet<LaneId>;
}

function positiveIntEnv(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const v = parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/** Non-negative float knob with a default (coverage floors are 0-ok,
 *  so unset/blank must NOT collapse to Number('')===0 — check first). */
function nonNegativeFloatEnv(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

/** Plain model-id shape (provider prefixes and version tags allowed);
 *  anything else — including an unset env — resolves to '' (inherit). */
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,64}$/;

function modelIdEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = (env[name] ?? '').trim();
  return MODEL_ID_RE.test(v) ? v : '';
}

/** Speaker-suffix shape for the assistant lane (word chars, `_`, `-`);
 *  anything else — including unset — resolves to the 'assistant'
 *  default, so a typo narrows to a sane role instead of matching all. */
const SPEAKER_MATCH_RE = /^[A-Za-z0-9_-]{1,40}$/;

function speakerMatchEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = (env[name] ?? '').trim();
  return SPEAKER_MATCH_RE.test(v) ? v : 'assistant';
}

function enumEnv<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const v = (env[name] ?? '').trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

const GENRES = ['dialogue', 'assistant_chat', 'documents'] as const;

/** The genre dimension resolved alone — the preset lookup needs it
 *  before any other field can resolve. */
function resolveGenre(env: NodeJS.ProcessEnv): RetrievalGenre {
  return enumEnv(env, 'RETRIEVAL_GENRE', GENRES) ?? 'assistant_chat';
}

/** Legacy per-lane keys imply 'always' ONLY when one of them is
 *  enabled; their falsy state is indistinguishable from unset, so it
 *  defers to the genre preset (the first-class key
 *  RETRIEVAL_VERBATIM_EVIDENCE is the explicit off switch). */
function legacyVerbatimMode(env: NodeJS.ProcessEnv): VerbatimEvidenceMode | undefined {
  return envFlagEnabled(env.SEARCH_EPISODIC_LANE_ENABLED) ||
    envFlagEnabled(env.SYNTHESIZE_SOURCE_EXCERPTS) ||
    envFlagEnabled(env.SEARCH_SEGMENT_LANE_ENABLED)
    ? 'always'
    : undefined;
}

/** SYNTHESIZE_DATE_CONTEXT set to ANY value is an explicit operator
 *  choice (E2 made date context default-on, so an explicit '0' is the
 *  measured LoCoMo pin and must beat a preset); unset defers to the
 *  genre preset. */
function legacyDateAnchoring(env: NodeJS.ProcessEnv): DateAnchoring | undefined {
  if (env.SYNTHESIZE_DATE_CONTEXT === undefined) return undefined;
  return envFlagNotDisabled(env.SYNTHESIZE_DATE_CONTEXT) ? 'absolute' : 'none';
}

/** env ?? preset ?? off for boolean profile fields. envFlagEnabled
 *  cannot tell unset from an explicit '0', so the unset check comes
 *  first: a SET key — including an explicit '0' — is the operator's
 *  word and beats the preset in both directions. */
function presetFlag(env: NodeJS.ProcessEnv, name: string, preset: boolean | undefined): boolean {
  if (env[name] === undefined) return preset ?? false;
  return envFlagEnabled(env[name]);
}

/**
 * The boot-default profile, from env. The enum dimensions have
 * first-class keys (RETRIEVAL_GENRE / RETRIEVAL_VERBATIM_EVIDENCE /
 * RETRIEVAL_DATE_ANCHORING); when unset they derive from the legacy
 * per-lane keys so existing deployments resolve to the same behavior.
 * This function is the ONLY place those env keys are read.
 *
 * Field precedence (genre-presets.ts): explicit env key > genre preset
 * > code default. The preset partial for the resolved genre fills only
 * the fields whose env keys are unset.
 */
export function resolveRetrievalProfile(env: NodeJS.ProcessEnv = process.env): RetrievalProfile {
  return resolveForGenre(resolveGenre(env), env);
}

function resolveForGenre(genre: RetrievalGenre, env: NodeJS.ProcessEnv): RetrievalProfile {
  const preset = GENRE_PRESETS[genre];
  const routerOn = envFlagEnabled(env.SYNTHESIZE_ANSWER_ROUTER_ENABLED);
  const lanes = new Set<LaneId>();
  if (routerOn) {
    for (const lane of ALL_LANES) {
      if (lane === 'instruction') {
        if (envFlagEnabled(env.SYNTHESIZE_INSTRUCTION_LANE)) lanes.add(lane);
      } else if (lane === 'strategy') {
        // G4 strategy-memory lane: own master flag (the instruction-
        // lane idiom); the read-side serving switch
        // (STRATEGY_RETRIEVAL_ENABLED) gates separately inside
        // StrategyMemoryService — lane membership alone serves nothing.
        if (envFlagEnabled(env.STRATEGY_MEMORY_ENABLED)) lanes.add(lane);
      } else {
        lanes.add(lane);
      }
    }
  }
  return {
    genre,
    verbatimEvidence:
      enumEnv(env, 'RETRIEVAL_VERBATIM_EVIDENCE', [
        'off',
        'shape_conditioned',
        'always',
        'fused',
        'routed',
      ] as const) ??
      legacyVerbatimMode(env) ??
      preset.verbatimEvidence ??
      'shape_conditioned',
    insightEvidence:
      enumEnv(env, 'RETRIEVAL_INSIGHT_EVIDENCE', ['off', 'routed', 'query_arc'] as const) ??
      preset.insightEvidence ??
      'off',
    timelineEvidence:
      enumEnv(env, 'RETRIEVAL_TIMELINE_EVIDENCE', ['off', 'routed', 'scan'] as const) ??
      preset.timelineEvidence ??
      'off',
    coverageScanMode:
      enumEnv(env, 'RETRIEVAL_COVERAGE_SCAN_MODE', ['brute', 'hnsw'] as const) ?? 'brute',
    coverageLexMode:
      enumEnv(env, 'RETRIEVAL_COVERAGE_LEX_MODE', ['phrase', 'or_terms'] as const) ?? 'phrase',
    // Cross-cutting locale flag (MULTILINGUAL_ family, off the RETRIEVAL_
    // budget); resolved directly from env here, no genre preset.
    cjkSegmentation: envFlagEnabled(env.MULTILINGUAL_CJK_SEGMENTATION),
    scanHnswEf: positiveIntEnv(env, 'RETRIEVAL_SCAN_HNSW_EF', 400),
    scanHnswOverfetch: positiveIntEnv(env, 'RETRIEVAL_SCAN_HNSW_OVERFETCH', 4),
    dateAnchoring:
      enumEnv(env, 'RETRIEVAL_DATE_ANCHORING', ['none', 'session_date', 'absolute'] as const) ??
      legacyDateAnchoring(env) ??
      preset.dateAnchoring ??
      'absolute',
    temporalMode:
      enumEnv(env, 'RETRIEVAL_TEMPORAL_MODE', ['filter', 'overlap_boost'] as const) ??
      preset.temporalMode ??
      'filter',
    factBudget: positiveIntEnv(env, 'SEARCH_FACT_CENTRIC_BUDGET', 48),
    quotesPerPrompt: positiveIntEnv(env, 'SEARCH_EPISODIC_LANE_TOPK', 8),
    sourceExcerptsCap: positiveIntEnv(env, 'SYNTHESIZE_SOURCE_EXCERPTS_CAP', 16),
    segmentTopK: positiveIntEnv(env, 'SEARCH_SEGMENT_LANE_TOPK', 5),
    segmentRerank: presetFlag(env, 'SEARCH_SEGMENT_LANE_RERANK', preset.segmentRerank),
    factRerank: presetFlag(env, 'SEARCH_FACT_RERANK', preset.factRerank),
    mentionDates: presetFlag(env, 'RETRIEVAL_MENTION_DATES', preset.mentionDates),
    sceneTraces: presetFlag(env, 'RETRIEVAL_SCENE_TRACES', preset.sceneTraces),
    enumStrict: presetFlag(env, 'RETRIEVAL_ENUM_STRICT', preset.enumStrict),
    extraEvidenceCap: positiveIntEnv(env, 'SYNTHESIZE_EXTRA_EVIDENCE_CAP', 40),
    wideProbe: presetFlag(env, 'SYNTHESIZE_LANE_WIDE_PROBE', preset.wideProbe),
    wideProbeLimit: positiveIntEnv(env, 'SYNTHESIZE_WIDE_PROBE_LIMIT', 12),
    entityExpansion: presetFlag(env, 'RETRIEVAL_ENTITY_EXPANSION', preset.entityExpansion),
    salienceScoring: presetFlag(env, 'RETRIEVAL_SALIENCE_SCORING', preset.salienceScoring),
    updateStoryRendering: presetFlag(env, 'RETRIEVAL_UPDATE_STORY', preset.updateStoryRendering),
    orderingFrame: presetFlag(env, 'RETRIEVAL_ORDERING_FRAME', preset.orderingFrame),
    abstentionCalibration:
      enumEnv(env, 'RETRIEVAL_ABSTENTION_CALIBRATION', [
        'off',
        'coverage',
        'verifier',
        'minicheck',
      ] as const) ??
      preset.abstentionCalibration ??
      'off',
    verifierTopicCoverage: presetFlag(
      env,
      'RETRIEVAL_VERIFIER_TOPIC_COVERAGE',
      preset.verifierTopicCoverage,
    ),
    verifierModel: modelIdEnv(env, 'RETRIEVAL_VERIFIER_MODEL'),
    digestEvidence: presetFlag(env, 'RETRIEVAL_DIGEST_EVIDENCE', preset.digestEvidence),
    digestLanes:
      enumEnv(env, 'RETRIEVAL_DIGEST_LANES', ['all', 'summary_ku'] as const) ??
      preset.digestLanes ??
      'all',
    rawWindow: presetFlag(env, 'RETRIEVAL_RAW_WINDOW', preset.rawWindow),
    rawWindowSpan: positiveIntEnv(env, 'RETRIEVAL_RAW_WINDOW_SPAN', 2),
    assistantLane: presetFlag(env, 'RETRIEVAL_ASSISTANT_LANE', preset.assistantLane),
    assistantLaneTopK: positiveIntEnv(env, 'RETRIEVAL_ASSISTANT_LANE_TOPK', 6),
    assistantLaneMatch: speakerMatchEnv(env, 'RETRIEVAL_ASSISTANT_LANE_MATCH'),
    factsAsKeys: presetFlag(env, 'RETRIEVAL_FACTS_AS_KEYS', preset.factsAsKeys),
    factsAsKeysCap: positiveIntEnv(env, 'RETRIEVAL_FACTS_AS_KEYS_CAP', 8),
    timeFilter: presetFlag(env, 'RETRIEVAL_TIME_FILTER', preset.timeFilter),
    dateMath: presetFlag(env, 'RETRIEVAL_DATE_MATH', preset.dateMath),
    answerConditioning: presetFlag(env, 'RETRIEVAL_ANSWER_CONDITIONING', preset.answerConditioning),
    noiseFilter: presetFlag(env, 'RETRIEVAL_NOISE_FILTER', preset.noiseFilter),
    searchLoop: presetFlag(env, 'RETRIEVAL_SEARCH_LOOP', preset.searchLoop),
    l3Escalation: presetFlag(env, 'RETRIEVAL_L3_ESCALATION', preset.l3Escalation),
    l3MaxSessions: positiveIntEnv(env, 'RETRIEVAL_L3_MAX_SESSIONS', 3),
    l3TokenCap: positiveIntEnv(env, 'RETRIEVAL_L3_TOKEN_CAP', 60000),
    abstentionMinTopScore: nonNegativeFloatEnv(env, 'RETRIEVAL_ABSTENTION_MIN_SCORE', 0.35),
    abstentionMinEvidence: positiveIntEnv(env, 'RETRIEVAL_ABSTENTION_MIN_EVIDENCE', 2),
    lanes,
  };
}

const LANE_ID_SET = new Set<string>(ALL_LANES);

/** The tenant's parsed overlay object from RETRIEVAL_PROFILE_OVERRIDES,
 *  or undefined when absent/malformed (per-tenant fail-open to base —
 *  the JSON shape itself is boot-validated in env-validation). */
function tenantOverlay(
  companyId: string,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> | undefined {
  const raw = env.RETRIEVAL_PROFILE_OVERRIDES;
  if (!raw || !raw.trim()) return undefined;
  let overrides: Record<string, Record<string, unknown>>;
  try {
    overrides = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const o = overrides?.[companyId];
  return o && typeof o === 'object' ? o : undefined;
}

/**
 * Per-tenant profile resolution: the boot default overlaid with the
 * tenant's entry in RETRIEVAL_PROFILE_OVERRIDES (a JSON object mapping
 * companyId → partial profile; `lanes` as an array of LaneIds).
 * Unknown fields and malformed overrides are ignored per-tenant.
 *
 * The overlay's `genre` resolves FIRST: a tenant pinned to another
 * genre gets THAT genre's preset-backed base (genre-presets.ts), then
 * the remaining overlay fields apply on top — so per-field precedence
 * is overlay field > explicit env key > genre preset > code default.
 */
export function resolveRetrievalProfileFor(
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): RetrievalProfile {
  const o = tenantOverlay(companyId, env);
  const overlayGenre =
    o && typeof o.genre === 'string' && (GENRES as readonly string[]).includes(o.genre)
      ? (o.genre as RetrievalGenre)
      : resolveGenre(env);
  const base = resolveForGenre(overlayGenre, env);
  if (!o) return base;
  const merged: RetrievalProfile = { ...base };
  // Data-driven like the numeric/boolean loops below — every enum
  // field overlays through one loop (a per-field if-ladder pushed the
  // function over the complexity budget when the V8 points landed).
  const enumOverlays: ReadonlyArray<[keyof RetrievalProfile, readonly string[]]> = [
    ['genre', ['dialogue', 'assistant_chat', 'documents']],
    ['verbatimEvidence', ['off', 'shape_conditioned', 'always', 'fused', 'routed']],
    ['insightEvidence', ['off', 'routed', 'query_arc']],
    ['timelineEvidence', ['off', 'routed', 'scan']],
    ['coverageScanMode', ['brute', 'hnsw']],
    ['coverageLexMode', ['phrase', 'or_terms']],
    ['dateAnchoring', ['none', 'session_date', 'absolute']],
    ['temporalMode', ['filter', 'overlap_boost']],
    ['abstentionCalibration', ['off', 'coverage', 'verifier', 'minicheck']],
    ['digestLanes', ['all', 'summary_ku']],
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
    'scanHnswEf',
    'scanHnswOverfetch',
    'rawWindowSpan',
    'assistantLaneTopK',
    'factsAsKeysCap',
    'l3MaxSessions',
    'l3TokenCap',
  ] as const) {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      merged[key] = Math.floor(v);
    }
  }
  // Free-string knobs, each behind its own shape gate (the enum loop
  // can't host them — their value sets are open).
  const stringOverlays: ReadonlyArray<
    ['verifierModel' | 'assistantLaneMatch', (v: string) => boolean]
  > = [
    ['verifierModel', (v) => v === '' || MODEL_ID_RE.test(v)],
    ['assistantLaneMatch', (v) => SPEAKER_MATCH_RE.test(v)],
  ];
  for (const [key, ok] of stringOverlays) {
    const v = o[key];
    if (typeof v === 'string' && ok(v)) merged[key] = v;
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
    'factRerank',
    'mentionDates',
    'sceneTraces',
    'enumStrict',
    'wideProbe',
    'entityExpansion',
    'salienceScoring',
    'updateStoryRendering',
    'orderingFrame',
    'verifierTopicCoverage',
    'digestEvidence',
    'rawWindow',
    'timeFilter',
    'dateMath',
    'answerConditioning',
    'noiseFilter',
    'searchLoop',
    'l3Escalation',
    'assistantLane',
    'factsAsKeys',
    'cjkSegmentation',
  ] as const) {
    if (typeof o[key] === 'boolean') merged[key] = o[key] as boolean;
  }
  if (Array.isArray(o.lanes)) {
    merged.lanes = new Set(o.lanes.filter((l): l is LaneId => LANE_ID_SET.has(String(l))));
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
  /**
   * G8 trace-derived ranking: SEARCH_USAGE_RANKING_ENABLED gates reading
   * fact_usage.readCount into the usage ranking factor;
   * SEARCH_USAGE_BETA is its strength (0 = off), SEARCH_USAGE_SATURATION
   * the readCount at which the saturating boost tops out. Needs recording
   * ON first for readCount to accrue any data.
   */
  usageRanking: boolean;
  usageBeta: number;
  usageSaturation: number;
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
  /** Fact-pool slice the fact-level rerank pass rescoring can afford. */
  factRerankWindow: number;
  rerankSkipMargin: number;
  /** Fused-score band width the rerankers may reorder WITHIN. A score
   *  gap wider than the band (trust priors above all — SEARCH_TRUST_BETA
   *  rides the fused score) survives every rerank stage; 0 disables and
   *  restores absolute reranker priority. */
  rerankTrustBand: number;
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
  /**
   * Multilingual Tier 1. `softLangFilter` (MULTILINGUAL_SOFT_LANG_FILTER)
   * turns the hard same-language WHERE exclusion into a confidence-gated
   * ranking boost — the where-builder drops the exclusion and scoreRows
   * applies the same-language factor, but ONLY when the query language was
   * detected with high confidence (search.service gates on it).
   * `langAttribution` (MULTILINGUAL_LANG_ATTRIBUTION) mirrors the detector
   * flag so the search path can emit query-surface attribution telemetry
   * only when attribution is on. Both default off ⇒ byte-identical.
   */
  softLangFilter: boolean;
  langAttribution: boolean;
}

function tuningInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
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

export function resolveSearchTuning(env: NodeJS.ProcessEnv = process.env): SearchTuning {
  return {
    usageRecording: envFlagEnabled(env.SEARCH_USAGE_RECORDING_ENABLED),
    usageDecay: envFlagEnabled(env.SEARCH_USAGE_DECAY_ENABLED),
    usageRanking: envFlagEnabled(env.SEARCH_USAGE_RANKING_ENABLED),
    usageBeta: nonNegativeFloat(env, 'SEARCH_USAGE_BETA'),
    usageSaturation: tuningInt(env, 'SEARCH_USAGE_SATURATION', 20),
    pprEnabled: envFlagEnabled(env.SEARCH_PPR_ENABLED),
    pprAutoThreshold: tuningInt(env, 'SEARCH_PPR_AUTO_THRESHOLD', 0),
    trustBeta: nonNegativeFloat(env, 'SEARCH_TRUST_BETA'),
    corroborationGamma: nonNegativeFloat(env, 'SEARCH_CORROBORATION_GAMMA'),
    authorityDelta: nonNegativeFloat(env, 'SEARCH_AUTHORITY_DELTA'),
    chatterPenalty: unitPenalty(env, 'SEARCH_CHATTER_PENALTY'),
    crossEncoderLocalWindow: tuningInt(env, 'SEARCH_CROSS_ENCODER_LOCAL_WINDOW', 20),
    crossEncoderWindow: tuningInt(env, 'SEARCH_CROSS_ENCODER_WINDOW', 50),
    factRerankWindow: tuningInt(env, 'SEARCH_FACT_RERANK_WINDOW', 64),
    rerankSkipMargin: nonNegativeFloat(env, 'SEARCH_RERANK_SKIP_MARGIN'),
    // Default 0 = band off (audit round 3: a non-zero band reshapes
    // ranking even without a trust experiment — enable after a
    // benchmark/canary, and always alongside SEARCH_TRUST_BETA, where
    // 0.1 is the measured contract the fact-trust e2e pins).
    rerankTrustBand: nonNegativeFloat(env, 'SEARCH_RERANK_TRUST_BAND'),
    stageBudgets: resolveStageBudgets(env),
    tokenCountOffload: envFlagEnabled(env.SEARCH_TOKEN_COUNT_OFFLOAD ?? '1'),
    tokenOffloadMinHits: tuningInt(env, 'SEARCH_TOKEN_OFFLOAD_MIN_HITS', 24),
    combinedVectorGraph: envFlagEnabled(env.SEARCH_COMBINED_VECTOR_GRAPH),
    hnswEnabled: envFlagEnabled(env.SEARCH_HNSW_ENABLED),
    hnswEf: tuningInt(env, 'SEARCH_HNSW_EF', 100),
    hnswOverfetch: tuningInt(env, 'SEARCH_HNSW_OVERFETCH', 4),
    highlightEnabled: envFlagEnabled(env.SEARCH_HIGHLIGHT_ENABLED),
    edgeExpansion: resolveExpansionConfig(env),
    softLangFilter: envFlagEnabled(env.MULTILINGUAL_SOFT_LANG_FILTER),
    langAttribution: envFlagEnabled(env.MULTILINGUAL_LANG_ATTRIBUTION),
  };
}
