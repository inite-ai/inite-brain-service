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
  /** Tier 5: reinforce the language directive on the corrective regeneration
   *  after an output-language mismatch (answer-language guard). */
  answerLangStrict?: boolean | undefined;
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
  /**
   * BELIEFS_SERVING_LANE: rendered current-state belief lines, their
   * own section — the verifier reads the same lines
   * (VerifyRequest.beliefLines, evidence parity).
   */
  beliefLines?: string[] | undefined;
  /**
   * BELIEFS_SERVING_LANE: expose the belief-citation affordance — the
   * schema gains `citedBeliefIds` and the system prompt the matching
   * rule. Effective only when beliefLines are non-empty (no rendered
   * beliefs ⇒ nothing citable ⇒ prompt and schema byte-identical — the
   * fragmentAffordance guard).
   */
  beliefCitations?: boolean | undefined;
  /**
   * BELIEFS_LANE_DATE_DISAMBIGUATION (memory-fitness D4): the belief
   * section header gains the date-scoping clause (a belief-line date is
   * when the belief last changed, never the asked-about event's date) —
   * resolved once per request beside the lane flag and matching the
   * lane's `belief current since` token. Effective only when
   * beliefLines are non-empty (no section ⇒ byte-identical prompt).
   */
  beliefDateDisambiguation?: boolean | undefined;
  /**
   * MM-zoom PR2 (profile.fragmentLane): rendered media-evidence lines,
   * their own section — the verifier reads the same lines
   * (capabilityEvidenceLines, evidence parity).
   */
  fragmentLines?: string[] | undefined;
  /**
   * EVIDENCE_FRAGMENT_CITATIONS: expose the fragment-citation
   * affordance — the schema gains `citedFragmentIds` and the system
   * prompt the matching rule. Effective only when fragmentLines are
   * non-empty (no rendered fragments ⇒ nothing citable ⇒ prompt and
   * schema byte-identical).
   */
  fragmentCitations?: boolean | undefined;
}

/** V13 refine affordance — appended to either system prompt. */
const REFINE_ADDENDUM = `

RETRIEVAL REFINEMENT: you may request ONE better retrieval before your answer is final. If the facts do not contain the specific detail the query asks for, set "refineQuery" to a self-contained search query that would find it — name the entity and the missing detail, in different words than the original query. Otherwise set "refineQuery" to null. Fill "answer" with your best grounded attempt either way.`;

/** MM-zoom PR2 fragment-citation affordance — appended when the media
 *  section rendered AND EVIDENCE_FRAGMENT_CITATIONS is on. */
const FRAGMENT_CITE_ADDENDUM = `

FRAGMENT CITATIONS: some evidence lines are media-derived and headed by an [evidence_fragment:...] id. When a claim in your answer rests on such a line, copy that id EXACTLY as it appears into the citedFragmentIds array (in addition to any factIds you cite). Cite only ids present in the evidence — never invent one. citedFragmentIds is [] when no media line supports a claim.`;

/** BELIEFS_SERVING_LANE belief-citation affordance — appended when the
 *  current-state section rendered (citations ride the master flag). */
const BELIEF_CITE_ADDENDUM = `

BELIEF CITATIONS: some evidence lines are distilled current-state beliefs headed by a [semantic_belief:...] id. When a claim in your answer rests on such a line, copy that id EXACTLY as it appears into the citedBeliefIds array (in addition to any factIds you cite). Cite only ids present in the evidence — never invent one. citedBeliefIds is [] when no belief line supports a claim.`;

/**
 * BELIEFS_SERVING_LANE abstention guard (memory-fitness D5): the
 * current-state preference in the belief section must not weaken the
 * base evidence-only/abstention discipline — the lane adds evidence,
 * never permission to answer. The closing sentence mirrors the base
 * GENERATOR_SYSTEM rule 3 abstention sentence VERBATIM. Appended only
 * when the belief section actually rendered (flag off / empty lane ⇒
 * byte-identical system prompt) and only in the default abstaining
 * mode — never with GENERATOR_SYSTEM_ANSWER, whose always-commit
 * contract (neverAbstain) is deliberately unchanged.
 */
const BELIEF_ABSTENTION_ADDENDUM = `

BELIEF LINES PRESERVE ABSTENTION: the current-state record is ADDITIONAL evidence, not permission to answer beyond the evidence. Prefer a belief line only when one covers the asked subject/field. If neither a belief line nor the facts answer the question, output the exact answer string "I don't have grounded evidence for that." with citedFactIds set to [].`;

