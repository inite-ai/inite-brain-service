/**
 * Real-SurrealDB integration test for the Phase J queue.
 *
 * Spins up the testcontainers Surreal (started by global-setup), wires
 * SurrealService + JobClaimService + LeaderLeaseService against it,
 * and walks the full enqueue → claim → renew → complete cycle. Also
 * verifies the failure paths (dedup collapse, requeue with backoff,
 * zombie reap) and that leader_lease lives in the `system` database
 * not a tenant DB.
 *
 * Skipped if SURREALDB_URL is not set — keeps `pnpm test` (unit-only)
 * cheap. Runs under `pnpm test:e2e:real` via the matching testRegex
 * in test/jest-e2e-real.json.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { SurrealService } from '../src/db/surreal.service';
import { JobClaimService } from '../src/jobs/job-claim.service';
import { LeaderLeaseService } from '../src/jobs/leader-lease.service';

const TENANT = `q${Math.floor(Math.random() * 1e8)}`;

describe('JobClaimService — real Surreal end-to-end', () => {
  let moduleRef: TestingModule;
  let surreal: SurrealService;
  let claim: JobClaimService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [SurrealService, JobClaimService, LeaderLeaseService],
    }).compile();
    await moduleRef.init();
    surreal = moduleRef.get(SurrealService);
    claim = moduleRef.get(JobClaimService);
  }, 60_000);

  afterAll(async () => {
    if (moduleRef) await moduleRef.close();
  });

  it('enqueue creates a pending row and complete transitions it to succeeded', async () => {
    const { runId, created } = await claim.enqueue({
      jobType: 'dreams',
      companyId: TENANT,
      triggeredBy: 'cron',
      payload: { ops: ['dedup'] },
    });
    expect(created).toBe(true);
    expect(runId).toBeTruthy();

    // Row exists with status='pending', claimedBy=NONE, attempts=0
    const before = await surreal.withCompany(TENANT, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT status, claimedBy, attempts, payload FROM job_run WHERE runId = $r`,
        { r: runId },
      );
      return (rows as any[])[0];
    });
    expect(before.status).toBe('pending');
    expect(before.claimedBy).toBeFalsy();
    expect(before.attempts).toBe(0);
    expect(before.payload).toEqual({ ops: ['dedup'] });

    // Claim it — CAS pending→running
    const claimed = await claim.claimNext({
      companyId: TENANT,
      jobType: 'dreams',
      ttlSeconds: 60,
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.runId).toBe(runId);
    expect(claimed!.attempts).toBe(1);

    const afterClaim = await surreal.withCompany(TENANT, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT status, claimedBy, leaseUntil FROM job_run WHERE runId = $r`,
        { r: runId },
      );
      return (rows as any[])[0];
    });
    expect(afterClaim.status).toBe('running');
    expect(afterClaim.claimedBy).toContain('#');

    // Complete
    await claim.complete({
      companyId: TENANT,
      recordId: claimed!.recordId,
      result: { ok: true, summarized: 42 },
    });
    const afterComplete = await surreal.withCompany(TENANT, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT status, result, claimedBy FROM job_run WHERE runId = $r`,
        { r: runId },
      );
      return (rows as any[])[0];
    });
    expect(afterComplete.status).toBe('succeeded');
    expect(afterComplete.result).toEqual({ ok: true, summarized: 42 });
    expect(afterComplete.claimedBy).toBeFalsy();
  }, 60_000);

  it('claimNext returns null when no pending rows are visible', async () => {
    const got = await claim.claimNext({
      companyId: TENANT,
      jobType: 'compaction',
      ttlSeconds: 60,
    });
    expect(got).toBeNull();
  });

  it('renew pushes leaseUntil forward and bubbles cancelRequested', async () => {
    const { runId } = await claim.enqueue({
      jobType: 'compaction',
      companyId: TENANT,
      triggeredBy: 'cron',
    });
    const claimed = await claim.claimNext({
      companyId: TENANT,
      jobType: 'compaction',
      ttlSeconds: 30,
    });
    expect(claimed?.runId).toBe(runId);

    const r1 = await claim.renew({
      companyId: TENANT,
      recordId: claimed!.recordId,
      ttlSeconds: 60,
    });
    expect(r1.stillOwned).toBe(true);
    expect(r1.cancelRequested).toBe(false);

    // Flip cancelRequested via the operator path (UPDATE on job_run).
    await surreal.withCompany(TENANT, async (db) => {
      await db.query(
        `UPDATE job_run SET cancelRequested = true WHERE runId = $r`,
        { r: runId },
      );
    });
    const r2 = await claim.renew({
      companyId: TENANT,
      recordId: claimed!.recordId,
      ttlSeconds: 60,
    });
    expect(r2.stillOwned).toBe(true);
    expect(r2.cancelRequested).toBe(true);

    await claim.cancelled({
      companyId: TENANT,
      recordId: claimed!.recordId,
    });
  }, 60_000);

  it('dedup collision returns the existing runId (created=false)', async () => {
    const a = await claim.enqueue({
      jobType: 'calibration_refit',
      companyId: TENANT,
      triggeredBy: 'cron',
      dedupKey: 'cal_2030-01-01',
    });
    expect(a.created).toBe(true);

    const b = await claim.enqueue({
      jobType: 'calibration_refit',
      companyId: TENANT,
      triggeredBy: 'cron',
      dedupKey: 'cal_2030-01-01',
    });
    expect(b.created).toBe(false);
    expect(b.runId).toBe(a.runId);
  }, 60_000);

  it('fail requeues with backoff while attempts < maxAttempts', async () => {
    const { runId } = await claim.enqueue({
      jobType: 'source_trust_refit',
      companyId: TENANT,
      triggeredBy: 'cron',
    });
    const claimed = await claim.claimNext({
      companyId: TENANT,
      jobType: 'source_trust_refit',
      ttlSeconds: 60,
    });
    expect(claimed?.runId).toBe(runId);

    const out = await claim.fail({
      companyId: TENANT,
      recordId: claimed!.recordId,
      attempts: 1,
      error: { message: 'transient boom' },
      maxAttempts: 3,
      backoffBaseMs: 1000,
    });
    expect(out.requeued).toBe(true);

    // Row should be pending again with visibleAfter in the future.
    const row = await surreal.withCompany(TENANT, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT status, visibleAfter FROM job_run WHERE runId = $r`,
        { r: runId },
      );
      return (rows as any[])[0];
    });
    expect(row.status).toBe('pending');
    expect(Date.parse(row.visibleAfter)).toBeGreaterThan(Date.now());
  }, 60_000);

  it('reapZombies recycles a stale running row back to pending', async () => {
    const { runId } = await claim.enqueue({
      jobType: 'reindex_embeddings',
      companyId: TENANT,
      triggeredBy: 'cron',
    });
    const claimed = await claim.claimNext({
      companyId: TENANT,
      jobType: 'reindex_embeddings',
      ttlSeconds: 60,
    });
    expect(claimed).not.toBeNull();

    // Force the lease into the past.
    await surreal.withCompany(TENANT, async (db) => {
      await db.query(
        `UPDATE type::thing($rid) SET leaseUntil = type::datetime($t)`,
        { rid: claimed!.recordId, t: new Date(Date.now() - 60_000).toISOString() },
      );
    });

    const out = await claim.reapZombies({
      companyId: TENANT,
      maxAttempts: 3,
      backoffBaseMs: 1000,
    });
    expect(out.requeued).toBe(1);

    const row = await surreal.withCompany(TENANT, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT status, claimedBy FROM job_run WHERE runId = $r`,
        { r: runId },
      );
      return (rows as any[])[0];
    });
    expect(row.status).toBe('pending');
    expect(row.claimedBy).toBeFalsy();
  }, 60_000);

  it('reapZombies abandons a stale row at/above maxAttempts (ZombieAbandoned)', async () => {
    // Distinct dedupKey: a prior test already enqueued a no-dedupKey
    // reindex_embeddings row, and the (jobType, dedupKey) unique index would
    // collide on ['reindex_embeddings', NONE] for a second keyless enqueue.
    const { runId } = await claim.enqueue({
      jobType: 'reindex_embeddings',
      companyId: TENANT,
      triggeredBy: 'cron',
      dedupKey: 'zombie_abandon_test',
    });

    // Drive THIS row (by runId) directly into a stale-running state at the
    // attempts cap, rather than via claimNext — a prior reap test leaves a
    // pending row of another jobType, so claimNext is nondeterministic here.
    // This isolates the requeue/abandon split in fn::reap_zombies (0038).
    await surreal.withCompany(TENANT, async (db) => {
      await db.query(
        `UPDATE job_run SET
            status = 'running', claimedBy = 'dead-worker', attempts = 3,
            leaseUntil = type::datetime($t)
         WHERE runId = $r`,
        { r: runId, t: new Date(Date.now() - 60_000).toISOString() },
      );
    });

    const out = await claim.reapZombies({
      companyId: TENANT,
      maxAttempts: 3,
      backoffBaseMs: 1000,
    });
    expect(out.failed).toBe(1);
    expect(out.requeued).toBe(0);

    const row = await surreal.withCompany(TENANT, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT status, claimedBy, error.name AS errName, finishedAt FROM job_run WHERE runId = $r`,
        { r: runId },
      );
      return (rows as any[])[0];
    });
    expect(row.status).toBe('failed');
    expect(row.claimedBy).toBeFalsy();
    expect(row.errName).toBe('ZombieAbandoned');
    expect(row.finishedAt).toBeTruthy();
  }, 60_000);
});

describe('LeaderLeaseService — real Surreal end-to-end', () => {
  let moduleRef: TestingModule;
  let surreal: SurrealService;
  let leader: LeaderLeaseService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [SurrealService, LeaderLeaseService],
    }).compile();
    await moduleRef.init();
    surreal = moduleRef.get(SurrealService);
    leader = moduleRef.get(LeaderLeaseService);
  }, 60_000);

  afterAll(async () => {
    if (moduleRef) await moduleRef.close();
  });

  it('tryAcquire writes a row to the system database', async () => {
    const ok = await leader.tryAcquire('test_lease_a', 60);
    expect(ok).toBe(true);

    // Verify the row landed in the `system` DB (withAdminDb), not a
    // tenant `co_*` DB.
    const rows = await leader.list();
    const target = rows.find((r) => r.name === 'test_lease_a');
    expect(target).toBeDefined();
    expect(target!.leaderId).toMatch(/.+#\d+/);

    await leader.release('test_lease_a');
  }, 60_000);

  it('tryAcquire returns false when another holder owns an unexpired lease', async () => {
    const a = await leader.tryAcquire('test_lease_b', 60);
    expect(a).toBe(true);

    // Inject a different leaderId for the lease so our re-try is a
    // different identity. We do this by directly UPSERTing in system.
    await surreal.withAdminDb(async (db) => {
      await db.query(
        `UPDATE leader_lease SET leaderId = 'other-pod#1'
          WHERE name = $name`,
        { name: 'test_lease_b' },
      );
    });

    const second = await leader.tryAcquire('test_lease_b', 60);
    expect(second).toBe(false);

    // Cleanup — release fails because we're not the owner, that's
    // expected. Just drop the row.
    await surreal.withAdminDb(async (db) => {
      await db.query(`DELETE FROM leader_lease WHERE name = $name`, {
        name: 'test_lease_b',
      });
    });
  }, 60_000);
});
