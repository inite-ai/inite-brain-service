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
  isRefusal,
} from './metrics';
import type { LlmJudge } from './judge';
import { runPool } from '../harness/pool';
import { loadCheckpoint, appendCheckpoint } from '../checkpoint';

/** LoCoMo category id for adversarial (unanswerable) questions. */
const ADVERSARIAL_CATEGORY = 5;

/**
 * Did the agent decline to answer? For adversarial (cat5) questions this
 * IS the correctness signal — the right move is to refuse, not to produce
 * the tempting `adversarial_answer`. An empty prediction counts, as does
 * the synthesize grounded-evidence sentinel (which the generic
 * REFUSAL_PATTERNS list doesn't cover) and any of those patterns.
 */
export function isAbstention(prediction: string): boolean {
  const p = (prediction ?? '').trim().toLowerCase();
  if (p === '') return true;
  if (p.includes('grounded evidence')) return true;
  if (p.includes("don't have") || p.includes('do not have')) return true;
  return isRefusal(prediction);
}

/** Agents may return a bare answer string or an answer with token cost. */
export type AgentAnswer =
  | string
  | { answer: string; promptTokens?: number; completionTokens?: number };

export interface QaAgent {
  /** companyId is the per-sample brain tenant the conversation lives in. */
  answer(input: {
    companyId: string;
    question: string;
    asOf?: string;
  }): Promise<AgentAnswer>;
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
  /** True when the agent declined to answer. For cat5 this is correctness. */
  abstained: boolean;
  errored?: string;
  /** LLM-judge verdict (--judge). undefined when judge off or errored. */
  judgeCorrect?: boolean;
  /** Judge error message — recorded, never fails the run. */
  judgeErrored?: string;
  /** Generator prompt tokens for this question, when the agent reports it. */
  promptTokens?: number;
  completionTokens?: number;
}

/** Per-run token accounting — the context-minimization axis. */
export interface TokenSummary {
  /** Questions that carried usage (others ran through agents that don't report it). */
  reportedN: number;
  avgPromptTokens: number;
  p90PromptTokens: number;
  maxPromptTokens: number;
  avgCompletionTokens: number;
  totalPromptTokens: number;
}

export interface CategorySummary {
  category: number;
  n: number;
  f1: number;
  rougeL: number;
  bleu1: number;
  exactMatch: number;
  adversarial: number;
  /** Fraction of the category's questions the agent declined to answer. */
  abstentionRate: number;
  /** Mean over successfully-judged questions in the category. Omitted
   *  when the judge is off. */
  judgeAccuracy?: number;
  /** Count of successfully-judged questions the mean is over. */
  judgedN?: number;
}

/**
 * Adversarial (cat5) summary. These questions are EXCLUDED from the
 * headline per the official LoCoMo protocol; correctness here is
 * abstention, reported on its own axis.
 */
export interface AdversarialSummary {
  n: number;
  abstentionRate: number;
}

