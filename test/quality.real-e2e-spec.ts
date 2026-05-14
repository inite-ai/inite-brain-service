/**
 * Quality eval — real OpenAI, separate process, vertical scenarios.
 *
 * Composition root: spawns one brain process with two API keys
 * (full + read-only-no-pii) on the same companyId, wires the runner
 * from its single-purpose collaborators, runs all scenarios, prints
 * the markdown report, asserts overall thresholds.
 */
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { BrainClient } from '@inite/knowledge';
import { spawnService, SpawnedService } from './spawn';
import { loadOpenAiKey } from './spawn/openai-key-loader';
import { allScenarios } from './eval/scenarios';
import { loadDirectoryJson } from './eval/loaders/json-directory.loader';
import { buildQueryBankFromDirectory } from './eval/loaders/directory-query-bank';
import {
  SetupApplier,
  QueryExecutor,
  ScenarioRunner,
  Aggregator,
  EvalRunner,
  Reporter,
  MemoryAssertionsChecker,
  MiaChecker,
  FaithfulnessChecker,
} from './eval/runner';
import type { Scenario } from './eval/types';

describe('Quality eval (real OpenAI, multi-vertical scenarios)', () => {
  let svc: SpawnedService;

  beforeAll(async () => {
    svc = await spawnService({
      // Primary key: all scopes including PII.
      scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
      // Extra key on the same tenant without brain:read_pii — used by
      // the PII-gating scenarios.
      extraKeyScopes: [['brain:read', 'brain:write']],
    });
  }, 90_000);

  afterAll(async () => {
    if (svc) await svc.stop();
  });

  it('meets quality thresholds across verticals', async () => {
    // 180s per request — synthesize fans out 3 LLM calls (generator,
    // verifier, often a retry on rate limit). 60s was tripping under
    // the larger query set (~250 retrieval queries + 3 synthesize +
    // their decompose/verify legs). Per-request budget, not total run.
    const sdkOpts = { baseUrl: svc.baseUrl, timeoutMs: 180_000 };
    const fullClient = new BrainClient({ ...sdkOpts, apiKey: svc.primary.plaintext });
    const limitedClient = new BrainClient({ ...sdkOpts, apiKey: svc.extras[0].plaintext });

    // Faithfulness verifier needs its own OpenAI client — runs in the
    // test process (the metric file lives outside Nest's container so
    // it stays unit-testable). Pinned model snapshot mirrors the one
    // spawn-service hands the brain process.
    const openai = new OpenAI({ apiKey: loadOpenAiKey() });
    const runner = new EvalRunner(
      new ScenarioRunner(
        new SetupApplier(fullClient),
        new QueryExecutor(fullClient, limitedClient),
        new MemoryAssertionsChecker(fullClient),
        new MiaChecker(fullClient),
        new FaithfulnessChecker(fullClient, openai, 'gpt-4o-mini-2024-07-18'),
      ),
      new Aggregator(),
    );

    const directoryScenarios = loadDirectoryScenarios();
    if (directoryScenarios.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[quality] augmenting with ${directoryScenarios.length} directory scenario(s) ` +
          `(${directoryScenarios.reduce((n, s) => n + s.queries.length, 0)} queries)`,
      );
    }
    const scenarios: Scenario[] = [...allScenarios, ...directoryScenarios];

    const report = await runner.run(scenarios);

    const reporter = new Reporter();
    console.log('\n' + reporter.render(report) + '\n');

    // Stable JSON for baseline-diff / artifact upload. Off by default
    // (env-gated) so local `pnpm test:eval` doesn't litter the repo.
    const reportOut = process.env.BRAIN_EVAL_REPORT_OUT;
    if (reportOut) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(resolve(reportOut)), { recursive: true });
      writeFileSync(
        resolve(reportOut),
        JSON.stringify(reporter.serialize(report), null, 2),
      );
      // eslint-disable-next-line no-console
      console.log(`[quality] wrote machine-readable report to ${reportOut}`);
    }

    // Aggregate-level thresholds are necessary but not sufficient: a
    // vertical with extraction-recall=0.00 can ride below the radar
    // when other verticals' high scores pull the overall mean above
    // threshold. Assert per-vertical too — any vertical-level metric
    // that has a threshold and a non-null value must clear it.
    const collect = (
      label: string,
      metrics: { name: string; value: number | null; threshold?: number }[],
    ) =>
      metrics
        .filter(
          (m) =>
            m.threshold !== undefined &&
            m.value !== null &&
            m.value < m.threshold,
        )
        .map(
          (m) => `${label}.${m.name} ${m.value?.toFixed(2)} < ${m.threshold}`,
        );

    const failures = [
      ...collect('overall', report.overall),
      ...report.perVertical.flatMap((v) =>
        collect(v.vertical, v.metrics),
      ),
    ];

    expect({ failed: failures }).toEqual({ failed: [] });
  }, 1_200_000);
});

/**
 * Pull in directory-shaped fixtures (Wikidata exports, operator JSON
 * dumps) and synthesize a query bank for each. Default-on for the
 * cached Wikidata Russian-writers fixture so the gate measures
 * retrieval against a real reference set, not just the ~40 declarative
 * scenarios. Skipped silently if the file is absent (e.g., a fresh
 * clone before `pnpm fetch:wikidata`).
 *
 * Env knobs:
 *   BRAIN_EVAL_DIRECTORY_PATH      — comma-separated paths to override
 *                                    the default fixture set
 *   BRAIN_EVAL_DIRECTORY_SAMPLE    — entities to sample per directory
 *                                    (default 30; cap on bank size and
 *                                    OpenAI spend per gate)
 *   BRAIN_EVAL_DIRECTORY_SEED      — sampling seed (default 42)
 *   BRAIN_EVAL_DIRECTORY_DISABLE=1 — opt out entirely (e.g. local fast
 *                                    iteration without the Wikidata leg)
 */
function loadDirectoryScenarios(): Scenario[] {
  if (process.env.BRAIN_EVAL_DIRECTORY_DISABLE === '1') return [];

  const explicitPaths = process.env.BRAIN_EVAL_DIRECTORY_PATH
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const defaultPaths = [
    'test/eval/fixtures/wd-russian-writers.json',
    'test/eval/fixtures/wd-russian-writers-ru.json',
  ];
  const paths = explicitPaths && explicitPaths.length > 0 ? explicitPaths : defaultPaths;

  const sample = parseInt(process.env.BRAIN_EVAL_DIRECTORY_SAMPLE ?? '30', 10);
  const seed = parseInt(process.env.BRAIN_EVAL_DIRECTORY_SEED ?? '42', 10);

  const out: Scenario[] = [];
  for (const rel of paths) {
    const abs = resolve(rel);
    if (!existsSync(abs)) {
      // eslint-disable-next-line no-console
      console.warn(`[quality] directory fixture not found, skipping: ${abs}`);
      continue;
    }
    const loaded = loadDirectoryJson(abs);
    // The query-bank generator wants the raw JsonDirectory (entity
    // facts to pick names/dob/address from) AND the loader's Scenario
    // (its setup steps are reused as-is). Loader doesn't surface the
    // raw directory, so we re-parse — cheap for a few-hundred-KB JSON
    // and keeps the loader API unchanged.
    const directory = JSON.parse(readFileSync(abs, 'utf8'));
    const bank = buildQueryBankFromDirectory(directory, loaded.scenario, {
      sampleEntities: sample,
      seed,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[quality] directory '${rel}': ${bank.stats.entitiesSeeded} entities seeded, ` +
        `${bank.stats.entitiesSampled} sampled, ${bank.stats.queriesGenerated} queries generated`,
    );
    out.push(bank.scenario);
  }
  return out;
}
