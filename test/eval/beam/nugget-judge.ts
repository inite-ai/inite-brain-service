import type { OpenAiLike } from '../metrics/faithfulness';

/**
 * BEAM official nugget judge (--nugget-judge) — per-rubric-item LLM
 * grading with partial credit, mirroring the benchmark's evaluation
 * code (repo mohammadtavakoli78/BEAM, src/prompts.py
 * unified_llm_judge_base_prompt + src/evaluation/compute_metrics.py)
 * so our numbers are comparable to the paper's tables. The strict
 * binary judge stays the headline; this runs alongside it.
 *
 * Two DELIBERATE fixes over the reference implementation, both
 * documented here because they change absolute numbers:
 *   1. Partial credit survives aggregation. The official code does
 *      `score += int(response['score'])` in 8 of 10 ability
 *      evaluators, so a judged 0.5 truncates to 0. We sum floats.
 *   2. The judge sees the actual question. The official prompt
 *      declares a `<question>` slot and anchors its responsiveness
 *      rule to it, but the code never substitutes it — the judge gets
 *      the literal placeholder. We substitute.
 *
 * event_ordering follows the paper's reported metric instead: greedy
 * LLM equivalence alignment of the newline-split response against the
 * rubric list, then normalized Kendall tau-b (report_results.py reads
 * tau_norm, NOT the tau×F1 final_score it also computes).
 */

/** Verbatim from src/prompts.py (unified_llm_judge_base_prompt). */
export const BEAM_NUGGET_JUDGE_PROMPT = `
You are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.

## EVALUATION INPUTS
- QUESTION (what the user asked): <question>
- RUBRIC CRITERION (what to check): <rubric_item>
- RESPONSE TO EVALUATE: <llm_response>

## EVALUATION RUBRIC:
The rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate.

**IMPORTANT**: Pay careful attention to whether the rubric specifies:
- **Positive requirements** (things the response SHOULD include/do)
- **Negative constraints** (things the response SHOULD NOT include/do, often indicated by "no", "not", "avoid", "absent")

## RESPONSIVENESS REQUIREMENT (anchored to the QUESTION)
A compliant response must be **on-topic with respect to the QUESTION** and attempt to answer it.
- If the response does not address the QUESTION, score **0.0** and stop.
- For negative constraints, both must hold: (a) the response is responsive to the QUESTION, and (b) the prohibited element is absent.

## SEMANTIC TOLERANCE RULES:
Judge by meaning, not exact wording.
- Accept **paraphrases** and **synonyms** that preserve intent.
- **Case/punctuation/whitespace** differences must be ignored.
- **Numbers/currencies/dates** may appear in equivalent forms (e.g., “$68,000”, “68k”, “68,000 USD”, or “sixty-eight thousand dollars”). Treat them as equal when numerically equivalent.
- If the rubric expects a number or duration, prefer **normalized comparison** (extract and compare values) over string matching.

## STYLE NEUTRALITY (prevents style contamination):
Ignore tone, politeness, length, and flourish unless the rubric explicitly requires a format/structure (e.g., “itemized list”, “no citations”, “one sentence”).
- Do **not** penalize hedging, voice, or verbosity if content satisfies the rubric.
- Only evaluate format when the rubric **explicitly** mandates it.

## SCORING SCALE:
- **1.0 (Complete Compliance)**: Fully complies with the rubric criterion.
  - Positive: required element present, accurate, properly executed (allowing semantic equivalents).
  - Negative: prohibited element **absent** AND response is **responsive**.

- **0.5 (Partial Compliance)**: Partially complies.
  - Positive: element present but minor inaccuracies/incomplete execution.
  - Negative: generally responsive and mostly avoids the prohibited element but with minor/edge violations.

- **0.0 (No Compliance)**: Fails to comply.
  - Positive: required element missing or incorrect.
  - Negative: prohibited element present **or** response is non-responsive/evasive even if the element is absent.

## EVALUATION INSTRUCTIONS:
1. **Understand the Requirement**: Determine if the rubric is asking for something to be present (positive) or absent (negative/constraint).

2. **Parse Compound Statements**: If the rubric contains multiple elements connected by "and" or commas, evaluate whether:
   - **All elements** must be present for full compliance (1.0)
   - **Some elements** present indicates partial compliance (0.5)
   - **No elements** present indicates no compliance (0.0)

3. **Check Compliance**:
   - For positive requirements: Look for the presence and quality of the required element
   - For negative constraints: Look for the absence of the prohibited element

4. **Assign Score**: Based on compliance with the specific rubric criterion according to the scoring scale above.

5. **Provide Reasoning**: Explain whether the rubric criterion was satisfied and justify the score.

## OUTPUT FORMAT:
Return your evaluation in JSON format with two fields:

{
   "score": [your score: 1.0, 0.5, or 0.0],
   "reason": "[detailed explanation of whether the rubric criterion was satisfied and why this justified the assigned score]"
}

NOTE: ONLY output the json object, without any explanation before or after that
`;

/** Verbatim system message of llm_equivalence (compute_metrics.py). */
const EQUIVALENCE_SYSTEM = `
            You are a binary classifier.
            If the TWO snippets describe the SAME event/fact, reply **YES**
            Otherwise reply **NO**. No extra words.
            DO NOT provide any exaplanation.
        `;

export interface OrderingScore {
  precision: number;
  recall: number;
  f1: number;
  /** (tau_b + 1) / 2 — the number the paper's tables report. */
  tauNorm: number;
  /** tau_norm × F1 — computed but unreported upstream; kept for depth. */
  finalScore: number;
}