export interface RunReport {
  generatedAt: string;
  totalQuestions: number;
  /** Per-question generator token accounting, when agents report usage. */
  tokens?: TokenSummary;
  /**
   * Headline metrics over the ANSWERABLE categories (1-4) only.
   * `n` is the count of cat1-4 questions, not the grand total — this is
   * the official LoCoMo denominator. Adversarial (cat5) is excluded and
   * surfaced in `adversarial` instead.
   */
  overall: Omit<CategorySummary, 'category' | 'n' | 'abstentionRate'> & {
    n: number;
  };
  /** Adversarial (cat5) abstention, reported separately from the headline. */
  adversarial: AdversarialSummary;
  perCategory: CategorySummary[];
  perSample: Array<{ sampleId: string; n: number; f1: number }>;
  scores: QuestionScore[];
  /**
   * Ingest completeness for this run, when the runner ingested (absent on
   * --skip-ingest). `degraded` flags that mentions were dropped after retries,
   * so the headline was measured on a PARTIAL brain — provenance the saved
   * artifact must carry, else a degraded run looks clean.
   */
  ingest?: { ingested: number; dropped: number; degraded: boolean };
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
    /** Cost cap for cheap iteration: stop after this many questions total
     *  (across all conversations). Undefined = every question. The subset
     *  is the QA order as loaded (naturally category-mixed); per-category n
     *  in the report shows the resulting balance. */
    maxQuestions?: number;
    /**
     * Questions answered concurrently. Each question is an independent read
     * against an already-ingested tenant, so a bounded pool is race-safe and
     * turns a serial ~1s-3s-per-question crawl into wall-clock/concurrency.
     * Default 1 = serial, byte-identical to the pre-concurrency behaviour.
     * Results are written back by load-order index, so the report is order-
     * deterministic regardless of completion order.
     */
    qaConcurrency?: number;
    /**
     * JSONL checkpoint path: finished questions are appended as they
     * complete and skipped on rerun, so a quota death or stand OOM
     * mid-run costs nothing. Keyed by content (sample+category+question),
     * so the same file is valid across --samples/--max-questions slices.
     * Errored rows (and judge-failed rows when the judge is on) are NOT
     * checkpointed — a resume retries them.
     */
    resume?: string;
  } = {},
): Promise<RunReport> {
  const grand = conversations.reduce((a, c) => a + c.qa.length, 0);
  const total = options.maxQuestions
    ? Math.min(options.maxQuestions, grand)
    : grand;

  // Flatten to an ordered work list so a bounded pool can run questions
  // concurrently. maxQuestions caps in load order, matching the serial path.
  interface WorkItem {
    conv: NormalizedConversation;
    companyId: string;
    q: LocomoQuestion;
  }
  const work: WorkItem[] = [];
  outer: for (const conv of conversations) {
    const companyId = options.companyIdFor?.(conv) ?? '';
    for (const q of conv.qa) {
      if (options.maxQuestions && work.length >= options.maxQuestions) {
        break outer;
      }
      work.push({ conv, companyId, q });
    }
  }

  const restored = await loadCheckpoint<QuestionScore>(
    options.resume,
    scoreKey,
  );
  const scores: QuestionScore[] = new Array(work.length);
  let done = 0;

  await runPool(options.qaConcurrency ?? 1, work, async (item, idx) => {
    const { conv, companyId, q } = item;
    const prior = restored.get(
      scoreKey({ sampleId: conv.sampleId, category: q.category, question: q.question }),
    );
    if (prior) {
      scores[idx] = prior; // preserve load order regardless of finish order
      done += 1;
      options.onProgress?.(done, total);
      return;
    }
    const score = await scoreQuestion(
      agent,
      companyId,
      conv,
      q,
      options.perQuestionTimeoutMs,
    );
    if (options.judge) await applyJudge(options.judge, score);
    scores[idx] = score;
    // A row is checkpointed only when complete for this run's config:
    // never on an errored answer, and — with the judge on — never on a
    // failed grade, so a resume retries instead of freezing the gap.
    if (
      !score.errored &&
      (!options.judge || score.judgeCorrect !== undefined)
    ) {
      await appendCheckpoint(options.resume, score);
    }
    done += 1;
    options.onProgress?.(done, total);
  });
  return summarize(scores);
}

/** Content-addressed checkpoint key — stable across dataset slices. */
function scoreKey(s: {
  sampleId: string;
  category: number;
  question: string;
}): string {
  return `${s.sampleId}::${s.category}::${s.question}`;
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
    // Clear the PRIOR verdict too: if this re-grade errors, applyJudge leaves
    // judgeCorrect untouched — and a stale boolean from the loaded report would
    // then be counted as a fresh verdict. Start undefined (like the online
    // path) so an errored re-grade is excluded, not silently carried over.
    delete score.judgeCorrect;
    await applyJudge(judge, score);
    onProgress?.(++done, scores.length);
  }
  return summarize(scores);
}

/** Grade one question with the LLM judge, in place. Contained: a judge
 *  error is recorded on judgeErrored and never propagates. */
