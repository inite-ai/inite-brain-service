/**
 * LongMemEval-S harness — the CAPACITY axis of the eval program.
 *
 * LoCoMo conversations (16-26k tokens) fit in a modern context window, so
 * it can only measure representation QUALITY against a strong full-context
 * baseline. LongMemEval haystacks (~115k tokens/question) do not fit
 * comfortably — this is where context-minimization is the product.
 *
 * Per question (isolated tenant via X-Brain-Tenant, requires the brain to
 * run with BRAIN_TENANT_OVERRIDE_ENABLED=1, INGEST_EPISODE_ONLY=1,
 * EPISODE_SUBSTRATE_ENABLED=1 and the read flags of the winning stack):
 *   1. register user/assistant speaker entities (deriver attribution)
 *   2. ingest every haystack turn episode-only (LLM-free)
 *   3. POST /maintenance/derive {version} — session-window derivation
 *   4. POST /maintenance/segments — verbatim segment lane
 *   5. QA via /v1/search/multi-hop (+ judge)
 *
 *   OPENAI_API_KEY=... npx ts-node -r tsconfig-paths/register \
 *     scripts/run-longmemeval.ts --dataset /tmp/longmemeval_s.json \
 *     --brain-url http://localhost:3031 --api-key loco-dev-key \
 *     --samples 50 --question-concurrency 2 --judge \
 *     --resume var/lme.ckpt.jsonl --out var/lme-baseline.json
 *
 * Full 500-question runs MUST pass --resume: every finished question is
 * checkpointed to JSONL, so a quota death mid-run resumes for free.
 */
import { promises as fs } from 'node:fs';
import OpenAI from 'openai';
import {
  loadLongMemEval,
  LmeQuestion,
} from '../test/eval/longmemeval/loader';
import { ABSTAIN_RE } from '../test/eval/abstain';
import { loadCheckpoint, appendCheckpoint } from '../test/eval/checkpoint';
import { createOpenAiJudge } from '../test/eval/locomo/judge';

interface Args {
  dataset: string;
  brainUrl: string;
  apiKey: string;
  out: string;
  samples?: number;
  sampleOffset?: number;
  /** Filter to specific question types (comma-separated). */
  types?: string[];
  questionConcurrency: number;
  derivedVersion: string;
  judge: boolean;
  judgeModel: string;
  openaiApiKey?: string;
  /** Skip ingest+derive for tenants that already have the derived world. */
  skipIngest: boolean;
  /** JSONL checkpoint: completed questions survive quota deaths (full run). */
  resume?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dataset: '',
    brainUrl: process.env.BRAIN_URL ?? 'http://localhost:3031',
    apiKey: process.env.BRAIN_API_KEY ?? 'local-dev-key',
    out: 'lme-report.json',
    questionConcurrency: 1,
    derivedVersion: process.env.RETRIEVAL_DERIVED_VERSION?.trim() || 'wd-v2',
    judge: false,
    judgeModel: process.env.LOCOMO_JUDGE_MODEL ?? 'gpt-4.1-mini',
    openaiApiKey: process.env.OPENAI_API_KEY,
    skipIngest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--dataset') (args.dataset = next), i++;
    else if (a === '--brain-url') (args.brainUrl = next), i++;
    else if (a === '--api-key') (args.apiKey = next), i++;
    else if (a === '--out') (args.out = next), i++;
    else if (a === '--samples') (args.samples = parseInt(next, 10)), i++;
    else if (a === '--sample-offset')
      (args.sampleOffset = parseInt(next, 10)), i++;
    else if (a === '--types') (args.types = next.split(',')), i++;
    else if (a === '--question-concurrency')
      (args.questionConcurrency = parseInt(next, 10)), i++;
    else if (a === '--derived-version') (args.derivedVersion = next), i++;
    else if (a === '--judge') args.judge = true;
    else if (a === '--judge-model') (args.judgeModel = next), i++;
    else if (a === '--skip-ingest') args.skipIngest = true;
    else if (a === '--resume') (args.resume = next), i++;
  }
  if (!args.dataset) throw new Error('missing --dataset longmemeval_s.json');
  if (args.judge && !args.openaiApiKey)
    throw new Error('--judge requires OPENAI_API_KEY');
  return args;
}

