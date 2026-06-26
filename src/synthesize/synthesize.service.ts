import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SearchService, SearchHit } from '../search/search.service';
import { Semaphore } from '../common/semaphore';
import { withSpan } from '../common/tracing';
import { withGenAiCall } from '../common/gen-ai-observability';
import { clampLlmInputText } from '../common/input-limits';
import { traceArtifact } from '../common/debug-trace';
import { getAbortSignal } from '../common/request-context';
import { MetricsService } from '../metrics/metrics.service';
import {
  SynthesisGuardrails,
  SynthesizeDto,
} from './dto/synthesize.dto';
import { buildDecisionLog, type DecisionLogEntry } from './decision-log';
import { applyConformalGuardrail } from './conformal-guardrail';
import { detectLanguage } from '../ai/locale/language-detector';
import {
  NOOP_REPORTER,
  type ProgressReporter,
} from '../mcp/progress-reporter';

export interface Citation {
  factId: string;
  entityId: string;
  canonicalName: string;
  predicate: string;
  object: string;
}

export type SynthesisReason =
  | 'no_results'
  | 'no_grounded_evidence'
  | 'verifier_failed'
  | 'verifier_partial'
  | 'generator_error'
  | 'verifier_error';

export interface SynthesizeResult {
  answer: string | null;
  reason?: SynthesisReason;
  citations: Citation[];
  results: SearchHit[];
  /**
   * Populated only when the request was made with `explain: true`. One
   * entry per retrieved fact, with score breakdown, retrieval-stage
   * provenance, and a picked/rejected verdict with a deterministic
   * rejection reason. See `decision-log.ts`.
   */
  decisionLog?: DecisionLogEntry[];
}

interface GeneratorOutput {
  answer: string;
  citedFactIds: string[];
}

interface VerifierOutput {
  verdict: 'supported' | 'partial' | 'unsupported';
  unsupportedClaims?: string[];
}

const GENERATOR_SYSTEM = `You are an answer synthesizer for a knowledge graph.

Given a user query and a set of retrieved facts (each with a unique factId), generate a CONCISE answer that:
1. Uses ONLY information present in the provided facts. Do NOT speculate, fill in missing details, or use outside knowledge.
2. After each claim in the answer, inline a citation in square brackets with the factId(s) supporting it: e.g. "Maya complained about a broken washing machine [fact_abc]".
3. If the facts do not answer the question, output the exact answer string "I don't have grounded evidence for that." with citedFactIds set to [].

Output strictly the JSON shape requested by the schema. Do not include preamble, follow-ups, or chain-of-thought.`;

const VERIFIER_SYSTEM = `You are a fact-grounding auditor for a knowledge-graph answer system.

Given a synthesized answer and the set of source facts that were available at generation time, judge whether every CLAIM in the answer is directly supported by at least one fact.

Definitions:
- "supported": every distinct claim is directly stated by at least one source fact.
- "partial": some claims are supported, but at least one claim is paraphrased / inferred without a directly supporting fact.
- "unsupported": one or more central claims are not in the facts at all (hallucination).

Be strict on "supported" — a paraphrase that adds detail beyond the facts is "partial" at best. Cite each unsupported / partially-supported claim by quoting the offending span verbatim.

Output strictly the JSON shape requested by the schema.`;

/**
 * SynthesizeService — orchestrates the corrective-RAG flow:
 *
 *   search → generate → verify → return
 *
 * Each LLM call runs under its own OTel span; metrics emit one
 * outcome per request via brain_synthesize_total{outcome}. The
 * service is request-scoped — no per-tenant state.
 *
 * Failure modes are explicit. "I don't know" is the default for
 * empty results, generator errors, and verifier failures in strict
 * mode. The caller never sees a generated answer that wasn't
 * grounded in the retrieved set (in strict mode).
 */
@Injectable()
export class SynthesizeService {
  private readonly logger = new Logger(SynthesizeService.name);
  private readonly openai: OpenAI;
  private readonly defaultModel: string;
  private readonly limiter: Semaphore;
  private readonly defaultGuardrails: SynthesisGuardrails;
  private readonly minCalibratedConfidence: number;

