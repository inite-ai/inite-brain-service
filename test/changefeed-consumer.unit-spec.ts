/**
 * Unit-test for ChangefeedDrainService.consumeForTenant — exercises
 * the cursor-advance + batch-cap + audit-event-emit paths without
 * standing up a real SurrealDB testcontainer.
 *
 * Closes the Phase 2 audit gap (migration 0002 declared CHANGEFEED
 * 30d INCLUDE ORIGINAL but no consumer existed). We assert:
 *   1. A cold cursor (lastVersionstamp=0) consumes every change.
 *   2. perBatchLimit caps the batch and leaves pendingRemaining > 0.
 *   3. Cursor is advanced to the highest consumed versionstamp — in the
 *      SAME transaction as the INSERT (R4 #3 atomicity).
 *   4. The UPDATE post-image is read from `current`, not the reverse patch
 *      array under `update` (R4 #3 post-image parsing).
 *   5. Each event carries a deterministic record id so a re-drain is a
 *      no-op via INSERT IGNORE (R4 #3 idempotency).
 */
import { StringRecordId } from 'surrealdb';
import { ChangefeedDrainService } from '../src/audit/changefeed-drain.service';

type Captured = { sql: string; params?: Record<string, unknown> | undefined };

function mkSurreal(opts: {
  cursors?: Record<string, number>;
  changes?: Record<string, Array<Record<string, unknown>>>;
}) {
  const calls: Captured[] = [];
  const cursors = { ...(opts.cursors ?? {}) };
  const changes = opts.changes ?? {};
  // Mirror INSERT IGNORE semantics: a re-inserted primary key is skipped, so
  // the store tracks which deterministic ids have already landed.
  const inserted = new Set<string>();
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
      // The drain now composes the INSERT + cursor UPSERT into ONE
      // BEGIN…COMMIT block (runTransaction), so both statements — and their
      // merged params — arrive in a single query() call.
      if (sql.includes('INSERT IGNORE INTO audit_event')) {
        for (const e of (params?.events as Array<{ id: unknown }> | undefined) ?? []) {
          inserted.add(String(e.id));
        }
      }
      if (sql.includes('UPSERT changefeed_state')) {
        cursors[params?.source as string] = params?.vs as number;
      }
      return [[], [], []];
    },
  };
  return {
    db,
    calls,
    inserted,
    surreal: {
      withCompany: async (_c: string, fn: (d: any) => Promise<any>) => fn(db),
    },
  };
}

function mkSvc(surreal: any, cfgOverrides: Record<string, string> = {}): ChangefeedDrainService {
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'AUDIT_CHANGEFEED_ENABLED') return cfgOverrides[k] ?? '1';
      if (k === 'AUDIT_CHANGEFEED_BATCH') return cfgOverrides[k] ?? '500';
      return def;
    },
  } as any;
  return new ChangefeedDrainService(surreal, config);
}