/** Minimal HTTP client with per-question tenant header. */
class TenantClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly tenant: string,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Brain-Tenant': this.tenant,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}

interface LmeScore {
  questionId: string;
  questionType: string;
  question: string;
  gold: string;
  prediction: string;
  isAbstention: boolean;
  abstained: boolean;
  promptTokens?: number;
  errored?: string;
  judgeCorrect?: boolean;
}

function tenantFor(q: LmeQuestion): string {
  // companyId charset: lowercase slug of the question id.
  return `lme_${q.questionId.toLowerCase().replace(/[^a-z0-9_-]+/g, '_')}`.slice(
    0,
    60,
  );
}

async function ingestQuestion(
  args: Args,
  q: LmeQuestion,
  log: (m: string) => void,
): Promise<void> {
  const client = new TenantClient(args.brainUrl, args.apiKey, tenantFor(q));
  const convId = `lme:${q.questionId}`;
  const slug = q.questionId.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  // Speaker entities for deriver attribution (exact canonicalNameLc match).
  for (const speaker of ['user', 'assistant']) {
    await client.call('POST', '/v1/ingest/fact', {
      entityRef: {
        vertical: 'lme',
        id: `${slug}__${speaker}`,
        name: `${slug}__${speaker}`,
        type: 'person',
      },
      predicate: 'name',
      object: `${slug}__${speaker}`,
      source: { vertical: 'lme', recorder: 'lme-harness' },
    });
  }
  let turnIdx = 0;
  for (const session of q.sessions) {
    const base = new Date(session.dateIso).getTime();
    for (const [i, turn] of session.turns.entries()) {
      const emittedAt = new Date(base + i * 30_000).toISOString();
      await client.call('POST', '/v1/ingest/mention', {
        text: turn.content.slice(0, 8000),
        contextRef: {
          vertical: 'lme',
          conversationId: convId,
          messageId: `${session.sessionId}:${i}`,
        },
        knownEntities: [
          {
            vertical: 'lme',
            id: `${slug}__${turn.role}`,
            role: 'speaker',
            name: `${slug}__${turn.role}`,
          },
        ],
        emittedAt,
      });
      turnIdx += 1;
    }
  }
  log(`ingested ${turnIdx} turns`);
  const derived = await client.call<{ propositions: number }>(
    'POST',
    '/v1/admin/maintenance/derive',
    { version: args.derivedVersion, force: true },
  );
  const segs = await client.call<{ segments: number }>(
    'POST',
    '/v1/admin/maintenance/segments',
    {},
  );
  log(`derived ${derived.propositions} props, ${segs.segments} segments`);
}

