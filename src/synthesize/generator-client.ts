import type OpenAI from 'openai';
import { chatCallParams } from '../ai/openai-client';
import { withGenAiCall } from '../common/gen-ai-observability';
import { getAbortSignal } from '../common/request-context';
import { traceArtifact } from '../common/debug-trace';
import type { MetricsService } from '../metrics/metrics.service';
import type { LaneId } from '../search/retrieval-profile';
import { buildGeneratorUserMessage } from './generator-prompt';
import { salvageTruncatedAnswer } from './synthesize.helpers';


import type { GeneratorOutput } from './synthesize.types';

/**
 * Generator client — the synthesis LLM call, split out of
 * synthesize.service.ts (V10 architecture pass, max-lines gate) at the
 * same seam as the verifier: a self-contained LLM call with its own
 * contract, symmetric to verifier.ts. The orchestrator decides WHAT to
 * generate from; this module owns HOW the call is made — system-prompt
 * selection, strict-JSON schema, the truncation salvage (audit W5
 * #24), usage accounting and tracing.
 */

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

export interface GenerateRequest {
  openai: OpenAI;
  metrics?: MetricsService | undefined;
  /** For the salvage warning; the orchestrator's logger. */
  logger?: { warn(message: string): void } | undefined;
  query: string;
  factLines: string[];
  /** Episodic-lane quotes (P2) — rendered as a separate typed section. */
  transcriptLines?: string[] | undefined;
  /** V8 §1: derived insights — their own section, own budget slot. */
  insightLines?: string[] | undefined;
  /** V8 §2: transcript excerpts are the mention record (ordering ask). */
  timelineEvidence?: boolean | undefined;
  /** V10 §3: order-of-mention frame replaces the enumeration frame. */
  orderingFrame?: boolean | undefined;
  /** V10 §2b: date-arbitrated conflict frame (updateStoryRendering). */
  dateArbitratedConflicts?: boolean | undefined;
  /** V10 §4: insight lines are a query-time topic record. */
  arcInsights?: boolean | undefined;
  model: string;
  answerLang: string | null;
  neverAbstain?: boolean | undefined;
  /** ISO date the answer should treat as "today" (SYNTHESIZE_DATE_CONTEXT). */
  dateContext?: string | undefined;
  /** T1 typed dispatch lane, when the router matched. */
  lane?: LaneId | null | undefined;
  /** §8 item 3: enumeration scope discipline (profile.enumStrict). */
  enumStrict?: boolean | undefined;
  /** T7: standing user instructions for their own section. */
  instructions?: string[] | undefined;
  /** T3: COMPETING conflict pairs detected in the evidence. */
  conflicts?: Array<{ factIds: string[]; label: string }> | undefined;
  /** V13 (profile.dateMath): computed date table lines. */
  dateMathLines?: string[] | undefined;
  /** V13 G2 (profile.answerConditioning): per-shape reading frame. */
  shapeInstruction?: string | undefined;
  /**
   * G4 strategy lane: fenced advisory notes — GENERATOR-ONLY, the
   * documented verifier-parity exception (advice, not evidence).
   */
  strategyNotes?: string[] | undefined;
  /**
   * V13 constrained search loop: expose the ONE-round refine
   * affordance — the schema gains a nullable `refineQuery` and the
   * system prompt the matching rule. The second (forced-answer) call
   * simply omits this, so the cap is structural, not behavioral.
   */
  allowRefine?: boolean | undefined;
}

/** V13 refine affordance — appended to either system prompt. */
const REFINE_ADDENDUM = `

RETRIEVAL REFINEMENT: you may request ONE better retrieval before your answer is final. If the facts do not contain the specific detail the query asks for, set "refineQuery" to a self-contained search query that would find it — name the entity and the missing detail, in different words than the original query. Otherwise set "refineQuery" to null. Fill "answer" with your best grounded attempt either way.`;

export async function runGenerator(req: GenerateRequest): Promise<GeneratorOutput> {
  const { openai, metrics, logger, model, answerLang, neverAbstain } = req;
  const systemPrompt =
    (neverAbstain ? GENERATOR_SYSTEM_ANSWER : GENERATOR_SYSTEM) +
    (req.allowRefine ? REFINE_ADDENDUM : '');
  const user = buildGeneratorUserMessage(req);
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
    metrics,
    () =>
      openai.chat.completions.create(
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
                  ...(req.allowRefine
                    ? { refineQuery: { type: ['string', 'null'] } }
                    : {}),
                },
                required: [
                  'answer',
                  'citedFactIds',
                  ...(req.allowRefine ? ['refineQuery'] : []),
                ],
              },
            },
          },
          ...chatCallParams(model, { temperature: 0, visibleCap: 512, reasoningCap: 4096 }),
        },
        { signal: getAbortSignal() },
      ),
  );
  const content = res.choices[0]?.message?.content;
  if (!content) throw new Error('empty generator response');
  // Audit W5 #24: the exhaustive-list lanes ("a partial list is a wrong
  // answer") run against a 512-token cap. A truncated strict-JSON body
  // used to throw here and degrade to `generator_error` — i.e. the
  // lanes that must enumerate silently ABSTAINED instead of returning
  // what they had. Say so explicitly in the trace, and salvage the
  // answer text when the JSON envelope is the only casualty.
  const finishReason = res.choices[0]?.finish_reason;
  let parsed: GeneratorOutput;
  try {
    parsed = JSON.parse(content) as GeneratorOutput;
  } catch (err) {
    if (finishReason !== 'length') throw err;
    const salvaged = salvageTruncatedAnswer(content);
    if (!salvaged) throw err;
    logger?.warn('generator output hit the token cap; salvaged the partial answer');
    metrics?.countSynthesize('generator_truncated');
    traceArtifact('synthesize.generator_truncated', {
      finishReason,
      salvagedChars: salvaged.answer.length,
    });
    parsed = salvaged;
  }
  if (typeof parsed.answer !== 'string') {
    throw new Error('generator returned non-string answer');
  }
  if (!Array.isArray(parsed.citedFactIds)) {
    parsed.citedFactIds = [];
  }
  if (res.usage) {
    parsed.usage = {
      promptTokens: res.usage.prompt_tokens ?? 0,
      completionTokens: res.usage.completion_tokens ?? 0,
    };
  }
  traceArtifact('synthesize.generator_output', parsed);
  return parsed;
}
