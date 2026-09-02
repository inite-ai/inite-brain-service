import type { SearchHit } from '../search/search.service';
import { detectLanguage, type ScriptCode } from '../ai/locale/language-detector';
import type { LaneId, RetrievalProfile } from '../search/retrieval-profile';
import { routeLane, detectEvidenceConflicts } from './answer-router';
import type { MultilingualLaneClassifierService } from './multilingual-lane-classifier.service';
import type { SynthesisGuardrails, SynthesizeDto } from './dto/synthesize.dto';
import type { SearchDto } from '../search/dto/search.dto';
import type { DecisionLogEntry } from './decision-log';
import { resolveDateContext } from './evidence-union';
import type { Citation } from './fact-index';
import type { GeneratorOutput, SynthesizeResult } from './synthesize.types';
import { buildDateMathLines } from './date-math';
import { detectAnswerShape, shapeInstructionFor } from './answer-shape';
import { resolvePromptFrames } from './evidence-gates';
import type { GenerateRequest } from './generator-client';
import type { MetricsService } from '../metrics/metrics.service';

/**
 * Pure helpers of the synthesize orchestrator, split out of
 * synthesize.service.ts (max-lines budget — the V9 §2/§4 lanes pushed
 * the service over 800). No IO, no DI; type-only imports back into the
 * service module, so there is no runtime cycle.
 */

/**
 * Route a query to a typed lane. Multilingual Tier 4 (MULTILINGUAL_LANE_ROUTING):
 * when the English-regex router MISSES (null) and the flag is on, a language-
 * agnostic nearest-centroid classifier proposes a lane for a non-English query
 * — abstain-safe (low confidence ⇒ null ⇒ the generic path). Flag off /
 * classifier absent ⇒ the regex route, byte-identical.
 */
export async function resolveRoutedLane(
  profile: RetrievalProfile,
  query: string,
  classifier?: MultilingualLaneClassifierService,
): Promise<LaneId | null> {
  const lane = routeLane(profile, query);
  if (lane !== null || !profile.multilingualLaneRouting || !classifier) return lane;
  return classifier.augmentLane(query, profile.lanes);
}

/**
 * Evidence-conflict detection, threaded with the Tier 4 typed-compare flag
 * (MULTILINGUAL_CONFLICT). Off ⇒ byte-identical surface-string comparison.
 */
function evidenceConflicts(
  results: SearchHit[],
  profile: RetrievalProfile,
): Array<{ factIds: string[]; label: string }> {
  return detectEvidenceConflicts(results, profile.lanes, profile.multilingualConflict);
}

/**
 * Serve an answer-cache hit — and count it as the terminal `ok` it is. admit()
 * only ever caches a verifier-`supported`, cited answer, so a served hit is an
 * `ok`; recording it in the SAME brain_synthesize_total counter the fresh path
 * bumps keeps the MRI per-request denominator (terminal synthesize count)
 * inclusive of cache hits instead of silently dropping them and skewing every
 * "per query" rate (R3 P1). Read-only accounting: no verdict/serving change, and
 * the caller only reaches here when the cache is on (off by default).
 */
export function serveCacheHit(
  metrics: MetricsService | undefined,
  hit: SynthesizeResult,
): SynthesizeResult {
  metrics?.countSynthesize('ok');
  return hit;
}

/**
 * V13 answer-side frames, both profile-gated and both pure: the
 * computed date table (RETRIEVAL_DATE_MATH) and the G2 per-shape
 * reading instruction (RETRIEVAL_ANSWER_CONDITIONING). Undefined
 * fields render nothing — byte-identical prompt with both flags off.
 */
export function resolveAnswerFrames(args: {
  profile: RetrievalProfile;
  query: string;
  results: SearchHit[];
}): { dateMathLines?: string[] | undefined; shapeInstruction?: string | undefined } {
  const shape = args.profile.answerConditioning ? detectAnswerShape(args.query) : null;
  return {
    dateMathLines: args.profile.dateMath ? buildDateMathLines(args.results) : undefined,
    shapeInstruction: shape ? shapeInstructionFor(shape) : undefined,
  };
}

