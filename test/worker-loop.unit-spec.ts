/**
 * Unit coverage for WorkerLoopService — the leader-elected polling
 * loop that drains the job_run queue. We assert:
 *
 *   - register() collects handlers
 *   - dispatch routes return-value to complete(), thrown to fail()
 *   - dispatch routes thrown-after-cancelRequest to cancelled()
 *   - dispatch routes thrown-after-lost-claim to neither (skip write)
 *   - renew tick polls cancelRequested + propagates into AbortSignal
 *   - onApplicationShutdown aborts in-flight handlers
 *
 * The polling loop itself is exercised indirectly — we drive
 * dispatch() through the private path via a thin test harness that
 * doesn't require a real LeaderLease or the lease-acquire cron.
 */
import { ConfigService } from '@nestjs/config';
import { WorkerLoopService } from '../src/jobs/worker-loop.service';
import type { JobClaim } from '../src/jobs/job-claim.service';
import type { JobType } from '../src/jobs/job-run.service';

function makeConfig(env: Record<string, string | undefined> = {}): ConfigService {
  return {
    get: <T>(key: string, dflt?: T) => (env[key] ?? dflt) as T,
    getOrThrow: <T>(key: string) => env[key] as unknown as T,
  } as unknown as ConfigService;
}

function makeClaimSvc(opts: {
  renewSequence?: Array<{ stillOwned: boolean; cancelRequested: boolean }>;
} = {}) {
  const calls = {
    completed: [] as Array<{ recordId: string; result?: unknown }>,
    failed: [] as Array<{ recordId: string; attempts: number; error: unknown }>,
    cancelled: [] as Array<{ recordId: string; result?: unknown }>,
    renewed: [] as Array<{ recordId: string }>,
  };
  let renewIdx = 0;
  return {
    calls,
    identity: () => 'host-test#42',
    claimNext: jest.fn(),
    renew: jest.fn(async (input: { recordId: string }) => {
      calls.renewed.push({ recordId: input.recordId });
      const seq = opts.renewSequence ?? [];
      return (
        seq[renewIdx++] ?? { stillOwned: true, cancelRequested: false }
      );
    }),
    complete: jest.fn(async (input: { recordId: string; result?: unknown }) => {
      calls.completed.push({ recordId: input.recordId, result: input.result });
    }),
    fail: jest.fn(
      async (input: {
        recordId: string;
        attempts: number;
        error: unknown;
      }) => {
        calls.failed.push({
          recordId: input.recordId,
          attempts: input.attempts,
          error: input.error,
        });
        return { requeued: true };
      },
    ),
    cancelled: jest.fn(async (input: { recordId: string; result?: unknown }) => {
      calls.cancelled.push({
        recordId: input.recordId,
        result: input.result,
      });
    }),
    enqueue: jest.fn(),
    reapZombies: jest.fn(),
    listActiveClaims: jest.fn(),
  };
}

function makeJobClaim(opts: {
  recordId?: string;
  runId?: string;
  jobType?: JobType;
  companyId?: string;
  attempts?: number;
  payload?: Record<string, unknown> | null;
} = {}): JobClaim {
  return {
    recordId: opts.recordId ?? 'job_run:abc',
    runId: opts.runId ?? 'run-uuid-1',
    jobType: opts.jobType ?? 'dreams',
    companyId: opts.companyId ?? 'co_x',
    attempts: opts.attempts ?? 1,
    payload: opts.payload ?? null,
    leaseUntil: '2030-01-01T00:05:00Z',
  };
}

// We need to reach the private dispatch() method from tests because
// the full polling loop is hard to drive deterministically with real
// timers. Cast to any to grant access — this is unit-level coverage
// of the dispatch contract.
function callDispatch(svc: WorkerLoopService, claim: JobClaim, reg: any) {
  return (svc as any).dispatch(claim, reg);
}

describe('WorkerLoopService.register', () => {
  it('collects handlers by jobType and exposes registeredTypes()', () => {
    const svc = new WorkerLoopService(makeConfig());
    svc.register('dreams', async () => ({}));
    svc.register('compaction', async () => ({}));
    expect(svc.registeredTypes()).toEqual(
      expect.arrayContaining(['dreams', 'compaction']),
    );
    expect(svc.registeredTypes()).toHaveLength(2);
  });
});