  constructor(
    private readonly search: SearchService,
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY'),
      timeout: parseInt(
        this.configService.get<string>('OPENAI_TIMEOUT_MS', '30000'),
        10,
      ),
      maxRetries: parseInt(
        this.configService.get<string>('OPENAI_MAX_RETRIES', '3'),
        10,
      ),
    });
    this.defaultModel = this.configService.get<string>(
      'SYNTHESIZE_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('SYNTHESIZE_CONCURRENCY', '4'),
        10,
      ),
    );
    const raw = this.configService.get<string>(
      'SYNTHESIZE_DEFAULT_GUARDRAILS',
      'strict',
    );
    this.defaultGuardrails =
      raw === 'lenient' || raw === 'off' ? raw : 'strict';
    // ConU conformal guardrail floor. Pre-fix the default was 0 (off);
    // the audit found prod also never set the env, so the guardrail
    // short-circuited at applyConformalGuardrail():53 and the Phase 3.C
    // claim was unfulfilled. The default is now 0.30 — equivalent to
    // the bitemporal RESOLVER reject_threshold so a fact admitted as a
    // valid INSERTED by the conflict resolver is also admitted as a
    // valid synthesize citation. Operators can disable per-deployment
    // by setting SYNTHESIZE_MIN_CONFIDENCE=0.
    this.minCalibratedConfidence = parseFloat(
      this.configService.get<string>('SYNTHESIZE_MIN_CONFIDENCE', '0.30'),
    );
  }

  async synthesize(
    companyId: string,
    dto: SynthesizeDto,
    callerScopes: string[],
    onProgress: ProgressReporter = NOOP_REPORTER,
  ): Promise<SynthesizeResult> {
    // Defence-in-depth clamp. SynthesizeDto.@MaxLength('query', 8000)
    // covers HTTP callers, but multi-hop and admin-demo drive
    // synthesize() with bodies that bypass class-validator. Clamp here
    // so the generator prompt size is bounded regardless of caller.
    const clamped = clampLlmInputText(dto.query ?? '', 'query');
    if (clamped.truncated) {
      this.logger.warn(
        `synthesize: query truncated to ${clamped.value.length} chars (companyId=${companyId})`,
      );
    }
    dto = { ...dto, query: clamped.value };
    const guardrails: SynthesisGuardrails =
      dto.synthesisGuardrails ?? this.defaultGuardrails;
    const model = dto.synthesisModel ?? this.defaultModel;
    const explain = dto.explain === true;

    onProgress({ stage: 'search', message: 'hybrid retrieval' });
    const searchResult = await withSpan(
      'synthesize.search',
      () => this.search.search(companyId, dto, callerScopes),
      { 'synthesize.guardrails': guardrails },
    );
    // Conformal guardrail: drop facts below the calibrated-confidence
    // floor BEFORE the generator sees them as citation targets. Facts
    // still appear in the DecisionLog (with the `low_score` reject
    // reason) when the caller asked for `explain: true`. With the
    // default floor of 0 this is a no-op.
    const guardrail = applyConformalGuardrail(searchResult.results, {
      minCalibratedConfidence: this.minCalibratedConfidence,
    });
    const results = guardrail.kept;
    if (guardrail.droppedCount > 0) {
      this.logger.debug(
        `conformal guardrail dropped ${guardrail.droppedCount} fact(s) below ${this.minCalibratedConfidence}`,
      );
    }

    if (results.length === 0) {
      this.metrics?.countSynthesize('no_results');
      return attachDecisionLog(
        {
          answer: null,
          reason: 'no_results',
          citations: [],
          results: [],
        },
        explain ? [] : undefined,
      );
    }

    const { factIndex, factLines } = buildFactIndex(results);

    if (factIndex.size === 0) {
      // Search returned entities but they were stripped to ids by
      // outputShape='ids' / token budget. Treat as no_results for
      // synthesis purposes — we have nothing to cite.
      this.metrics?.countSynthesize('no_results');
      return attachDecisionLog(
        {
          answer: null,
          reason: 'no_results',
          citations: [],
          results,
        },
        explain ? buildDecisionLog(results, new Set()) : undefined,
      );
    }

    // Phase 4.C — resolve the answer language. Explicit DTO wins;
    // otherwise we detect from the query (so a Russian question gets
    // a Russian answer by default without the caller having to opt in).
    const answerLang =
      dto.answerLang ?? detectAnswerLang(dto.query);

    onProgress({
      stage: 'generate',
      message: `LLM grounding answer over ${factIndex.size} facts`,
    });
    let generated: GeneratorOutput;
    try {
      generated = await withSpan(
        'synthesize.generate',
        () =>
          this.limiter.run(() =>
            this.callGenerator(dto.query, factLines, model, answerLang),
          ),
        { 'synthesize.facts': factIndex.size },
      );
    } catch (err) {
      this.logger.warn(
        `Synthesize generator failed: ${(err as Error).message}`,
      );
      this.metrics?.countSynthesize('generator_error');
      return attachDecisionLog(
        {
          answer: null,
          reason: 'generator_error',
          citations: [],
          results,
        },
        explain ? buildDecisionLog(results, new Set()) : undefined,
      );
    }

    const citations = resolveCitations(
      generated.citedFactIds,
      generated.answer,
      factIndex,
    );
    const citedSet = new Set(citations.map((c) => c.factId));
    const decisionLog = explain
      ? buildDecisionLog(results, citedSet)
      : undefined;

    // Sentinel "I don't know" path. Generator was honest about
    // empty grounding; no need to verify, no need to cite.
    if (
      generated.answer.trim() === "I don't have grounded evidence for that."
    ) {
      this.metrics?.countSynthesize('no_grounded_evidence');
      return attachDecisionLog(
        {
          answer: generated.answer,
          reason: 'no_grounded_evidence',
          citations: [],
          results,
        },
        decisionLog,
      );
    }

    if (guardrails === 'off') {
      this.metrics?.countSynthesize('ok');
      return attachDecisionLog(
        { answer: generated.answer, citations, results },
        decisionLog,
      );
    }

    onProgress({ stage: 'verify', message: 'verifier checking claim grounding' });
    // Verifier — the corrective guardrail. Runs in strict and
    // lenient modes. Strict gates the answer behind a 'supported'
    // verdict; lenient surfaces the verdict but returns the answer
    // either way.
    let verdict: VerifierOutput;
    try {
      verdict = await withSpan(
        'synthesize.verify',
        () =>
          this.limiter.run(() =>
            this.callVerifier(
              dto.query,
              generated.answer,
              factLines,
              model,
            ),
          ),
        { 'synthesize.facts': factIndex.size },
      );
    } catch (err) {
      this.logger.warn(`Synthesize verifier failed: ${(err as Error).message}`);
      this.metrics?.countSynthesize('verifier_error');
      return verifierErrorResult(
        guardrails,
        generated.answer,
        citations,
        results,
        decisionLog,
      );
    }

    return this.finalizeVerdict(
      verdict.verdict,
      generated.answer,
      citations,
      results,
      guardrails,
      decisionLog,
    );
  }

  /**
   * Verdict → response shape. Extracted out of `synthesize()` to keep
   * its cyclomatic complexity under the gate: the synthesize method is
   * a long happy-path / error-path ladder; folding the verifier-decision
   * matrix here collapses 12 branches into a 3-state switch.
   *
   * Strict + non-supported → answer dropped (fail-closed). Lenient
   * surfaces the answer with a reason tag. Supported is the ok path.
   */
  private finalizeVerdict(
    verdict: VerifierOutput['verdict'],
    answer: string,
    citations: Citation[],
    results: SynthesizeResult['results'],
    guardrails: SynthesisGuardrails,
    decisionLog?: DecisionLogEntry[],
  ): SynthesizeResult {
    if (verdict === 'supported') {
      this.metrics?.countSynthesize('ok');
      return attachDecisionLog(
        { answer, citations, results },
        decisionLog,
      );
    }
    const reason: SynthesisReason =
      verdict === 'partial' ? 'verifier_partial' : 'verifier_failed';
    this.metrics?.countSynthesize(reason);
    if (guardrails === 'lenient') {
      return attachDecisionLog(
        { answer, reason, citations, results },
        decisionLog,
      );
    }
    // strict — fail closed.
    return attachDecisionLog(
      { answer: null, reason, citations: [], results },
      decisionLog,
    );
  }

  private async callGenerator(
    query: string,
    factLines: string[],
    model: string,
    answerLang: string | null,
  ): Promise<GeneratorOutput> {
    const langInstruction = answerLang
      ? `\n\nLanguage policy: write your answer in ${answerLang} (ISO 639-1). Keep citation spans in their original language.`
      : '';
    const user = `Query: ${query}\n\nRetrieved facts:\n${factLines.join('\n')}${langInstruction}`;
    traceArtifact('synthesize.generator_prompt', {
      system: GENERATOR_SYSTEM,
      user,
      model,
      answerLang,
    });
    const res = await withGenAiCall(
      {
        kind: 'chat',
        spanName: 'gen_ai.chat.synthesize_generator',
        system: 'openai',
        model,
        attrs: { 'brain.synthesize.answer_lang': answerLang ?? 'auto' },
      },
      this.metrics,
      () => this.openai.chat.completions.create(
      {
      model,
      messages: [
        { role: 'system', content: GENERATOR_SYSTEM },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'synthesized_answer',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              answer: { type: 'string' },
              citedFactIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['answer', 'citedFactIds'],
          },
        },
      },
      max_completion_tokens: 512,
      temperature: 0,
    }, { signal: getAbortSignal() }),
    );
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('empty generator response');
    const parsed = JSON.parse(content) as GeneratorOutput;
    if (typeof parsed.answer !== 'string') {
      throw new Error('generator returned non-string answer');
    }
    if (!Array.isArray(parsed.citedFactIds)) {
      parsed.citedFactIds = [];
    }
    traceArtifact('synthesize.generator_output', parsed);
    return parsed;
  }

  private async callVerifier(
    query: string,
    answer: string,
    factLines: string[],
    model: string,
  ): Promise<VerifierOutput> {
    const user = `Query: ${query}\n\nAnswer:\n${answer}\n\nSource facts:\n${factLines.join('\n')}`;
    traceArtifact('synthesize.verifier_prompt', {
      system: VERIFIER_SYSTEM,
      user,
      model,
    });
    const res = await withGenAiCall(
      {
        kind: 'chat',
        spanName: 'gen_ai.chat.synthesize_verifier',
        system: 'openai',
        model,
      },
      this.metrics,
      () => this.openai.chat.completions.create(
      {
      model,
      messages: [
        { role: 'system', content: VERIFIER_SYSTEM },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'verifier_verdict',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              verdict: {
                type: 'string',
                enum: ['supported', 'partial', 'unsupported'],
              },
              unsupportedClaims: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['verdict', 'unsupportedClaims'],
          },
        },
      },
      max_completion_tokens: 256,
      temperature: 0,
    }, { signal: getAbortSignal() }),
    );
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('empty verifier response');
    const parsed = JSON.parse(content) as VerifierOutput;
    if (
      parsed.verdict !== 'supported' &&
      parsed.verdict !== 'partial' &&
      parsed.verdict !== 'unsupported'
    ) {
      throw new Error('verifier returned invalid verdict');
    }
    traceArtifact('synthesize.verifier_output', parsed);
    return parsed;
  }
}

