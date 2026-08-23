/**
 * Bounded per-jobType poller concurrency (WorkerPollerService.runLoop):
 *   1. default env → strictly serial: no second claim while a dispatch
 *      is in flight (the original code path, byte-identical);
 *   2. per-type max 2, two tenants → two dispatches in flight at once;
 *   3. per-type max 2, ONE tenant at the default tenant cap 1 → the
 *      second slot stays empty (no claim attempts for a capped tenant),
 *      and frees up when the in-flight dispatch resolves;
 *   4. global cap 1 across two jobTypes on the shared service instance
 *      → one dispatch in flight process-wide;
 *   5. abort mid-flight → the loop drains in-flight dispatches before
 *      resolving, and handlers observe the shutdown abort.
 */
import { WorkerPollerService } from '../src/jobs/worker-poller.service';
import { JobDispatcherService } from '../src/jobs/job-dispatcher.service';
import type { JobClaim } from '../src/jobs/job-claim.service';
import type { JobType } from '../src/jobs/job-run.service';
import type {
  PollControl,
  RegisteredHandler,
} from '../src/jobs/worker-loop.types';

const ENV_KEYS = [
  'WORKER_LOOP_POLL_MS',
  'WORKER_LOOP_EMPTY_BACKOFF_MS',
  'WORKER_LOOP_MAX_CONCURRENT',
  'WORKER_LOOP_MAX_CONCURRENT_DREAMS',
  'WORKER_LOOP_TENANT_MAX_CONCURRENT',
  'WORKER_LOOP_GLOBAL_MAX_CONCURRENT',
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Tight cadences so the loops cycle fast under real timers.
  process.env.WORKER_LOOP_POLL_MS = '5';
  process.env.WORKER_LOOP_EMPTY_BACKOFF_MS = '5';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeReg(jobType: JobType = 'dreams'): RegisteredHandler {
  return {
    jobType,
    handler: async () => ({}),
    ttlSeconds: 3,
    maxAttempts: 3,
  };
}

function makeControl(): { control: PollControl; abort: () => void } {
  const ac = new AbortController();
  return {
    control: { isLeader: () => true, signal: ac.signal },
    abort: () => ac.abort(),
  };
}

/**
 * Dispatcher stub that parks every dispatch on a deferred so the test
 * controls exactly when each "job" finishes.
 */
function makeParkedDispatcher() {
  const parked: Array<{ claim: JobClaim; release: () => void }> = [];
  const dispatch = jest.fn(
    (claim: JobClaim) =>
      new Promise<void>((resolve) => {
        parked.push({ claim, release: resolve });
      }),
  );
  const releaseAll = () => {
    for (const p of parked) p.release();
  };
  return { dispatcher: { dispatch } as never, dispatch, parked, releaseAll };
}

/**
 * Claim-service stub backed by fixed per-(jobType, tenant) job counts.
 * claimNext consumes one job per call; null once a bucket is empty.
 */
function makeQueue(jobs: Record<string, number>) {
  const counts = { ...jobs };
  let seq = 0;
  const claimNext = jest.fn(
    async (input: { companyId: string; jobType: JobType }) => {
      const key = `${input.jobType}::${input.companyId}`;
      if ((counts[key] ?? 0) <= 0) return null;
      counts[key] = (counts[key] ?? 0) - 1;
      seq += 1;
      return {
        recordId: `job_run:${seq}`,
        runId: `run-${seq}`,
        jobType: input.jobType,
        companyId: input.companyId,
        attempts: 1,
        payload: null,
        leaseUntil: '2030-01-01T00:05:00Z',
      } as JobClaim;
    },
  );
  return { claimNext };
}

function makeApiKeys(companyIds: string[]) {
  return { knownCompanyIds: () => companyIds };
}

function makePoller(args: {
  dispatcher: unknown;
  claimSvc: unknown;
  tenants: string[];
}): WorkerPollerService {
  return new WorkerPollerService(
    args.dispatcher as never,
    args.claimSvc as never,
    makeApiKeys(args.tenants) as never,
  );
}

describe('WorkerPollerService.runLoop — default env stays serial', () => {
  it('does not attempt a second claim until the first dispatch resolves', async () => {
    const { dispatcher, dispatch, parked, releaseAll } = makeParkedDispatcher();
    const claimSvc = makeQueue({ 'dreams::co_a': 2 });
    const poller = makePoller({ dispatcher, claimSvc, tenants: ['co_a'] });
    const { control, abort } = makeControl();

    const loop = poller.runLoop(makeReg(), control);
    await settle();
    // First job claimed and dispatched; the serial loop is parked on the
    // awaited dispatch, so no further claim attempt happened.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(claimSvc.claimNext).toHaveBeenCalledTimes(1);

    parked[0]!.release();
    await settle();
    // Dispatch resolved → the loop went around and claimed the second job.
    expect(claimSvc.claimNext.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(dispatch).toHaveBeenCalledTimes(2);

    abort();
    releaseAll();
    await loop;
  });
});

describe('WorkerPollerService.runLoop — per-jobType concurrency', () => {
  it('max=2 with two tenants keeps two dispatches in flight concurrently', async () => {
    process.env.WORKER_LOOP_MAX_CONCURRENT_DREAMS = '2';
    const { dispatcher, dispatch, parked, releaseAll } = makeParkedDispatcher();
    const claimSvc = makeQueue({ 'dreams::co_a': 1, 'dreams::co_b': 1 });
    const poller = makePoller({
      dispatcher,
      claimSvc,
      tenants: ['co_a', 'co_b'],
    });
    const { control, abort } = makeControl();

    const loop = poller.runLoop(makeReg(), control);
    await settle();
    // Both tenants' jobs are in flight at the same time — neither has
    // resolved yet (they're parked), so this is real concurrency.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(parked.map((p) => p.claim.companyId).sort()).toEqual([
      'co_a',
      'co_b',
    ]);

    abort();
    releaseAll();
    await loop;
  });

  it('max=2 with one tenant at tenant cap 1 leaves the second slot empty', async () => {
    process.env.WORKER_LOOP_MAX_CONCURRENT = '2';
    // WORKER_LOOP_TENANT_MAX_CONCURRENT defaults to 1.
    const { dispatcher, dispatch, parked, releaseAll } = makeParkedDispatcher();
    const claimSvc = makeQueue({ 'dreams::co_a': 3 });
    const poller = makePoller({ dispatcher, claimSvc, tenants: ['co_a'] });
    const { control, abort } = makeControl();

    const loop = poller.runLoop(makeReg(), control);
    await settle();
    // One in flight; the tenant is at its cap, so the poller must not
    // even attempt further claims for it while the job runs.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(claimSvc.claimNext).toHaveBeenCalledTimes(1);

    parked[0]!.release();
    await settle();
    // Slot freed → the tenant is eligible again and its next job runs.
    expect(dispatch).toHaveBeenCalledTimes(2);

    abort();
    releaseAll();
    await loop;
  });

  it('global cap 1 across two jobTypes keeps one dispatch in flight process-wide', async () => {
    process.env.WORKER_LOOP_MAX_CONCURRENT = '2';
    process.env.WORKER_LOOP_GLOBAL_MAX_CONCURRENT = '1';
    const { dispatcher, dispatch, parked, releaseAll } = makeParkedDispatcher();
    const claimSvc = makeQueue({
      'dreams::co_a': 1,
      'compaction::co_a': 1,
    });
    // One shared service instance — the global counter lives on it.
    const poller = makePoller({ dispatcher, claimSvc, tenants: ['co_a'] });
    const { control, abort } = makeControl();

    const loopA = poller.runLoop(makeReg('dreams'), control);
    const loopB = poller.runLoop(makeReg('compaction'), control);
    await settle();
    // Both loops have work available, but only one dispatch may fly.
    expect(dispatch).toHaveBeenCalledTimes(1);

    parked[0]!.release();
    await settle();
    // Global slot freed → the other jobType's job goes out.
    expect(dispatch).toHaveBeenCalledTimes(2);

    abort();
    releaseAll();
    await Promise.all([loopA, loopB]);
  });
});

