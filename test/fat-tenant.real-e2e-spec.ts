/**
 * Fat-tenant retrieval eval — measures retrieval quality on a
 * mid-scale tenant (~500 entities, ~3-5k facts). Lets us see
 * whether techniques that pathologically fail on small graphs
 * (PPR, community lookup, GraphRAG) actually pay off when the
 * graph is dense enough for hub effects to dissipate.
 *
 * Excluded from the default eval suite — generator runs through
 * the full ingest path so seeding 2k+ steps takes a few minutes
 * even without LLM extraction (the search path still hits real
 * OpenAI for embeddings on each query). Run explicitly:
 *
 *     SEARCH_RERANKER_ENABLED=1 SEARCH_PREDICATE_ROUTER_ENABLED=1 \
 *       pnpm exec jest --config ./test/jest-e2e-real.json \
 *         --runInBand --testPathPattern=fat-tenant
 *
 * Tune scale via FAT_TENANT_CUSTOMERS / FAT_TENANT_STAFF /
 * FAT_TENANT_PROJECTS env vars (defaults 500 / 50 / 30).
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

describe('Fat-tenant retrieval eval', () => {
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

  // Opt-in: this test seeds 2k+ setup steps and intentionally documents
  // failure modes that are not yet solved (Klaus Weber anchor falls
  // out of top-3 even with reranker+router on). Run explicitly via
  // FAT_TENANT_RUN=1 — otherwise skip so default sweeps stay green.
  const run = process.env.FAT_TENANT_RUN === '1' ? it : it.skip;

  run(
    'retrieves anchor entities from a ~500-entity tenant',
    async () => {
      const customers = parseInt(process.env.FAT_TENANT_CUSTOMERS ?? '500', 10);
      const staff = parseInt(process.env.FAT_TENANT_STAFF ?? '50', 10);
      const projects = parseInt(process.env.FAT_TENANT_PROJECTS ?? '30', 10);

      const fixture = buildFatTenant({ customers, staff, projects });

      console.log(
        `[fat-tenant] generated ${fixture.stats.totalEntities} entities, ` +
          `${fixture.stats.totalFacts} facts`,
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

      // Pass criterion: every query in the fat-tenant scenario
      // must return its expected entity in the top-3. Stricter than
      // overall thresholds because the queries are anchor lookups
      // — anything below top-3 means the graph noise dominates,
      // which is the exact regime we're trying to characterise.
      const queryResults = report.outcomes.flatMap((o) => o.queryResults);
      const failed = queryResults.filter(
        (q) => q.rankOfExpected === 0 || q.rankOfExpected > 3,
      );
      expect({
        failed: failed.map(
          (q) => `${q.query} → rank ${q.rankOfExpected}, top=${q.topEntityRef}`,
        ),
      }).toEqual({ failed: [] });
    },
    1_800_000, // 30 min — seeding 2k+ setup steps is slow without LLM batching
  );
});
