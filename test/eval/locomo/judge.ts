import type { OpenAiLike } from '../metrics/faithfulness';

/**
 * LoCoMo LLM-as-judge — optional binary CORRECT/WRONG grading of a
 * prediction against the gold answer (`--judge`).
 *
 * Token-F1 / ROUGE-L / BLEU-1 penalise a correct answer that paraphrases
 * or adds detail ("I have a dog named Luna and two cats" vs gold "two cats
 * and a dog"), so every recent memory-system paper reports an LLM judge
 * instead. This adds one alongside the surface-overlap metrics (never
 * replacing them) so our numbers are comparable to Mem0 / MemMachine /
 * Synthius-Mem, which all publish judge accuracy.
 *
 * The prompt below is FIXED and mirrored verbatim in docs/locomo.md — a
 * judge is only comparable across runs (and across papers) if its rubric
 * is pinned. Change it only with a deliberate version bump documented
 * there.
 */
export const LOCOMO_JUDGE_SYSTEM = `You are grading a memory system's answer against a gold answer for a question about a long multi-session conversation.

Grade CORRECT or WRONG. CORRECT means the prediction conveys the same essential information as the gold answer; wording, word order, and formatting differences do not matter. Numeric values and dates must match in meaning (e.g. "May 2023" matches "2023-05"). A prediction that adds extra correct detail is still CORRECT; one that contradicts or omits the essential fact is WRONG.

Special case — abstention gold: if the gold answer states that the conversation contains no information (e.g. "no information available", "not mentioned"), the prediction is CORRECT only if it also declines to answer, and WRONG if it asserts any specific answer.

Output strictly the requested JSON.`;

export interface LlmJudge {
  grade(input: {
    question: string;
    gold: string;
    prediction: string;
    category: number;
  }): Promise<{ correct: boolean }>;
}

/**
 * OpenAI-backed judge. One chat call per question, temperature 0, strict
 * `{ correct: boolean }` schema, ~16 output tokens. An empty prediction
 * short-circuits to WRONG for non-abstention golds without an API call —
 * cheap and deterministic. (Abstention golds still call the judge: an
 * empty prediction can be a legitimate decline.)
 */
export function createOpenAiJudge(client: OpenAiLike, model: string): LlmJudge {
  return {
    async grade({ question, gold, prediction, category }) {
      if (!prediction.trim() && !looksLikeAbstention(gold)) {
        return { correct: false };
      }
      const res = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: LOCOMO_JUDGE_SYSTEM },
          {
            role: 'user',
            content:
              `Question: ${question}\n` +
              `Gold answer: ${gold}\n` +
              `Prediction: ${prediction || '(empty)'}\n` +
              `Category: ${category}`,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'locomo_judge',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { correct: { type: 'boolean' } },
              required: ['correct'],
            },
          },
        },
        max_completion_tokens: 16,
        temperature: 0,
      });
      const content = res.choices?.[0]?.message?.content;
      if (!content) throw new Error('judge returned empty content');
      const parsed = JSON.parse(content) as { correct?: unknown };
      if (typeof parsed.correct !== 'boolean') {
        throw new Error('judge returned malformed correct flag');
      }
      return { correct: parsed.correct };
    },
  };
}

/** Heuristic for LoCoMo category-5 "no information" golds. */
function looksLikeAbstention(gold: string): boolean {
  return /no information|not (mentioned|available|provided|specified)|cannot be (answered|determined)/i.test(
    gold,
  );
}
