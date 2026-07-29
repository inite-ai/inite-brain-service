/**
 * BEAM harness — the SCALE LADDER of the eval program.
 *
 * BEAM (ICLR 2026): 100K/500K/1M-token conversations, ten memory
 * abilities, 20 probing questions per conversation. Where LoCoMo measures
 * representation quality inside the context window and LongMemEval-S
 * measures ~115k capacity, BEAM measures how accuracy decays as the
 * haystack grows past a million tokens — full-context baselines stop
 * being runnable at all, so the memory system is compared per tier.
 *
 * Per conversation (isolated tenant via X-Brain-Tenant; brain must run
 * with BRAIN_TENANT_OVERRIDE_ENABLED=1, INGEST_EPISODE_ONLY=1,
 * EPISODE_SUBSTRATE_ENABLED=1 plus the winning read-stack flags):
 *   1. register user/assistant speaker entities
 *   2. ingest every turn episode-only (LLM-free), chunking 60-70-turn
 *      BEAM sessions into 20-turn sub-sessions (+2h jumps > the 1h
 *      deriver gap) so each derivation call sees a bounded transcript
 *   3. derive {version, force} + compose segments
 *   4. answer all 20 questions via /v1/search/multi-hop, strict judge
 *
 *   python3 scripts/fetch-beam-dataset.py --split 100K --out /tmp/beam_100k.json
 *   OPENAI_API_KEY=... npx ts-node -r tsconfig-paths/register \
 *     scripts/run-beam.ts --dataset /tmp/beam_100k.json \
 *     --brain-url http://localhost:3031 --api-key loco-dev-key \
 *     --judge --resume var/beam-100k.ckpt.jsonl --out var/beam-100k.json
 */
import { promises as fs } from 'node:fs';
import OpenAI from 'openai';
import {
  loadBeam,
  beamQuestionDateIso,
  BeamConversation,
  BeamQuestion,
} from '../test/eval/beam/loader';
import { ABSTAIN_RE } from '../test/eval/abstain';
import { loadCheckpoint, appendCheckpoint } from '../test/eval/checkpoint';
import { createOpenAiJudge } from '../test/eval/locomo/judge';

/** Sub-session chunking: bounded transcripts for the session deriver. */
const CHUNK_TURNS = 20;
const CHUNK_JUMP_MS = 2 * 3600_000; // > the deriver's 1h session gap
const TURN_STEP_MS = 30_000;
const TURN_CHAR_CAP = 8000; // protocol constant, same as LongMemEval

interface Args {
  dataset: string;
  brainUrl: string;
  apiKey: string;
  out: string;
  samples?: number;
  sampleOffset?: number;
  /** Filter to specific abilities (comma-separated). */
  abilities?: string[];
  conversationConcurrency: number;
  derivedVersion: string;
  judge: boolean;
  judgeModel: string;
  openaiApiKey?: string;
  skipIngest: boolean;
  resume?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dataset: '',
    brainUrl: process.env.BRAIN_URL ?? 'http://localhost:3031',
    apiKey: process.env.BRAIN_API_KEY ?? 'local-dev-key',
    out: 'beam-report.json',
    conversationConcurrency: 1,
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
    else if (a === '--abilities') (args.abilities = next.split(',')), i++;
    else if (a === '--conversation-concurrency')
      (args.conversationConcurrency = parseInt(next, 10)), i++;
    else if (a === '--derived-version') (args.derivedVersion = next), i++;
    else if (a === '--judge') args.judge = true;
    else if (a === '--judge-model') (args.judgeModel = next), i++;
    else if (a === '--skip-ingest') args.skipIngest = true;
    else if (a === '--resume') (args.resume = next), i++;
  }
  if (!args.dataset) throw new Error('missing --dataset beam_100k.json');
  if (args.judge && !args.openaiApiKey)
    throw new Error('--judge requires OPENAI_API_KEY');
  return args;
}

