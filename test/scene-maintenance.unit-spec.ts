/**
 * Unit coverage for the scheduled scene-maintenance pass
 * (src/admin/scene-maintenance.service.ts, SCENES_SCHEDULED_MAINTENANCE):
 * the default-off pin (no roster read, no query, no mark), the reentrancy
 * guard (a slow night never overlaps the next firing), per-tenant error
 * isolation across the roster, both budget fences (per-tenant conversation
 * cap + whole-run wall clock), and the dirty-mark clear contract (cleared
 * for conversations that swapped, KEPT for the ones the composer skipped).
 *
 * Collaborators are stubbed positionally — no Nest DI, no Surreal, and no
 * paid call anywhere: the composer and the belief promoter are plain fakes.
 */
import { SceneMaintenanceService } from '../src/admin/scene-maintenance.service';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { SceneComposerService, SceneRunResult } from '../src/admin/scene-composer.service';
import type {
  BeliefPromotionService,
  BeliefPromotionResult,
} from '../src/admin/belief-promotion.service';
import type { MetricsService } from '../src/metrics/metrics.service';
import { emptyBatchOutcome, foldBatchOutcome } from '../src/common/batch-outcome';

const FLAGS = [
  'SCENES_SEGMENTATION_ENABLED',
  'SCENES_SCHEDULED_MAINTENANCE',
  'SCENES_BELIEF_PROMOTION',
  'SCENES_MAINTENANCE_MAX_CONVERSATIONS',
  'SCENES_MAINTENANCE_TIME_BUDGET_MS',
] as const;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of FLAGS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SCENES_SEGMENTATION_ENABLED = '1';
  process.env.SCENES_SCHEDULED_MAINTENANCE = '1';
});
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** One tenant's fake dirty table, addressed the way the real one is. */
interface FakeTenant {
  dirty: string[];
  /** Cleared ids, in clear order — the assertion surface for the marks. */
  cleared: string[];
  /** Selection limits the pass asked for, one per read. */
  limits: number[];
  throws?: string;
}

