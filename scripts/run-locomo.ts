#!/usr/bin/env tsx
/**
 * LoCoMo runner CLI.
 *
 *   tsx scripts/run-locomo.ts \
 *     --dataset path/to/locomo10.json \
 *     --brain-url http://localhost:3000 \
 *     --api-key local-dev-key \
 *     [--out report.json] \
 *     [--samples 1]          # cap samples for a smoke run
 *     [--skip-ingest]        # assume brain already populated
 *
 * Cost note (measured, not guessed — brain runs gpt-4o-mini for
 * extraction/synthesis + text-embedding-3-small; both are cheap):
 * a 1-sample smoke (~420 mentions ingested + ~200 QA through
 * multi-hop + synthesize, judge on) costs well under $1. A full
 * 10-sample run with the retrieval stack enabled (reranker/HyPE/
 * query-expansion each add gpt-4o-mini calls) lands in the low
 * single-digit dollars. Use --samples 1 for a smoke.
 *
 * Tenancy: the api key pins the tenant. We do NOT pick a per-sample
 * companyId — all conversations co-exist in one tenant, namespaced by
 * entity-id prefix `<sampleId>__`. A real deployment doesn't reshape
 * its tenancy for a benchmark, and this matches the production path.
 *
 * Brain MUST be running with brain:write + brain:read + brain:read_pii
 * + brain:admin scopes on the api key. A fresh dev tenant is the
 * cleanest — but mixing with existing data won't corrupt anything
 * (each sample's entities are prefixed; queries scope to the prefix
 * implicitly via the speaker entity ref).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { loadLocomoDataset } from '../test/eval/locomo/loader';
import { planIngest, executeIngest } from '../test/eval/locomo/ingest';
import {
  runLocomo,
  rejudgeScores,
  type RunReport,
} from '../test/eval/locomo/runner';
import { createOpenAiJudge, type LlmJudge } from '../test/eval/locomo/judge';
import {
  createHttpIngestSink,
  createHttpQaAgent,
  createHttpAgenticAgent,
} from '../test/eval/locomo/http-agent';
import { createClaudeMcpAgent } from '../test/eval/locomo/claude-agent';
import { HttpBrainClient } from '../test/eval/http-brain-client';

type AgentKind = 'http' | 'claude-mcp' | 'agentic';

interface Args {
  dataset: string;
  brainUrl: string;
  apiKey: string;
  out: string;
  samples?: number;
  /** Skip the first N conversations before applying --samples — selects a
   *  held-out block (e.g. --sample-offset 5 --samples 5 = conv 6..10). */
  sampleOffset?: number;
  /** Cost cap: stop QA after this many questions (ingest is unaffected). */
  maxQuestions?: number;
  /** Per-question wall-clock cap (ms). Default 60s; raise on a saturated
   *  stand so slow questions produce late answers instead of empty ones. */
  qaTimeoutMs?: number;
  /** Mentions in flight during ingest (default 1 serial). Speeds iteration. */
  ingestConcurrency?: number;
  /** Questions answered concurrently (default 1 serial). Each is an
   *  independent read; a bounded pool turns the serial QA crawl into
   *  wall-clock/concurrency. */
  qaConcurrency?: number;
  skipIngest: boolean;
  agent: AgentKind;
  /** Tenant id used to build the MCP URL when --agent claude-mcp. */
  companyId?: string;
  anthropicApiKey?: string;
  /** Anthropic model for --agent claude-mcp (default in claude-agent.ts is stale). */
  agentModel?: string;
  /** LLM-as-judge: binary correct/wrong grading ALONGSIDE token-F1. */
  judge: boolean;
  judgeModel: string;
  openaiApiKey?: string;
  /** Re-grade a previously written report offline (no ingest / no QA). */
  judgeReport?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    brainUrl: process.env.BRAIN_URL ?? 'http://localhost:3000',
    apiKey: process.env.BRAIN_API_KEY ?? 'local-dev-key',
    out: 'locomo-report.json',
    skipIngest: false,
    agent: 'http',
    companyId: process.env.BRAIN_COMPANY_ID,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    agentModel: process.env.LOCOMO_AGENT_MODEL,
    judge: false,
    judgeModel: process.env.LOCOMO_JUDGE_MODEL ?? 'gpt-4.1-mini',
    openaiApiKey: process.env.OPENAI_API_KEY,
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
    else if (a === '--max-questions') (args.maxQuestions = parseInt(next, 10)), i++;
    else if (a === '--qa-timeout-ms') (args.qaTimeoutMs = parseInt(next, 10)), i++;
    else if (a === '--ingest-concurrency')
      (args.ingestConcurrency = parseInt(next, 10)), i++;
    else if (a === '--qa-concurrency')
      (args.qaConcurrency = parseInt(next, 10)), i++;
    else if (a === '--skip-ingest') args.skipIngest = true;
    else if (a === '--agent') (args.agent = next as AgentKind), i++;
    else if (a === '--agent-model') (args.agentModel = next), i++;
    else if (a === '--company-id') (args.companyId = next), i++;
    else if (a === '--judge') args.judge = true;
    else if (a === '--judge-model') (args.judgeModel = next), i++;
    else if (a === '--judge-report') (args.judgeReport = next), i++;
  }
  // --judge-report re-grades an existing report offline; it needs no dataset.
  if (!args.dataset && !args.judgeReport) {
    throw new Error('missing --dataset path/to/locomo10.json');
  }
  if ((args.judge || args.judgeReport) && !args.openaiApiKey) {
    throw new Error('--judge requires OPENAI_API_KEY env');
  }
  if (args.agent === 'claude-mcp') {
    if (!args.companyId) {
      throw new Error(
        '--agent claude-mcp requires --company-id <id> (or BRAIN_COMPANY_ID env)',
      );
    }
    if (!args.anthropicApiKey) {
      throw new Error(
        '--agent claude-mcp requires ANTHROPIC_API_KEY env',
      );
    }
  }
  return args as Args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const judge: LlmJudge | undefined =
    args.judge || args.judgeReport
      ? createOpenAiJudge(
          new OpenAI({ apiKey: args.openaiApiKey }),
          args.judgeModel,
        )
      : undefined;

  // Offline re-grade path: load a saved report, judge its scores, rewrite.
  if (args.judgeReport) {
    console.error(
      `[locomo] re-grading ${args.judgeReport} with judge=${args.judgeModel}`,
    );
    const prior = JSON.parse(
      await fs.readFile(args.judgeReport, 'utf8'),
    ) as RunReport;
    const report = await rejudgeScores(prior.scores, judge!, (done, total) => {
      if (done % 25 === 0 || done === total) {
        console.error(`[locomo:judge] ${done}/${total}`);
      }
    });
    await fs.writeFile(args.judgeReport, JSON.stringify(report, null, 2));
    printReport(report, args.judgeReport);
    return;
  }

  console.error(
    `[locomo] dataset=${args.dataset} brain=${args.brainUrl} out=${args.out}`,
  );
  const conversations = await loadLocomoDataset(args.dataset);
  const offset = args.sampleOffset ?? 0;
  const sliced = args.samples
    ? conversations.slice(offset, offset + args.samples)
    : conversations.slice(offset);
  console.error(
    `[locomo] loaded ${sliced.length}/${conversations.length} samples, ${sliced.reduce((a, c) => a + c.qa.length, 0)} QA pairs`,
  );

  const client = new HttpBrainClient({
    baseUrl: args.brainUrl,
    apiKey: args.apiKey,
  });

  let totalIngested = 0;
  let totalDropped = 0;
  if (!args.skipIngest) {
    const sink = createHttpIngestSink(client);
    for (const conv of sliced) {
      const plan = planIngest(conv);
      console.error(
        `[locomo:ingest] sample=${conv.sampleId} speakers=${plan.speakers.length} mentions=${plan.mentions.length}`,
      );
      const outcome = await executeIngest(plan, sink, {
        concurrency: args.ingestConcurrency,
        onDrop: ({ sourceMessageId, error }) =>
          console.error(
            `[locomo:ingest] DROPPED ${sourceMessageId} after retries: ${error}`,
          ),
      });
      totalIngested += outcome.ingested;
      totalDropped += outcome.dropped.length;
      console.error(
        `[locomo:ingest] sample=${conv.sampleId} ingested=${outcome.ingested} dropped=${outcome.dropped.length}`,
      );
    }
    if (totalDropped > 0) {
      // Surfaced, not silent: a run that dropped mentions is degraded — the
      // headline is measured over whatever facts survived, so flag it.
      console.error(
        `[locomo] WARNING: ${totalDropped} mention(s) dropped after retries — results are on a partial ingest.`,
      );
    }
  } else {
    console.error('[locomo] --skip-ingest: assuming brain already populated');
  }

  let agentClose: (() => Promise<void>) | undefined;
  const agent =
    args.agent === 'claude-mcp'
      ? await (async () => {
          const { agent: a, close } = await createClaudeMcpAgent({
            brainUrl: args.brainUrl,
            companyId: args.companyId!,
            apiKey: args.apiKey,
            anthropicApiKey: args.anthropicApiKey!,
            options: args.agentModel ? { model: args.agentModel } : undefined,
          });
          agentClose = close;
          return a;
        })()
      : args.agent === 'agentic'
      ? createHttpAgenticAgent(client)
      : createHttpQaAgent(client, {
          useMultiHop: true,
          // Never-abstain: on LoCoMo an abstention scores strictly worse than
          // a best-effort short answer (the LLM judge rewards a topical guess
          // and punishes "no evidence"). Match the community answering
          // convention every published system uses.
          synthesisGuardrails: 'answer',
        });

  const report = await runLocomo(sliced, agent, {
    judge,
    maxQuestions: args.maxQuestions,
    perQuestionTimeoutMs: args.qaTimeoutMs,
    qaConcurrency: args.qaConcurrency,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) {
        console.error(`[locomo:qa] ${done}/${total}`);
      }
    },
  });
  if (agentClose) await agentClose();

  // Record ingest completeness in the artifact so a headline measured on a
  // partial brain is never mistaken for a clean run (stderr scrolls away).
  if (!args.skipIngest) {
    report.ingest = {
      ingested: totalIngested,
      dropped: totalDropped,
      degraded: totalDropped > 0,
    };
  }

  await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(report, null, 2));
  printReport(report, args.out);
}