async function answerQuestion(args: Args, q: LmeQuestion): Promise<LmeScore> {
  const client = new TenantClient(args.brainUrl, args.apiKey, tenantFor(q));
  const score: LmeScore = {
    questionId: q.questionId,
    questionType: q.questionType,
    question: q.question,
    gold: q.answer,
    prediction: '',
    isAbstention: q.isAbstention,
    abstained: false,
  };
  try {
    const res = await client.call<{
      synthesis?: {
        answer: string | null;
        tokenUsage?: { promptTokens: number };
      };
    }>('POST', '/v1/search/multi-hop', {
      query: q.question,
      synthesize: true,
      synthesisGuardrails: q.isAbstention ? 'lenient' : 'answer',
      asOf: q.questionDateIso,
    });
    score.prediction = res.synthesis?.answer ?? '';
    score.promptTokens = res.synthesis?.tokenUsage?.promptTokens;
  } catch (e) {
    score.errored = (e as Error).message;
  }
  score.abstained =
    !score.errored &&
    (!score.prediction.trim() || ABSTAIN_RE.test(score.prediction));
  return score;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = await loadLongMemEval(args.dataset);
  const offset = args.sampleOffset ?? 0;
  let picked = all.slice(offset, args.samples ? offset + args.samples : undefined);
  if (args.types?.length) {
    picked = picked.filter((q) => args.types!.includes(q.questionType));
  }
  const done = await loadCheckpoint<LmeScore>(
    args.resume,
    (s) => s.questionId,
  );
  const pickedTotal = picked.length;
  picked = picked.filter((q) => !done.has(q.questionId));
  const haystackChars = picked.reduce(
    (a, q) =>
      a +
      q.sessions.reduce(
        (b, s) => b + s.turns.reduce((t, u) => t + u.content.length, 0),
        0,
      ),
    0,
  );
  console.error(
    `[lme] ${picked.length}/${all.length} questions ` +
      `(${done.size ? `${pickedTotal - picked.length} checkpointed, ` : ''}` +
      `~${Math.round(haystackChars / 4 / 1000)}k haystack tokens to ingest), ` +
      `version=${args.derivedVersion}`,
  );
  const judge = args.judge
    ? createOpenAiJudge(new OpenAI({ apiKey: args.openaiApiKey }), args.judgeModel)
    : undefined;

  const scores: LmeScore[] = [...done.values()];
  let idx = 0;
  const workers = Array.from(
    { length: Math.max(1, args.questionConcurrency) },
    async () => {
      for (;;) {
        const i = idx++;
        if (i >= picked.length) return;
        const q = picked[i];
        const tag = `[lme ${i + 1}/${picked.length} ${q.questionId}]`;
        try {
          if (!args.skipIngest) {
            await ingestQuestion(args, q, (m) => console.error(`${tag} ${m}`));
          }
          const s = await answerQuestion(args, q);
          if (judge && !q.isAbstention && !s.errored) {
            try {
              s.judgeCorrect = (
                await judge.grade({
                  question: q.question,
                  gold: s.gold,
                  prediction: s.prediction,
                  category: 0, // non-LoCoMo axis — prompt context only
                })
              ).correct;
            } catch (e) {
              console.error(`${tag} judge error: ${(e as Error).message}`);
            }
          }
          scores.push(s);
          // Errored scores are NOT checkpointed — a resume retries them.
          if (!s.errored) await appendCheckpoint(args.resume, s);
          console.error(
            `${tag} ${s.errored ? 'ERROR' : q.isAbstention ? `abstain=${s.abstained}` : `judge=${s.judgeCorrect}`}`,
          );
        } catch (e) {
          scores.push({
            questionId: q.questionId,
            questionType: q.questionType,
            question: q.question,
            gold: q.answer,
            prediction: '',
            isAbstention: q.isAbstention,
            abstained: false,
            errored: (e as Error).message,
          });
          console.error(`${tag} PIPELINE ERROR: ${(e as Error).message}`);
        }
      }
    },
  );
  await Promise.all(workers);

  const answerable = scores.filter((s) => !s.isAbstention);
  const judged = answerable.filter((s) => s.judgeCorrect !== undefined);
  const byType = new Map<string, LmeScore[]>();
  for (const s of answerable) {
    byType.set(s.questionType, [...(byType.get(s.questionType) ?? []), s]);
  }
  const abst = scores.filter((s) => s.isAbstention);
  const report = {
    generatedAt: new Date().toISOString(),
    dataset: 'longmemeval_s',
    derivedVersion: args.derivedVersion,
    n: scores.length,
    judgeAccuracy: judged.length
      ? judged.filter((s) => s.judgeCorrect).length / judged.length
      : undefined,
    judgedN: judged.length,
    byType: [...byType.entries()].map(([t, arr]) => {
      const j = arr.filter((s) => s.judgeCorrect !== undefined);
      return {
        type: t,
        n: arr.length,
        judgeAccuracy: j.length
          ? j.filter((s) => s.judgeCorrect).length / j.length
          : undefined,
      };
    }),
    abstention: {
      n: abst.length,
      abstainedRate: abst.length
        ? abst.filter((s) => s.abstained).length / abst.length
        : undefined,
    },
    avgPromptTokens: (() => {
      const t = scores.filter((s) => s.promptTokens !== undefined);
      return t.length
        ? Math.round(t.reduce((a, s) => a + (s.promptTokens ?? 0), 0) / t.length)
        : undefined;
    })(),
    errored: scores.filter((s) => s.errored).length,
    scores,
  };
  await fs.writeFile(args.out, JSON.stringify(report, null, 2));
  console.error(
    `[lme] judge=${report.judgeAccuracy !== undefined ? (100 * report.judgeAccuracy).toFixed(1) + '%' : 'n/a'} (n=${report.judgedN}) abstention=${report.abstention.abstainedRate ?? 'n/a'} avgPromptTok=${report.avgPromptTokens ?? 'n/a'} errors=${report.errored} → ${args.out}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
