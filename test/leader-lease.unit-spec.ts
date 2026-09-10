/**
 * LeaderLeaseService against a scripted SurrealService: the fencing epoch
 * acquire() returns, the boolean tryAcquire() wrapper over it, and the
 * point read behind isHeld().
 */
import { LeaderLeaseService } from '../src/jobs/leader-lease.service';
import { PROCESS_IDENTITY } from '../src/common/process-identity';

interface QueryCall {
  sql: string;
  params?: Record<string, unknown> | undefined;
}

function mkSurreal(steps: Array<(call: QueryCall) => unknown[] | Error>) {
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
  const surreal = { withAdminDb: async <T>(fn: (d: any) => Promise<T>) => fn(db) } as any;
  return { surreal, calls };
}

describe('LeaderLeaseService', () => {
  it('acquire returns the epoch the transaction committed; tryAcquire is its boolean', async () => {
    // 3.x slot shape for the 2-statement tx: [BEGIN, LET, IF/RETURN, COMMIT].
    const { surreal, calls } = mkSurreal([
      () => [null, null, 4, null],
      () => [null, null, 4, null],
    ]);
    const svc = new LeaderLeaseService(surreal);
    expect(await svc.acquire('worker_loop', 90)).toBe(4);
    expect(await svc.tryAcquire('worker_loop', 90)).toBe(true);
    expect(calls[0]!.params).toMatchObject({ name: 'worker_loop', me: PROCESS_IDENTITY });
    // A change of holder bumps the epoch; the same holder keeps it.
    expect(calls[0]!.sql).toContain(
      'IF $row.leaderId = $me { $row.epoch OR 0 } ELSE { ($row.epoch OR 0) + 1 }',
    );
    expect(calls[0]!.sql).toContain('epoch: $epoch');
  });

  it('acquire returns null (tryAcquire false) while another holder has an unexpired lease', async () => {
    const { surreal } = mkSurreal([() => [null, null, null, null], () => [null, null, null, null]]);
    const svc = new LeaderLeaseService(surreal);
    expect(await svc.acquire('worker_loop', 90)).toBeNull();
    expect(await svc.tryAcquire('worker_loop', 90)).toBe(false);
  });

  it('acquire treats a datastore failure as not-leader', async () => {
    const { surreal } = mkSurreal([() => new Error('connection reset')]);
    const svc = new LeaderLeaseService(surreal);
    expect(await svc.acquire('worker_loop', 90)).toBeNull();
  });

  it('isHeld is true only for our identity, an unexpired lease, and the epoch we hold', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 1_000).toISOString();
    const rows: unknown[][] = [
      [{ leaderId: PROCESS_IDENTITY, leaseUntil: future, epoch: 2 }],
      [
        {
          leaderId: 'other-host#7#00000000-0000-0000-0000-000000000000',
          leaseUntil: future,
          epoch: 3,
        },
      ],
      [{ leaderId: PROCESS_IDENTITY, leaseUntil: past, epoch: 2 }],
      [{ leaderId: PROCESS_IDENTITY, leaseUntil: future, epoch: 3 }],
      [], // row wiped
    ];
    const { surreal, calls } = mkSurreal(rows.map((r) => () => [r]));
    const svc = new LeaderLeaseService(surreal);
    expect(await svc.isHeld('worker_loop', 2)).toBe(true);
    expect(await svc.isHeld('worker_loop', 2)).toBe(false);
    expect(await svc.isHeld('worker_loop', 2)).toBe(false);
    expect(await svc.isHeld('worker_loop', 2)).toBe(false);
    expect(await svc.isHeld('worker_loop', 2)).toBe(false);
    // A point read on the record id, not a table scan.
    expect(calls[0]!.sql).toContain("FROM type::record('leader_lease:' + $name)");
    expect(calls[0]!.sql).not.toContain('WHERE');
  });

  it('isHeld without an epoch checks holder and expiry only', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { surreal } = mkSurreal([
      () => [[{ leaderId: PROCESS_IDENTITY, leaseUntil: future, epoch: 9 }]],
    ]);
    expect(await new LeaderLeaseService(surreal).isHeld('worker_loop')).toBe(true);
  });

  it('isHeld answers false when the read fails — not knowing is not holding', async () => {
    const { surreal } = mkSurreal([() => new Error('pool closed')]);
    expect(await new LeaderLeaseService(surreal).isHeld('worker_loop', 1)).toBe(false);
  });

  it('without a datastore the lease is always ours at epoch 0', async () => {
    const svc = new LeaderLeaseService();
    expect(await svc.acquire('worker_loop')).toBe(0);
    expect(await svc.tryAcquire('worker_loop')).toBe(true);
    expect(await svc.isHeld('worker_loop', 0)).toBe(true);
  });
});
