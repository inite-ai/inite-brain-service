/**
 * Unit coverage for the worker-loop trio after the max-params split:
 *   - WorkerLoopService.register collects handlers
 *   - JobDispatcherService routes return-value→complete, thrown→fail,
 *     thrown-after-cancel→cancelled, thrown-after-lost-claim→neither
 *   - renew tick polls cancelRequested + propagates into AbortSignal
 *   - the shutdown AbortSignal aborts in-flight handlers
 *   - WorkerPollerService.sampleByFairness weighting
 */
import { WorkerLoopService } from '../src/jobs/worker-loop.service';
import { WorkerPollerService } from '../src/jobs/worker-poller.service';
import { JobDispatcherService } from '../src/jobs/job-dispatcher.service';
import type { JobClaim } from '../src/jobs/job-claim.service';
import type { JobType } from '../src/jobs/job-run.service';

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
      return seq[renewIdx++] ?? { stillOwned: true, cancelRequested: false };
    }),
    complete: jest.fn(async (input: { recordId: string; result?: unknown }) => {
      calls.completed.push({ recordId: input.recordId, result: input.result });
    }),
    fail: jest.fn(
      async (input: { recordId: string; attempts: number; error: unknown }) => {
        calls.failed.push({
          recordId: input.recordId,
          attempts: input.attempts,
          error: input.error,
        });
        return { requeued: true };
      },
    ),
    cancelled: jest.fn(async (input: { recordId: string; result?: unknown }) => {
      calls.cancelled.push({ recordId: input.recordId, result: input.result });
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

function mkDispatcher(claimSvc: unknown, metrics?: unknown): JobDispatcherService {
  return new JobDispatcherService(
    claimSvc as never,
    undefined,
    metrics as never,
  );
}

function callDispatch(
  dispatcher: JobDispatcherService,
  claim: JobClaim,
  reg: any,
  signal: AbortSignal = new AbortController().signal,
) {
  return dispatcher.dispatch(claim, reg, signal);
}

describe('WorkerLoopService.register', () => {
  it('collects handlers by jobType and exposes registeredTypes()', () => {
    const svc = new WorkerLoopService(undefined as never);
    svc.register('dreams', async () => ({}));
    svc.register('compaction', async () => ({}));
    expect(svc.registeredTypes()).toEqual(
      expect.arrayContaining(['dreams', 'compaction']),
    );
    expect(svc.registeredTypes()).toHaveLength(2);
  });
});

describe('JobDispatcherService.dispatch', () => {
  it('routes a successful handler result to complete()', async () => {
    const claim = makeJobClaim();
    const claimSvc = makeClaimSvc();
    const reg = {
      jobType: 'dreams' as JobType,
      handler: async () => ({ ok: true }),
      ttlSeconds: 3,
      maxAttempts: 3,
    };
    await callDispatch(mkDispatcher(claimSvc), claim, reg);
    expect(claimSvc.calls.completed).toHaveLength(1);
    expect(claimSvc.calls.completed[0].recordId).toBe('job_run:abc');
    expect(claimSvc.calls.completed[0].result).toEqual({ ok: true });
    expect(claimSvc.calls.failed).toHaveLength(0);
  });

  it('records a job metric with the terminal outcome and a duration', async () => {
    const claim = makeJobClaim({ jobType: 'dreams' });
    const claimSvc = makeClaimSvc();
    const recordJob = jest.fn();
    await callDispatch(mkDispatcher(claimSvc, { recordJob }), claim, {
      jobType: 'dreams' as JobType,
      handler: async () => ({ ok: true }),
      ttlSeconds: 3,
      maxAttempts: 3,
    });
    expect(recordJob).toHaveBeenCalledTimes(1);
    const [jobType, outcome, seconds] = recordJob.mock.calls[0];
    expect(jobType).toBe('dreams');
    expect(outcome).toBe('succeeded');
    expect(typeof seconds).toBe('number');
    expect(seconds).toBeGreaterThanOrEqual(0);
  });

  it('routes a thrown handler error to fail()', async () => {
    const claim = makeJobClaim({ attempts: 2 });
    const claimSvc = makeClaimSvc();
    const reg = {
      jobType: 'dreams' as JobType,
      handler: async () => {
        throw new Error('handler boom');
      },
      ttlSeconds: 3,
      maxAttempts: 3,
    };
    await callDispatch(mkDispatcher(claimSvc), claim, reg);
    expect(claimSvc.calls.failed).toHaveLength(1);
    expect(claimSvc.calls.failed[0].attempts).toBe(2);
    expect((claimSvc.calls.failed[0].error as Error).message).toBe(
      'handler boom',
    );
  });

  it('routes cancel-requested → cancelled() not failed()', async () => {
    const claim = makeJobClaim();
    const claimSvc = makeClaimSvc({
      renewSequence: [{ stillOwned: true, cancelRequested: true }],
    });
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
        throw new Error('aborted');
      },
      ttlSeconds: 1, // → renew tick every ttl/3 = 333ms
      maxAttempts: 3,
    };
    await callDispatch(mkDispatcher(claimSvc), claim, reg);
    expect(sawAbort).toBe(true);
    expect(claimSvc.calls.cancelled).toHaveLength(1);
    expect(claimSvc.calls.failed).toHaveLength(0);
    expect(claimSvc.calls.completed).toHaveLength(0);
  });

  it('skips terminal write when claim is lost mid-handler', async () => {
    const claim = makeJobClaim();
    const claimSvc = makeClaimSvc({
      renewSequence: [{ stillOwned: false, cancelRequested: false }],
    });
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
    await callDispatch(mkDispatcher(claimSvc), claim, reg);
    expect(claimSvc.calls.completed).toHaveLength(0);
    expect(claimSvc.calls.failed).toHaveLength(0);
    expect(claimSvc.calls.cancelled).toHaveLength(0);
  });

  it('completed handler receives a workerId in ctx', async () => {
    const claim = makeJobClaim();
    const claimSvc = makeClaimSvc();
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
    await callDispatch(mkDispatcher(claimSvc), claim, reg);
    expect(observedWorkerId).toBe('host-test#42');
  });

  it('aborts in-flight handlers when the shutdown signal fires', async () => {
    const claim = makeJobClaim();
    const claimSvc = makeClaimSvc();
    const ac = new AbortController();
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
    const dispatched = callDispatch(mkDispatcher(claimSvc), claim, reg, ac.signal);
    setTimeout(() => ac.abort(), 5);
    await dispatched;
    expect(sawAbort).toBe(true);
  });
});

