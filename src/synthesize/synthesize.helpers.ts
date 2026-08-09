import type { SearchHit } from '../search/search.service';
import { detectLanguage } from '../ai/locale/language-detector';
import type { LaneId, RetrievalProfile } from '../search/retrieval-profile';
import type { SynthesisGuardrails, SynthesizeDto } from './dto/synthesize.dto';
import type { DecisionLogEntry } from './decision-log';
import { resolveDateContext } from './evidence-union';
import type { Citation } from './fact-index';
import type { GeneratorOutput, SynthesizeResult } from './synthesize.types';

/**
 * Pure helpers of the synthesize orchestrator, split out of
 * synthesize.service.ts (max-lines budget — the V9 §2/§4 lanes pushed
 * the service over 800). No IO, no DI; type-only imports back into the
 * service module, so there is no runtime cycle.
 */

/** Temporal lane forces the Today anchor from asOf; others follow the
 *  profile's dateAnchoring. */
export function resolveLaneDateContext(
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
export function salvageTruncatedAnswer(
  content: string,
): GeneratorOutput | null {
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
  while ((m = re.exec(answer)) !== null) ids.push(m[1]);
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
  const candidates = [
    ...(citedFactIds ?? []),
    ...extractInlineCitations(answer ?? ''),
  ];
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
 * Detect the answer language: explicit DTO value wins, else the pure
 * detector on the query; `null` when the detector is undecided so the
 * caller can omit the language instruction from the prompt entirely
 * (the generator's own multilingual default is correct enough for
 * the `und` case).
 */
export function resolveAnswerLang(dto: SynthesizeDto): string | null {
  if (dto.answerLang) return dto.answerLang;
  const r = detectLanguage(dto.query);
  return r.language === 'und' ? null : r.language;
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
  return attachDecisionLog(
    { answer, reason: 'verifier_error', citations, results },
    decisionLog,
  );
}
