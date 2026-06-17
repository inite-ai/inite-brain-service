import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SearchService, SearchHit } from '../search/search.service';
import { Semaphore } from '../common/semaphore';
import { withSpan } from '../common/tracing';
import { traceArtifact } from '../common/debug-trace';
import { MetricsService } from '../metrics/metrics.service';
import {
  SynthesisGuardrails,
  SynthesizeDto,
} from './dto/synthesize.dto';

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
  }

  async synthesize(
    companyId: string,
    dto: SynthesizeDto,
    callerScopes: string[],
  ): Promise<SynthesizeResult> {
    const guardrails: SynthesisGuardrails =
      dto.synthesisGuardrails ?? this.defaultGuardrails;
    const model = dto.synthesisModel ?? this.defaultModel;

    const searchResult = await withSpan(
      'synthesize.search',
      () => this.search.search(companyId, dto, callerScopes),
      { 'synthesize.guardrails': guardrails },
    );
    const results = searchResult.results;

    if (results.length === 0) {
      this.metrics?.countSynthesize('no_results');
      return {
        answer: null,
        reason: 'no_results',
        citations: [],
        results: [],
      };
    }

    // Build the (factId → fact context) lookup BOTH the generator
    // and the verifier reference. We surface compact facts only —
    // the LLM doesn't need the score / validFrom timestamps to do
    // grounding, and shorter prompts mean cheaper / faster calls.
    const factIndex = new Map<
      string,
      Citation
    >();
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

    if (factIndex.size === 0) {
      // Search returned entities but they were stripped to ids by
      // outputShape='ids' / token budget. Treat as no_results for
      // synthesis purposes — we have nothing to cite.
      this.metrics?.countSynthesize('no_results');
      return {
        answer: null,
        reason: 'no_results',
        citations: [],
        results,
      };
    }

    let generated: GeneratorOutput;
    try {
      generated = await withSpan(
        'synthesize.generate',
        () =>
          this.limiter.run(() =>
            this.callGenerator(dto.query, factLines, model),
          ),
        { 'synthesize.facts': factIndex.size },
      );
    } catch (err) {
      this.logger.warn(
        `Synthesize generator failed: ${(err as Error).message}`,
      );
      this.metrics?.countSynthesize('generator_error');
      return {
        answer: null,
        reason: 'generator_error',
        citations: [],
        results,
      };
    }

    // Resolve cited factIds against the retrieved set. A factId
    // not in the index is a hallucinated citation — drop it from
    // the citations list (the verifier will typically catch the
    // claim it backed, too). Order matches the LLM's emitted order.
    const citations: Citation[] = [];
    const seen = new Set<string>();
    for (const id of generated.citedFactIds ?? []) {
      const cite = factIndex.get(id);
      if (cite && !seen.has(id)) {
        seen.add(id);
        citations.push(cite);
      }
    }

    // Sentinel "I don't know" path. Generator was honest about
    // empty grounding; no need to verify, no need to cite.
    if (
      generated.answer.trim() === "I don't have grounded evidence for that."
    ) {
      this.metrics?.countSynthesize('no_grounded_evidence');
      return {
        answer: generated.answer,
        reason: 'no_grounded_evidence',
        citations: [],
        results,
      };
    }

    if (guardrails === 'off') {
      this.metrics?.countSynthesize('ok');
      return {
        answer: generated.answer,
        citations,
        results,
      };
    }

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
      // In strict mode, a verifier outage MUST NOT silently let an
      // unverified answer through. Strict ⇒ fail closed.
      if (guardrails === 'strict') {
        return {
          answer: null,
          reason: 'verifier_error',
          citations: [],
          results,
        };
      }
      return {
        answer: generated.answer,
        reason: 'verifier_error',
        citations,
        results,
      };
    }

    return this.finalizeVerdict(
      verdict.verdict,
      generated.answer,
      citations,
      results,
      guardrails,
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
  ): SynthesizeResult {
    if (verdict === 'supported') {
      this.metrics?.countSynthesize('ok');
      return { answer, citations, results };
    }
    const reason: SynthesisReason =
      verdict === 'partial' ? 'verifier_partial' : 'verifier_failed';
    this.metrics?.countSynthesize(reason);
    if (guardrails === 'lenient') {
      return { answer, reason, citations, results };
    }
    // strict — fail closed.
    return { answer: null, reason, citations: [], results };
  }

  private async callGenerator(
    query: string,
    factLines: string[],
    model: string,
  ): Promise<GeneratorOutput> {
    const user = `Query: ${query}\n\nRetrieved facts:\n${factLines.join('\n')}`;
    traceArtifact('synthesize.generator_prompt', {
      system: GENERATOR_SYSTEM,
      user,
      model,
    });
    const res = await this.openai.chat.completions.create({
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
    });
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
    const res = await this.openai.chat.completions.create({
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
    });
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
