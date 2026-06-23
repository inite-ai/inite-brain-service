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
 * Cost note: a full LoCoMo run ingests ~6k turns × 10 samples through
 * the NLU extractor (one OpenAI call per turn) plus ~1.5k QA calls
 * through search + synthesize (2 OpenAI calls each). Budget ~$80 on
 * gpt-4o-mini at current pricing. Use --samples 1 for a smoke run
 * under $10.
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
import { loadLocomoDataset } from '../test/eval/locomo/loader';
import { planIngest, executeIngest } from '../test/eval/locomo/ingest';
import { runLocomo } from '../test/eval/locomo/runner';
import {
  createHttpIngestSink,
  createHttpQaAgent,
} from '../test/eval/locomo/http-agent';
import { HttpBrainClient } from '../test/eval/http-brain-client';

interface Args {
  dataset: string;
  brainUrl: string;
  apiKey: string;
  out: string;
  samples?: number;
  skipIngest: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    brainUrl: process.env.BRAIN_URL ?? 'http://localhost:3000',
    apiKey: process.env.BRAIN_API_KEY ?? 'local-dev-key',
    out: 'locomo-report.json',
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
    else if (a === '--skip-ingest') args.skipIngest = true;
  }
  if (!args.dataset) {
    throw new Error('missing --dataset path/to/locomo10.json');
  }
  return args as Args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.error(
    `[locomo] dataset=${args.dataset} brain=${args.brainUrl} out=${args.out}`,
  );
  const conversations = await loadLocomoDataset(args.dataset);
  const sliced = args.samples
    ? conversations.slice(0, args.samples)
    : conversations;
  console.error(
    `[locomo] loaded ${sliced.length}/${conversations.length} samples, ${sliced.reduce((a, c) => a + c.qa.length, 0)} QA pairs`,
  );

  const client = new HttpBrainClient({
    baseUrl: args.brainUrl,
    apiKey: args.apiKey,
  });

  if (!args.skipIngest) {
    const sink = createHttpIngestSink(client);
    for (const conv of sliced) {
      const plan = planIngest(conv);
      console.error(
        `[locomo:ingest] sample=${conv.sampleId} speakers=${plan.speakers.length} mentions=${plan.mentions.length}`,
      );
      await executeIngest(plan, sink);
    }
  } else {
    console.error('[locomo] --skip-ingest: assuming brain already populated');
  }

  const agent = createHttpQaAgent(client, {
    useMultiHop: true,
    synthesisGuardrails: 'lenient',
  });

  const report = await runLocomo(sliced, agent, {
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) {
        console.error(`[locomo:qa] ${done}/${total}`);
      }
    },
  });

  await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(report, null, 2));

  console.error('');
  console.error('LoCoMo report');
  console.error('=============');
  console.error(`total questions: ${report.totalQuestions}`);
  console.error(
    `overall F1: ${pct(report.overall.f1)}   ROUGE-L: ${pct(report.overall.rougeL)}   BLEU-1: ${pct(report.overall.bleu1)}   EM: ${pct(report.overall.exactMatch)}`,
  );
  console.error('');
  console.error('per category:');
  for (const c of report.perCategory) {
    console.error(
      `  ${categoryLabel(c.category).padEnd(20)} n=${String(c.n).padStart(4)}   F1=${pct(c.f1)}   ROUGE-L=${pct(c.rougeL)}   adversarial=${pct(c.adversarial)}`,
    );
  }
  console.error('');
  console.error(`report written to ${args.out}`);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function categoryLabel(c: number): string {
  return (
    {
      1: 'single-hop',
      2: 'multi-hop',
      3: 'temporal',
      4: 'open-domain',
      5: 'adversarial',
    } as Record<number, string>
  )[c] ?? `category-${c}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
