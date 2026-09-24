/**
 * The System One decision contract.
 *
 * A decision is not a generation: the caller states the STATE to judge and a
 * map of typed QUESTIONS, and gets back typed answers with a probability
 * distribution — never prose to parse. Every question in one request is
 * evaluated against the same state in parallel, so asking ten of them costs
 * about what asking one costs.
 *
 * The three primitives mirror TypeSafe's Jev API (`POST /v1/systemone`) because
 * that is the model this plane was built for, but nothing here is
 * vendor-specific: an OpenAI-backed implementation answers the same shapes,
 * which is exactly what makes a lane switchable and therefore measurable.
 */

/** "Is this statement true?" — answered as a probability, not a boolean. */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  /** Optional descriptions of what true and false mean for this judgement. */
  criteria?: { true: string; false: string };
}

/** "Choose one option" — at most 255 options, each with a description. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** "Score on a rubric" — 2..10 ordered, described levels. */
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  /** P(true), 0..1. Its distance from 0.5 IS the confidence. */
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  /** How concentrated the distribution is on the top option, 0..1. */
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionRequest {
  /** Text, a JSON object, or an array of either — whatever the judgement is about. */
  state: string | Record<string, unknown> | Array<string | Record<string, unknown>>;
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionResponse {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** What the decision actually cost, when the gateway reports it (OpenRouter). */
    cost?: number;
  };
}

/**
 * How certain the model is about ONE answer, on a single 0..1 scale so a lane
 * can gate on it without knowing which primitive it asked.
 *
 * For a noul the answer IS the probability, so certainty is its distance from
 * the coin flip, rescaled: 0.5 → 0, 0.95 → 0.9. For choice and score the model
 * reports its own concentration measure.
 */
export function certaintyOf(answer: DecisionAnswer): number {
  if (answer.type === 'noul') return Math.abs(answer.noul - 0.5) * 2;
  return answer.confidence;
}