async function applyJudge(judge: LlmJudge, score: QuestionScore): Promise<void> {
  // Adversarial (cat5) has no answerable gold — grading a semantic match
  // against the tempting `adversarial_answer` would invert correctness.
  // Correctness here is abstention, which we already computed; skip the
  // (billable) LLM call and mirror it into judgeCorrect for a uniform axis.
  if (score.category === ADVERSARIAL_CATEGORY) {
    score.judgeCorrect = score.abstained;
    return;
  }
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
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let errored: string | undefined;
  try {
    const raw = await withTimeout(
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
    if (typeof raw === 'string') {
      prediction = raw;
    } else {
      prediction = raw.answer;
      promptTokens = raw.promptTokens;
      completionTokens = raw.completionTokens;
    }
  } catch (e) {
    errored = (e as Error).message;
  }
  // Defensive: gold answers are coerced to string at the loader boundary,
  // but a stray non-string here would throw inside the token metrics and
  // abort the entire (expensive) run — coerce again so one odd field can't.
  const gold = typeof q.answer === 'string' ? q.answer : String(q.answer ?? '');
  const pred = typeof prediction === 'string' ? prediction : String(prediction ?? '');
  return {
    sampleId: conv.sampleId,
    category: q.category,
    question: q.question,
    gold,
    prediction: pred,
    f1: tokenF1(pred, gold),
    rougeL: rougeL(pred, gold),
    bleu1: bleu1(pred, gold),
    exactMatch: exactMatch(pred, gold),
    adversarial: adversarialScore(pred, gold),
    // An errored/timed-out question produces an empty prediction, which
    // isAbstention('') reads as `true` — but a network failure is NOT a
    // deliberate decline. Counting it as one would inflate the adversarial
    // (cat5) abstention rate with mere infrastructure failures. Only a
    // genuine (non-errored) empty/refusal answer counts as an abstention.
    abstained: errored ? false : isAbstention(pred),
    errored,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
  };
}

/** Aggregate per-question usage into the run-level token summary. */
export function summarizeTokens(
  scores: QuestionScore[],
): TokenSummary | undefined {
  const reported = scores.filter((s) => s.promptTokens !== undefined);
  if (reported.length === 0) return undefined;
  const prompts = reported
    .map((s) => s.promptTokens as number)
    .sort((a, b) => a - b);
  const sum = prompts.reduce((a, b) => a + b, 0);
  return {
    reportedN: reported.length,
    avgPromptTokens: Math.round(sum / reported.length),
    p90PromptTokens: prompts[Math.min(
      prompts.length - 1,
      Math.floor(prompts.length * 0.9),
    )],
    maxPromptTokens: prompts[prompts.length - 1],
    avgCompletionTokens: Math.round(
      reported.reduce((a, s) => a + (s.completionTokens ?? 0), 0) /
        reported.length,
    ),
    totalPromptTokens: sum,
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
      abstentionRate: mean(arr, (s) => (s.abstained ? 1 : 0)),
      ...judgeStats(arr),
    });
  }
  const bySample = new Map<string, QuestionScore[]>();
  for (const s of scores) {
    const arr = bySample.get(s.sampleId) ?? [];
    arr.push(s);
    bySample.set(s.sampleId, arr);
  }
  // Official LoCoMo protocol: the headline denominator is cat1-4 only.
  // Adversarial (cat5) is excluded and scored as abstention on its own axis.
  const answerable = scores.filter((s) => s.category !== ADVERSARIAL_CATEGORY);
  const adversarial = scores.filter((s) => s.category === ADVERSARIAL_CATEGORY);
  return {
    generatedAt: new Date().toISOString(),
    totalQuestions: scores.length,
    tokens: summarizeTokens(scores),
    overall: {
      n: answerable.length,
      f1: mean(answerable, (s) => s.f1),
      rougeL: mean(answerable, (s) => s.rougeL),
      bleu1: mean(answerable, (s) => s.bleu1),
      exactMatch: mean(answerable, (s) => s.exactMatch),
      adversarial: mean(answerable, (s) => s.adversarial),
      ...judgeStats(answerable),
    },
    adversarial: {
      n: adversarial.length,
      abstentionRate: mean(adversarial, (s) => (s.abstained ? 1 : 0)),
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