describe('WorkerPollerService.runLoop — abort drains in-flight dispatches', () => {
  it('waits for in-flight jobs and propagates the shutdown abort to handlers', async () => {
    process.env.WORKER_LOOP_MAX_CONCURRENT = '2';
    const claimSvc = {
      identity: () => 'host-test#42',
      claimNext: jest.fn(),
      renew: jest.fn(async () => ({
        stillOwned: true,
        cancelRequested: false,
      })),
      complete: jest.fn(async () => undefined),
      fail: jest.fn(async () => ({ requeued: true })),
      cancelled: jest.fn(async () => undefined),
    };
    claimSvc.claimNext
      .mockResolvedValueOnce({
        recordId: 'job_run:abc',
        runId: 'run-uuid-1',
        jobType: 'dreams',
        companyId: 'co_a',
        attempts: 1,
        payload: null,
        leaseUntil: '2030-01-01T00:05:00Z',
      })
      .mockResolvedValue(null);
    // Real dispatcher: it owns the shutdown→handler abort propagation
    // and the terminal write, which is exactly what drain relies on.
    const dispatcher = new JobDispatcherService(claimSvc as never, undefined);
    let sawAbort = false;
    const reg: RegisteredHandler = {
      jobType: 'dreams',
      handler: async (ctx) => {
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
    const poller = makePoller({ dispatcher, claimSvc, tenants: ['co_a'] });
    const { control, abort } = makeControl();

    const loop = poller.runLoop(reg, control);
    await settle();
    expect(claimSvc.claimNext).toHaveBeenCalled();

    let loopResolved = false;
    void loop.then(() => {
      loopResolved = true;
    });
    // The handler is parked on its abortSignal — the loop must not have
    // resolved yet.
    expect(loopResolved).toBe(false);

    abort();
    await loop;
    expect(sawAbort).toBe(true);
    expect(claimSvc.complete).toHaveBeenCalledTimes(1);
  });
});
