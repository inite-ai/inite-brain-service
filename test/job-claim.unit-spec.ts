/**
 * Unit coverage for JobClaimService — CAS enqueue / claimNext / renew
 * / complete / fail / release / reapZombies. We mock the SurrealService
 * at the withCompany boundary and assert what SQL it issued and how the
 * service reacted to driver-level errors (unique violation collapse,
 * read conflict retry).
 */
import { Logger } from '@nestjs/common';
import { JobClaimService } from '../src/jobs/job-claim.service';
import { PROCESS_IDENTITY } from '../src/common/process-identity';

interface QueryCall {
  sql: string;
  params?: Record<string, unknown> | undefined;
}

function mkDbScript(steps: Array<(call: QueryCall) => unknown[] | Error>) {
  const calls: QueryCall[] = [];
  let i = 0;
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      const call = { sql, params };
      calls.push(call);
      const step = steps[i++] ?? (() => [[]]);
      const out = step(call);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { db, calls };
}

function mkSurreal(db: { query: (s: string, p?: any) => Promise<any> }) {
  return {
    withCompany: async <T>(_c: string, fn: (d: any) => Promise<T>) => fn(db),
  } as any;
}

const CLAIMED_ROW = {
  id: 'job_run:abc',
  runId: 'run-uuid-1',
  jobType: 'dreams',
  attempts: 1,
  payload: { operations: ['dedup'] },
  leaseUntil: '2030-01-01T00:05:00Z',
};