/** The strict-JSON answer schema, affordance-conditional fields included
 *  (extracted from runGenerator for the complexity budget — pure). */
function buildAnswerSchema(opts: {
  allowRefine: boolean;
  fragmentAffordance: boolean;
  beliefAffordance: boolean;
}): { schema: Record<string, unknown>; required: string[] } {
  return {
    schema: {
      answer: { type: 'string' },
      citedFactIds: { type: 'array', items: { type: 'string' } },
      ...(opts.allowRefine ? { refineQuery: { type: ['string', 'null'] } } : {}),
      ...(opts.fragmentAffordance
        ? { citedFragmentIds: { type: 'array', items: { type: 'string' } } }
        : {}),
      ...(opts.beliefAffordance
        ? { citedBeliefIds: { type: 'array', items: { type: 'string' } } }
        : {}),
    },
    required: [
      'answer',
      'citedFactIds',
      ...(opts.allowRefine ? ['refineQuery'] : []),
      ...(opts.fragmentAffordance ? ['citedFragmentIds'] : []),
      ...(opts.beliefAffordance ? ['citedBeliefIds'] : []),
    ],
  };
}

export async function runGenerator(req: GenerateRequest): Promise<GeneratorOutput> {
  const { openai, metrics, logger, model, answerLang, neverAbstain } = req;
  // The affordance is real only when fragments actually rendered —
  // flag-on with an empty lane keeps prompt and schema byte-identical.
  const fragmentAffordance = req.fragmentCitations === true && (req.fragmentLines?.length ?? 0) > 0;
  // Same guard for beliefs: flag-on with an empty lane keeps prompt and
  // schema byte-identical (BELIEFS_SERVING_LANE).
  const beliefAffordance = req.beliefCitations === true && (req.beliefLines?.length ?? 0) > 0;
  // The abstention guard rides the RENDERED section, not the citation
  // affordance — it must hold even under a future header/flag split.
  const beliefRendered = (req.beliefLines?.length ?? 0) > 0;
  const answerSchema = buildAnswerSchema({
    allowRefine: req.allowRefine === true,
    fragmentAffordance,
    beliefAffordance,
  });
  const systemPrompt =
    (neverAbstain ? GENERATOR_SYSTEM_ANSWER : GENERATOR_SYSTEM) +
    (req.allowRefine ? REFINE_ADDENDUM : '') +
    (fragmentAffordance ? FRAGMENT_CITE_ADDENDUM : '') +
    (beliefAffordance ? BELIEF_CITE_ADDENDUM : '') +
    (beliefRendered && !neverAbstain ? BELIEF_ABSTENTION_ADDENDUM : '');
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
                properties: answerSchema.schema,
                required: answerSchema.required,
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
  const parsed = parseGeneratorContent(content, res.choices[0]?.finish_reason, {
    logger,
    metrics,
  });
  if (res.usage) {
    parsed.usage = {
      promptTokens: res.usage.prompt_tokens ?? 0,
      completionTokens: res.usage.completion_tokens ?? 0,
    };
  }
  traceArtifact('synthesize.generator_output', parsed);
  return parsed;
}

/**
 * Parse + defensively normalize the generator's strict-JSON body
 * (extracted from runGenerator for the complexity budget).
 *
 * Audit W5 #24: the exhaustive-list lanes ("a partial list is a wrong
 * answer") run against a 512-token cap. A truncated strict-JSON body
 * used to throw here and degrade to `generator_error` — i.e. the lanes
 * that must enumerate silently ABSTAINED instead of returning what they
 * had. Say so explicitly in the trace, and salvage the answer text when
 * the JSON envelope is the only casualty.
 */
function parseGeneratorContent(
  content: string,
  finishReason: string | undefined,
  deps: { logger: GenerateRequest['logger']; metrics: GenerateRequest['metrics'] },
): GeneratorOutput {
  const { logger, metrics } = deps;
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
  // Defensive parse: a non-array (or affordance-off) citedFragmentIds is
  // absent — the resolver fence downstream re-validates every id anyway.
  if (parsed.citedFragmentIds !== undefined && !Array.isArray(parsed.citedFragmentIds)) {
    delete parsed.citedFragmentIds;
  }
  // Same defensive parse for the belief arm (BELIEFS_SERVING_LANE).
  if (parsed.citedBeliefIds !== undefined && !Array.isArray(parsed.citedBeliefIds)) {
    delete parsed.citedBeliefIds;
  }
  return parsed;
}