/**
 * Secondary-retrieval DTO builder (audit 2026-08-19 P1: every probe and
 * refine round used to send only {query, limit}, silently dropping the
 * caller's filter contract — entity/predicate/type anchors, confidence
 * and status floors, search mode, asOf and the user scope. An M2M call
 * with an explicit userId lost the user's memory in every secondary
 * search). One builder inherits the FULL constraint set; only the query
 * and limit vary per probe.
 */
export function buildSecondaryDto(
  base: SearchDto,
  override: { query: string; limit?: number },
): SearchDto {
  return {
    ...(base.asOf !== undefined ? { asOf: base.asOf } : {}),
    ...(base.userId !== undefined ? { userId: base.userId } : {}),
    ...(base.entityIds ? { entityIds: base.entityIds } : {}),
    ...(base.entityTypes ? { entityTypes: base.entityTypes } : {}),
    ...(base.predicates ? { predicates: base.predicates } : {}),
    ...(base.minConfidence !== undefined ? { minConfidence: base.minConfidence } : {}),
    ...(base.includeContested !== undefined ? { includeContested: base.includeContested } : {}),
    ...(base.includeRetracted !== undefined ? { includeRetracted: base.includeRetracted } : {}),
    ...(base.requireProvenance !== undefined ? { requireProvenance: base.requireProvenance } : {}),
    ...(base.searchMode ? { searchMode: base.searchMode } : {}),
    // Audit 2026-08-21 P1: the temporal/language/confidence axes are
    // retrieval SEMANTICS and must survive into secondary searches too.
    // outputShape/tokenBudget are deliberately NOT inherited — they
    // shape the caller's RESPONSE, not what a probe may retrieve.
    ...(base.includeStale !== undefined ? { includeStale: base.includeStale } : {}),
    ...(base.confidenceFloor !== undefined ? { confidenceFloor: base.confidenceFloor } : {}),
    ...(base.queryLang !== undefined ? { queryLang: base.queryLang } : {}),
    ...(base.disableLangFilter !== undefined ? { disableLangFilter: base.disableLangFilter } : {}),
    query: override.query,
    limit: override.limit ?? base.limit ?? 10,
  } as SearchDto;
}

/**
 * Assemble the generator-client request from the query-invariant context
 * (profile/lane/model/answerLang/collected sections) plus the per-round
 * evidence (`o`). ONE builder for round-1, the refine round, and the Tier 5
 * answer-language retry, so those calls cannot drift; the only per-round
 * differences are the evidence lines, the conflict set (derived from
 * `o.results`), and the two optional switches (`allowRefine`, `answerLangStrict`).
 * Pure — no `this`, no IO; field VALUES match the historical inline calls
 * (order is irrelevant, the client destructures by name) so the assembled
 * prompt is byte-identical.
 */