/** Minimal HTTP client with per-conversation tenant header. */
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
      throw new Error(
        `HTTP ${res.status} ${method} ${path}: ${text.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }
}

interface BeamScore {
  questionId: string;
  ability: string;
  difficulty: string;
  question: string;
  gold: string;
  prediction: string;
  abstained: boolean;
  promptTokens?: number;
  errored?: string;
  judgeCorrect?: boolean;
}

function tenantFor(conv: BeamConversation): string {
  return `beam_${conv.split}_${conv.conversationId}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .slice(0, 60);
}

function conversationRef(conv: BeamConversation): string {
  return `beam:${conv.split.toLowerCase()}-${conv.conversationId}`;
}

/** Deriver speaker slug: convRef after ':' with '-'→'_' (see deriver). */
function speakerName(conv: BeamConversation, role: string): string {
  const slug = conversationRef(conv)
    .slice(conversationRef(conv).lastIndexOf(':') + 1)
    .toLowerCase()
    .replace(/-/g, '_');
  return `${slug}__${role}`;
}

async function ingestConversation(
  args: Args,
  conv: BeamConversation,
  log: (m: string) => void,
): Promise<void> {
  const client = new TenantClient(args.brainUrl, args.apiKey, tenantFor(conv));
  for (const role of ['user', 'assistant']) {
    await client.call('POST', '/v1/ingest/fact', {
      entityRef: {
        vertical: 'beam',
        id: speakerName(conv, role),
        name: speakerName(conv, role),
        type: 'person',
      },
      predicate: 'name',
      object: speakerName(conv, role),
      source: { vertical: 'beam', recorder: 'beam-harness' },
    });
  }
  let turnTotal = 0;
  for (const session of conv.sessions) {
    const base = new Date(session.dateIso).getTime();
    for (const [i, turn] of session.turns.entries()) {
      const chunk = Math.floor(i / CHUNK_TURNS);
      const emittedAt = new Date(
        base + chunk * CHUNK_JUMP_MS + (i % CHUNK_TURNS) * TURN_STEP_MS,
      ).toISOString();
      await client.call('POST', '/v1/ingest/mention', {
        text: turn.content.slice(0, TURN_CHAR_CAP),
        contextRef: {
          vertical: 'beam',
          conversationId: conversationRef(conv),
          messageId: `${session.sessionId}:${i}`,
        },
        knownEntities: [
          {
            vertical: 'beam',
            id: speakerName(conv, turn.role),
            role: 'speaker',
            name: speakerName(conv, turn.role),
          },
        ],
        emittedAt,
      });
      turnTotal += 1;
    }
  }
  log(`ingested ${turnTotal} turns`);
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

async function answerQuestion(
  args: Args,
  conv: BeamConversation,
  q: BeamQuestion,
): Promise<BeamScore> {
  const client = new TenantClient(args.brainUrl, args.apiKey, tenantFor(conv));
  const score: BeamScore = {
    questionId: q.questionId,
    ability: q.ability,
    difficulty: q.difficulty,
    question: q.question,
    gold: q.gold,
    prediction: '',
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
      synthesisGuardrails: q.ability === 'abstention' ? 'lenient' : 'answer',
      asOf: beamQuestionDateIso(conv),
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

/** Judge gold: ideal answer plus the BEAM rubric as explicit key points. */
function judgeGold(q: BeamQuestion): string {
  if (q.rubric.length === 0) return q.gold;
  return `${q.gold}\nKey points the answer must reflect:\n${q.rubric
    .map((r) => `- ${r}`)
    .join('\n')}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = await loadBeam(args.dataset);
  const offset = args.sampleOffset ?? 0;
  const picked = all.slice(
    offset,
    args.samples ? offset + args.samples : undefined,
  );
  const questionsOf = (conv: BeamConversation): BeamQuestion[] =>
    args.abilities?.length
      ? conv.questions.filter((q) => args.abilities!.includes(q.ability))
      : conv.questions;

  const done = await loadCheckpoint<BeamScore>(args.resume, (s) => s.questionId);
  const haystackChars = picked.reduce(
    (a, c) =>
      a +
      c.sessions.reduce(
        (b, s) => b + s.turns.reduce((t, u) => t + u.content.length, 0),
        0,
      ),
    0,
  );
  console.error(
    `[beam] ${picked.length}/${all.length} conversations, ` +
      `${picked.reduce((a, c) => a + questionsOf(c).length, 0)} questions ` +
      `(${done.size} checkpointed), ~${Math.round(haystackChars / 4 / 1000)}k haystack tokens, ` +
      `version=${args.derivedVersion}`,
  );
  const judge = args.judge
    ? createOpenAiJudge(
        new OpenAI({ apiKey: args.openaiApiKey }),
        args.judgeModel,
      )
    : undefined;

  const scores: BeamScore[] = [...done.values()];
  let idx = 0;
  const workers = Array.from(
    { length: Math.max(1, args.conversationConcurrency) },
    async () => {
      for (;;) {
        const i = idx++;
        if (i >= picked.length) return;
        const conv = picked[i];
        const pending = questionsOf(conv).filter(
          (q) => !done.has(q.questionId),
        );
        const tag = `[beam ${i + 1}/${picked.length} conv-${conv.conversationId}]`;
        if (pending.length === 0) {
          console.error(`${tag} fully checkpointed, skipping`);
          continue;
        }
        try {
          if (!args.skipIngest) {
            await ingestConversation(args, conv, (m) =>
              console.error(`${tag} ${m}`),
            );
          }
          for (const q of pending) {
            const s = await answerQuestion(args, conv, q);
            if (judge && q.ability !== 'abstention' && !s.errored) {
              try {
                s.judgeCorrect = (
                  await judge.grade({
                    question: q.question,
                    gold: judgeGold(q),
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
              `${tag} ${q.questionId} ${
                s.errored
                  ? 'ERROR'
                  : q.ability === 'abstention'
                    ? `abstain=${s.abstained}`
                    : `judge=${s.judgeCorrect}`
              }`,
            );
          }
        } catch (e) {
          console.error(`${tag} PIPELINE ERROR: ${(e as Error).message}`);
          for (const q of pending) {
            scores.push({
              questionId: q.questionId,
              ability: q.ability,
              difficulty: q.difficulty,
              question: q.question,
              gold: q.gold,
              prediction: '',
              abstained: false,
              errored: (e as Error).message,
            });
          }
        }
      }
    },
  );
  await Promise.all(workers);

  const answerable = scores.filter((s) => s.ability !== 'abstention');
  const judged = answerable.filter((s) => s.judgeCorrect !== undefined);
  const byAbility = new Map<string, BeamScore[]>();
  for (const s of answerable) {
    byAbility.set(s.ability, [...(byAbility.get(s.ability) ?? []), s]);
  }
  const abst = scores.filter((s) => s.ability === 'abstention');
  const withTokens = scores.filter((s) => s.promptTokens !== undefined);
  const report = {
    generatedAt: new Date().toISOString(),
    dataset: args.dataset,
    split: picked[0]?.split,
    derivedVersion: args.derivedVersion,
    n: scores.length,
    judgeAccuracy: judged.length
      ? judged.filter((s) => s.judgeCorrect).length / judged.length
      : undefined,
    judgedN: judged.length,
    byAbility: [...byAbility.entries()].map(([ability, arr]) => {
      const j = arr.filter((s) => s.judgeCorrect !== undefined);
      return {
        ability,
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
    avgPromptTokens: withTokens.length
      ? Math.round(
          withTokens.reduce((a, s) => a + (s.promptTokens ?? 0), 0) /
            withTokens.length,
        )
      : undefined,
    errored: scores.filter((s) => s.errored).length,
    scores,
  };
  await fs.writeFile(args.out, JSON.stringify(report, null, 2));
  console.error(
    `[beam] judge=${
      report.judgeAccuracy !== undefined
        ? (100 * report.judgeAccuracy).toFixed(1) + '%'
        : 'n/a'
    } (n=${report.judgedN}) abstention=${report.abstention.abstainedRate ?? 'n/a'} ` +
      `avgPromptTok=${report.avgPromptTokens ?? 'n/a'} errors=${report.errored} → ${args.out}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
