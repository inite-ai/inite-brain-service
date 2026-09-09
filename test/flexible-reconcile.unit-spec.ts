/**
 * 0135_flexible_reconcile is DERIVED from the migrations before it. These
 * pin the derivation (last declaration wins, clauses carried verbatim,
 * IF NOT EXISTS becomes OVERWRITE, a later non-FLEXIBLE redefinition drops
 * the field) and that the committed file is what the generator produces.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectFlexibleFields,
  renderFlexibleReconcile,
  statementsOf,
} from '../src/db/flexible-fields';

const MIGRATIONS = join(__dirname, '..', 'src', 'db', 'migrations');

function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'flex-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql, 'utf8');
  return dir;
}

describe('collectFlexibleFields', () => {
  it('keeps the LATEST declaration per field, carries its clauses verbatim, and drops fields later redefined without FLEXIBLE', () => {
    const dir = fixtureDir({
      '0001_a.surql': `
        -- a comment; with a semicolon
        DEFINE TABLE IF NOT EXISTS t SCHEMAFULL;
        DEFINE FIELD IF NOT EXISTS meta ON t TYPE option<object> FLEXIBLE;
        DEFINE FIELD IF NOT EXISTS gone ON t TYPE object FLEXIBLE;
        DEFINE FIELD IF NOT EXISTS items ON t TYPE array DEFAULT [];
        DEFINE FIELD IF NOT EXISTS items.* ON t TYPE object FLEXIBLE;
        DEFINE FIELD IF NOT EXISTS plain ON t TYPE string;`,
      '0002_b.surql': `
        DEFINE FIELD OVERWRITE meta ON t TYPE option<object> FLEXIBLE PERMISSIONS
            FOR select WHERE
                kind != 'secret';
        DEFINE FIELD OVERWRITE gone ON t TYPE object;`,
      '0135_flexible_reconcile.surql': `DEFINE FIELD OVERWRITE never ON t TYPE object FLEXIBLE;`,
      'notes.txt': 'DEFINE FIELD IF NOT EXISTS ignored ON t TYPE object FLEXIBLE;',
    });
    const out = collectFlexibleFields(dir);
    expect(out.map((d) => `${d.table}.${d.field}`)).toEqual(['t.items.*', 't.meta']);
    const meta = out.find((d) => d.field === 'meta')!;
    expect(meta.migration).toBe('0002_b.surql');
    expect(meta.statement).toBe(
      `DEFINE FIELD OVERWRITE meta ON t TYPE option<object> FLEXIBLE PERMISSIONS
            FOR select WHERE
                kind != 'secret'`,
    );
    const items = out.find((d) => d.field === 'items.*')!;
    expect(items.statement).toBe('DEFINE FIELD OVERWRITE items.* ON t TYPE object FLEXIBLE');
  });

  it('splits statements on semicolons after stripping line comments', () => {
    expect(statementsOf(`A; -- x; y\nB;\n-- C;\n`)).toEqual(['A', 'B']);
  });
});

describe('0135_flexible_reconcile.surql', () => {
  const declarations = collectFlexibleFields(MIGRATIONS);

  it('is exactly what the generator produces (regenerate: pnpm migrations:flexible)', () => {
    const committed = readFileSync(join(MIGRATIONS, '0135_flexible_reconcile.surql'), 'utf8');
    expect(committed).toBe(renderFlexibleReconcile(declarations));
  });

  it('covers the whole class, including the job_run fields 0134 repaired by hand', () => {
    const keys = new Set(declarations.map((d) => `${d.table}.${d.field}`));
    for (const k of [
      'job_run.error',
      'job_run.payload',
      'job_run.progress',
      'job_run.result',
      'knowledge_fact.objectMeta',
      'knowledge_entity.externalRefs',
      'debug_trace.spans.*',
      'memory_episode.stateDeltas',
    ]) {
      expect(keys).toContain(k);
    }
    // Array containers are not FLEXIBLE themselves — only their elements.
    expect(keys).not.toContain('debug_trace.spans');
    // objectMeta's latest declaration is 0057's, PERMISSIONS and all.
    const objectMeta = declarations.find((d) => d.field === 'objectMeta')!;
    expect(objectMeta.migration).toBe('0057_abac_db_fence.surql');
    expect(objectMeta.statement).toContain('fn::policy_row_denied');
    expect(declarations.length).toBeGreaterThanOrEqual(40);
  });
});