export function buildGeneratorArgs(
  ctx: {
    dto: SynthesizeDto;
    profile: RetrievalProfile;
    lane: LaneId | null;
    model: string;
    answerLang: string | null;
    guardrails: SynthesisGuardrails;
    shapeInstruction?: string | undefined;
    collected: {
      transcriptLines: string[];
      insightLines: string[];
      instructions?: string[] | undefined;
      timelineEvidence: boolean;
      strategyNotes?: string[] | undefined;
      /** MM-zoom PR2: rendered media-evidence lines (own section). */
      fragmentLines?: string[] | undefined;
      /** EVIDENCE_FRAGMENT_CITATIONS, resolved once per request. */
      fragmentCitations?: boolean | undefined;
    };
  },
  o: {
    results: SearchHit[];
    promptFactLines: string[];
    dateMathLines?: string[] | undefined;
    allowRefine?: boolean | undefined;
    answerLangStrict?: boolean | undefined;
  },
): Omit<GenerateRequest, 'openai' | 'metrics' | 'logger'> {
  const { profile, dto, collected } = ctx;
  return {
    query: dto.query,
    factLines: o.promptFactLines,
    transcriptLines: collected.transcriptLines,
    insightLines: collected.insightLines,
    timelineEvidence: collected.timelineEvidence,
    // V10 frame switches — resolved once by the kernel, not inline.
    ...resolvePromptFrames(profile, collected.timelineEvidence),
    model: ctx.model,
    answerLang: ctx.answerLang,
    neverAbstain: ctx.guardrails === 'answer',
    // Date context anchors "today"; the temporal lane forces it from asOf.
    dateContext: resolveLaneDateContext(profile, ctx.lane, dto.asOf),
    lane: ctx.lane,
    enumStrict: profile.enumStrict,
    instructions: collected.instructions,
    // T3: evidence-conditional conflict pairs (from THIS round's results).
    conflicts: evidenceConflicts(o.results, profile),
    dateMathLines: o.dateMathLines,
    shapeInstruction: ctx.shapeInstruction,
    // G4 strategy lane: advisory notes, GENERATOR-ONLY (parity exception).
    strategyNotes: collected.strategyNotes,
    // MM-zoom PR2: media evidence + the fragment-citation affordance —
    // both rounds of the search loop carry them identically.
    fragmentLines: collected.fragmentLines,
    fragmentCitations: collected.fragmentCitations,
    ...(o.allowRefine !== undefined ? { allowRefine: o.allowRefine } : {}),
    ...(o.answerLangStrict ? { answerLangStrict: true } : {}),
  };
}

/** Temporal lane forces the Today anchor from asOf; others follow the
 *  profile's dateAnchoring. */
function resolveLaneDateContext(
  profile: RetrievalProfile,
  lane: LaneId | null,
  asOf: string | undefined,
): string | undefined {
  if (lane === 'temporal' && asOf) return asOf.slice(0, 10);
  return resolveDateContext(profile.dateAnchoring, asOf);
}

/**
 * Recover the answer text from a JSON body the provider cut off at the
 * token cap (finish_reason='length'). Strict JSON mode emits the schema
 * fields in order, so the partial body still contains `"answer": "…`
 * with the closing quote missing. Returns null when nothing usable is
 * there — the caller then throws as before.
 */