function printReport(report: RunReport, out: string): void {
  const o = report.overall;
  console.error('');
  console.error('LoCoMo report');
  console.error('=============');
  console.error(`total questions: ${report.totalQuestions}`);
  console.error(
    `headline (cat 1-4, n=${o.n}) — the official LoCoMo denominator; adversarial excluded`,
  );
  if (o.judgeAccuracy !== undefined) {
    // Judge accuracy is the market-comparable number; F1 shown for context.
    console.error(
      `  judge accuracy: ${pct(o.judgeAccuracy)} (n=${o.judgedN})   [token-F1: ${pct(o.f1)}  ROUGE-L: ${pct(o.rougeL)}  EM: ${pct(o.exactMatch)}]`,
    );
  } else {
    console.error(
      `  token-F1: ${pct(o.f1)}   ROUGE-L: ${pct(o.rougeL)}   BLEU-1: ${pct(o.bleu1)}   EM: ${pct(o.exactMatch)}   (run with --judge for the comparable number)`,
    );
  }
  console.error(
    `adversarial (cat 5, n=${report.adversarial.n}) — correct = abstain: ${pct(report.adversarial.abstentionRate)} abstention`,
  );
  console.error('');
  console.error('per category:');
  for (const c of report.perCategory) {
    const metric =
      c.category === 5
        ? `abstention=${pct(c.abstentionRate)}`
        : `F1=${pct(c.f1)}   ROUGE-L=${pct(c.rougeL)}` +
          (c.judgeAccuracy !== undefined ? `   judge=${pct(c.judgeAccuracy)}` : '');
    console.error(
      `  ${categoryLabel(c.category).padEnd(20)} n=${String(c.n).padStart(4)}   ${metric}`,
    );
  }
  console.error('');
  console.error(`report written to ${out}`);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function categoryLabel(c: number): string {
  return (
    {
      1: 'multi-hop',
      2: 'temporal',
      3: 'open-domain',
      4: 'single-hop',
      5: 'adversarial',
    } as Record<number, string>
  )[c] ?? `category-${c}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