// ── Pure helpers (lifted out of `synthesize()` to keep the orchestrator
// under the cognitive-complexity gate) ────────────────────────────────

interface FactIndexResult {
  factIndex: Map<string, Citation>;
  factLines: string[];
}

/**
 * Build the (factId → Citation) lookup the generator/verifier consult,
 * plus a human-readable line-per-fact list rendered into the prompts.
 * No-IO, no DI — pure.
 */
function buildFactIndex(results: SearchHit[]): FactIndexResult {
  const factIndex = new Map<string, Citation>();
  const factLines: string[] = [];
  for (const r of results) {
    for (const f of r.facts) {
      factIndex.set(f.factId, {
        factId: f.factId,
        entityId: r.entityId,
        canonicalName: r.canonicalName,
        predicate: f.predicate,
        object: f.object,
      });
      factLines.push(
        `[${f.factId}] ${r.canonicalName} (${r.entityType}) — ${f.predicate}: ${f.object}`,
      );
    }
  }
  return { factIndex, factLines };
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
function resolveCitations(
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
function attachDecisionLog(
  result: SynthesizeResult,
  decisionLog: DecisionLogEntry[] | undefined,
): SynthesizeResult {
  return decisionLog === undefined ? result : { ...result, decisionLog };
}

/**
 * Detect the answer language from the user query. Wraps the pure
 * detector and returns `null` when the detector is undecided so the
 * caller can omit the language instruction from the prompt entirely
 * (the generator's own multilingual default is correct enough for
 * the `und` case).
 */
function detectAnswerLang(query: string): string | null {
  const r = detectLanguage(query);
  return r.language === 'und' ? null : r.language;
}

/**
 * Verifier-error result selection: strict ⇒ fail-closed (drop answer);
 * lenient/off ⇒ surface the answer with a `verifier_error` reason.
 * Extracted from `synthesize()` to keep the orchestrator under the
 * cognitive-complexity gate.
 */
function verifierErrorResult(
  guardrails: SynthesisGuardrails,
  answer: string,
  citations: Citation[],
  results: SearchHit[],
  decisionLog: DecisionLogEntry[] | undefined,
): SynthesizeResult {
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
