import { ConfigService } from '@nestjs/config';
import { DreamsService } from '../src/dreams/dreams.service';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { SurrealService } from '../src/db/surreal.service';
import type {
  DreamsDedupService,
  DedupResult,
} from '../src/dreams/dedup.service';
import type {
  DreamsResolverService,
  ResolverResult,
} from '../src/dreams/resolver.service';
import type { CompactionService } from '../src/compaction/compaction.service';

/**
 * Unit coverage for DreamsService orchestrator. The collaborators
 * are stubbed so we can verify branching logic (which ops fire,
 * what stats land, error containment) without spinning up Surreal
 * or hitting OpenAI.
 */
describe('DreamsService', () => {
  function makeConfig(env: Record<string, string | undefined>): ConfigService {
    return {
      get: <T>(key: string, dflt?: T) => (env[key] ?? dflt) as T,
      getOrThrow: <T>(key: string) => {
        const v = env[key];
        if (v === undefined) throw new Error(`missing ${key}`);
        return v as unknown as T;
      },
    } as unknown as ConfigService;
  }

  function makeApiKeys(ids: string[]): ApiKeyService {
    return {
      knownCompanyIds: () => ids,
    } as unknown as ApiKeyService;
  }

  function makeSurreal(): SurrealService {
    return {
      withCompany: async <T>(
        _companyId: string,
        fn: (db: unknown) => Promise<T>,
      ) => fn({}),
    } as unknown as SurrealService;
  }

  function makeDedup(opts: {
    enabled: boolean;
    result?: DedupResult;
    throws?: boolean;
  }): DreamsDedupService {
    return {
      isEnabled: () => opts.enabled,
      run: async () => {
        if (opts.throws) throw new Error('dedup boom');
        return (
          opts.result ?? {
            suspectsEvaluated: 0,
            llmJudgements: 0,
            identityLinksCreated: 0,
            unsurePairs: 0,
          }
        );
      },
    } as unknown as DreamsDedupService;
  }

  function makeResolver(opts: {
    enabled: boolean;
    result?: ResolverResult;
  }): DreamsResolverService {
    return {
      isEnabled: () => opts.enabled,
      run: async () =>
        opts.result ?? {
          pairsConsidered: 0,
          llmJudgements: 0,
          resolutionsApplied: 0,
          unsurePairs: 0,
        },
    } as unknown as DreamsResolverService;
  }

  function makeCompaction(throws = false): CompactionService {
    return {
      compactCompany: async () => {
        if (throws) throw new Error('compaction boom');
        return {
          companyId: 'co_x',
          factsCompacted: 0,
          summariesCreated: 0,
          bytesFreed: 0,
        };
      },
    } as unknown as CompactionService;
  }

  function makeMetrics(): {
    metrics: { countDreams: jest.Mock; countDreamsEmitted: jest.Mock };
  } {
    const metrics = {
      countDreams: jest.fn(),
      countDreamsEmitted: jest.fn(),
    };
    return { metrics };
  }

  it('default ops empty when nothing is enabled — cron is a no-op', async () => {
    const svc = new DreamsService(
      makeSurreal(),
      makeApiKeys(['co_a']),
      makeDedup({ enabled: false }),
      makeResolver({ enabled: false }),
      makeCompaction(),
      makeConfig({}),
    );
    const out = await svc.runForTenant('co_a', []);
    expect(out.dedup).toBeUndefined();
    expect(out.resolve).toBeUndefined();
    expect(out.summarized).toBeUndefined();
  });

  it('runs dedup when requested even if env-default is empty', async () => {
    const dedup = makeDedup({
      enabled: true,
      result: {
        suspectsEvaluated: 3,
        llmJudgements: 2,
        identityLinksCreated: 1,
        unsurePairs: 1,
      },
    });
    const { metrics } = makeMetrics();
    const svc = new DreamsService(
      makeSurreal(),
      makeApiKeys(['co_a']),
      dedup,
      makeResolver({ enabled: false }),
      makeCompaction(),
      makeConfig({}),
      metrics as never,
    );
    const out = await svc.runForTenant('co_a', ['dedup']);
    expect(out.dedup?.identityLinksCreated).toBe(1);
    expect(out.resolve).toBeUndefined();
    // Metric: identity_link emitted once.
    expect(metrics.countDreamsEmitted).toHaveBeenCalledWith('identity_link', 1);
    expect(metrics.countDreams).toHaveBeenCalledWith('ok');
  });

  it('runs resolve and reports resolution count to metrics', async () => {
    const { metrics } = makeMetrics();
    const svc = new DreamsService(
      makeSurreal(),
      makeApiKeys(['co_a']),
      makeDedup({ enabled: false }),
      makeResolver({
        enabled: true,
        result: {
          pairsConsidered: 5,
          llmJudgements: 5,
          resolutionsApplied: 3,
          unsurePairs: 2,
        },
      }),
      makeCompaction(),
      makeConfig({}),
      metrics as never,
    );
    const out = await svc.runForTenant('co_a', ['resolve']);
    expect(out.resolve?.resolutionsApplied).toBe(3);
    expect(metrics.countDreamsEmitted).toHaveBeenCalledWith('resolution', 3);
  });

  it('summarize delegates to compaction.compactCompany and reports success', async () => {
    const { metrics } = makeMetrics();
    const svc = new DreamsService(
      makeSurreal(),
      makeApiKeys(['co_a']),
      makeDedup({ enabled: false }),
      makeResolver({ enabled: false }),
      makeCompaction(false),
      makeConfig({}),
      metrics as never,
    );
    const out = await svc.runForTenant('co_a', ['summarize']);
    expect(out.summarized).toBe(true);
    expect(metrics.countDreamsEmitted).toHaveBeenCalledWith('summary', 1);
  });

  it('summarize failure does NOT throw — flagged as summarized=false', async () => {
    const svc = new DreamsService(
      makeSurreal(),
      makeApiKeys(['co_a']),
      makeDedup({ enabled: false }),
      makeResolver({ enabled: false }),
      makeCompaction(true),
      makeConfig({}),
    );
    const out = await svc.runForTenant('co_a', ['summarize']);
    expect(out.summarized).toBe(false);
  });

  it('runAll fans out across tenants and isolates errors', async () => {
    const { metrics } = makeMetrics();
    let callIdx = 0;
    const dedup = {
      isEnabled: () => true,
      run: async () => {
        callIdx++;
        if (callIdx === 2) throw new Error('only tenant b is sad');
        return {
          suspectsEvaluated: 0,
          llmJudgements: 0,
          identityLinksCreated: 0,
          unsurePairs: 0,
        };
      },
    } as unknown as DreamsDedupService;
    const svc = new DreamsService(
      makeSurreal(),
      makeApiKeys(['co_a', 'co_b', 'co_c']),
      dedup,
      makeResolver({ enabled: false }),
      makeCompaction(),
      makeConfig({}),
      metrics as never,
    );
    const out = await svc.runAll(['dedup']);
    expect(out).toHaveLength(3);
    expect(out[0].error).toBeUndefined();
    expect(out[1].error).toMatch(/only tenant b is sad/);
    expect(out[2].error).toBeUndefined();
    // ok should fire for the two healthy tenants, failed for the bad one.
    const okCount = (
      metrics.countDreams as jest.Mock
    ).mock.calls.filter((c) => c[0] === 'ok').length;
    const failedCount = (
      metrics.countDreams as jest.Mock
    ).mock.calls.filter((c) => c[0] === 'failed').length;
    expect(okCount).toBe(2);
    expect(failedCount).toBe(1);
  });

  it('runDaily is a no-op when DREAMS_ENABLED!=1 even with sub-services on', async () => {
    const { metrics } = makeMetrics();
    const svc = new DreamsService(
      makeSurreal(),
      makeApiKeys(['co_a']),
      makeDedup({
        enabled: true,
        result: {
          suspectsEvaluated: 1,
          llmJudgements: 1,
          identityLinksCreated: 1,
          unsurePairs: 0,
        },
      }),
      makeResolver({ enabled: false }),
      makeCompaction(),
      makeConfig({} /* DREAMS_ENABLED unset → '0' */),
      metrics as never,
    );
    const out = await svc.runDaily();
    expect(out).toEqual([]);
    expect(metrics.countDreams).not.toHaveBeenCalled();
  });

  it('runDaily fires when DREAMS_ENABLED=1 and runs the env-default ops', async () => {
    const { metrics } = makeMetrics();
    const dedup = makeDedup({
      enabled: true,
      result: {
        suspectsEvaluated: 0,
        llmJudgements: 0,
        identityLinksCreated: 2,
        unsurePairs: 0,
      },
    });
    const svc = new DreamsService(
      makeSurreal(),
      makeApiKeys(['co_a']),
      dedup,
      makeResolver({ enabled: false }),
      makeCompaction(),
      makeConfig({ DREAMS_ENABLED: '1' }),
      metrics as never,
    );
    const out = await svc.runDaily();
    expect(out).toHaveLength(1);
    expect(out[0].dedup?.identityLinksCreated).toBe(2);
  });
});
