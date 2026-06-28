/**
 * Directory eval — drops a realistic-shape jumbo tenant into brain
 * (default 1k customers + 100 staff + 60 projects, ~5-8k facts) with
 * temporal tier trajectories, retracted complaints, GDPR forgets,
 * and competing-status conflicts. Asserts BOTH retrieval ranking
 * AND memory-lifecycle correctness — a brain that ranks well but
 * leaks forgotten data fails the suite.
 *
 * Differences from fat-tenant.real-e2e-spec.ts:
 *   - Larger default scale (1k customers vs 500).
 *   - Memory-lifecycle features turned on at meaningful fractions.
 *   - Pass criterion folds memory-lifecycle-correctness into the
 *     scenario-level threshold; a single forgotten-customer leak
 *     fails the run.
 *
 * Run explicitly:
 *
 *     OPENAI_API_KEY=... pnpm test:eval:directory
 *
 * or via the underlying jest entry point with custom scale:
 *
 *     DIRECTORY_RUN=1 BRAIN_DIRECTORY_CUSTOMERS=2000 \
 *       pnpm exec jest --config ./test/jest-e2e-real.json \
 *         --runInBand --testPathPattern=directory
 */
import { HttpBrainClient } from './eval/http-brain-client';
import { spawnService, SpawnedService } from './spawn';
import { buildFatTenant } from './eval/fixtures/fat-tenant.generator';
import {
  SetupApplier,
  QueryExecutor,
  ScenarioRunner,
  Aggregator,
  EvalRunner,
  Reporter,
  MemoryAssertionsChecker,
  MiaChecker,
} from './eval/runner';

describe('Directory eval (jumbo tenant + memory lifecycle)', () => {
  let svc: SpawnedService;

  beforeAll(async () => {
    svc = await spawnService({
      scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
      extraKeyScopes: [['brain:read', 'brain:write']],
    });
  }, 90_000);

  afterAll(async () => {
    if (svc) await svc.stop();
  });

  // Opt-in: jumbo seeding takes minutes, OpenAI tokens add up.
  const run = process.env.DIRECTORY_RUN === '1' ? it : it.skip;

  run(
    'survives a 1k-customer directory with retracts, forgets, temporal updates',
    async () => {
      const customers = parseInt(
        process.env.BRAIN_DIRECTORY_CUSTOMERS ?? '1000',
        10,
      );
      const staff = parseInt(process.env.BRAIN_DIRECTORY_STAFF ?? '100', 10);
      const projects = parseInt(
        process.env.BRAIN_DIRECTORY_PROJECTS ?? '60',
        10,
      );

      const fixture = buildFatTenant({
        customers,
        staff,
        projects,
        // Tunable lifecycle pressure — defaults match the generator,
        // exposed here so an operator can crank competing-fraction up
        // for stress runs without editing fixture code.
        temporalTierFraction: parseFloat(
          process.env.BRAIN_DIRECTORY_TEMPORAL_TIER_FRAC ?? '0.3',
        ),
        competingStatusFraction: parseFloat(
          process.env.BRAIN_DIRECTORY_COMPETING_FRAC ?? '0.05',
        ),
        retractedComplaintsFraction: parseFloat(
          process.env.BRAIN_DIRECTORY_RETRACT_FRAC ?? '0.03',
        ),
        forgottenCustomersFraction: parseFloat(
          process.env.BRAIN_DIRECTORY_FORGET_FRAC ?? '0.01',
        ),
      });


      console.log(
        `[directory] generated ${fixture.stats.totalEntities} entities, ` +
          `${fixture.stats.totalFacts} facts. ` +
          `temporal-tier=${fixture.stats.temporalTierCustomers}, ` +
          `competing=${fixture.stats.competingStatusCustomers}, ` +
          `retracted=${fixture.stats.retractedComplaints}, ` +
          `forgotten=${fixture.stats.forgottenCustomers}`,
      );

      const fullClient = new HttpBrainClient({
        baseUrl: svc.baseUrl,
        apiKey: svc.primary.plaintext,
      });
      const limitedClient = new HttpBrainClient({
        baseUrl: svc.baseUrl,
        apiKey: svc.extras[0].plaintext,
      });

      const runner = new EvalRunner(
        new ScenarioRunner(
          new SetupApplier(fullClient),
          new QueryExecutor(fullClient, limitedClient),
          new MemoryAssertionsChecker(fullClient),
          new MiaChecker(fullClient),
        ),
        new Aggregator(),
      );

      const report = await runner.run(fixture.scenarios);


      console.log('\n' + new Reporter().render(report) + '\n');

      // Per-vertical pass criteria. memory-lifecycle-correctness
      // MUST be 1.0 — any forgotten data still findable, or any
      // retracted fact still surfacing in default search, fails.
      // Retrieval threshold is recall@3 ≥ 0.75: looser than the
      // small-scale eval since the directory's noise dominates,
      // tighter than 0 so a retrieval regression also fails the run.
      const memoryFailures = report.outcomes.flatMap((o) =>
        o.memoryAssertionResults.filter((a) => !a.passed),
      );
      const miaFailures = report.outcomes.flatMap((o) =>
        o.miaTestResults.filter((m) => !m.passed),
      );
      const queryFailures = report.outcomes
        .flatMap((o) => o.queryResults)
        .filter((q) => q.rankOfExpected === 0 || q.rankOfExpected > 3);
      expect({
        memoryFailures: memoryFailures.map(
          (m) => `${m.scenarioId} ${m.kind}: ${m.description} — ${m.detail ?? ''}`,
        ),
        miaFailures: miaFailures.map(
          (m) =>
            `${m.scenarioId} privacy leak: AUC=${m.auc.toFixed(3)} > ${m.threshold.toFixed(2)} — ${m.description}`,
        ),
        queryFailures: queryFailures.map(
          (q) => `${q.query} → rank ${q.rankOfExpected}`,
        ),
      }).toEqual({ memoryFailures: [], miaFailures: [], queryFailures: [] });
    },
    1_800_000, // 30 min — seeding 5-8k facts is slow without LLM batching
  );
});
