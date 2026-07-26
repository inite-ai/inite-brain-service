import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
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
import { applyEvidenceUnion, resolveDateContext } from './evidence-union';
import { EpisodeLaneService } from './episode-lane.service';
import { detectLanguage } from '../ai/locale/language-detector';
import {
  NOOP_REPORTER,
  type ProgressReporter,
} from '../mcp/progress-reporter';

export interface SynthesizeOptions {
  companyId: string;
  dto: SynthesizeDto;
  callerScopes: string[];
  onProgress?: ProgressReporter;
  /**
   * Pre-retrieved evidence merged into the re-search results before the
   * generator sees them (multi-hop passes its hop hits here under
   * MULTI_HOP_SYNTH_EVIDENCE_UNION). Base results keep their order;
   * unseen extra facts append best-score-first, capped by
   * SYNTHESIZE_EXTRA_EVIDENCE_CAP.
   */
  extraHits?: SearchHit[];
}

export interface Citation {
  factId: string;
  entityId: string;
  canonicalName: string;
  predicate: string;
  object: string;
  /** Who claimed it — the write-time sourceKey (trustSnapshot). Lets a
   *  caller chase the citation to get_source_reputation. Absent on
   *  pre-0044 facts. */
  sourceKey?: string;
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

/**
 * Generator user-message assembly, exported for byte-equality tests.
 * Without `dateContext` the output is identical to the historical
 * format; with it, an anchored "Today" + date-arithmetic instruction
 * sits between the query and the fact list (SYNTHESIZE_DATE_CONTEXT).
 */
export function buildGeneratorUserMessage({
  query,
  factLines,
  transcriptLines,
  answerLang,
  dateContext,
}: {
  query: string;
  factLines: string[];
  /** Episodic-lane quotes (P2) — separate typed section after the facts. */
  transcriptLines?: string[];
  answerLang: string | null;
  dateContext?: string;
}): string {
  const langInstruction = answerLang
    ? `\n\nLanguage policy: write your answer in ${answerLang} (ISO 639-1). Keep citation spans in their original language.`
    : '';
  const dateInstruction = dateContext
    ? `Today: ${dateContext}. Facts carry date stamps like (as of YYYY-MM-DD). Resolve relative time expressions ("last week", "next month") against the stamp of the fact that states them, and answer "when" questions with a specific date or period, using simple date arithmetic when needed.\n`
    : '';
  const transcriptSection =
    transcriptLines && transcriptLines.length > 0
      ? `\n\nTranscript excerpts (verbatim, chronological — use them to answer, but cite factIds only):\n${transcriptLines.join('\n')}`
      : '';
  return `Query: ${query}\n${dateInstruction}\nRetrieved facts:\n${factLines.join('\n')}${transcriptSection}${langInstruction}`;
}

interface VerifierOutput {
  verdict: 'supported' | 'partial' | 'unsupported';
  unsupportedClaims?: string[];
}

const GENERATOR_SYSTEM = `You are an answer synthesizer for a knowledge graph.

Given a user query and a set of retrieved facts (each prefixed with its factId in square brackets, e.g. "[knowledge_fact:8a3fd2c1b9e4f7a6d5c0] ..."), generate a CONCISE answer that:
1. Uses ONLY information present in the provided facts. Do NOT speculate, fill in missing details, or use outside knowledge.
2. After each claim in the answer, inline a citation in square brackets, copying the factId EXACTLY as it appears in the fact list — including its "knowledge_fact:" prefix. Do not abbreviate, renumber, or change the prefix. Example: "Maya complained about a broken washing machine [knowledge_fact:8a3fd2c1b9e4f7a6d5c0]". Mirror every factId you cite inline into the citedFactIds array.
3. If the facts do not answer the question, output the exact answer string "I don't have grounded evidence for that." with citedFactIds set to [].

Output strictly the JSON shape requested by the schema. Do not include preamble, follow-ups, or chain-of-thought.`;

/**
 * Best-effort / never-abstain generator (guardrails='answer'). Same grounding
 * discipline, but instead of refusing when the facts are thin it commits to
 * the single most likely SHORT answer the retrieved facts point to. For QA
 * settings where an abstention scores strictly worse than a best guess.
 */
const GENERATOR_SYSTEM_ANSWER = `You are an answer synthesizer for a knowledge graph.

Given a user query and a set of retrieved facts (each prefixed with its factId in square brackets, e.g. "[knowledge_fact:8a3fd2c1b9e4f7a6d5c0] ..."), generate a SHORT, CONCRETE answer that:
1. Is grounded in the provided facts — prefer specifics stated in them; do not invent named entities, dates, or numbers that no fact supports.
2. After each claim, inline a citation copying the factId EXACTLY (including its "knowledge_fact:" prefix), and mirror every cited factId into citedFactIds.
3. ALWAYS commit to an answer. If the facts do not fully resolve the question, give the single most likely short answer they point to — do NOT refuse, do NOT output "I don't have grounded evidence", do NOT hedge with "the facts don't say". Answer in as few words as the question allows.

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
  private readonly minFactTrust: number;

  // Fourth dep is the flag-gated L0 episodic lane (P2 of the substrate
  // redesign); optional so positionally-constructed unit tests stay as-is.
  // eslint-disable-next-line max-params
  constructor(
    private readonly search: SearchService,
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly episodeLane?: EpisodeLaneService,
  ) {
    this.openai = createOpenAiClientOrThrow(this.configService);
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
      raw === 'lenient' || raw === 'off' || raw === 'answer' ? raw : 'strict';
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
    // Source-reputation Phase 5: citation floor on the write-time source
    // reputation (factTrust.sourceReputation). Default 0 = off; facts
    // without a snapshot sit on the neutral 0.5, so floors ≤ 0.5 only
    // ever drop facts whose source has genuinely EARNED distrust.
    this.minFactTrust = parseFloat(
      this.configService.get<string>('SYNTHESIZE_MIN_FACT_TRUST', '0'),
    );
  }

  async synthesize({
    companyId,
    dto,
    callerScopes,
    onProgress = NOOP_REPORTER,
    extraHits,
  }: SynthesizeOptions): Promise<SynthesizeResult> {
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
    // Conformal guardrail: drop facts below the calibrated-confidence floor
    // (default SYNTHESIZE_MIN_CONFIDENCE=0.30) BEFORE the generator sees them
    // as citation targets. Facts still appear in the DecisionLog (with the
    // `low_score` reject reason) when the caller asked for `explain: true`.
    //
    // In 'answer' (never-abstain) mode the floor is disabled: the whole point
    // of that mode is to commit to a best-effort answer, so silently dropping
    // low-confidence facts here — which can empty `results` and force the
    // `no_results` null return below — would defeat it. That was a real
    // cross-knob trap: 'answer' callers otherwise had to ALSO set
    // SYNTHESIZE_MIN_CONFIDENCE=0 to actually never abstain.
    // Evidence union (Phase A): fold the caller's pre-retrieved hits in
    // BEFORE the guardrail so extra facts face the same floors. Base
    // results stay first; unseen extras append best-score-first, capped.
    const evidence = applyEvidenceUnion(searchResult.results, extraHits);

    const answerMode = guardrails === 'answer';
    const prepared = this.prepareEvidence(evidence, answerMode, explain);
    if ('empty' in prepared) return prepared.empty;
    const { results, factIndex, factLines } = prepared;

    // Episodic lane (P2, SEARCH_EPISODIC_LANE_ENABLED): dated verbatim
    // quotes from the L0 substrate as their own typed prompt section —
    // the lossless fallback for facts extraction missed or fragmented.
    // Provenance lane (A1, SYNTHESIZE_SOURCE_EXCERPTS): source turns of
    // the selected evidence facts — carries the concrete detail the
    // derivation summarized away. Both render into the same transcript
    // section; dedupe keeps a turn surfaced by both lanes single.
    const laneLines =
      (await this.episodeLane?.transcriptLines({
        companyId,
        query: dto.query,
        callerScopes,
      })) ?? [];
    const sourceLines =
      (await this.episodeLane?.sourceExcerpts({
        companyId,
        factIds: [...factIndex.keys()],
        callerScopes,
      })) ?? [];
    const transcriptLines = [...new Set([...sourceLines, ...laneLines])];

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
            this.callGenerator({
              query: dto.query,
              factLines,
              transcriptLines,
              model,
              answerLang,
              neverAbstain: guardrails === 'answer',
              // Date context (SYNTHESIZE_DATE_CONTEXT): anchor "today"
              // for the generator so relative/when questions resolve
              // against the facts' date stamps instead of guessing.
              dateContext: resolveDateContext(dto.asOf),
            }),
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
    // empty grounding; no need to verify, no need to cite. Skipped in
    // never-abstain mode — there the generator is instructed never to emit
    // the sentinel, and if it slips through we still return it as the answer
    // rather than tagging an abstention (the mode's whole point).
    if (
      guardrails !== 'answer' &&
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

    // Never-abstain mode returns the grounded best-effort answer directly,
    // like 'off' but semantically "always answer" — verifier is skipped.
    if (guardrails === 'off' || guardrails === 'answer') {
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
            this.callVerifier({
              query: dto.query,
              answer: generated.answer,
              factLines,
              model,
            }),
          ),
        { 'synthesize.facts': factIndex.size },
      );
    } catch (err) {
      this.logger.warn(`Synthesize verifier failed: ${(err as Error).message}`);
      this.metrics?.countSynthesize('verifier_error');
      return verifierErrorResult({
        guardrails,
        answer: generated.answer,
        citations,
        results,
        decisionLog,
      });
    }

    return this.finalizeVerdict({
      verdict: verdict.verdict,
      answer: generated.answer,
      citations,
      results,
      guardrails,
      decisionLog,
    });
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
  private finalizeVerdict({
    verdict,
    answer,
    citations,
    results,
    guardrails,
    decisionLog,
  }: {
    verdict: VerifierOutput['verdict'];
    answer: string;
    citations: Citation[];
    results: SynthesizeResult['results'];
    guardrails: SynthesisGuardrails;
    decisionLog?: DecisionLogEntry[];
  }): SynthesizeResult {
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

  /**
   * Guardrail + no-results prologue of synthesize(), extracted verbatim
   * (complexity budget). Returns `{empty}` with the early-return result,
   * or the prepared evidence for the generator.
   */
  private prepareEvidence(
    evidence: SearchHit[],
    answerMode: boolean,
    explain: boolean,
  ):
    | { empty: SynthesizeResult }
    | ({ results: SearchHit[] } & ReturnType<typeof buildFactIndex>) {
    const guardrail = applyConformalGuardrail(evidence, {
      minCalibratedConfidence: answerMode ? 0 : this.minCalibratedConfidence,
      minFactTrust: answerMode ? 0 : this.minFactTrust,
    });
    const results = guardrail.kept;
    if (guardrail.droppedCount > 0) {
      this.logger.debug(
        `conformal guardrail dropped ${guardrail.droppedCount} fact(s) below ${this.minCalibratedConfidence}`,
      );
    }
    if (results.length === 0) {
      this.metrics?.countSynthesize('no_results');
      return {
        empty: attachDecisionLog(
          { answer: null, reason: 'no_results', citations: [], results: [] },
          explain ? [] : undefined,
        ),
      };
    }
    const { factIndex, factLines } = buildFactIndex(results);
    if (factIndex.size === 0) {
      // Search returned entities but they were stripped to ids by
      // outputShape='ids' / token budget. Treat as no_results for
      // synthesis purposes — we have nothing to cite.
      this.metrics?.countSynthesize('no_results');
      return {
        empty: attachDecisionLog(
          { answer: null, reason: 'no_results', citations: [], results },
          explain ? buildDecisionLog(results, new Set()) : undefined,
        ),
      };
    }
    return { results, factIndex, factLines };
  }

  private async callGenerator({
    query,
    factLines,
    transcriptLines,
    model,
    answerLang,
    neverAbstain = false,
    dateContext,
  }: {
    query: string;
    factLines: string[];
    /** Episodic-lane quotes (P2) — rendered as a separate typed section. */
    transcriptLines?: string[];
    model: string;
    answerLang: string | null;
    neverAbstain?: boolean;
    /** ISO date the answer should treat as "today" (SYNTHESIZE_DATE_CONTEXT). */
    dateContext?: string;
  }): Promise<GeneratorOutput> {
    const systemPrompt = neverAbstain
      ? GENERATOR_SYSTEM_ANSWER
      : GENERATOR_SYSTEM;
    const user = buildGeneratorUserMessage({
      query,
      factLines,
      transcriptLines,
      answerLang,
      dateContext,
    });
    traceArtifact('synthesize.generator_prompt', {
      system: systemPrompt,
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
        { role: 'system', content: systemPrompt },
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

  private async callVerifier({
    query,
    answer,
    factLines,
    model,
  }: {
    query: string;
    answer: string;
    factLines: string[];
    model: string;
  }): Promise<VerifierOutput> {
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
        ...(f.sourceKey ? { sourceKey: f.sourceKey } : {}),
      });
      factLines.push(
        `[${f.factId}] ${r.canonicalName} (${r.entityType}) — ${f.predicate}: ${f.object}${formatFactValidity(f.validFrom, f.validUntil)}`,
      );
    }
  }
  return { factIndex, factLines };
}

/**
 * Render a fact's validity window as a compact suffix for the prompt.
 * Without this the generator sees no temporal metadata and can only
 * abstain on "when did X happen" questions even when the answering fact
 * was retrieved — its validFrom carries the date. We surface a bare
 * `YYYY-MM-DD` (the time-of-day is noise for recall dating) and a
 * closing bound only when the fact is no longer open. Unparseable or
 * epoch-sentinel dates render nothing rather than a misleading "1970".
 */
function formatFactValidity(validFrom?: string, validUntil?: string): string {
  const from = toValidityDate(validFrom);
  const until = toValidityDate(validUntil);
  if (!from && !until) return '';
  if (from && until) return ` (valid ${from} → ${until})`;
  if (from) return ` (as of ${from})`;
  return ` (until ${until})`;
}

function toValidityDate(value?: string): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  // Drop ONLY the epoch sentinel (new Date(0), the unknown-date fallback) so it
  // never reads as 1970. `=== 0`, not `<= 0`: a real pre-1970 validFrom (an
  // older person's dob, a historical event) must still render its date.
  if (t === 0) return undefined;
  return new Date(t).toISOString().slice(0, 10);
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
function verifierErrorResult({
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