describe('WorkerLoopService.leader', () => {
  it('reports false until lease is acquired (default state)', () => {
    const svc = new WorkerLoopService(undefined as never);
    expect(svc.leader()).toBe(false);
  });
});

describe('WorkerPollerService.sampleByFairness', () => {
  it('returns single-element list unchanged', () => {
    const svc = new WorkerPollerService(undefined as never);
    expect(svc.sampleByFairness('dreams', ['co_only'])).toEqual(['co_only']);
  });

  it('returns empty list unchanged', () => {
    const svc = new WorkerPollerService(undefined as never);
    expect(svc.sampleByFairness('dreams', [])).toEqual([]);
  });

  it('all tenants get sampled exactly once (permutation)', () => {
    const svc = new WorkerPollerService(undefined as never);
    const tenants = ['a', 'b', 'c', 'd'];
    const out = svc.sampleByFairness('dreams', tenants);
    expect([...out].sort()).toEqual([...tenants].sort());
  });

  it('heavily-claimed tenants are sampled later on average', () => {
    const svc = new WorkerPollerService(undefined as never);
    const tenants = ['busy', 'quiet'];
    for (let i = 0; i < 32; i++) {
      (svc as any).recordClaim('dreams', 'busy');
    }
    let busyFirst = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      const out = svc.sampleByFairness('dreams', tenants);
      if (out[0] === 'busy') busyFirst++;
    }
    expect(busyFirst).toBeLessThan(trials * 0.4);
  });

  it('recentClaimsSnapshot reflects recordClaim writes', () => {
    const svc = new WorkerPollerService(undefined as never);
    (svc as any).recordClaim('dreams', 'co_a');
    (svc as any).recordClaim('dreams', 'co_a');
    (svc as any).recordClaim('compaction', 'co_b');
    const snap = svc.recentClaimsSnapshot();
    expect(snap['dreams::co_a']).toBe(2);
    expect(snap['compaction::co_b']).toBe(1);
  });

  it('recordClaim is bounded at 64', () => {
    const svc = new WorkerPollerService(undefined as never);
    for (let i = 0; i < 100; i++) {
      (svc as any).recordClaim('dreams', 'co_a');
    }
    expect(svc.recentClaimsSnapshot()['dreams::co_a']).toBe(64);
  });
});
