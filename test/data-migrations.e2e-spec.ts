/**
 * Data migrations against a REAL SurrealDB (0197 + src/db/data-migrations/).
 * The point of the mechanism is that the fix lands where 0182 / 0164's
 * `UPDATE knowledge_edge … WHERE` did not: with the indexes on validUntil
 * and resolutionCheckedAt in place, rows are seeded in the shapes
 * production holds, the runner works through them in batches of one, and
 * the ledger says done only once a re-count finds none left.
 */
import { StringRecordId, type Surreal } from 'surrealdb';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { DATA_MIGRATIONS, type DataMigration } from '../src/db/data-migrations/data-migration';
import { DataMigrationRunnerService } from '../src/db/data-migrations/data-migration-runner.service';
import { runDataMigrations } from '../src/db/data-migrations/run-data-migrations';

interface EdgeRow {
  validFrom?: unknown;
  validUntil?: unknown;
  invalidatedAt?: unknown;
  resolutionCheckedAt?: unknown;
}

describe('data migrations (real SurrealDB)', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_data_migrations_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const db = <T>(fn: (d: Surreal) => Promise<T>) =>
    f.app.get(SurrealService).withCompany(f.companyId, fn);

  const entity = (name: string) =>
    db(async (d) => {
      const [rows] = await d.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity CONTENT { type: 'other', canonicalName: $name }`,
        { name },
      );
      return String(rows[0]!.id);
    });

  const edge = (kind: string, content: Record<string, unknown>) =>
    db(async (d) => {
      const [a, b] = [await entity(`${kind}-a`), await entity(`${kind}-b`)];
      const [rows] = await d.query<[Array<{ id: unknown }>]>(
        `RELATE $from->knowledge_edge->$to CONTENT $content RETURN AFTER`,
        {
          from: new StringRecordId(a),
          to: new StringRecordId(b),
          content: { kind, weight: 1, source: { vertical: 'chat' }, ...content },
        },
      );
      return String(rows[0]!.id);
    });

  const read = (id: string) =>
    db(async (d) => {
      const [rows] = await d.query<[EdgeRow[]]>(
        `SELECT validFrom, validUntil, invalidatedAt, resolutionCheckedAt FROM $id`,
        { id: new StringRecordId(id) },
      );
      return rows[0]!;
    });

  it('fixes every seeded shape, leaves the rest alone, and verifies before marking done', async () => {
    const created = new Date('2026-01-10T00:00:00Z');
    const closed = new Date('2026-02-01T00:00:00Z');
    // Pre-0164: the valid-time close sits in invalidatedAt only.
    const pre0164 = [];
    for (let i = 0; i < 3; i++)
      pre0164.push(await edge(`pre_${i}`, { createdAt: created, invalidatedAt: closed }));
    // Closed on the valid axis, never marked checked (0182's miss).
    const unchecked = await edge('unchecked', {
      createdAt: created,
      validFrom: created,
      validUntil: closed,
      invalidatedAt: closed,
    });
    // Open, written without a start (the dreams identity_of link).
    const startless = await edge('identity_of', { createdAt: created });
    // Controls: open with a start; stated only as ending (start unknown on purpose).
    const control = await edge('control', { createdAt: created, validFrom: created });
    const endsLater = await edge('ends_later', {
      createdAt: created,
      validUntil: new Date('2999-01-01T00:00:00Z'),
    });

    const migrations = f.app.get<DataMigration[]>(DATA_MIGRATIONS);
    const before = await db(async (d) => Promise.all(migrations.map((m) => m.pending(d))));
    // endsLater is closed on the valid axis too, so 0182's rule marks it checked.
    expect(before).toEqual([3, 5, 1]);

    const run = await db((d) =>
      runDataMigrations(d, migrations, { deadline: Date.now() + 60_000, batchSize: 1 }),
    );
    expect(run.outcomes.map((o) => [o.id, o.fixed, o.remaining, o.done])).toEqual([
      ['edge_valid_until_from_invalidated', 3, 0, true],
      ['edge_resolution_checked', 5, 0, true],
      ['edge_valid_from_created', 1, 0, true],
    ]);

    for (const id of pre0164) {
      const e = await read(id);
      expect(new Date(e.validUntil as string)).toEqual(closed);
      expect(new Date(e.validFrom as string)).toEqual(created);
      expect(e.resolutionCheckedAt).toBeDefined();
    }
    expect((await read(unchecked)).resolutionCheckedAt).toBeDefined();
    expect(new Date((await read(startless)).validFrom as string)).toEqual(created);
    expect((await read(control)).resolutionCheckedAt).toBeUndefined();
    expect((await read(endsLater)).validFrom).toBeUndefined();

    const ledger = await db(async (d) => {
      const [rows] = await d.query<
        [Array<{ status: string; fixed: number; verifiedAt?: unknown }>]
      >(`SELECT status, fixed, verifiedAt FROM data_migration`);
      return rows;
    });
    expect(ledger).toHaveLength(3);
    for (const row of ledger) {
      expect(row.status).toBe('done');
      expect(row.verifiedAt).toBeDefined();
    }
  });

  it('the job handler skips what is verified done', async () => {
    const result = await f.app.get(DataMigrationRunnerService).runTenant(f.companyId);
    expect(result).toMatchObject({ alreadyDone: 3, budgetExhausted: false, outcomes: [] });
  });
});
