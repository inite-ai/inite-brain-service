/**
 * GATE: from 0197 on, a schema migration is DDL only; a row fix is a data
 * migration (src/db/data-migrations/, AGENTS.md ground rule 1).
 *
 * Why: on SurrealDB 3.2.4 an `UPDATE t … WHERE` whose filter is planned
 * through an index on the filtered field is a silent no-op. 0182's backfill
 * and 0164's second backfill each left production rows unfixed while the
 * migrator recorded them applied, and a backfill in a schema file runs on
 * the request path, unbatched, in the one transaction per file. A data
 * migration counts what is left, fixes it by explicit record id in batches
 * in the background, and is marked done only when a re-count finds none.
 *
 * Checked over TOP-LEVEL statements (test/surql-statements.ts): bodies of
 * DEFINE FUNCTION / DEFINE EVENT run later, on the request path, and stay
 * allowed — as is any DEFINE / REMOVE / ALTER. Everything else that
 * writes (UPDATE, UPSERT, DELETE, INSERT, RELATE, CREATE, or a LET / FOR /
 * IF wrapping one) fails. Files before 0197 shipped already and are left
 * as they are.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leadingKeyword, oneLine, splitStatements, type SurqlStatement } from './surql-statements';

const MIGRATIONS_DIR = join(__dirname, '../src/db/migrations');
const FIRST_DDL_ONLY = 197;

const SCHEMA_KEYWORDS = new Set(['DEFINE', 'REMOVE', 'ALTER', 'OPTION', 'USE', 'INFO']);
const WRITES = /\b(UPDATE|UPSERT|DELETE|INSERT|RELATE|CREATE)\b/i;

/** The offending text of a statement, or null when it is DDL. */
function dataLeg(stmt: SurqlStatement): string | null {
  if (SCHEMA_KEYWORDS.has(leadingKeyword(stmt))) return null;
  return WRITES.test(stmt.masked) ? oneLine(stmt) : null;
}

function ddlOnlyFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.surql$/.test(f) && Number(f.slice(0, 4)) >= FIRST_DDL_ONLY)
    .sort();
}

describe('GATE: schema migrations from 0197 are DDL only', () => {
  it('finds 0197', () => {
    expect(ddlOnlyFiles()).toContain('0197_data_migration_ledger.surql');
  });

  it('no top-level statement writes rows (write a DataMigration instead)', () => {
    const offenders: string[] = [];
    for (const file of ddlOnlyFiles()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      for (const stmt of splitStatements(sql)) {
        const leg = dataLeg(stmt);
        if (leg) offenders.push(`${file}: ${leg.slice(0, 160)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  describe('the detector', () => {
    const legs = (sql: string) =>
      splitStatements(sql)
        .map(dataLeg)
        .filter((l): l is string => l !== null);

    it('flags every top-level write form', () => {
      const sql = `
        UPDATE knowledge_edge SET a = 1 WHERE a IS NONE;
        UPSERT t:1 SET a = 1;
        DELETE t WHERE a = 1;
        INSERT INTO t { a: 1 };
        RELATE a:1->e->b:1;
        CREATE t SET a = 1;
        LET $x = (UPDATE t SET a = 1);
        FOR $r IN (SELECT id FROM t) { UPDATE $r.id SET a = 1; };`;
      expect(legs(sql)).toHaveLength(8);
    });

    it('allows DDL, including write statements inside function and event bodies', () => {
      const sql = `
        -- an UPDATE in a comment is not a statement
        DEFINE TABLE IF NOT EXISTS t SCHEMAFULL PERMISSIONS FOR select, create, update, delete FULL;
        DEFINE FIELD IF NOT EXISTS a ON t TYPE option<int>;
        DEFINE INDEX IF NOT EXISTS t_a ON t FIELDS a;
        DEFINE FUNCTION OVERWRITE fn::fix($id: record<t>) { UPDATE $id SET a = 1; DELETE u WHERE b = $id; };
        DEFINE EVENT OVERWRITE e ON t WHEN $event = 'DELETE' THEN { DELETE u WHERE b = $before.id };
        REMOVE INDEX IF EXISTS old ON t;
        DEFINE FIELD OVERWRITE note ON t TYPE string DEFAULT 'UPDATE me';`;
      expect(legs(sql)).toEqual([]);
    });
  });
});