function makeSurreal(tenants: Record<string, FakeTenant>): {
  surreal: SurrealService;
  companies: string[];
} {
  const companies: string[] = [];
  const surreal = {
    withCompany: async <T>(companyId: string, fn: (db: unknown) => Promise<T>) => {
      companies.push(companyId);
      const t = tenants[companyId];
      if (!t) throw new Error(`no fake tenant ${companyId}`);
      if (t.throws) throw new Error(t.throws);
      const db = {
        query: async <R>(sql: string, params?: Record<string, unknown>): Promise<R> => {
          if (sql.includes('SELECT id, conversationId')) {
            const limit = Number(params?.limit ?? 0);
            t.limits.push(limit);
            const page = t.dirty.slice(0, limit).map((conversationId) => ({
              id: `scene_dirty_conversation:['${conversationId}']`,
              conversationId,
              markedAt: '2026-03-01T00:00:00.000Z',
            }));
            return [page] as unknown as R;
          }
          if (sql.includes('SELECT VALUE id FROM scene_dirty_conversation')) {
            // The race fence resolves to "everything asked for" here; the
            // fence itself is exercised in the e2e against a real server.
            return [params?.ids ?? []] as unknown as R;
          }
          if (sql.includes('DELETE scene_dirty_conversation')) {
            t.cleared.push(...((params?.doomed as string[]) ?? []));
            return [[]] as unknown as R;
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
      };
      return fn(db);
    },
  } as unknown as SurrealService;
  return { surreal, companies };
}

function makeApiKeys(ids: string[]): ApiKeyService {
  return { knownCompanyIds: () => ids } as unknown as ApiKeyService;
}

function makeComposer(
  impl: (companyId: string, opts: { conversationIds?: string[] }) => Promise<SceneRunResult>,
): { composer: SceneComposerService; calls: Array<{ companyId: string; ids?: string[] }> } {
  const calls: Array<{ companyId: string; ids?: string[] }> = [];
  const composer = {
    run: async (companyId: string, opts: { conversationIds?: string[] } = {}) => {
      calls.push({ companyId, ...(opts.conversationIds ? { ids: opts.conversationIds } : {}) });
      return impl(companyId, opts);
    },
  } as unknown as SceneComposerService;
  return { composer, calls };
}

/** A composer result whose outcome is folded from its counters, like the real one. */
const composed = (over: Partial<SceneRunResult> = {}): SceneRunResult => {
  const base = { conversations: 0, scenes: 0, skipped: [], ...over };
  return {
    ...base,
    outcome:
      over.outcome ??
      foldBatchOutcome({
        total: base.conversations + base.skipped.length,
        succeeded: base.conversations,
        failed: base.skipped.map((s) => ({ key: s.conversationId, error: s.reason })),
      }),
  };
};

function makeBeliefs(result?: Partial<BeliefPromotionResult>, throws?: string) {
  const calls: string[] = [];
  const beliefs = {
    run: async (companyId: string) => {
      calls.push(companyId);
      if (throws) throw new Error(throws);
      return {
        scenes: 0,
        eligibleScenes: 0,
        skippedMixedUser: 0,
        skippedConflict: 0,
        fieldFolds: 0,
        fieldFoldAmbiguous: 0,
        fieldOrphansAbsorbed: 0,
        fieldOrphanAmbiguous: 0,
        skippedFloor: 0,
        skippedStale: 0,
        beliefsCreated: 0,
        beliefsCorroborated: 0,
        beliefsRevised: 0,
        supportEdges: 0,
        ...result,
      } as BeliefPromotionResult;
    },
  } as unknown as BeliefPromotionService;
  return { beliefs, calls };
}

function makeMetrics() {
  const metrics = {
    countSceneMaintenance: jest.fn(),
    countSceneMaintenanceEmitted: jest.fn(),
    observeSceneMaintenanceDuration: jest.fn(),
  };
  return { metrics: metrics as unknown as MetricsService, spy: metrics };
}

describe('SceneMaintenanceService — flag gate', () => {
  it('PIN: with SCENES_SCHEDULED_MAINTENANCE off the cron does nothing at all', async () => {
    delete process.env.SCENES_SCHEDULED_MAINTENANCE;
    const roster = jest.fn(() => ['co_a']);
    const { composer, calls } = makeComposer(async () => composed());
    const svc = new SceneMaintenanceService(
      makeSurreal({}).surreal,
      { knownCompanyIds: roster } as unknown as ApiKeyService,
      composer,
      makeBeliefs().beliefs,
    );
    await expect(svc.runNightly()).resolves.toEqual({
      tenants: [],
      budgetExhausted: false,
      skippedForBudget: 0,
      outcome: emptyBatchOutcome(),
    });
    expect(roster).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('PIN: the scenes MASTER flag off also stops the pass (no orphan marks)', async () => {
    delete process.env.SCENES_SEGMENTATION_ENABLED;
    const roster = jest.fn(() => ['co_a']);
    const svc = new SceneMaintenanceService(
      makeSurreal({}).surreal,
      { knownCompanyIds: roster } as unknown as ApiKeyService,
      makeComposer(async () => composed()).composer,
      makeBeliefs().beliefs,
    );
    await svc.runNightly();
    expect(roster).not.toHaveBeenCalled();
  });
});

describe('SceneMaintenanceService — reentrancy guard', () => {
  it('a second firing while the first is in flight is a no-op', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tenants = { co_a: { dirty: ['c1'], cleared: [], limits: [] } };
    const { composer, calls } = makeComposer(async () => {
      await gate;
      return composed({ conversations: 1, scenes: 2 });
    });
    const svc = new SceneMaintenanceService(
      makeSurreal(tenants).surreal,
      makeApiKeys(['co_a']),
      composer,
      makeBeliefs().beliefs,
    );
    const first = svc.runNightly();
    const second = await svc.runNightly();
    // The overlapping tick returns the empty summary, not a partial run.
    expect(second.tenants).toHaveLength(0);
    release();
    const done = await first;
    expect(done.tenants).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('the guard releases: the NEXT night runs normally', async () => {
    const tenants = { co_a: { dirty: ['c1'], cleared: [], limits: [] } };
    const { composer, calls } = makeComposer(async () => composed({ conversations: 1, scenes: 1 }));
    const svc = new SceneMaintenanceService(
      makeSurreal(tenants).surreal,
      makeApiKeys(['co_a']),
      composer,
      makeBeliefs().beliefs,
    );
    await svc.runNightly();
    await svc.runNightly();
    expect(calls).toHaveLength(2);
  });
});

describe('SceneMaintenanceService — roster isolation', () => {
  it('one failing tenant does not abort the roster', async () => {
    const tenants: Record<string, FakeTenant> = {
      co_a: { dirty: ['a1'], cleared: [], limits: [] },
      co_b: { dirty: [], cleared: [], limits: [], throws: 'surreal down' },
      co_c: { dirty: ['c1'], cleared: [], limits: [] },
    };
    const { composer, calls } = makeComposer(async () => composed({ conversations: 1, scenes: 3 }));
    const { metrics, spy } = makeMetrics();
    const svc = new SceneMaintenanceService(
      makeSurreal(tenants).surreal,
      makeApiKeys(['co_a', 'co_b', 'co_c']),
      composer,
      makeBeliefs().beliefs,
      metrics,
    );
    const run = await svc.runAll();
    expect(run.tenants.map((t) => t.companyId)).toEqual(['co_a', 'co_b', 'co_c']);
    expect(run.tenants[1]!.error).toBe('surreal down');
    expect(run.tenants[1]!.scenes).toBe(0);
    // The tenants either side of the failure both ran to completion.
    expect(calls.map((c) => c.companyId)).toEqual(['co_a', 'co_c']);
    expect(run.tenants[0]!.scenes).toBe(3);
    expect(run.tenants[2]!.scenes).toBe(3);
    expect(spy.countSceneMaintenance).toHaveBeenCalledWith('failed');
    expect(spy.countSceneMaintenance).toHaveBeenCalledWith('ok');
    // The failing tenant keeps every mark it had.
    expect(tenants.co_b!.cleared).toEqual([]);
  });

  it('a tenant with nothing dirty is skipped without composing', async () => {
    const tenants: Record<string, FakeTenant> = {
      co_quiet: { dirty: [], cleared: [], limits: [] },
    };
    const { composer, calls } = makeComposer(async () => composed());
    const { metrics, spy } = makeMetrics();
    const svc = new SceneMaintenanceService(
      makeSurreal(tenants).surreal,
      makeApiKeys(['co_quiet']),
      composer,
      makeBeliefs().beliefs,
      metrics,
    );
    const run = await svc.runAll();
    expect(calls).toHaveLength(0);
    expect(run.tenants[0]).toMatchObject({ dirty: 0, conversations: 0, scenes: 0, cleared: 0 });
    expect(spy.countSceneMaintenance).toHaveBeenCalledWith('skipped_no_dirty');
  });
});

describe('SceneMaintenanceService — budgets', () => {
  it('caps the dirty page at SCENES_MAINTENANCE_MAX_CONVERSATIONS', async () => {
    process.env.SCENES_MAINTENANCE_MAX_CONVERSATIONS = '2';
    const tenants: Record<string, FakeTenant> = {
      co_big: { dirty: ['c1', 'c2', 'c3', 'c4', 'c5'], cleared: [], limits: [] },
    };
    const { composer, calls } = makeComposer(async (_c, opts) =>
      composed({ conversations: opts.conversationIds?.length ?? 0, scenes: 4 }),
    );
    const svc = new SceneMaintenanceService(
      makeSurreal(tenants).surreal,
      makeApiKeys(['co_big']),
      composer,
      makeBeliefs().beliefs,
    );
    const run = await svc.runAll();
    expect(tenants.co_big!.limits).toEqual([2]);
    expect(calls[0]!.ids).toEqual(['c1', 'c2']);
    expect(run.tenants[0]!.dirty).toBe(2);
    // The rest of the backlog is still marked — it drains tomorrow.
    expect(tenants.co_big!.cleared).toEqual([
      "scene_dirty_conversation:['c1']",
      "scene_dirty_conversation:['c2']",
    ]);
  });

  it('the default cap applies when the knob is unset or nonsense', async () => {
    for (const raw of [undefined, '', 'lots', '0', '-3']) {
      const tenants: Record<string, FakeTenant> = {
        co_a: { dirty: [], cleared: [], limits: [] },
      };
      if (raw === undefined) delete process.env.SCENES_MAINTENANCE_MAX_CONVERSATIONS;
      else process.env.SCENES_MAINTENANCE_MAX_CONVERSATIONS = raw;
      const svc = new SceneMaintenanceService(
        makeSurreal(tenants).surreal,
        makeApiKeys(['co_a']),
        makeComposer(async () => composed()).composer,
        makeBeliefs().beliefs,
      );
      await svc.runAll();
      expect(tenants.co_a!.limits).toEqual([200]);
    }
  });

  it('the wall-clock budget stops the roster from starting new tenants', async () => {
    // A budget already spent by the time the first tenant would start.
    process.env.SCENES_MAINTENANCE_TIME_BUDGET_MS = '1';
    const tenants: Record<string, FakeTenant> = {
      co_a: { dirty: ['a1'], cleared: [], limits: [] },
      co_b: { dirty: ['b1'], cleared: [], limits: [] },
    };
    const { composer, calls } = makeComposer(async () => composed({ conversations: 1 }));
    const { metrics, spy } = makeMetrics();
    const svc = new SceneMaintenanceService(
      makeSurreal(tenants).surreal,
      makeApiKeys(['co_a', 'co_b']),
      composer,
      makeBeliefs().beliefs,
      metrics,
    );
    const now = jest.spyOn(Date, 'now');
    // startedAt, then a deadline check per tenant — both already past.
    now.mockReturnValueOnce(1_000).mockReturnValue(1_000_000);
    const run = await svc.runAll();
    now.mockRestore();
    expect(calls).toHaveLength(0);
    expect(run.budgetExhausted).toBe(true);
    expect(run.skippedForBudget).toBe(2);
    expect(spy.countSceneMaintenance).toHaveBeenCalledWith('skipped_budget');
    // Nothing composed ⇒ nothing cleared: the marks all survive.
    expect(tenants.co_a!.cleared).toEqual([]);
    expect(tenants.co_b!.cleared).toEqual([]);
  });
});

describe('SceneMaintenanceService — dirty-mark lifecycle', () => {
  it('clears the marks that swapped and KEEPS the ones the composer skipped', async () => {
    const tenants: Record<string, FakeTenant> = {
      co_a: { dirty: ['ok1', 'bad', 'ok2'], cleared: [], limits: [] },
    };
    const { composer } = makeComposer(async () =>
      composed({
        conversations: 2,
        scenes: 5,
        skipped: [{ conversationId: 'bad', reason: 'turn read failed' }],
      }),
    );
    const svc = new SceneMaintenanceService(
      makeSurreal(tenants).surreal,
      makeApiKeys(['co_a']),
      composer,
      makeBeliefs().beliefs,
    );
    const run = await svc.runAll();
    expect(tenants.co_a!.cleared).toEqual([
      "scene_dirty_conversation:['ok1']",
      "scene_dirty_conversation:['ok2']",
    ]);
    expect(run.tenants[0]!.cleared).toBe(2);
    expect(run.tenants[0]!.dirty).toBe(3);
  });

  it('a compose that skipped EVERYTHING clears nothing', async () => {
    const tenants: Record<string, FakeTenant> = {
      co_a: { dirty: ['x'], cleared: [], limits: [] },
    };
    const { composer } = makeComposer(async () =>
      composed({ skipped: [{ conversationId: 'x', reason: 'boom' }] }),
    );
    const svc = new SceneMaintenanceService(
      makeSurreal(tenants).surreal,
      makeApiKeys(['co_a']),
      composer,
      makeBeliefs().beliefs,
    );
    const run = await svc.runAll();
    expect(tenants.co_a!.cleared).toEqual([]);
    expect(run.tenants[0]!.cleared).toBe(0);
  });
});

describe('SceneMaintenanceService — belief promotion leg', () => {
  it('runs only when SCENES_BELIEF_PROMOTION is on, and counts the upserts', async () => {
    const tenants: Record<string, FakeTenant> = {
      co_a: { dirty: ['c1'], cleared: [], limits: [] },
    };
    const off = makeBeliefs();
    const svcOff = new SceneMaintenanceService(
      makeSurreal(tenants).surreal,
      makeApiKeys(['co_a']),
      makeComposer(async () => composed({ conversations: 1 })).composer,
      off.beliefs,
    );
    await svcOff.runAll();
    expect(off.calls).toHaveLength(0);

    process.env.SCENES_BELIEF_PROMOTION = '1';
    const on = makeBeliefs({ beliefsCreated: 2, beliefsRevised: 1, beliefsCorroborated: 4 });
    const tenants2: Record<string, FakeTenant> = {
      co_a: { dirty: ['c1'], cleared: [], limits: [] },
    };
    const svcOn = new SceneMaintenanceService(
      makeSurreal(tenants2).surreal,
      makeApiKeys(['co_a']),
      makeComposer(async () => composed({ conversations: 1 })).composer,
      on.beliefs,
    );
    const run = await svcOn.runAll();
    expect(on.calls).toEqual(['co_a']);
    expect(run.tenants[0]!.beliefs).toBe(7);
  });

  it('a failing promotion degrades — the swap still counts and the marks clear', async () => {
    process.env.SCENES_BELIEF_PROMOTION = '1';
    const tenants: Record<string, FakeTenant> = {
      co_a: { dirty: ['c1'], cleared: [], limits: [] },
    };
    const { beliefs } = makeBeliefs(undefined, 'promotion exploded');
    const svc = new SceneMaintenanceService(
      makeSurreal(tenants).surreal,
      makeApiKeys(['co_a']),
      makeComposer(async () => composed({ conversations: 1, scenes: 2 })).composer,
      beliefs,
    );
    const run = await svc.runAll();
    expect(run.tenants[0]!.error).toBeUndefined();
    expect(run.tenants[0]!.scenes).toBe(2);
    expect(run.tenants[0]!.beliefs).toBe(0);
    expect(tenants.co_a!.cleared).toHaveLength(1);
  });
});

describe('SceneMaintenanceService — metrics', () => {
  it('emits the artefact counters and the per-tenant duration', async () => {
    const tenants: Record<string, FakeTenant> = {
      co_a: { dirty: ['c1', 'c2'], cleared: [], limits: [] },
    };
    const { metrics, spy } = makeMetrics();
    const svc = new SceneMaintenanceService(
      makeSurreal(tenants).surreal,
      makeApiKeys(['co_a']),
      makeComposer(async () => composed({ conversations: 2, scenes: 6, enriched: 5 })).composer,
      makeBeliefs().beliefs,
      metrics,
    );
    await svc.runAll();
    expect(spy.countSceneMaintenanceEmitted).toHaveBeenCalledWith('conversation', 2);
    expect(spy.countSceneMaintenanceEmitted).toHaveBeenCalledWith('scene', 6);
    expect(spy.countSceneMaintenanceEmitted).toHaveBeenCalledWith('enriched', 5);
    expect(spy.countSceneMaintenanceEmitted).toHaveBeenCalledWith('dirty_cleared', 2);
    expect(spy.observeSceneMaintenanceDuration).toHaveBeenCalledTimes(1);
  });
});
