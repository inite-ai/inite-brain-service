/**
 * R4 #3 — the audit changefeed drain against a real SurrealDB (v3.2.4).
 *
 * Proves the correctness fix end-to-end:
 *   - CREATE / UPDATE / DELETE round-trip through `SHOW CHANGES` into
 *     audit_event, with the UPDATE post-image read from `current` (the old
 *     drain read the reverse PATCH ARRAY under `update` and lost every update).
 *   - Atomic insert + cursor: after a drain the events are present AND the
 *     changefeed_state cursor has advanced (they ride one transaction).
 *   - Idempotent re-drain: resetting the cursor and draining the same window
 *     again produces NO duplicate audit_event rows (deterministic record id +
 *     INSERT IGNORE).
 *
 * This is the flag-independent path — consumeForTenant() runs regardless of
 * AUDIT_CHANGEFEED_ENABLED (only the cron tick is gated), so the drain logic
 * is exercised directly.
 */
import { StringRecordId } from 'surrealdb';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { ChangefeedDrainService } from '../src/audit/changefeed-drain.service';

describe('changefeed drain: create/update/delete + idempotent re-drain', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_changefeed_drain_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('captures post-images (UPDATE from current) atomically and re-drains idempotently', async () => {
    const surreal = f.app.get(SurrealService);
    const drain = f.app.get(ChangefeedDrainService);

    // Precondition: ensure the CHANGEFEED is live on knowledge_entity.
    // migration 0002 declares it via `DEFINE TABLE IF NOT EXISTS … CHANGEFEED`,
    // but on SurrealDB 3.x that is a NO-OP when 0001 already created the table
    // (verified: the clause is silently dropped) — so a tenant DB first created
    // under 3.x, like this ephemeral testcontainer, has no changefeed. Tenants
    // migrated under v2.x (where IF NOT EXISTS DID apply the clause) still carry
    // it. OVERWRITE re-applies the table-level attribute; fields/indexes persist.
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        'DEFINE TABLE OVERWRITE knowledge_entity SCHEMAFULL CHANGEFEED 30d INCLUDE ORIGINAL',
      );
    });

    // Seed CREATE → UPDATE → DELETE on a CHANGEFEED table (each is its own
    // versionstamp). `type` is a STRUCTURAL field, so its post-image value
    // survives redaction and proves the drain read `current`, not the patch
    // array. `canonicalName` is a value field and must come back redacted.
    const entityId = await surreal.withCompany(f.companyId, async (db) => {
      const [created] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity SET type = 'other', canonicalName = 'Secret Person',
           externalRefs = {} RETURN id`,
      );
      const id = String((created as Array<{ id: unknown }>)[0]!.id);
      await db.query(`UPDATE $id SET type = 'staff', canonicalName = 'Renamed Person'`, {
        id: new StringRecordId(id),
      });
      await db.query(`DELETE $id`, { id: new StringRecordId(id) });
      return id;
    });

    // One drain pass covers all three changes.
    const r1 = await drain.consumeForTenant(f.companyId);
    expect(r1.consumed.knowledge_entity).toBeGreaterThanOrEqual(3);

    const events = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT op, recordId, versionstamp, after FROM audit_event
           WHERE source = 'knowledge_entity' ORDER BY versionstamp ASC`,
      );
      return (rows as Array<Record<string, unknown>>) ?? [];
    });

    const byOp = (op: string) => events.filter((e) => e.op === op);
    expect(byOp('create')).toHaveLength(1);
    expect(byOp('update')).toHaveLength(1);
    expect(byOp('delete')).toHaveLength(1);

    // CREATE post-image: the original structural value, value field redacted.
    const createAfter = byOp('create')[0]!.after as Record<string, unknown>;
    expect(createAfter.type).toBe('other');
    expect(String(createAfter.id)).toBe(entityId);
    expect(createAfter.canonicalName).toBe('[redacted]');

    // UPDATE post-image: the NEW structural value, read from `current`. The
    // bug read the reverse patch array here and dropped it entirely.
    const updateEv = byOp('update')[0]!;
    const updateAfter = updateEv.after as Record<string, unknown>;
    expect(updateAfter.type).toBe('staff');
    expect(String(updateAfter.id)).toBe(entityId);
    expect(updateAfter.canonicalName).toBe('[redacted]');
    expect(String(updateEv.recordId)).toBe(entityId);

    // DELETE: id only, no post-image.
    const deleteEv = byOp('delete')[0]!;
    expect(String(deleteEv.recordId)).toBe(entityId);
    expect(deleteEv.after == null).toBe(true);

    // ATOMICITY: the events landed AND the cursor advanced together.
    const cursorAfter = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ lastVersionstamp: number }>]>(
        `SELECT lastVersionstamp FROM changefeed_state
           WHERE source = 'knowledge_entity' LIMIT 1`,
      );
      return (rows as Array<{ lastVersionstamp: number }>)[0]?.lastVersionstamp ?? 0;
    });
    expect(cursorAfter).toBeGreaterThan(0);

    // IDEMPOTENCY: reset the cursor and re-drain the SAME window. Deterministic
    // ids collide, INSERT IGNORE no-ops the duplicates, count is unchanged.
    const countAll = () =>
      surreal.withCompany(f.companyId, async (db) => {
        const [rows] = await db.query<[Array<{ n: number }>]>(
          `SELECT count() AS n FROM audit_event WHERE source = 'knowledge_entity' GROUP ALL`,
        );
        return (rows as Array<{ n: number }>)[0]?.n ?? 0;
      });

    const before = await countAll();
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `UPSERT changefeed_state:['knowledge_entity'] CONTENT {
            source: 'knowledge_entity', lastVersionstamp: 0, updatedAt: time::now() }`,
      );
    });
    await drain.consumeForTenant(f.companyId);
    const after = await countAll();
    expect(after).toBe(before);
  });
});
