import type OpenAI from 'openai';
import { chatCallParams } from '../ai/openai-client';
import { withGenAiCall } from '../common/gen-ai-observability';
import { getAbortSignal } from '../common/request-context';
import { traceArtifact } from '../common/debug-trace';
import type { MetricsService } from '../metrics/metrics.service';

/**
 * Corrective-RAG verifier: audits a synthesized answer against the
 * EVIDENCE BUNDLE the generator was given. Split out of
 * synthesize.service.ts (third split, file-size gate) at a real seam —
 * the auditor is a self-contained LLM call with its own contract.
 *
 * Audit W5 #22: the bundle used to be fact lines only, so an answer
 * correctly built from transcript quotes or the computed interval table
 * had claims present in no fact line — strict mode dropped correct
 * answers, and every other mode shipped quoted L0 content with zero
 * faithfulness scoring. Whatever the generator may answer from, the
 * verifier must judge against.
 *
 * ONE deliberate exception (G4 strategy lane): the generator's fenced
 * ADVISORY strategy notes are NOT part of this bundle. They are
 * guidance about HOW to answer (question-class strategies distilled
 * from post-mortems), not evidence about the user — the parity
 * invariant exists so the auditor can judge every claim SOURCE the
 * generator had; a strategy note is not a claim source, and handing
 * it to the auditor as evidence would let an unsupported claim verify
 * as "supported" merely because an advisory note mentioned its topic.
 * The generator frame forbids answering FROM the notes
 * (STRATEGY_ADVISORY_INSTRUCTION), and this asymmetry is the
 * enforcement: a note-derived claim has no supporting evidence here
 * and fails the audit. See CollectedEvidence.strategyNotes.
 */
export interface VerifierOutput {
  verdict: 'supported' | 'partial' | 'unsupported';
  unsupportedClaims?: string[];
  /**
   * V10 §5 (topic-coverage audits only): whether the evidence contains
   * an actual answer to the query — not merely facts on its topic.
   * Undefined when the audit ran without topic coverage.
   */
  questionAnswered?: boolean;
}

const VERIFIER_SYSTEM = `You are a fact-grounding auditor for a knowledge-graph answer system.

Given a synthesized answer and the EVIDENCE that was available at generation time, judge whether every CLAIM in the answer is directly supported by at least one piece of that evidence. The evidence may come in several sections: extracted source facts, verbatim conversation turns, and computed date intervals. ALL sections count as support — a claim taken word-for-word from a quoted turn is supported, exactly like one taken from a fact.

Definitions:
- "supported": every distinct claim is directly stated by at least one piece of evidence.
- "partial": some claims are supported, but at least one claim is paraphrased / inferred without directly supporting evidence.
- "unsupported": one or more central claims are not in the evidence at all (hallucination).

Be strict on "supported" — a paraphrase that adds detail beyond the evidence is "partial" at best. Cite each unsupported / partially-supported claim by quoting the offending span verbatim.

Output strictly the JSON shape requested by the schema.`;

/**
 * V10 §5 topic-coverage addendum. The V9 residual on the abstention
 * row: 13/40 misses were fabrications ASSEMBLED from real facts —
 * every atomic claim individually grounded, the connecting link
 * invented — and the base audit passes them as "supported". Two
 * tightenings: relationship claims need their own evidence, and the
 * auditor separately judges whether the evidence answers the query
 * at all.
 */
const TOPIC_COVERAGE_ADDENDUM = `

Two additional rules for this audit:
- Relationship claims: any asserted CONNECTION between facts — causal ("because", "led to", "which made"), motivational, attributive, or part-whole — is itself a claim. It counts as supported only when some piece of evidence states that connection directly. An answer whose individual facts are each supported but whose connecting link appears nowhere in the evidence is "partial" at best.
- Additionally output "questionAnswered": true only when the evidence contains an actual answer to the query — a statement (or directly-linked statements) that resolves what the query asks. Evidence that is merely on the same topic, or answers a neighboring question, does not count. Judge the EVIDENCE against the query, independently of how confident the answer sounds.`;