export function salvageTruncatedAnswer(content: string): GeneratorOutput | null {
  const m = /"answer"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(content);
  if (!m) return null;
  let answer: string;
  try {
    answer = JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
  if (!answer.trim()) return null;
  return { answer, citedFactIds: [] };
}

/**
 * Strip a record-id prefix down to its bare tail so citations resolve
 * across format drift. The generator is shown `[knowledge_fact:<tail>]`
 * in the fact list but the prompt's own example uses `[fact_abc]`, so the
 * model intermittently emits `fact_<tail>` / `fact:<tail>` instead of the
 * canonical `knowledge_fact:<tail>`. Tails are 20-char random slugs, so
 * matching on the tail is unambiguous.
 */
function citationTail(id: string): string {
  return id.replace(/^knowledge_fact[:_]/i, '').replace(/^fact[:_]/i, '');
}

/**
 * Pull `[<factId>]` citation markers out of the answer text. The generator
 * RELIABLY inlines a bracketed citation after each claim (system prompt
 * rule #2) but only INTERMITTENTLY mirrors them into the structured
 * `citedFactIds` array — so the answer text is the more trustworthy
 * citation source. Matches an optional table prefix + a ≥6-char slug to
 * avoid catching ordinary bracketed prose.
 */
function extractInlineCitations(answer: string): string[] {
  const ids: string[] = [];
  const re = /\[((?:knowledge_fact[:_]|fact[:_])?[A-Za-z0-9]{6,})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) ids.push(m[1]!); // group 1 is mandatory
  return ids;
}

/**
 * Resolve the generator's citations against the retrieved index. Unions
 * the structured `citedFactIds` array with the `[...]` markers parsed from
 * the answer text (the model populates the array unreliably — see
 * extractInlineCitations) and matches each candidate by exact id OR by
 * bare tail (see citationTail) so prefix drift still resolves. A candidate
 * that matches no retrieved fact is a hallucinated citation — dropped.
 * Preserves emission order; deduplicates by resolved factId.
 */
export function resolveCitations(
  citedFactIds: string[] | undefined,
  answer: string,
  factIndex: Map<string, Citation>,
): Citation[] {
  const byTail = new Map<string, Citation>();
  for (const [id, cite] of factIndex) byTail.set(citationTail(id), cite);

  const citations: Citation[] = [];
  const seen = new Set<string>();
  const candidates = [...(citedFactIds ?? []), ...extractInlineCitations(answer ?? '')];
  for (const raw of candidates) {
    const cite = factIndex.get(raw) ?? byTail.get(citationTail(raw));
    if (cite && !seen.has(cite.factId)) {
      seen.add(cite.factId);
      citations.push(cite);
    }
  }
  return citations;
}

/**
 * Attach an optional decisionLog to a result without ternary noise at
 * each return site. Keeps the orchestrator under the complexity gate.
 */
export function attachDecisionLog(
  result: SynthesizeResult,
  decisionLog: DecisionLogEntry[] | undefined,
): SynthesizeResult {
  return decisionLog === undefined ? result : { ...result, decisionLog };
}

/**
 * Confidence floor for treating a detected language as the answer target
 * (Tier 5 answer-language guard). The Tier 1 detector reports `confidence`
 * ∈ [0,1] — the dominant-script fraction (non-Latin) or the stopword
 * fraction (Latin). Below this floor the query language is too weakly
 * signalled to force, so the guard declines to `no forced language` (the
 * generator's own multilingual default). Also the floor below which a
 * DETECTED ANSWER language is not trusted enough to call a mismatch.
 */
const ANSWER_LANG_MIN_CONFIDENCE = 0.3;

/** Normalise a locale hint to a bare ISO 639-1 code, or null if unusable. */
function normalizeLangCode(x: string | undefined): string | null {
  if (!x) return null;
  const code = x.trim().toLowerCase().slice(0, 2);
  return /^[a-z]{2}$/.test(code) ? code : null;
}

/**
 * Detect the answer language.
 *
 * Default (guard off / no profile) — BYTE-IDENTICAL to the historical
 * behaviour: explicit DTO value wins, else the pure detector on the query;
 * `null` when the detector is undecided (`und`) so the caller omits the
 * language instruction and the generator's own multilingual default applies.
 *
 * Tier 5 (profile.answerLangGuard, MULTILINGUAL_ANSWER_GUARD) — a strict
 * fallback ORDER so the retrieved FACTS never decide the answer language:
 *   1. explicit `answerLang`,
 *   2. the user/session locale (dto.queryLang),
 *   3. a CONFIDENTLY-detected query language (Tier 1 confidence ≥ floor),
 *   4. `null` — no forced language.
 */
export function resolveAnswerLang(
  dto: SynthesizeDto,
  profile?: { answerLangGuard?: boolean } | undefined,
): string | null {
  if (dto.answerLang) return dto.answerLang;
  if (profile?.answerLangGuard) {
    const locale = normalizeLangCode(dto.queryLang);
    if (locale) return locale;
    const r = detectLanguage(dto.query);
    return r.language !== 'und' && r.confidence >= ANSWER_LANG_MIN_CONFIDENCE ? r.language : null;
  }
  const r = detectLanguage(dto.query);
  return r.language === 'und' ? null : r.language;
}

/** Canonical ISO 15924 script for an ISO 639-1 target language. Non-Latin
 *  targets each map to their one script by the Tier 1 detector's convention;
 *  everything else is Latin. */
function scriptForLang(lang: string): ScriptCode {
  switch (lang.slice(0, 2).toLowerCase()) {
    case 'ru':
      return 'Cyrl';
    case 'zh':
      return 'Hani';
    case 'ja':
      return 'Hira';
    case 'ko':
      return 'Hang';
    case 'ar':
      return 'Arab';
    case 'hi':
      return 'Deva';
    default:
      return 'Latn';
  }
}

/**
 * Whether a generated `answer` is in the wrong language for `targetLang`
 * (Tier 5 output-language check). Deliberately CROSS-SCRIPT only: a Latin
 * answer to a Cyrillic/CJK/Arabic/Devanagari target (and vice-versa) is the
 * high-precision, high-value failure the detector catches reliably. Within-
 * script disambiguation (e.g. Spanish vs English) is NOT adjudicated — short-
 * answer Latin stopword scoring is too noisy (see language-detector.ts), and
 * a false mismatch would waste a corrective LLM call. Undetermined (`und`) or
 * low-confidence detections are never a mismatch, so proper-noun-only / numeric
 * answers ("Paris", "42") in any target are left alone.
 */
export function answerLanguageMismatch(
  answer: string,
  targetLang: string,
  minConfidence: number = ANSWER_LANG_MIN_CONFIDENCE,
): boolean {
  if (!answer.trim()) return false;
  // Attribution OFF: a deterministic label independent of
  // MULTILINGUAL_LANG_ATTRIBUTION — this check is about the SCRIPT.
  const det = detectLanguage(answer, false);
  if (det.language === 'und' || det.script === 'Zyyy') return false;
  if (det.confidence < minConfidence) return false;
  return det.script !== scriptForLang(targetLang);
}

/**
 * Tier 5 output-language guard (the decision + bounded retry, side of the
 * generator call the orchestrator owns via `regenerate`). Returns the
 * CORRECTED answer when a cross-script mismatch was found and a regeneration
 * ran, or `null` when nothing should change (guard off / no forced target /
 * no mismatch / retry threw) — the caller then keeps the original. Bounded to
 * ONE retry: a still-mismatched retry is flagged (metrics + log) and returned
 * best-effort. Pure control-flow — the LLM call is injected.
 */
export async function enforceAnswerLanguage(
  deps: { metrics?: MetricsService | undefined; logger: { warn(message: string): void } },
  ctx: { guard: boolean; target: string | null; answer: string | null | undefined },
  regenerate: () => Promise<GeneratorOutput>,
): Promise<GeneratorOutput | null> {
  const { guard, target, answer } = ctx;
  if (!guard || !target || !answer || !answerLanguageMismatch(answer, target)) return null;
  deps.metrics?.countSynthesize('answer_lang_retry');
  try {
    const retry = await regenerate();
    if (answerLanguageMismatch(retry.answer, target)) {
      // Bounded: one retry, then flag — the retry (reinforced directive) is the
      // best-effort attempt, so it is still returned.
      deps.metrics?.countSynthesize('answer_lang_unresolved');
      deps.logger.warn(
        `answer-language guard: answer still not in target '${target}' after one retry`,
      );
    }
    return retry;
  } catch (err) {
    deps.logger.warn(
      `answer-language retry failed (${(err as Error).message}); keeping the original answer`,
    );
    return null;
  }
}

/**
 * Verifier-error result selection: strict ⇒ fail-closed (drop answer);
 * lenient/off ⇒ surface the answer with a `verifier_error` reason.
 * Extracted from `synthesize()` to keep the orchestrator under the
 * cognitive-complexity gate.
 */
export function verifierErrorResult({
  guardrails,
  answer,
  citations,
  results,
  decisionLog,
}: {
  guardrails: SynthesisGuardrails;
  answer: string;
  citations: Citation[];
  results: SearchHit[];
  decisionLog: DecisionLogEntry[] | undefined;
}): SynthesizeResult {
  if (guardrails === 'strict') {
    return attachDecisionLog(
      { answer: null, reason: 'verifier_error', citations: [], results },
      decisionLog,
    );
  }
  return attachDecisionLog({ answer, reason: 'verifier_error', citations, results }, decisionLog);
}
