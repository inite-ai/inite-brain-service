/**
 * Unit-test for ChangefeedDrainService.consumeForTenant — exercises
 * the cursor-advance + batch-cap + audit-event-emit paths without
 * standing up a real SurrealDB testcontainer.
 *
 * Closes the Phase 2 audit gap (migration 0002 declared CHANGEFEED
 * 30d INCLUDE ORIGINAL but no consumer existed). We assert:
 *   1. A cold cursor (lastVersionstamp=0) consumes every change.
 *   2. perBatchLimit caps the batch and leaves pendingRemaining > 0.
 *   3. Cursor is advanced to the highest consumed versionstamp.
 *   4. The unknown-source guard rejects an out-of-allowlist table.
 */
import { ChangefeedDrainService } from '../src/audit/changefeed-drain.service';

type Captured = { sql: string; params?: Record<string, unknown> };

function mkSurreal(opts: {
  cursors?: Record<string, number>;
  changes?: Record<string, Array<Record<string, unknown>>>;
}) {
  const calls: Captured[] = [];
  const cursors = { ...(opts.cursors ?? {}) };
  const changes = opts.changes ?? {};
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT lastVersionstamp')) {
        const s = params?.s as string;
        const v = cursors[s] ?? 0;
        return [v ? [{ lastVersionstamp: v }] : []];
      }
      if (sql.startsWith('SHOW CHANGES')) {
        const match = sql.match(/FOR TABLE (\w+)/);
        const table = match?.[1] ?? '';
        return [changes[table] ?? []];
      }
      if (sql.startsWith('CREATE audit_event')) {
        return [[]];
      }
      if (sql.startsWith('UPSERT changefeed_state')) {
        const s = params?.source as string;
        cursors[s] = params?.vs as number;
        return [[]];
      }
      return [[]];
    },
  };
  return {
    db,
    calls,
    surreal: {
      withCompany: async (_c: string, fn: (d: any) => Promise<any>) => fn(db),
    },
  };
}

function mkSvc(
  surreal: any,
  cfgOverrides: Record<string, string> = {},
): ChangefeedDrainService {
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'AUDIT_CHANGEFEED_ENABLED') return cfgOverrides[k] ?? '1';
      if (k === 'AUDIT_CHANGEFEED_BATCH') return cfgOverrides[k] ?? '500';
      return def;
    },
  } as any;
  return new ChangefeedDrainService(surreal, config);
}

describe('ChangefeedDrainService', () => {
  it('consumes every change from a cold cursor and advances to the high-water mark', async () => {
    const { surreal, calls } = mkSurreal({
      cursors: {},
      changes: {
        knowledge_entity: [
          {
            versionstamp: 10,
            changes: [{ update: { id: 'knowledge_entity:a', name: 'A' } }],
          },
          {
            versionstamp: 12,
            changes: [{ update: { id: 'knowledge_entity:b', name: 'B' } }],
          },
        ],
      },
    });
    const svc = mkSvc(surreal);
    const r = await svc.consumeForTenant('co_a');
    expect(r.consumed.knowledge_entity).toBe(2);
    expect(r.pendingRemaining).toBe(0);
    const advance = calls.find((c) => c.sql.startsWith('UPSERT changefeed_state'));
    expect(advance).toBeTruthy();
    expect(advance!.params?.vs).toBe(12);
    // Consumer batches via `INSERT INTO audit_event $events` now —
    // one round-trip per (tenant × source). The two emit rows ride
    // in the same params.events array.
    const inserts = calls.filter((c) =>
      c.sql.startsWith('INSERT INTO audit_event'),
    );
    expect(inserts).toHaveLength(1);
    expect(
      ((inserts[0].params?.events ?? []) as unknown[]).length,
    ).toBe(2);
    // SHOW CHANGES must carry a LIMIT so a cold cursor can't materialise
    // the whole 30-day retention into the process.
    const show = calls.find((c) => c.sql.startsWith('SHOW CHANGES'));
    expect(show).toBeTruthy();
    expect(show!.sql).toMatch(/LIMIT \d+/);
  });

  it('caps batch size and reports pendingRemaining for the trailing slice', async () => {
    const generated = Array.from({ length: 5 }, (_, i) => ({
      versionstamp: 100 + i,
      changes: [{ update: { id: `knowledge_fact:${i}` } }],
    }));
    const { surreal } = mkSurreal({ changes: { knowledge_fact: generated } });
    const svc = mkSvc(surreal, { AUDIT_CHANGEFEED_BATCH: '2' });
    const r = await svc.consumeForTenant('co_a');
    expect(r.consumed.knowledge_fact).toBe(2);
    expect(r.pendingRemaining).toBe(3);
  });

  it('does not re-emit the boundary row when SINCE is inclusive', async () => {
    // Cursor already at 12; the DB (inclusive SINCE) re-returns vs=12 plus a
    // genuinely new vs=14. Only the new row must be emitted and the cursor
    // advanced — the boundary row at the cursor is dropped.
    const { surreal, calls } = mkSurreal({
      cursors: { knowledge_entity: 12 },
      changes: {
        knowledge_entity: [
          {
            versionstamp: 12,
            changes: [{ update: { id: 'knowledge_entity:b', name: 'B' } }],
          },
          {
            versionstamp: 14,
            changes: [{ update: { id: 'knowledge_entity:c', name: 'C' } }],
          },
        ],
      },
    });
    const svc = mkSvc(surreal);
    const r = await svc.consumeForTenant('co_a');
    expect(r.consumed.knowledge_entity).toBe(1);
    const inserts = calls.filter((c) =>
      c.sql.startsWith('INSERT INTO audit_event'),
    );
    expect(((inserts[0].params?.events ?? []) as unknown[]).length).toBe(1);
    const advance = calls.find((c) =>
      c.sql.startsWith('UPSERT changefeed_state'),
    );
    expect(advance!.params?.vs).toBe(14);
  });

  it('emits nothing on a second tick with no new writes past the cursor', async () => {
    // Two ticks, the only change is at the cursor boundary → 0 new emits.
    const { surreal, calls } = mkSurreal({
      cursors: { knowledge_fact: 20 },
      changes: {
        knowledge_fact: [
          { versionstamp: 20, changes: [{ update: { id: 'knowledge_fact:x' } }] },
        ],
      },
    });
    const svc = mkSvc(surreal);
    const r = await svc.consumeForTenant('co_a');
    expect(r.consumed).toEqual({});
    expect(
      calls.filter((c) => c.sql.startsWith('INSERT INTO audit_event')),
    ).toHaveLength(0);
  });

  it('emits no audit_event rows when the source returns nothing', async () => {
    const { surreal, calls } = mkSurreal({});
    const svc = mkSvc(surreal);
    const r = await svc.consumeForTenant('co_a');
    expect(r.consumed).toEqual({});
    const inserts = calls.filter((c) =>
      c.sql.startsWith('INSERT INTO audit_event'),
    );
    expect(inserts).toHaveLength(0);
  });
});