export interface NuggetJudge {
  /** Mean over rubric items (floats — partial credit survives). */
  scoreQuestion(input: {
    question: string;
    rubric: string[];
    prediction: string;
  }): Promise<{ nuggetScore: number; itemScores: number[] }>;
  /** event_ordering: LLM-aligned normalized Kendall tau-b vs the rubric. */
  orderingScore(input: {
    rubric: string[];
    prediction: string;
  }): Promise<OrderingScore>;
}

/** Strip optional ``` fences (mirrors their parse_json_response). */
function parseJudgeJson(raw: string): { score?: unknown } {
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text);
  if (fenced) text = fenced[1]!;
  return JSON.parse(text) as { score?: unknown };
}

/**
 * Kendall tau-b over two equal-length rank vectors (ties allowed).
 * Pairs tied in BOTH vectors are excluded; ties in one vector feed the
 * denominator's tie terms — the scipy variant="b" definition the
 * official scorer calls. Returns null when a denominator term is 0
 * (mirrors scipy's nan → their `else 0` guard).
 */
export function kendallTauB(x: number[], y: number[]): number | null {
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  for (let i = 0; i < x.length; i += 1) {
    for (let j = i + 1; j < x.length; j += 1) {
      const dx = x[i]! - x[j]!;
      const dy = y[i]! - y[j]!;
      if (dx === 0 && dy === 0) continue;
      if (dx === 0) tiesX += 1;
      else if (dy === 0) tiesY += 1;
      else if (dx * dy > 0) concordant += 1;
      else discordant += 1;
    }
  }
  const nx = concordant + discordant + tiesX;
  const ny = concordant + discordant + tiesY;
  if (nx === 0 || ny === 0) return null;
  return (concordant - discordant) / Math.sqrt(nx * ny);
}

/**
 * Greedy 1-to-1 alignment (align_with_llm): each system item claims the
 * first unclaimed reference item the equivalence judge calls the same,
 * and is canonicalised to that reference string; unmatched items pass
 * through verbatim.
 */
async function alignWithLlm(
  reference: string[],
  system: string[],
  equivalent: (a: string, b: string) => Promise<boolean>,
): Promise<{ referenceCanon: string[]; systemCanon: string[] }> {
  const used = new Set<number>();
  const systemCanon: string[] = [];
  for (const s of system) {
    let matched: number | null = null;
    for (const [index, r] of reference.entries()) {
      if (used.has(index)) continue;
      if (await equivalent(r, s)) {
        matched = index;
        break;
      }
    }
    if (matched !== null) {
      systemCanon.push(reference[matched]!);
      used.add(matched);
    } else {
      systemCanon.push(s);
    }
  }
  return { referenceCanon: reference, systemCanon };
}

/** Pure scorer over canonicalised lists (event_ordering_score core). */
export function orderingScoreFromCanon(
  referenceCanon: string[],
  systemCanon: string[],
): OrderingScore {
  const refSet = new Set(referenceCanon);
  const sysSet = new Set(systemCanon);
  const tp = [...refSet].filter((x) => sysSet.has(x)).length;
  const fp = systemCanon.filter((x) => !refSet.has(x)).length;
  const fn = referenceCanon.filter((x) => !sysSet.has(x)).length;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const union = [...new Set([...referenceCanon, ...systemCanon])];
  const tieRank = union.length + 1;
  const toRank = (seq: string[]): number[] => {
    const r = new Map(seq.map((item, i) => [item, i + 1]));
    return union.map((u) => r.get(u) ?? tieRank);
  };
  const tau = kendallTauB(toRank(referenceCanon), toRank(systemCanon));
  const tauNorm = tau === null ? 0 : (tau + 1) / 2;
  return { precision, recall, f1, tauNorm, finalScore: tauNorm * f1 };
}

/**
 * Official system-list convention: the raw response split on newlines
 * (their code literally does `llm_response.split("\n")`). We trim and
 * drop blank lines — the one divergence, since judging empty strings
 * for equivalence is pure noise.
 */
export function splitOrderingResponse(prediction: string): string[] {
  return prediction
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function createNuggetJudge(
  client: OpenAiLike,
  model: string,
): NuggetJudge {
  async function judgeItem(
    question: string,
    rubricItem: string,
    prediction: string,
  ): Promise<number> {
    const prompt = BEAM_NUGGET_JUDGE_PROMPT.replace('<question>', question)
      .replace('<rubric_item>', rubricItem)
      .replace('<llm_response>', prediction || '(empty)');
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_completion_tokens: 400,
    });
    const raw = res.choices?.[0]?.message?.content ?? '';
    const parsed = parseJudgeJson(raw);
    const score = Number(parsed.score);
    if (![0, 0.5, 1].includes(score)) {
      throw new Error(`nugget judge returned invalid score: ${raw}`);
    }
    return score;
  }

  async function equivalent(a: string, b: string): Promise<boolean> {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: EQUIVALENCE_SYSTEM },
        {
          role: 'user',
          content: `First snippet: ${a} \n\n                       Second snippet: ${b}\n                    `,
        },
      ],
      temperature: 0,
      max_completion_tokens: 8,
    });
    return (res.choices?.[0]?.message?.content ?? '')
      .toLowerCase()
      .includes('yes');
  }

  return {
    async scoreQuestion({ question, rubric, prediction }) {
      const itemScores: number[] = [];
      for (const item of rubric) {
        itemScores.push(await judgeItem(question, item, prediction));
      }
      const nuggetScore = itemScores.length
        ? itemScores.reduce((a, b) => a + b, 0) / itemScores.length
        : 0;
      return { nuggetScore, itemScores };
    },
    async orderingScore({ rubric, prediction }) {
      const system = splitOrderingResponse(prediction);
      const { referenceCanon, systemCanon } = await alignWithLlm(
        rubric,
        system,
        equivalent,
      );
      return orderingScoreFromCanon(referenceCanon, systemCanon);
    },
  };
}
