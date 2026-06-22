/**
 * Unit coverage for JobClaimService — CAS enqueue / claimNext / renew
 * / complete / fail / reapZombies. We mock the SurrealService at the
 * withCompany boundary and assert what SQL it issued and how the
 * service reacted to driver-level errors (unique violation collapse,
 * read conflict retry).
 */
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
        return [[]];
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
  });

  it('fail terminal-fails at maxAttempts', async () => {
    let updateSql = '';
    const db = {
      query: async (sql: string, _params?: Record<string, unknown>) => {
        if (sql.includes('UPDATE')) updateSql = sql;
        return [[]];
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
  });

  it('reapZombies routes below-maxAttempts rows to requeue and at-max to fail', async () => {
    const updates: string[] = [];
    const db = {
      query: async (sql: string, _params?: Record<string, unknown>) => {
        if (sql.startsWith('SELECT id, attempts')) {
          return [
            [
              { id: 'job_run:a', attempts: 1, claimedBy: 'host#1' },
              { id: 'job_run:b', attempts: 3, claimedBy: 'host#1' },
            ],
          ];
        }
        if (sql.includes('UPDATE')) {
          updates.push(sql);
          return [[]];
        }
        return [[]];
      },
    };
    const svc = new JobClaimService(mkSurreal(db));
    const out = await svc.reapZombies({
      companyId: 'co_x',
      maxAttempts: 3,
    });
    expect(out.requeued).toBe(1);
    expect(out.failed).toBe(1);
    expect(updates.find((s) => s.includes("status = 'pending'"))).toBeDefined();
    expect(updates.find((s) => s.includes("status = 'failed'"))).toBeDefined();
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
