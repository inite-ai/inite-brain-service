/**
 * 0135_flexible_reconcile against a REAL SurrealDB (testcontainers, v3.2.4).
 *
 * The drift: a stored field definition that lost FLEXIBLE while the
 * migration ledger says its migration ran. A fresh tenant cannot be in that
 * state, so this suite MANUFACTURES it — OVERWRITE a few varied fields
 * without the flag — shows the production symptom, then re-applies 0135 and
 * shows every declared FLEXIBLE field carries the flag again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { collectFlexibleFields } from '../src/db/flexible-fields';

const MIGRATIONS = join(__dirname, '..', 'src', 'db', 'migrations');
const RECONCILE = readFileSync(join(MIGRATIONS, '0135_flexible_reconcile.surql'), 'utf8');

/** The stored DDL of every field on a table, as INFO FOR TABLE reports it. */
type FieldDdl = Record<string, string>;

describe('0135 FLEXIBLE reconcile: drift manufactured, symptom shown, class repaired', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  const declarations = collectFlexibleFields(MIGRATIONS);

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_flexible_drift_e2e' });
    surreal = f.app.get(SurrealService);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const fieldsOf = (table: string) =>
    surreal.withCompany(f.companyId, async (db) => {
      const [info] = await db.query<[{ fields?: FieldDdl }]>(`INFO FOR TABLE ${table};`);
      return (info as { fields?: FieldDdl } | undefined)?.fields ?? {};
    });

  it('a freshly migrated tenant carries FLEXIBLE on every declared field', async () => {
    const byTable = new Map<string, string[]>();
    for (const d of declarations) byTable.set(d.table, [...(byTable.get(d.table) ?? []), d.field]);
    for (const [table, fields] of byTable) {
      const ddl = await fieldsOf(table);
      for (const field of fields) {
        expect(`${table}.${field}: ${ddl[field]}`).toMatch(/FLEXIBLE/);
      }
    }
  });

  it('manufactured drift reproduces the production symptom, and re-applying 0135 repairs the whole class', async () => {
    // Four shapes: option<object>, object with DEFAULT, an array element,
    // and the PERMISSIONS-carrying objectMeta.
    const drifted = [
      { table: 'job_run', field: 'error' },
      { table: 'knowledge_entity', field: 'externalRefs' },
      { table: 'debug_trace', field: 'spans.*' },
      { table: 'knowledge_fact', field: 'objectMeta' },
    ];
    await surreal.withCompany(f.companyId, async (db) => {
      for (const { table, field } of drifted) {
        const decl = declarations.find((d) => d.table === table && d.field === field)!;
        // The same declaration with the flag removed — what the data cut left.
        await db.query(decl.statement.replace(/\s+FLEXIBLE\b/, ''));
      }
    });
    for (const { table, field } of drifted) {
      expect((await fieldsOf(table))[field]).not.toMatch(/FLEXIBLE/);
    }

    // The 2026-09-09 production symptom: fn::reap_zombies writing error.message.
    await expect(
      surreal.withCompany(f.companyId, (db) =>
        db.query(
          `CREATE job_run:drift_probe SET runId = 'drift-probe', jobType = 'probe', status = 'running', startedAt = time::now(), visibleAfter = time::now(), error = { message: 'boom' }`,
        ),
      ),
    ).rejects.toThrow(/error\.message|no such field/i);

    await surreal.withCompany(f.companyId, (db) => db.query(RECONCILE));

    for (const d of declarations) {
      expect(`${d.table}.${d.field}: ${(await fieldsOf(d.table))[d.field]}`).toMatch(/FLEXIBLE/);
    }
    const written = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ error?: { message?: string } }>]>(
        `CREATE job_run:drift_probe2 SET runId = 'drift-probe-2', jobType = 'probe', status = 'running', startedAt = time::now(), visibleAfter = time::now(), error = { message: 'boom' } RETURN error`,
      );
      return (rows as Array<{ error?: { message?: string } }>)[0]?.error?.message;
    });
    expect(written).toBe('boom');
  });
});
