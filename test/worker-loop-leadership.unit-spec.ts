/**
 * Leadership and shutdown on the worker trio:
 *   - WorkerPollerService confirms the lease (point read) before every
 *     claim and ends the loop the moment it is gone — not at the next
 *     renew tick up to 30 s later — and stamps the lease epoch on claims;
 *   - WorkerLoopService drains in-flight dispatches for ≤12 s at shutdown
 *     and hands still-running claims back BEFORE releasing the lease.
 */
import { WorkerLoopService } from '../src/jobs/worker-loop.service';
import { WorkerPollerService } from '../src/jobs/worker-poller.service';
import type { JobClaim } from '../src/jobs/job-claim.service';
import type { JobType } from '../src/jobs/job-run.service';
import type { PollControl, RegisteredHandler } from '../src/jobs/worker-loop.types';

function makeJobClaim(opts: { recordId: string; jobType?: JobType; companyId?: string }): JobClaim {
  return {
    recordId: opts.recordId,
    runId: `run-${opts.recordId}`,
    jobType: opts.jobType ?? 'dreams',
    companyId: opts.companyId ?? 'co_a',
    attempts: 1,
    payload: null,
    leaseUntil: '2030-01-01T00:05:00Z',
    claimEpoch: null,
  };
}

describe('WorkerPollerService.runLoop — leadership is confirmed before every claim', () => {
  const ENV = ['WORKER_LOOP_POLL_MS', 'WORKER_LOOP_EMPTY_BACKOFF_MS', 'WORKER_LOOP_MAX_CONCURRENT'];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = {};
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.WORKER_LOOP_POLL_MS = '5';
    process.env.WORKER_LOOP_EMPTY_BACKOFF_MS = '5';
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function harness(confirms: boolean[], leader = true) {
    let seq = 0;
    const claimNext = jest.fn(
      async (input: { companyId: string; jobType: JobType; epoch?: number | null }) =>
        makeJobClaim({
          recordId: `job_run:${++seq}`,
          jobType: input.jobType,
          companyId: input.companyId,
        }),
    );
    const dispatch = jest.fn(async () => undefined);
    const poller = new WorkerPollerService(
      { dispatch } as never,
      { claimNext } as never,
      { fanOutRoster: () => ['co_a'] } as never,
    );
    let i = 0;
    const confirmLeader = jest.fn(async () => confirms[i++] ?? false);
    const control: PollControl = {
      isLeader: () => leader,
      confirmLeader,
      epoch: () => 9,
      signal: new AbortController().signal,
    };
    const reg: RegisteredHandler = {
      jobType: 'dreams',
      handler: async () => ({}),
      ttlSeconds: 3,
      maxAttempts: 3,
    };
    return { poller, control, reg, claimNext, dispatch, confirmLeader };
  }

  it('serial loop: a false confirmation ends the loop before the next claim; every claim carries the lease epoch', async () => {
    const { poller, control, reg, claimNext, dispatch, confirmLeader } = harness([true, false]);
    await poller.runLoop(reg, control);
    expect(confirmLeader).toHaveBeenCalledTimes(2);
    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(claimNext.mock.calls[0]![0]).toMatchObject({ companyId: 'co_a', epoch: 9 });
  });

  it('bounded-concurrency loop: same contract', async () => {
    process.env.WORKER_LOOP_MAX_CONCURRENT = '2';
    const { poller, control, reg, claimNext, confirmLeader } = harness([true, false]);
    await poller.runLoop(reg, control);
    expect(confirmLeader).toHaveBeenCalledTimes(2);
    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(claimNext.mock.calls[0]![0]).toMatchObject({ epoch: 9 });
  });

  it('a loop whose cached flag is already false ends without a read or a claim', async () => {
    const { poller, control, reg, claimNext, confirmLeader } = harness([true], false);
    await poller.runLoop(reg, control);
    expect(confirmLeader).not.toHaveBeenCalled();
    expect(claimNext).not.toHaveBeenCalled();
  });
});

describe('WorkerLoopService — shutdown drains dispatches before releasing the lease', () => {
  const OLD = process.env.WORKER_LOOP_LEASE_RENEW_MS;
  beforeEach(() => {
    jest.useFakeTimers();
    // First acquire fires at renew/6 = 100 ms.
    process.env.WORKER_LOOP_LEASE_RENEW_MS = '600';
  });
  afterEach(() => {
    jest.useRealTimers();
    if (OLD === undefined) delete process.env.WORKER_LOOP_LEASE_RENEW_MS;
    else process.env.WORKER_LOOP_LEASE_RENEW_MS = OLD;
  });

  function boot(opts: { stuck: boolean }) {
    const order: string[] = [];
    const claim = makeJobClaim({ recordId: 'job_run:stuck' });
    const poller = {
      hasClaim: true,
      startDecay: jest.fn(),
      stopDecay: jest.fn(),
      // A stuck loop stands in for a handler ignoring the shutdown abort.
      runLoop: jest.fn(
        (_reg: RegisteredHandler, control: PollControl) =>
          new Promise<void>((resolve) => {
            if (!opts.stuck) {
              control.signal.addEventListener('abort', () => resolve(), { once: true });
            }
          }),
      ),
      activeClaims: () => (opts.stuck ? [claim] : []),
      releaseActiveClaims: jest.fn(async () => {
        order.push('release-claims');
        return 1;
      }),
    };
    const lease = {
      acquire: jest.fn(async () => 3),
      isHeld: jest.fn(async () => true),
      release: jest.fn(async () => {
        order.push('release-lease');
      }),
    };
    const svc = new WorkerLoopService(poller as never, lease as never);
    svc.register('dreams', async () => ({}));
    return { svc, poller, lease, order };
  }

  async function becomeLeader(svc: WorkerLoopService) {
    await svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(svc.leader()).toBe(true);
  }

  it('loops that stop on the abort signal drain at once and no claim is handed back', async () => {
    const { svc, poller, lease, order } = boot({ stuck: false });
    await becomeLeader(svc);
    expect(poller.runLoop).toHaveBeenCalledTimes(1);
    let done = false;
    const closing = svc.beforeApplicationShutdown().then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(1);
    await closing;
    expect(done).toBe(true);
    expect(poller.releaseActiveClaims).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledWith('worker_loop');
    expect(order).toEqual(['release-lease']);
  });

  it('a handler still running after the 12 s budget has its claim handed back BEFORE the lease is released', async () => {
    const { svc, poller, order } = boot({ stuck: true });
    await becomeLeader(svc);
    let done = false;
    const closing = svc.beforeApplicationShutdown().then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(11_999);
    expect(done).toBe(false);
    expect(poller.releaseActiveClaims).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await closing;
    expect(poller.releaseActiveClaims).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['release-claims', 'release-lease']);
  });

  it('confirmLeader() drops leadership as soon as the point read says the lease moved on', async () => {
    const { svc, poller, lease } = boot({ stuck: false });
    await becomeLeader(svc);
    const control = poller.runLoop.mock.calls[0]![1] as PollControl;
    expect(control.epoch()).toBe(3);
    expect(await control.confirmLeader()).toBe(true);
    expect(lease.isHeld).toHaveBeenLastCalledWith('worker_loop', 3);
    lease.isHeld.mockResolvedValueOnce(false);
    expect(await control.confirmLeader()).toBe(false);
    expect(svc.leader()).toBe(false);
    expect(control.isLeader()).toBe(false);
    expect(control.epoch()).toBeNull();
    // Abort so the parked loop and the renew timer go away.
    await svc.beforeApplicationShutdown();
  });
});
