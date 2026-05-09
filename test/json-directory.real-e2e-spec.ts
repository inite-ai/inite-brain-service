/**
 * JSON-directory eval — loads an arbitrary directory file and runs
 * it through the standard eval pipeline (retrieval queries +
 * memory-lifecycle assertions). The file path comes from
 * BRAIN_DIRECTORY_JSON; the test is skipped when unset so plain
 * test runs don't blow up.
 *
 * Usage:
 *
 *   OPENAI_API_KEY=... \
 *     BRAIN_DIRECTORY_JSON=test/eval/fixtures/example-directory.json \
 *     pnpm test:eval:json
 *
 * Or, with your own export:
 *
 *   OPENAI_API_KEY=... \
 *     BRAIN_DIRECTORY_JSON=/path/to/your/customers.json \
 *     pnpm test:eval:json
 *
 * Pass criterion: every memory-lifecycle assertion passes (any
 * forgotten/retracted-data leak fails the run) AND every declared
 * query lands the expected entity in top-3.
 */
import { resolve } from 'node:path';
import { BrainClient } from '@inite/knowledge';
import { spawnService, SpawnedService } from './spawn';
import { loadDirectoryJson } from './eval/loaders/json-directory.loader';
import {
  SetupApplier,
  QueryExecutor,
  ScenarioRunner,
  Aggregator,
  EvalRunner,
  Reporter,
  MemoryAssertionsChecker,
} from './eval/runner';

describe('JSON-directory eval (load + retrieval + lifecycle)', () => {
  let svc: SpawnedService;
  const path = process.env.BRAIN_DIRECTORY_JSON;

  beforeAll(async () => {
    if (!path) return;
    svc = await spawnService({
      scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
      extraKeyScopes: [['brain:read', 'brain:write']],
    });
  }, 90_000);

  afterAll(async () => {
    if (svc) await svc.stop();
  });

  // Skip cleanly when the env var is unset — plain `pnpm test:eval`
  // sweeps don't hit this file.
  const run = path ? it : it.skip;

  run(
    'survives the loaded directory with retrieval + lifecycle correctness',
    async () => {
      // path narrowed by the conditional above; assert for tsc.
      if (!path) throw new Error('unreachable');
      const abs = resolve(path);

      const loaded = loadDirectoryJson(abs);

      console.log(
        `[json-directory] loaded '${abs}': ` +
          `${loaded.stats.entities} entities, ` +
          `${loaded.stats.facts} facts, ` +
          `${loaded.stats.retracts} retracts, ` +
          `${loaded.stats.forgets} forgets`,
      );

      const sdkOpts = { baseUrl: svc.baseUrl, timeoutMs: 60_000 };
      const fullClient = new BrainClient({
        ...sdkOpts,
        apiKey: svc.primary.plaintext,
      });
      const limitedClient = new BrainClient({
        ...sdkOpts,
        apiKey: svc.extras[0].plaintext,
      });

      const runner = new EvalRunner(
        new ScenarioRunner(
          new SetupApplier(fullClient),
          new QueryExecutor(fullClient, limitedClient),
          new MemoryAssertionsChecker(fullClient),
        ),
        new Aggregator(),
      );

      const report = await runner.run([loaded.scenario]);

      console.log('\n' + new Reporter().render(report) + '\n');

      const memoryFailures = report.outcomes.flatMap((o) =>
        o.memoryAssertionResults.filter((a) => !a.passed),
      );
      const queryFailures = report.outcomes
        .flatMap((o) => o.queryResults)
        .filter((q) => q.rankOfExpected === 0 || q.rankOfExpected > 3);
      expect({
        memoryFailures: memoryFailures.map(
          (m) =>
            `${m.scenarioId} ${m.kind}: ${m.description} — ${m.detail ?? ''}`,
        ),
        queryFailures: queryFailures.map(
          (q) => `${q.query} → rank ${q.rankOfExpected}`,
        ),
      }).toEqual({ memoryFailures: [], queryFailures: [] });
    },
    1_800_000,
  );
});