/** The transaction call that carries the INSERT + cursor UPSERT (one block). */
function drainTx(calls: Captured[]): Captured | undefined {
  return calls.find(
    (c) =>
      c.sql.includes('INSERT IGNORE INTO audit_event') && c.sql.includes('UPSERT changefeed_state'),
  );
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

    // ATOMICITY: the INSERT and the cursor advance ride ONE transaction
    // (a crash can't insert events without advancing the cursor, or vice
    // versa). Exactly one such block for the single (tenant × source).
    const tx = drainTx(calls);
    expect(tx).toBeTruthy();
    // versionstamps are normalised to bigint (u64 on 3.x overflows number).
    expect(tx!.params?.vs).toBe(12n);
    expect(calls.filter((c) => c.sql.includes('INSERT IGNORE INTO audit_event'))).toHaveLength(1);

    const events = (tx!.params?.events ?? []) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    // DETERMINISTIC id: <source>_<versionstamp>_<ordinal>, as the record id
    // (StringRecordId), so a re-drain collides and INSERT IGNORE no-ops it.
    expect(events[0]!.id).toBeInstanceOf(StringRecordId);
    expect(String(events[0]!.id)).toBe('audit_event:knowledge_entity_10_0');
    expect(String(events[1]!.id)).toBe('audit_event:knowledge_entity_12_0');

    // SHOW CHANGES must carry a LIMIT so a cold cursor can't materialise
    // the whole 30-day retention into the process.
    const show = calls.find((c) => c.sql.startsWith('SHOW CHANGES'));
    expect(show).toBeTruthy();
    expect(show!.sql).toMatch(/LIMIT \d+/);
  });

  it('reads the UPDATE post-image from `current`, not the reverse patch array', async () => {
    // INCLUDE ORIGINAL shape: row under `current`, a reverse PATCH ARRAY under
    // `update`. The old Object.keys(item)[0] read the patch array → garbage
    // `after` and an empty recordId. The helper must read `current`.
    const { surreal, calls } = mkSurreal({
      changes: {
        knowledge_fact: [
          {
            versionstamp: 30,
            changes: [
              {
                current: { id: 'knowledge_fact:p1', status: 'superseded', object: 'secret' },
                update: [{ op: 'change', path: '/status', value: 'x' }],
              },
            ],
          },
        ],
      },
    });
    const svc = mkSvc(surreal);
    await svc.consumeForTenant('co_a');
    const events = (drainTx(calls)!.params?.events ?? []) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]!.op).toBe('update');
    expect(events[0]!.recordId).toBe('knowledge_fact:p1');
    const after = events[0]!.after as Record<string, unknown>;
    expect(after.status).toBe('superseded'); // post-image, not the patch op
    expect(after.object).toBe('[redacted]'); // value field still redacted
    expect(Array.isArray(after)).toBe(false);
  });

  it('is idempotent: a re-drain of the same window inserts no duplicates', async () => {
    const changeSet = {
      knowledge_entity: [
        { versionstamp: 10, changes: [{ update: { id: 'knowledge_entity:a' } }] },
        { versionstamp: 12, changes: [{ update: { id: 'knowledge_entity:b' } }] },
      ],
    };
    const { surreal, inserted } = mkSurreal({ changes: changeSet });
    const svc = mkSvc(surreal);
    await svc.consumeForTenant('co_a');
    expect(inserted.size).toBe(2);

    // Re-drain the SAME window (cursor reset to 0) — deterministic ids collide
    // and INSERT IGNORE no-ops them, so the row count is unchanged.
    const {
      surreal: surreal2,
      inserted: inserted2,
      calls: calls2,
    } = mkSurreal({
      cursors: {},
      changes: changeSet,
    });
    // Seed the store with the same ids the first drain would have written.
    inserted2.add('audit_event:knowledge_entity_10_0');
    inserted2.add('audit_event:knowledge_entity_12_0');
    const svc2 = mkSvc(surreal2);
    await svc2.consumeForTenant('co_a');
    // The INSERT still fires (IGNORE), but produces the SAME two ids → no growth.
    expect(inserted2.size).toBe(2);
    const events = (drainTx(calls2)!.params?.events ?? []) as Array<Record<string, unknown>>;
    expect(events.map((e) => String(e.id))).toEqual([
      'audit_event:knowledge_entity_10_0',
      'audit_event:knowledge_entity_12_0',
    ]);
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
    const tx = drainTx(calls);
    expect(((tx!.params?.events ?? []) as unknown[]).length).toBe(1);
    expect(tx!.params?.vs).toBe(14n);
  });

  it('emits nothing on a second tick with no new writes past the cursor', async () => {
    // Two ticks, the only change is at the cursor boundary → 0 new emits.
    const { surreal, calls } = mkSurreal({
      cursors: { knowledge_fact: 20 },
      changes: {
        knowledge_fact: [{ versionstamp: 20, changes: [{ update: { id: 'knowledge_fact:x' } }] }],
      },
    });
    const svc = mkSvc(surreal);
    const r = await svc.consumeForTenant('co_a');
    expect(r.consumed).toEqual({});
    expect(calls.filter((c) => c.sql.includes('INSERT IGNORE INTO audit_event'))).toHaveLength(0);
  });

  it('emits no audit_event rows when the source returns nothing', async () => {
    const { surreal, calls } = mkSurreal({});
    const svc = mkSvc(surreal);
    const r = await svc.consumeForTenant('co_a');
    expect(r.consumed).toEqual({});
    expect(calls.filter((c) => c.sql.includes('INSERT IGNORE INTO audit_event'))).toHaveLength(0);
  });
});
