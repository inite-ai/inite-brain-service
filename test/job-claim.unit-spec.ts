/**
 * Unit coverage for JobClaimService — CAS enqueue / claimNext / renew
 * / complete / fail / reapZombies. We mock the SurrealService at the
 * withCompany boundary and assert what SQL it issued and how the
 * service reacted to driver-level errors (unique violation collapse,
 * read conflict retry).
 */
import { Logger } from '@nestjs/common';
import { JobClaimService } from '../src/jobs/job-claim.service';

interface QueryCall {
  sql: string;
  params?: Record<string, unknown>;
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

describe('JobClaimService', () => {
  it('claimNext returns null when the transaction yields no row', async () => {
    // runTransaction returns the LAST statement's result. Our handler
    // wraps "RETURN NONE" when the SELECT was empty.
    const { db } = mkDbScript([
      () => [null], // BEGIN/COMMIT batch returns one slot: NONE
    ]);
    const svc = new JobClaimService(mkSurreal(db));
    const got = await svc.claimNext({
      companyId: 'co_x',
      jobType: 'dreams',
      ttlSeconds: 300,
    });
    expect(got).toBeNull();
  });

  it('claimNext returns a typed JobClaim when the tx yields a row', async () => {
    const { db } = mkDbScript([
      () => [
        {
          id: 'job_run:abc',
          runId: 'run-uuid-1',
          jobType: 'dreams',
          attempts: 1,
          payload: { operations: ['dedup'] },
          leaseUntil: '2030-01-01T00:05:00Z',
        },
      ],
    ]);
    const svc = new JobClaimService(mkSurreal(db));
    const got = await svc.claimNext({
      companyId: 'co_x',
      jobType: 'dreams',
      ttlSeconds: 300,
    });
    expect(got).not.toBeNull();
    expect(got?.runId).toBe('run-uuid-1');
    expect(got?.recordId).toBe('job_run:abc');
    expect(got?.payload).toEqual({ operations: ['dedup'] });
    expect(got?.attempts).toBe(1);
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

  it('enqueue collapses a dedup collision onto the existing row', async () => {
    // Simulate retryOnUniqueViolation exhausting on a UNIQUE-violation
    // error message, then findByDedup returning the existing runId.
    const dupErr = new Error(
      "Database index `job_run_dedup_idx` already contains a record",
    );
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
      ttlSeconds: 300,
    });
    expect(out.stillOwned).toBe(false);
    expect(out.cancelRequested).toBe(false);
  });

  it('renew bubbles cancelRequested up to the caller', async () => {
    const { db } = mkDbScript([
      () => [[{ cancelRequested: true }]],
    ]);
    const svc = new JobClaimService(mkSurreal(db));
    const out = await svc.renew({
      companyId: 'co_x',
      recordId: 'job_run:abc',
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
      attempts: 1,
      error: { message: 'boom' },
      maxAttempts: 3,
    });
    expect(out.requeued).toBe(true);
    expect(updateSql).toContain("status = 'pending'");
    expect(updateSql).toContain('visibleAfter');
    // Ownership guard present so a re-claimed row can't be stomped.
    expect(updateSql).toContain("claimedBy = $me AND status = 'running'");
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
      attempts: 3,
      error: { message: 'boom' },
      maxAttempts: 3,
    });
    expect(out.requeued).toBe(false);
    expect(updateSql).toContain("status = 'failed'");
    expect(updateSql).toContain("claimedBy = $me AND status = 'running'");
  });

  it('fail reports requeued=false when the guarded UPDATE matches no row (claim lost to a re-claim)', async () => {
    const db = {
      query: async (_sql: string, _params?: Record<string, unknown>) =>
        [[]], // 0 rows affected ⇒ we no longer own the running claim
    };
    const svc = new JobClaimService(mkSurreal(db));
    const out = await svc.fail({
      companyId: 'co_x',
      recordId: 'job_run:abc',
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
    await svc.complete({ companyId: 'co_x', recordId: 'job_run:abc' });
    await svc.cancelled({ companyId: 'co_x', recordId: 'job_run:abc' });
    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toContain("status = 'succeeded'");
    expect(sqls[0]).toContain("claimedBy = $me AND status = 'running'");
    expect(sqls[1]).toContain("status = 'cancelled'");
    expect(sqls[1]).toContain("claimedBy = $me AND status = 'running'");
  });

  it('complete()/cancelled() no-op + warn when the guarded UPDATE matches no row', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined as any);
    const db = { query: async () => [[]] }; // 0 rows ⇒ claim lost
    const svc = new JobClaimService(mkSurreal(db));
    await svc.complete({ companyId: 'co_x', recordId: 'job_run:abc' });
    await svc.cancelled({ companyId: 'co_x', recordId: 'job_run:abc' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no-op'));
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes('no-op')).length,
    ).toBe(2);
    warn.mockRestore();
  });

  it('reapZombies delegates to fn::reap_zombies and returns its counts', async () => {
    // The requeue/abandon split + per-row backoff now live in
    // fn::reap_zombies (migration 0038), run as two set-based UPDATEs in one
    // atomic statement — so no concurrent reaper can read-then-write the same
    // expired row. The service is now a thin caller: pass the knobs, return
    // the counts. We assert the wiring (fn name + params + result mapping).
    let captured: { sql: string; params?: Record<string, unknown> } | null =
      null;
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

  it('identity is hostname#pid format', () => {
    const svc = new JobClaimService();
    expect(svc.identity()).toMatch(/^.+#\d+$/);
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
    expect(rows[0].claimedBy).toBe('host#1');
  });
});