describe('WorkerLoopService.dispatch', () => {
  it('routes a successful handler result to complete()', async () => {
    const claim = makeJobClaim();
    const claimSvc = makeClaimSvc();
    const svc = new WorkerLoopService(
      makeConfig(),
      claimSvc as any,
    );
    const reg = {
      jobType: 'dreams' as JobType,
      handler: async () => ({ ok: true }),
      ttlSeconds: 3,
      maxAttempts: 3,
    };
    await callDispatch(svc, claim, reg);
    expect(claimSvc.calls.completed).toHaveLength(1);
    expect(claimSvc.calls.completed[0].recordId).toBe('job_run:abc');
    expect(claimSvc.calls.completed[0].result).toEqual({ ok: true });
    expect(claimSvc.calls.failed).toHaveLength(0);
  });

  it('routes a thrown handler error to fail()', async () => {
    const claim = makeJobClaim({ attempts: 2 });
    const claimSvc = makeClaimSvc();
    const svc = new WorkerLoopService(makeConfig(), claimSvc as any);
    const reg = {
      jobType: 'dreams' as JobType,
      handler: async () => {
        throw new Error('handler boom');
      },
      ttlSeconds: 3,
      maxAttempts: 3,
    };
    await callDispatch(svc, claim, reg);
    expect(claimSvc.calls.failed).toHaveLength(1);
    expect(claimSvc.calls.failed[0].attempts).toBe(2);
    expect((claimSvc.calls.failed[0].error as Error).message).toBe(
      'handler boom',
    );
  });

  it('routes cancel-requested → cancelled() not failed()', async () => {
    const claim = makeJobClaim();
    // First renew tick reports cancelRequested=true; this should
    // propagate into the handler's AbortSignal and route the throw
    // to cancelled() instead of fail().
    const claimSvc = makeClaimSvc({
      renewSequence: [{ stillOwned: true, cancelRequested: true }],
    });
    const svc = new WorkerLoopService(makeConfig(), claimSvc as any);
    let sawAbort = false;
    const reg = {
      jobType: 'dreams' as JobType,
      handler: async (ctx: any) => {
        await new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          });
          // Allow the renew interval to fire.
        });
        throw new Error('aborted');
      },
      ttlSeconds: 1, // → renew tick every ttl/3 = 333ms
      maxAttempts: 3,
    };
    await callDispatch(svc, claim, reg);
    expect(sawAbort).toBe(true);
    expect(claimSvc.calls.cancelled).toHaveLength(1);
    expect(claimSvc.calls.failed).toHaveLength(0);
    expect(claimSvc.calls.completed).toHaveLength(0);
  });

  it('skips terminal write when claim is lost mid-handler', async () => {
    const claim = makeJobClaim();
    // Renew reports stillOwned=false — zombie reaper took the row.
    const claimSvc = makeClaimSvc({
      renewSequence: [{ stillOwned: false, cancelRequested: false }],
    });
    const svc = new WorkerLoopService(makeConfig(), claimSvc as any);
    const reg = {
      jobType: 'dreams' as JobType,
      handler: async (ctx: any) => {
        await new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener('abort', resolve);
        });
        throw new Error('aborted by zombie reap');
      },
      ttlSeconds: 1,
      maxAttempts: 3,
    };
    await callDispatch(svc, claim, reg);
    // We should not have written complete, fail, OR cancelled — the
    // new owner does that.
    expect(claimSvc.calls.completed).toHaveLength(0);
    expect(claimSvc.calls.failed).toHaveLength(0);
    expect(claimSvc.calls.cancelled).toHaveLength(0);
  });

  it('completed handler receives a workerId in ctx', async () => {
    const claim = makeJobClaim();
    const claimSvc = makeClaimSvc();
    const svc = new WorkerLoopService(makeConfig(), claimSvc as any);
    let observedWorkerId = '';
    const reg = {
      jobType: 'dreams' as JobType,
      handler: async (ctx: any) => {
        observedWorkerId = ctx.workerId;
        return { ok: true };
      },
      ttlSeconds: 3,
      maxAttempts: 3,
    };
    await callDispatch(svc, claim, reg);
    expect(observedWorkerId).toBe('host-test#42');
  });
});

describe('WorkerLoopService.onApplicationShutdown', () => {
  it('aborts in-flight handlers', async () => {
    const claim = makeJobClaim();
    const claimSvc = makeClaimSvc();
    const svc = new WorkerLoopService(makeConfig(), claimSvc as any);
    let sawAbort = false;
    const reg = {
      jobType: 'dreams' as JobType,
      handler: async (ctx: any) => {
        await new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          });
        });
        return { ok: true };
      },
      ttlSeconds: 3,
      maxAttempts: 3,
    };
    const dispatched = callDispatch(svc, claim, reg);
    // Trigger shutdown — the dispatch's onShutdown listener aborts.
    setTimeout(() => void svc.onApplicationShutdown(), 5);
    await dispatched;
    expect(sawAbort).toBe(true);
  });
});

describe('WorkerLoopService.leader', () => {
  it('reports false until lease is acquired (default state)', () => {
    const svc = new WorkerLoopService(makeConfig());
    expect(svc.leader()).toBe(false);
  });
});
