/**
 * LongMemEval-S harness — the CAPACITY axis of the eval program.
 *
 * LoCoMo conversations (16-26k tokens) fit in a modern context window, so
 * it can only measure representation QUALITY against a strong full-context
 * baseline. LongMemEval haystacks (~115k tokens/question) do not fit
 * comfortably — this is where context-minimization is the product.
 *
 * Each question is its own EvalWorld (isolated tenant); the shared
 * world-axis driver (test/eval/harness/) does ingest → derive → segments
 * → dated QA → judge → checkpoint. Brain must run with
 * BRAIN_TENANT_OVERRIDE_ENABLED=1, INGEST_EPISODE_ONLY=1,
 * EPISODE_SUBSTRATE_ENABLED=1 and the read flags of the winning stack.
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
import { loadLongMemEval, LmeQuestion } from '../test/eval/longmemeval/loader';
import { parseFlags } from '../test/eval/harness/flags';
import { runWorlds } from '../test/eval/harness/driver';
import {
  buildAxisReport,
  estimateHaystackTokens,
  formatSummaryLine,
} from '../test/eval/harness/report';
import { EvalWorld } from '../test/eval/harness/types';
import { createOpenAiJudge } from '../test/eval/locomo/judge';

interface Args extends Record<string, unknown> {
  dataset: string;
  brainUrl: string;
  apiKey: string;
  out: string;
  samples?: number;
  sampleOffset?: number;
  types?: string[];
  questionConcurrency: number;
  derivedVersion: string;
  judge: boolean;
  judgeModel: string;
  skipIngest: boolean;
  resume?: string;
  /** Resolve first-person questions to the speaker entity. */
  personaHint: boolean;
}

const FLAGS = {
  '--dataset': { key: 'dataset', type: 'string' },
  '--brain-url': { key: 'brainUrl', type: 'string' },
  '--api-key': { key: 'apiKey', type: 'string' },
  '--out': { key: 'out', type: 'string' },
  '--samples': { key: 'samples', type: 'int' },
  '--sample-offset': { key: 'sampleOffset', type: 'int' },
  '--types': { key: 'types', type: 'list' },
  '--question-concurrency': { key: 'questionConcurrency', type: 'int' },
  '--derived-version': { key: 'derivedVersion', type: 'string' },
  '--judge': { key: 'judge', type: 'bool' },
  '--judge-model': { key: 'judgeModel', type: 'string' },
  '--skip-ingest': { key: 'skipIngest', type: 'bool' },
  '--resume': { key: 'resume', type: 'string' },
  '--persona-hint': { key: 'personaHint', type: 'bool' },
} as const;

function toWorld(q: LmeQuestion, personaHint: boolean): EvalWorld {
  const tenant = `lme_${q.questionId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')}`.slice(0, 60);
  return {
    tenant,
    conversationRef: `lme:${q.questionId}`,
    vertical: 'lme',
    sessions: q.sessions,
    questions: [
      {
        id: q.questionId,
        group: q.questionType,
        question: q.question,
        gold: q.answer,
        isAbstention: q.isAbstention,
        askedAtIso: q.questionDateIso,
      },
    ],
    ...(personaHint ? { personaHint } : {}),
  };
}

async function main() {
  const args = parseFlags<Args>(process.argv.slice(2), FLAGS, {
    dataset: '',
    brainUrl: process.env.BRAIN_URL ?? 'http://localhost:3031',
    apiKey: process.env.BRAIN_API_KEY ?? 'local-dev-key',
    out: 'lme-report.json',
    questionConcurrency: 1,
    derivedVersion: process.env.RETRIEVAL_DERIVED_VERSION?.trim() || 'wd-v2',
    judge: false,
    judgeModel: process.env.LOCOMO_JUDGE_MODEL ?? 'gpt-4.1-mini',
    skipIngest: false,
    personaHint: false,
  });
  if (!args.dataset) throw new Error('missing --dataset longmemeval_s.json');
  if (args.judge && !process.env.OPENAI_API_KEY)
    throw new Error('--judge requires OPENAI_API_KEY');

  const all = await loadLongMemEval(args.dataset);
  const offset = args.sampleOffset ?? 0;
  let picked = all.slice(
    offset,
    args.samples ? offset + args.samples : undefined,
  );
  if (args.types?.length) {
    picked = picked.filter((q) => args.types!.includes(q.questionType));
  }
  const worlds = picked.map((q) => toWorld(q, args.personaHint));
  console.error(
    `[lme] ${worlds.length}/${all.length} questions, ` +
      `~${Math.round(estimateHaystackTokens(worlds) / 1000)}k haystack tokens, ` +
      `version=${args.derivedVersion}`,
  );

  const { scores } = await runWorlds('lme', worlds, {
    brainUrl: args.brainUrl,
    apiKey: args.apiKey,
    derivedVersion: args.derivedVersion,
    concurrency: args.questionConcurrency,
    skipIngest: args.skipIngest,
    resume: args.resume,
    judge: args.judge
      ? createOpenAiJudge(
          new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
          args.judgeModel,
        )
      : undefined,
  });

  const axis = buildAxisReport(scores);
  const report = {
    generatedAt: new Date().toISOString(),
    dataset: 'longmemeval_s',
    derivedVersion: args.derivedVersion,
    ...axis,
    byType: axis.byGroup.map(({ group, ...rest }) => ({ type: group, ...rest })),
    byGroup: undefined,
    scores,
  };
  await fs.writeFile(args.out, JSON.stringify(report, null, 2));
  console.error(formatSummaryLine('lme', axis, args.out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
