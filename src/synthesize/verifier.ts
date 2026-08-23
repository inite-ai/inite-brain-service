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
  metrics?: MetricsService;
  query: string;
  answer: string;
  factLines: string[];
  /** Verbatim source turns the generator was allowed to answer from. */
  transcriptLines?: string[];
  /** Derived insights (V8 §1) the generator was allowed to answer from. */
  insightLines?: string[];
  /**
   * V8 §2 / V9 §2: the transcript excerpts were collected as the
   * MENTION RECORD for an ordering question — label them so the auditor
   * treats excerpt sequence as valid support for order claims (the
   * generator was explicitly told to prefer it over fact date stamps).
   */
  timelineEvidence?: boolean;
  /**
   * V10 §5: enable the topic-coverage audit — relationship-claim
   * strictness plus the `questionAnswered` judgment. Off =
   * byte-identical prompt and schema.
   */
  topicCoverage?: boolean;
  /** V13 (profile.dateMath): the computed date table the generator
   *  saw — weekday/gap claims grounded in it must not be flagged. */
  dateMathLines?: string[];
  model: string;
}

/** Compose the auditor's evidence sections; empty ones are omitted. */
function buildVerifierUserMessage({
  query,
  answer,
  factLines,
  transcriptLines,
  insightLines,
  timelineEvidence,
  dateMathLines,
}: {
  query: string;
  answer: string;
  factLines: string[];
  transcriptLines?: string[];
  insightLines?: string[];
  timelineEvidence?: boolean;
  dateMathLines?: string[];
}): string {
  const sections = [`Source facts:\n${factLines.join('\n')}`];
  if (transcriptLines && transcriptLines.length > 0) {
    const header = timelineEvidence
      ? `Source conversation turns (verbatim, chronological — the MENTION RECORD: the sequence of these excerpts is valid support for order-of-mention claims, and overrides fact date stamps):`
      : `Source conversation turns (verbatim, equally valid support):`;
    sections.push(`${header}\n` + transcriptLines.join('\n'));
  }
  if (insightLines && insightLines.length > 0) {
    sections.push(
      `Derived insights (equally valid support):\n` + insightLines.join('\n'),
    );
  }
  if (dateMathLines && dateMathLines.length > 0) {
    sections.push(
      `Computed date table (derived in code from the fact date stamps — weekday and gap claims grounded in it are valid support):\n` +
        dateMathLines.join('\n'),
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
  const system = topicCoverage
    ? VERIFIER_SYSTEM + TOPIC_COVERAGE_ADDENDUM
    : VERIFIER_SYSTEM;
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
                  ...(topicCoverage
                    ? { questionAnswered: { type: 'boolean' } }
                    : {}),
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