describe('JobClaimService', () => {
  it('claimNext returns null when no candidate is pending', async () => {
    const { db, calls } = mkDbScript([() => [[]]]);
    const svc = new JobClaimService(mkSurreal(db));
    const got = await svc.claimNext({
      companyId: 'co_x',
      jobType: 'dreams',
      ttlSeconds: 300,
    });
    expect(got).toBeNull();
    // One index-backed read; no CAS attempted, no transaction opened.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('SELECT id, visibleAfter FROM job_run');
    expect(calls[0]!.sql).not.toContain('BEGIN');
  });

  it('claimNext selects the candidate outside any transaction, then CAS-updates that one record', async () => {
    const { db, calls } = mkDbScript([() => [[{ id: 'job_run:abc' }]], () => [[CLAIMED_ROW]]]);
    const svc = new JobClaimService(mkSurreal(db));
    const got = await svc.claimNext({
      companyId: 'co_x',
      jobType: 'dreams',
      ttlSeconds: 300,
      epoch: 7,
    });
    expect(got).not.toBeNull();
    expect(got?.runId).toBe('run-uuid-1');
    expect(got?.recordId).toBe('job_run:abc');
    expect(got?.payload).toEqual({ operations: ['dedup'] });
    expect(got?.attempts).toBe(1);
    expect(got?.claimEpoch).toBe(7);

    expect(calls).toHaveLength(2);
    const [select, cas] = calls as [QueryCall, QueryCall];
    expect(select.sql).toMatch(/status = 'pending'\s+AND visibleAfter <= time::now\(\)/);
    expect(select.sql).toContain('LIMIT 1');
    // The CAS is a point write on the candidate's id, guarded on the
    // state the candidate was read in, and stamps the lease epoch.
    expect(cas.sql).toContain('UPDATE type::record($rid)');
    expect(cas.sql).toContain("WHERE status = 'pending' AND visibleAfter <= time::now()");
    expect(cas.sql).toContain('claimEpoch = $epoch');
    expect(cas.sql).not.toContain('BEGIN');
    expect(cas.params).toMatchObject({ rid: 'job_run:abc', me: PROCESS_IDENTITY, epoch: 7 });
  });

  it('claimNext without a lease epoch stamps claimEpoch = NONE', async () => {
    const { db, calls } = mkDbScript([() => [[{ id: 'job_run:abc' }]], () => [[CLAIMED_ROW]]]);
    const svc = new JobClaimService(mkSurreal(db));
    const got = await svc.claimNext({ companyId: 'co_x', jobType: 'dreams', ttlSeconds: 300 });
    expect(got?.claimEpoch).toBeNull();
    expect(calls[1]!.sql).toContain('claimEpoch = NONE');
    expect(calls[1]!.params).not.toHaveProperty('epoch');
  });

  it('claimNext moves on to the next candidate when the CAS loses the race', async () => {
    const { db, calls } = mkDbScript([
      () => [[{ id: 'job_run:a' }]],
      () => [[]], // another claimer flipped job_run:a between our read and our write
      () => [[{ id: 'job_run:b' }]],
      () => [[{ ...CLAIMED_ROW, id: 'job_run:b', runId: 'run-b' }]],
    ]);
    const svc = new JobClaimService(mkSurreal(db));
    const got = await svc.claimNext({ companyId: 'co_x', jobType: 'dreams', ttlSeconds: 300 });
    expect(got?.recordId).toBe('job_run:b');
    expect(got?.runId).toBe('run-b');
    expect(calls.map((c) => c.params?.rid)).toEqual([
      undefined,
      'job_run:a',
      undefined,
      'job_run:b',
    ]);
  });

  it('claimNext gives up after three lost races', async () => {
    const { db, calls } = mkDbScript([
      () => [[{ id: 'job_run:a' }]],
      () => [[]],
      () => [[{ id: 'job_run:b' }]],
      () => [[]],
      () => [[{ id: 'job_run:c' }]],
      () => [[]],
      () => [[{ id: 'job_run:d' }]], // never read
    ]);
    const svc = new JobClaimService(mkSurreal(db));
    const got = await svc.claimNext({ companyId: 'co_x', jobType: 'dreams', ttlSeconds: 300 });
    expect(got).toBeNull();
    expect(calls).toHaveLength(6);
  });

  it('claimNext returns null and swallows transient driver errors', async () => {
    const { db } = mkDbScript([
      () => new Error('Transaction read conflict; this transaction can be retried'),
      () => new Error('Transaction read conflict; this transaction can be retried'),
      () => new Error('Transaction read conflict; this transaction can be retried'),
      () => new Error('Transaction read conflict; this transaction can be retried'),
      () => new Error('Transaction read conflict; this transaction can be retried'),
      () => new Error('Transaction read conflict; this transaction can be retried'),
      () => new Error('Transaction read conflict; this transaction can be retried'),
    ]);
    const svc = new JobClaimService(mkSurreal(db));
    const got = await svc.claimNext({
      companyId: 'co_x',
      jobType: 'dreams',
      ttlSeconds: 300,
    });
    expect(got).toBeNull();
  });

  it('enqueue leaves visibleAfter to the datastore unless the job is deliberately delayed', async () => {
    // The claim filter is `visibleAfter <= time::now()`, evaluated by the
    // datastore: a row stamped from a process clock running ahead of it is
    // unclaimable until the difference elapses.
    const { db, calls } = mkDbScript([() => [[{ id: 'job_run:new' }]]]);
    const svc = new JobClaimService(mkSurreal(db));
    await svc.enqueue({ jobType: 'dreams', companyId: 'co_x', triggeredBy: 'cron' });
    expect(calls[0]!.sql).not.toContain('visibleAfter');
    expect(calls[0]!.params).not.toHaveProperty('visibleAfter');

    const at = new Date('2030-01-01T00:00:00.000Z');
    const scheduled = mkDbScript([() => [[{ id: 'job_run:later' }]]]);
    await new JobClaimService(mkSurreal(scheduled.db)).enqueue({
      jobType: 'dreams',
      companyId: 'co_x',
      triggeredBy: 'cron',
      visibleAfter: at,
    });
    expect(scheduled.calls[0]!.sql).toContain('visibleAfter: type::datetime($visibleAfter)');
    expect(scheduled.calls[0]!.params).toMatchObject({ visibleAfter: at.toISOString() });
  });

  it('enqueue collapses a dedup collision onto the existing row', async () => {
    // Simulate retryOnUniqueViolation exhausting on a UNIQUE-violation
    // error message, then findByDedup returning the existing runId.
    const dupErr = new Error('Database index `job_run_dedup_idx` already contains a record');
    const calls: QueryCall[] = [];
    let cursor = 0;
    const db = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        calls.push({ sql, params });
        cursor++;
        if (sql.includes('CREATE job_run')) {
          throw dupErr;
        }
        if (sql.includes('SELECT runId FROM job_run')) {
          return [[{ runId: 'pre-existing-uuid' }]];
        }
        return [[]];
      },
    };
    const svc = new JobClaimService(mkSurreal(db));
    const { runId, created } = await svc.enqueue({
      jobType: 'dreams',
      companyId: 'co_x',
      triggeredBy: 'cron',
      dedupKey: 'dreams_2030-01-01',
    });
    expect(created).toBe(false);
    expect(runId).toBe('pre-existing-uuid');
    expect(cursor).toBeGreaterThanOrEqual(2);
  });

  it('renew signals stillOwned=false when no rows matched the CAS WHERE', async () => {
    const { db } = mkDbScript([
      // The UPDATE … RETURN cancelRequested returns [[]] when nothing matched
      () => [[]],
    ]);
    const svc = new JobClaimService(mkSurreal(db));
    const out = await svc.renew({
      companyId: 'co_x',
      recordId: 'job_run:abc',
      claimEpoch: null,
      ttlSeconds: 300,
    });
    expect(out.stillOwned).toBe(false);
    expect(out.cancelRequested).toBe(false);
  });

  it('renew bubbles cancelRequested up to the caller', async () => {
    const { db } = mkDbScript([() => [[{ cancelRequested: true }]]]);
    const svc = new JobClaimService(mkSurreal(db));
    const out = await svc.renew({
      companyId: 'co_x',
      recordId: 'job_run:abc',
      claimEpoch: null,
      ttlSeconds: 300,
    });
    expect(out.stillOwned).toBe(true);
    expect(out.cancelRequested).toBe(true);
  });

  it('fail requeues with backoff while attempts < maxAttempts', async () => {
    let updateSql = '';
    const db = {
      query: async (sql: string, _params?: Record<string, unknown>) => {
        if (sql.includes('UPDATE')) updateSql = sql;
        // Non-empty ⇒ the ownership-guarded UPDATE matched our row.
        return [[{ id: 'job_run:abc' }]];
      },
    };
    const svc = new JobClaimService(mkSurreal(db));
    const out = await svc.fail({
      companyId: 'co_x',
      recordId: 'job_run:abc',
      claimEpoch: null,
      attempts: 1,
      error: { message: 'boom' },
      maxAttempts: 3,
    });
    expect(out.requeued).toBe(true);
    expect(updateSql).toContain("status = 'pending'");
    expect(updateSql).toContain('visibleAfter');
    // Ownership guard present so a re-claimed row can't be stomped.
    expect(updateSql).toContain("claimedBy = $me AND status = 'running' AND claimEpoch IS NONE");
  });

  it('fail terminal-fails at maxAttempts', async () => {
    let updateSql = '';
    const db = {
      query: async (sql: string, _params?: Record<string, unknown>) => {
        if (sql.includes('UPDATE')) updateSql = sql;
        return [[{ id: 'job_run:abc' }]];
      },
    };
    const svc = new JobClaimService(mkSurreal(db));
    const out = await svc.fail({
      companyId: 'co_x',
      recordId: 'job_run:abc',
      claimEpoch: null,
      attempts: 3,
      error: { message: 'boom' },
      maxAttempts: 3,
    });
    expect(out.requeued).toBe(false);
    expect(updateSql).toContain("status = 'failed'");
    expect(updateSql).toContain("claimedBy = $me AND status = 'running' AND claimEpoch IS NONE");
  });

  it('fail reports requeued=false when the guarded UPDATE matches no row (claim lost to a re-claim)', async () => {
    const db = {
      query: async (_sql: string, _params?: Record<string, unknown>) => [[]], // 0 rows affected ⇒ we no longer own the running claim
    };
    const svc = new JobClaimService(mkSurreal(db));
    const out = await svc.fail({
      companyId: 'co_x',
      recordId: 'job_run:abc',
      claimEpoch: null,
      attempts: 1,
      error: { message: 'boom' },
      maxAttempts: 3,
    });
    expect(out.requeued).toBe(false);
  });

  it('complete and cancelled guard the terminal write on ownership', async () => {
    const sqls: string[] = [];
    const db = {
      query: async (sql: string, _params?: Record<string, unknown>) => {
        sqls.push(sql);
        return [[{ id: 'job_run:abc' }]];
      },
    };
    const svc = new JobClaimService(mkSurreal(db));
    await svc.complete({ companyId: 'co_x', recordId: 'job_run:abc', claimEpoch: null });
    await svc.cancelled({ companyId: 'co_x', recordId: 'job_run:abc', claimEpoch: null });
    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toContain("status = 'succeeded'");
    expect(sqls[0]).toContain("claimedBy = $me AND status = 'running' AND claimEpoch IS NONE");
    expect(sqls[1]).toContain("status = 'cancelled'");
    expect(sqls[1]).toContain("claimedBy = $me AND status = 'running' AND claimEpoch IS NONE");
  });

  it('complete()/cancelled() no-op + warn when the guarded UPDATE matches no row', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    const db = { query: async () => [[]] }; // 0 rows ⇒ claim lost
    const svc = new JobClaimService(mkSurreal(db));
    await svc.complete({ companyId: 'co_x', recordId: 'job_run:abc', claimEpoch: null });
    await svc.cancelled({ companyId: 'co_x', recordId: 'job_run:abc', claimEpoch: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no-op'));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('no-op')).length).toBe(2);
    warn.mockRestore();
  });

  it('reapZombies delegates to fn::reap_zombies and returns its counts', async () => {
    // The requeue/abandon split + per-row backoff now live in
    // fn::reap_zombies (migration 0038), run as two set-based UPDATEs in one
    // atomic statement — so no concurrent reaper can read-then-write the same
    // expired row. The service is now a thin caller: pass the knobs, return
    // the counts. We assert the wiring (fn name + params + result mapping).
    let captured: {
      sql: string;
      params?: Record<string, unknown> | undefined;
    } | null = null;
    const db = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        captured = { sql, params };
        return [{ requeued: 2, failed: 1 }];
      },
    };
    const svc = new JobClaimService(mkSurreal(db));
    const out = await svc.reapZombies({
      companyId: 'co_x',
      maxAttempts: 3,
      backoffBaseMs: 30_000,
    });
    expect(out).toEqual({ requeued: 2, failed: 1 });
    expect(captured!.sql).toContain('fn::reap_zombies');
    expect(captured!.params).toMatchObject({
      max_attempts: 3,
      backoff_base_ms: 30_000,
    });
  });

  it('identity is the one process identity — hostname#pid#uuid', () => {
    const svc = new JobClaimService();
    expect(svc.identity()).toBe(PROCESS_IDENTITY);
    expect(svc.identity()).toMatch(/^.+#\d+#[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  });

  it('renew is fenced on the claim epoch, so a dispatch from a lapsed leadership loses its claim', async () => {
    const { db, calls } = mkDbScript([() => [[]]]);
    const svc = new JobClaimService(mkSurreal(db));
    const out = await svc.renew({
      companyId: 'co_x',
      recordId: 'job_run:abc',
      claimEpoch: 4,
      ttlSeconds: 300,
    });
    expect(out.stillOwned).toBe(false);
    expect(calls[0]!.sql).toContain(
      "claimedBy = $me AND status = 'running' AND claimEpoch = $epoch",
    );
    expect(calls[0]!.params).toMatchObject({ me: PROCESS_IDENTITY, epoch: 4 });
  });

  it('terminal writes taken under an epoch require the row to still carry it — a stale epoch is a no-op', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    const { db, calls } = mkDbScript([() => [[]], () => [[]], () => [[]]]);
    const svc = new JobClaimService(mkSurreal(db));
    await svc.complete({ companyId: 'co_x', recordId: 'job_run:abc', claimEpoch: 5 });
    const failed = await svc.fail({
      companyId: 'co_x',
      recordId: 'job_run:abc',
      claimEpoch: 5,
      attempts: 1,
      error: { message: 'boom' },
    });
    await svc.cancelled({ companyId: 'co_x', recordId: 'job_run:abc', claimEpoch: 5 });
    expect(failed.requeued).toBe(false);
    for (const call of calls) {
      expect(call.sql).toContain("claimedBy = $me AND status = 'running' AND claimEpoch = $epoch");
      expect(call.params).toMatchObject({ me: PROCESS_IDENTITY, epoch: 5 });
      // The row leaves the claim state clean for the next claimer.
      expect(call.sql).toContain('claimEpoch = NONE');
    }
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('no-op')).length).toBe(3);
    warn.mockRestore();
  });

  it('release hands the row back as pending, visible now, under the same ownership guard', async () => {
    const { db, calls } = mkDbScript([() => [[{ id: 'job_run:abc' }]], () => [[]]]);
    const svc = new JobClaimService(mkSurreal(db));
    const released = await svc.release({
      companyId: 'co_x',
      recordId: 'job_run:abc',
      claimEpoch: 2,
      reason: 'pod shutdown',
    });
    expect(released).toBe(true);
    expect(calls[0]!.sql).toContain("status = 'pending'");
    expect(calls[0]!.sql).toContain('visibleAfter = time::now()');
    expect(calls[0]!.sql).toContain(
      "claimedBy = $me AND status = 'running' AND claimEpoch = $epoch",
    );
    expect(calls[0]!.params).toMatchObject({
      err: { name: 'PodShutdown', message: 'pod shutdown' },
    });
    // A row we no longer own matches nothing — nothing to hand back.
    expect(
      await svc.release({
        companyId: 'co_x',
        recordId: 'job_run:abc',
        claimEpoch: 2,
        reason: 'pod shutdown',
      }),
    ).toBe(false);
  });

  it('listActiveClaims aggregates rows across tenants', async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("status = 'running'")) {
          return [
            [
              {
                runId: 'run-1',
                jobType: 'dreams',
                claimedBy: 'host#1',
                claimedAt: '2030-01-01T00:00:00Z',
                leaseUntil: '2030-01-01T00:05:00Z',
                heartbeatAt: '2030-01-01T00:00:30Z',
                attempts: 1,
              },
            ],
          ];
        }
        return [[]];
      },
    };
    const svc = new JobClaimService(mkSurreal(db));
    const rows = await svc.listActiveClaims(['co_x', 'co_y']);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.claimedBy).toBe('host#1');
  });
});
