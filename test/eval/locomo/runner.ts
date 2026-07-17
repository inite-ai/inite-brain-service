/**
 * LoCoMo QA runner.
 *
 * Given a populated brain (one tenant per sample, conversations
 * already ingested via mention), iterates the QA battery and produces
 * per-question scoring + a category-wise summary.
 *
 * The QaAgent abstraction lets us swap the answering strategy without
 * touching the harness:
 *   - HttpAgent      — calls `/v1/search/multi-hop` + `/v1/synthesize`
 *                      directly; cheapest, no Claude in the loop.
 *   - McpAgent       — drives Claude via the Anthropic SDK with brain
 *                      MCP transport bound; the natural agent path.
 *   - Custom         — any function with the QaAgent signature.
 *
 * The HttpAgent is what runs in CI (deterministic, no Claude key
 * required to compare brain-to-brain over time). McpAgent is what
 * runs for a published baseline against Mem0 / Zep / MemGPT —
 * everyone reports through-agent numbers in their papers.
 */
import type { NormalizedConversation, LocomoQuestion } from './types';
import {
  tokenF1,
  exactMatch,
  rougeL,
  bleu1,
  adversarialScore,
} from './metrics';
import type { LlmJudge } from './judge';

export interface QaAgent {
  /** companyId is the per-sample brain tenant the conversation lives in. */
  answer(input: {
    companyId: string;
    question: string;
    asOf?: string;
  }): Promise<string>;
}

export interface QuestionScore {
  sampleId: string;
  category: number;
  question: string;
  gold: string;
  prediction: string;
  f1: number;
  rougeL: number;
  bleu1: number;
  exactMatch: number;
  adversarial: number;
  errored?: string;
  /** LLM-judge verdict (--judge). undefined when judge off or errored. */
  judgeCorrect?: boolean;
  /** Judge error message — recorded, never fails the run. */
  judgeErrored?: string;
}

export interface CategorySummary {
  category: number;
  n: number;
  f1: number;
  rougeL: number;
  bleu1: number;
  exactMatch: number;
  adversarial: number;
  /** Mean over successfully-judged questions in the category. Omitted
   *  when the judge is off. */
  judgeAccuracy?: number;
  /** Count of successfully-judged questions the mean is over. */
  judgedN?: number;
}

export interface RunReport {
  generatedAt: string;
  totalQuestions: number;
  overall: Omit<CategorySummary, 'category' | 'n'> & { n: number };
  perCategory: CategorySummary[];
  perSample: Array<{ sampleId: string; n: number; f1: number }>;
  scores: QuestionScore[];
}

export async function runLocomo(
  conversations: NormalizedConversation[],
  agent: QaAgent,
  options: {
    /**
     * Optional per-sample tenant pin. Default: api key's companyId.
     * Kept on the runner so a future admin-key flow can route per
     * sample without touching this file.
     */
    companyIdFor?: (conv: NormalizedConversation) => string;
    /** Per-question wall-clock cap. Some LLM-heavy paths can hang. */
    perQuestionTimeoutMs?: number;
    onProgress?: (done: number, total: number) => void;
    /** Optional LLM judge (--judge). Reported ALONGSIDE token-F1, not
     *  instead of it; a judge failure is recorded per-question and never
     *  fails the run. */
    judge?: LlmJudge;
  } = {},
): Promise<RunReport> {
  const scores: QuestionScore[] = [];
  const total = conversations.reduce((a, c) => a + c.qa.length, 0);
  let done = 0;
  for (const conv of conversations) {
    const companyId = options.companyIdFor?.(conv) ?? '';
    for (const q of conv.qa) {
      const score = await scoreQuestion(
        agent,
        companyId,
        conv,
        q,
        options.perQuestionTimeoutMs,
      );
      if (options.judge) await applyJudge(options.judge, score);
      scores.push(score);
      done += 1;
      options.onProgress?.(done, total);
    }
  }
  return summarize(scores);
}

/**
 * Re-grade an EXISTING set of question scores with a judge and re-derive
 * the report — the `--judge-report` offline path. The paid QA run is
 * expensive; this lets a saved report be judged (and re-judged with a
 * future prompt version) for cents, without re-ingesting or re-querying.
 */
