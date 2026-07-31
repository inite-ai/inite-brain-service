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
 * Each conversation is one EvalWorld (isolated tenant, 20 questions);
 * the shared world-axis driver (test/eval/harness/) does ingest →
 * derive → segments → dated QA → judge → checkpoint. 60-70-turn BEAM
 * sessions are chunked into 20-turn sub-sessions (emittedAt jumps past
 * the deriver's 1h gap) so each derivation call sees a bounded
 * transcript. The judge receives the BEAM gold plus its rubric.
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
} from '../test/eval/beam/loader';
import { parseFlags } from '../test/eval/harness/flags';
import { runWorlds } from '../test/eval/harness/driver';
import {
  buildAxisReport,
  estimateHaystackTokens,
  formatSummaryLine,
} from '../test/eval/harness/report';
import { EvalWorld } from '../test/eval/harness/types';
import { createOpenAiJudge } from '../test/eval/locomo/judge';

/** Bounded transcripts for the session deriver (see header). */
const CHUNK_TURNS = 20;

interface Args extends Record<string, unknown> {
  dataset: string;
  brainUrl: string;
  apiKey: string;
  out: string;
  samples?: number;
  sampleOffset?: number;
  abilities?: string[];
  conversationConcurrency: number;
  derivedVersion: string;
  judge: boolean;
  judgeModel: string;
  skipIngest: boolean;
  resume?: string;
  /** Resolve first-person questions to the speaker entity (B2 leg). */
  personaHint: boolean;
  /**
   * 'synthetic' (default): fabricate asOf = last session +7d, the
   * historical convention. 'none': send NO asOf — BEAM golds are
   * event-to-event intervals with no notion of a question date (repo
   * research 2026-07-31), so the fabricated anchor makes T1's
   * distance-to-today annotations decoys; pair with
   * SYNTHESIZE_TEMPORAL_EVENT_INTERVALS on the brain.
   */
  asofPolicy: string;
}

const FLAGS = {
  '--dataset': { key: 'dataset', type: 'string' },
  '--brain-url': { key: 'brainUrl', type: 'string' },
  '--api-key': { key: 'apiKey', type: 'string' },
  '--out': { key: 'out', type: 'string' },
  '--samples': { key: 'samples', type: 'int' },
  '--sample-offset': { key: 'sampleOffset', type: 'int' },
  '--abilities': { key: 'abilities', type: 'list' },
  '--conversation-concurrency': { key: 'conversationConcurrency', type: 'int' },
  '--derived-version': { key: 'derivedVersion', type: 'string' },
  '--judge': { key: 'judge', type: 'bool' },
  '--judge-model': { key: 'judgeModel', type: 'string' },
  '--skip-ingest': { key: 'skipIngest', type: 'bool' },
  '--resume': { key: 'resume', type: 'string' },
  '--persona-hint': { key: 'personaHint', type: 'bool' },
  '--asof-policy': { key: 'asofPolicy', type: 'string' },
} as const;

function toWorld(
  conv: BeamConversation,
  abilities: string[] | undefined,
  opts: { personaHint: boolean; asofPolicy: string },
): EvalWorld {
  const { personaHint, asofPolicy } = opts;
  const askedAtIso =
    asofPolicy === 'none' ? undefined : beamQuestionDateIso(conv);
  const questions = conv.questions
    .filter((q) => !abilities?.length || abilities.includes(q.ability))
    .map((q) => ({
      id: q.questionId,
      group: q.ability,
      question: q.question,
      gold: q.gold,
      // BEAM ships a rubric of key points per question — the judge sees
      // gold + rubric; the report keeps the bare gold.
      judgeGold: q.rubric.length
        ? `${q.gold}\nKey points the answer must reflect:\n${q.rubric
            .map((r) => `- ${r}`)
            .join('\n')}`
        : undefined,
      isAbstention: q.ability === 'abstention',
      ...(askedAtIso ? { askedAtIso } : {}),
      meta: { difficulty: q.difficulty },
    }));
  return {
    tenant: `beam_${conv.split}_${conv.conversationId}`
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .slice(0, 60),
    conversationRef: `beam:${conv.split.toLowerCase()}-${conv.conversationId}`,
    vertical: 'beam',
    sessions: conv.sessions,
    questions,
    ...(personaHint ? { personaHint } : {}),
  };
}

async function main() {
  const args = parseFlags<Args>(process.argv.slice(2), FLAGS, {
    dataset: '',
    brainUrl: process.env.BRAIN_URL ?? 'http://localhost:3031',
    apiKey: process.env.BRAIN_API_KEY ?? 'local-dev-key',
    out: 'beam-report.json',
    conversationConcurrency: 1,
    derivedVersion: process.env.RETRIEVAL_DERIVED_VERSION?.trim() || 'wd-v2',
    judge: false,
    judgeModel: process.env.LOCOMO_JUDGE_MODEL ?? 'gpt-4.1-mini',
    skipIngest: false,
    personaHint: false,
    asofPolicy: 'synthetic',
  });
  if (!args.dataset) throw new Error('missing --dataset beam_100k.json');
  if (!['synthetic', 'none'].includes(args.asofPolicy)) {
    throw new Error(
      `--asof-policy must be synthetic|none (got "${args.asofPolicy}")`,
    );
  }
  if (args.judge && !process.env.OPENAI_API_KEY)
    throw new Error('--judge requires OPENAI_API_KEY');

  const all = await loadBeam(args.dataset);
  const offset = args.sampleOffset ?? 0;
  const picked = all.slice(
    offset,
    args.samples ? offset + args.samples : undefined,
  );
  const worlds = picked
    .map((c) =>
      toWorld(c, args.abilities, {
        personaHint: args.personaHint,
        asofPolicy: args.asofPolicy,
      }),
    )
    .filter((w) => w.questions.length > 0);
  console.error(
    `[beam] ${worlds.length}/${all.length} conversations, ` +
      `${worlds.reduce((a, w) => a + w.questions.length, 0)} questions, ` +
      `~${Math.round(estimateHaystackTokens(worlds) / 1000)}k haystack tokens, ` +
      `version=${args.derivedVersion}`,
  );

  const { scores } = await runWorlds('beam', worlds, {
    brainUrl: args.brainUrl,
    apiKey: args.apiKey,
    derivedVersion: args.derivedVersion,
    concurrency: args.conversationConcurrency,
    skipIngest: args.skipIngest,
    resume: args.resume,
    chunkTurns: CHUNK_TURNS,
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
    dataset: args.dataset,
    split: picked[0]?.split,
    derivedVersion: args.derivedVersion,
    ...axis,
    byAbility: axis.byGroup.map(({ group, ...rest }) => ({
      ability: group,
      ...rest,
    })),
    byGroup: undefined,
    scores,
  };
  await fs.writeFile(args.out, JSON.stringify(report, null, 2));
  console.error(formatSummaryLine('beam', axis, args.out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