export interface VerifyRequest {
  openai: OpenAI;
  metrics?: MetricsService | undefined;
  query: string;
  answer: string;
  factLines: string[];
  /** Verbatim source turns the generator was allowed to answer from. */
  transcriptLines?: string[] | undefined;
  /** Derived insights (V8 §1) the generator was allowed to answer from. */
  insightLines?: string[] | undefined;
  /**
   * BELIEFS_SERVING_LANE: the rendered current-state belief lines the
   * generator saw — evidence parity (W5 #22: belief lines are EVIDENCE,
   * unlike the advisory strategy notes). Composed as its own section
   * ONLY when non-empty — absent/empty ⇒ the prompt is byte-identical.
   */
  beliefLines?: string[] | undefined;
  /**
   * V8 §2 / V9 §2: the transcript excerpts were collected as the
   * MENTION RECORD for an ordering question — label them so the auditor
   * treats excerpt sequence as valid support for order claims (the
   * generator was explicitly told to prefer it over fact date stamps).
   */
  timelineEvidence?: boolean | undefined;
  /**
   * V10 §5: enable the topic-coverage audit — relationship-claim
   * strictness plus the `questionAnswered` judgment. Off =
   * byte-identical prompt and schema.
   */
  topicCoverage?: boolean | undefined;
  /** V13 (profile.dateMath): the computed date table the generator
   *  saw — weekday/gap claims grounded in it must not be flagged. */
  dateMathLines?: string[] | undefined;
  /**
   * Evidence-capability arm (FOVEA_EVIDENCE_CAPABILITY, 0113): rendered
   * lines of NON-TEXT evidence the generator was allowed to answer
   * from, each prefixed `[capability:<kind>]` (e.g. `[capability:visual]
   * whiteboard photo: …`). Composed as its own section in the auditor
   * prompt ONLY when non-empty — absent/empty ⇒ the prompt is
   * byte-identical. Populated by the fragment lane (MM-zoom PR2,
   * profile.fragmentLane): the SAME media lines the generator's section
   * rendered — evidence parity — alongside per-citation capabilities
   * (answer-integrity.ts citedCapabilities).
   */
  capabilityEvidenceLines?: string[] | undefined;
  model: string;
}

/** Compose the auditor's evidence sections; empty ones are omitted. */
function buildVerifierUserMessage({
  query,
  answer,
  factLines,
  transcriptLines,
  insightLines,
  beliefLines,
  timelineEvidence,
  dateMathLines,
  capabilityEvidenceLines,
}: {
  query: string;
  answer: string;
  factLines: string[];
  transcriptLines?: string[] | undefined;
  insightLines?: string[] | undefined;
  beliefLines?: string[] | undefined;
  timelineEvidence?: boolean | undefined;
  dateMathLines?: string[] | undefined;
  capabilityEvidenceLines?: string[] | undefined;
}): string {
  const sections = [`Source facts:\n${factLines.join('\n')}`];
  if (transcriptLines && transcriptLines.length > 0) {
    const header = timelineEvidence
      ? `Source conversation turns (verbatim, chronological — the MENTION RECORD: the sequence of these excerpts is valid support for order-of-mention claims, and overrides fact date stamps):`
      : `Source conversation turns (verbatim, equally valid support):`;
    sections.push(`${header}\n` + transcriptLines.join('\n'));
  }
  if (insightLines && insightLines.length > 0) {
    sections.push(`Derived insights (equally valid support):\n` + insightLines.join('\n'));
  }
  // Belief section (BELIEFS_SERVING_LANE seam) — only when non-empty,
  // so every no-lane audit prompt stays byte-identical.
  if (beliefLines && beliefLines.length > 0) {
    sections.push(
      `Current-state record (distilled belief lines — each states the CURRENT value of its subject/field and supersedes older values in the other sections for present-tense claims; equally valid support):\n` +
        beliefLines.join('\n'),
    );
  }
  if (dateMathLines && dateMathLines.length > 0) {
    sections.push(
      `Computed date table (derived in code from the fact date stamps — weekday and gap claims grounded in it are valid support):\n` +
        dateMathLines.join('\n'),
    );
  }
  // Evidence-capability section (0113 seam) — only when non-empty, so
  // every text-path audit prompt stays byte-identical.
  if (capabilityEvidenceLines && capabilityEvidenceLines.length > 0) {
    sections.push(
      `Non-text evidence (each line tagged [capability:<kind>] — equally valid support for claims of that kind):\n` +
        capabilityEvidenceLines.join('\n'),
    );
  }
  return `Query: ${query}\n\nAnswer:\n${answer}\n\n${sections.join('\n\n')}`;
}

/**
 * gpt-5* / o-series reasoning models reject a non-default temperature
 * (400 Unsupported value) AND bill their hidden reasoning against
 * max_completion_tokens — a 256 cap starves the visible JSON. Measured
 * live on the V11 §2 strong-judge arm: 23/40 audits 400'd and degraded
 * to verifier_error before this guard. Non-reasoning models keep the
 * deterministic temperature 0 and the tight cap — byte-identical call.
 */

export async function runVerifier(req: VerifyRequest): Promise<VerifierOutput> {
  const { openai, metrics, model, topicCoverage } = req;
  const system = topicCoverage ? VERIFIER_SYSTEM + TOPIC_COVERAGE_ADDENDUM : VERIFIER_SYSTEM;
  const user = buildVerifierUserMessage(req);
  traceArtifact('synthesize.verifier_prompt', {
    system,
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
    metrics,
    () =>
      openai.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: system },
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
                  ...(topicCoverage ? { questionAnswered: { type: 'boolean' } } : {}),
                },
                required: [
                  'verdict',
                  'unsupportedClaims',
                  ...(topicCoverage ? ['questionAnswered'] : []),
                ],
              },
            },
          },
          ...chatCallParams(model, { temperature: 0, visibleCap: 256, reasoningCap: 2048 }),
        },
        { signal: getAbortSignal() },
      ),
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
  if (topicCoverage && typeof parsed.questionAnswered !== 'boolean') {
    throw new Error('verifier returned no questionAnswered judgment');
  }
  traceArtifact('synthesize.verifier_output', parsed);
  return parsed;
}