export async function rejudgeScores(
  scores: QuestionScore[],
  judge: LlmJudge,
  onProgress?: (done: number, total: number) => void,
): Promise<RunReport> {
  let done = 0;
  for (const score of scores) {
    delete score.judgeErrored;
    await applyJudge(judge, score);
    onProgress?.(++done, scores.length);
  }
  return summarize(scores);
}

/** Grade one question with the LLM judge, in place. Contained: a judge
 *  error is recorded on judgeErrored and never propagates. */
async function applyJudge(judge: LlmJudge, score: QuestionScore): Promise<void> {
  try {
    const { correct } = await judge.grade({
      question: score.question,
      gold: score.gold,
      prediction: score.prediction,
      category: score.category,
    });
    score.judgeCorrect = correct;
  } catch (e) {
    score.judgeErrored = (e as Error).message;
  }
}

async function scoreQuestion(
  agent: QaAgent,
  companyId: string,
  conv: NormalizedConversation,
  q: LocomoQuestion,
  timeoutMs = 60_000,
): Promise<QuestionScore> {
  let prediction = '';
  let errored: string | undefined;
  try {
    prediction = await withTimeout(
      agent.answer({
        companyId,
        question: q.question,
        // LoCoMo questions don't carry an explicit asOf — but for
        // temporal questions the agent can derive one from the wording.
        // We surface the latest session timestamp so the natural
        // "default = actual now" cursor is up-to-date.
        asOf: conv.sessions[conv.sessions.length - 1]?.dateTime,
      }),
      timeoutMs,
    );
  } catch (e) {
    errored = (e as Error).message;
  }
  return {
    sampleId: conv.sampleId,
    category: q.category,
    question: q.question,
    gold: q.answer,
    prediction,
    f1: tokenF1(prediction, q.answer),
    rougeL: rougeL(prediction, q.answer),
    bleu1: bleu1(prediction, q.answer),
    exactMatch: exactMatch(prediction, q.answer),
    adversarial: adversarialScore(prediction, q.answer),
    errored,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function summarize(scores: QuestionScore[]): RunReport {
  const byCategory = new Map<number, QuestionScore[]>();
  for (const s of scores) {
    const arr = byCategory.get(s.category) ?? [];
    arr.push(s);
    byCategory.set(s.category, arr);
  }
  const perCategory: CategorySummary[] = [];
  for (const [category, arr] of [...byCategory.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    perCategory.push({
      category,
      n: arr.length,
      f1: mean(arr, (s) => s.f1),
      rougeL: mean(arr, (s) => s.rougeL),
      bleu1: mean(arr, (s) => s.bleu1),
      exactMatch: mean(arr, (s) => s.exactMatch),
      adversarial: mean(arr, (s) => s.adversarial),
      ...judgeStats(arr),
    });
  }
  const bySample = new Map<string, QuestionScore[]>();
  for (const s of scores) {
    const arr = bySample.get(s.sampleId) ?? [];
    arr.push(s);
    bySample.set(s.sampleId, arr);
  }
  return {
    generatedAt: new Date().toISOString(),
    totalQuestions: scores.length,
    overall: {
      n: scores.length,
      f1: mean(scores, (s) => s.f1),
      rougeL: mean(scores, (s) => s.rougeL),
      bleu1: mean(scores, (s) => s.bleu1),
      exactMatch: mean(scores, (s) => s.exactMatch),
      adversarial: mean(scores, (s) => s.adversarial),
      ...judgeStats(scores),
    },
    perCategory,
    perSample: [...bySample.entries()].map(([sampleId, arr]) => ({
      sampleId,
      n: arr.length,
      f1: mean(arr, (s) => s.f1),
    })),
    scores,
  };
}

function mean<T>(arr: T[], pick: (item: T) => number): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (const item of arr) sum += pick(item);
  return sum / arr.length;
}

/**
 * Judge accuracy over the questions that were successfully judged (a
 * defined judgeCorrect). Returns {} when the judge was off (or every
 * question errored), so the additive report fields stay absent and old
 * report JSONs remain schema-compatible.
 */
function judgeStats(
  arr: QuestionScore[],
): { judgeAccuracy: number; judgedN: number } | Record<string, never> {
  const judged = arr.filter((s) => typeof s.judgeCorrect === 'boolean');
  if (judged.length === 0) return {};
  return {
    judgeAccuracy: judged.filter((s) => s.judgeCorrect).length / judged.length,
    judgedN: judged.length,
  };
}