/**
 * Verifier answer-integrity arm, Part A (FOVEA_PLAUSIBILITY_CHECK). A DISTINCT
 * defense from runVerifier: the grounding auditor asks "is the answer ⊆ the
 * cited evidence"; this judge asks the orthogonal question the grounding audit
 * never covers — "are the CITED PREMISES themselves trustworthy world
 * knowledge, or is a supported answer merely faithfully restating a
 * counterfactual/sandbox premise out of its original context" (belief
 * distortion, docs/roadmap/memtrap-shakedown-2026-08.md class 4).
 *
 * It runs ONLY after a `supported` verdict, ONLY when the flag is on, and is a
 * separate LLM call — reusing the SAME OpenAI client + model idiom as
 * runVerifier (chatCallParams temperature/caps, withGenAiCall span, strict
 * json_schema, the shared abort signal). `plausible: false` ⇒ the service
 * downgrades the answer to an abstain.
 */
export interface PlausibilityOutput {
  /**
   * false ⇒ at least one cited premise contradicts general world knowledge OR
   * is a counterfactual/sandbox/hypothetical premise being applied as if it
   * were a general truth outside its original context. true ⇒ the cited
   * premises are plausible general knowledge (or in-context by construction).
   */
  plausible: boolean;
  /** The offending premise / reason, for the trace. Empty when plausible. */
  rationale?: string;
}

const PLAUSIBILITY_SYSTEM = `You are a world-knowledge plausibility auditor for a memory-grounded answer system.

The answer you are shown has ALREADY passed a separate grounding audit: every claim in it is faithfully taken from the CITED PREMISES below. Do NOT re-check grounding. Your job is the orthogonal question grounding never covers: are the CITED PREMISES themselves trustworthy as general world knowledge, or is this a case where a premise is only true inside some narrow, counterfactual, or sandboxed context and is now being applied out of that context?

Output "plausible": false when EITHER holds for at least one cited premise:
- Contradiction: the premise directly contradicts well-established, general world knowledge (a widely-known scientific, factual, or safety fact).
- Out-of-context counterfactual: the premise is explicitly hypothetical, sandbox-, role-play-, game-, or scenario-specific ("in this sandbox", "pretend that", "for this exercise", "assume X even though"), and the answer applies it as if it were a general truth for the user's real question.

Otherwise output "plausible": true. Be conservative — flag only CLEAR contradictions or CLEARLY out-of-context counterfactual premises; ordinary personal facts, preferences, and domain-specific but true statements are plausible. When flagging, quote the offending premise in "rationale"; leave it empty when plausible.

Output strictly the JSON shape requested by the schema.`;

export interface PlausibilityRequest {
  openai: OpenAI;
  metrics?: MetricsService | undefined;
  query: string;
  answer: string;
  /** The cited premises the supported answer rests on — one line each. */
  citedPremises: string[];
  model: string;
}

export async function runPlausibilityJudge(req: PlausibilityRequest): Promise<PlausibilityOutput> {
  const { openai, metrics, model, query, answer, citedPremises } = req;
  const user = `Query: ${query}\n\nAnswer:\n${answer}\n\nCited premises:\n${citedPremises.join('\n')}`;
  traceArtifact('synthesize.plausibility_prompt', { system: PLAUSIBILITY_SYSTEM, user, model });
  const res = await withGenAiCall(
    {
      kind: 'chat',
      spanName: 'gen_ai.chat.synthesize_plausibility',
      system: 'openai',
      model,
    },
    metrics,
    () =>
      openai.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: PLAUSIBILITY_SYSTEM },
            { role: 'user', content: user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'plausibility_verdict',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  plausible: { type: 'boolean' },
                  rationale: { type: 'string' },
                },
                required: ['plausible', 'rationale'],
              },
            },
          },
          ...chatCallParams(model, { temperature: 0, visibleCap: 256, reasoningCap: 2048 }),
        },
        { signal: getAbortSignal() },
      ),
  );
  const content = res.choices[0]?.message?.content;
  if (!content) throw new Error('empty plausibility response');
  const parsed = JSON.parse(content) as PlausibilityOutput;
  if (typeof parsed.plausible !== 'boolean') {
    throw new Error('plausibility judge returned no boolean verdict');
  }
  traceArtifact('synthesize.plausibility_output', parsed);
  return parsed;
}
