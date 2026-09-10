/**
 * GATE: every migration must be idempotent IN FORM.
 *
 * The migrator applies a file at most once per database, but "at most
 * once" is not the same as "exactly once, ever": a replica whose lease
 * expired mid-run can be taken over and the file re-applied, an aborted
 * batch is retried in place, and a tenant restored from a snapshot can
 * meet a manifest it has partly seen. A file that is idempotent in form
 * survives all three; one that is not corrupts data the second time it
 * runs.
 *
 * Two rules, checked over TOP-LEVEL statements only (statements inside a
 * DEFINE FUNCTION / DEFINE EVENT body are not executed at migration
 * time):
 *   1. every DEFINE carries `IF NOT EXISTS` or `OVERWRITE`;
 *   2. every data leg (UPDATE / UPSERT / DELETE / CREATE / INSERT, and
 *      FOR loops that write) is guarded, so a second run is a no-op —
 *      either the statement has a WHERE, or a FOR loop's source `LET`
 *      does, or the loop body has an IF.
 *
 * Historical violators are allowlisted BY NAME with a reason. Add to the
 * allowlist only for a file that already shipped; new migrations must
 * pass.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leadingKeyword, oneLine, splitStatements } from './surql-statements';

const MIGRATIONS_DIR = join(__dirname, '../src/db/migrations');

/**
 * Files exempt from rule 2, with the reason. These already shipped: the
 * fix is a follow-up migration, not an edit (migration files are
 * immutable once released).
 */
const UNGUARDED_DATA_LEG_ALLOWLIST: Record<string, string> = {
  '0007_search_haystack.surql':
    'unconditional full-table UPDATE knowledge_fact backfilling searchHaystack; ' +
    'recomputes the same value on a re-run, so it is wasteful rather than wrong',
};

const WRITE_KEYWORDS = new Set(['UPDATE', 'UPSERT', 'DELETE', 'CREATE', 'INSERT', 'RELATE']);
const WRITES_SOMEWHERE = new RegExp(`\\b(${[...WRITE_KEYWORDS].join('|')})\\b`, 'i');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.surql$/.test(f))
    .sort();
}

describe('GATE: migrations are idempotent in form', () => {
  const files = migrationFiles();

  it('finds the manifest', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('every top-level DEFINE carries IF NOT EXISTS or OVERWRITE', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      for (const stmt of splitStatements(sql)) {
        if (leadingKeyword(stmt) !== 'DEFINE') continue;
        if (!/^DEFINE\s+\w+\s+(IF\s+NOT\s+EXISTS|OVERWRITE)\b/i.test(oneLine(stmt))) {
          offenders.push(`${file}: ${oneLine(stmt).slice(0, 100)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every top-level data leg is guarded so a second run is a no-op', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const statements = splitStatements(sql);
      // `FOR $r IN $src { UPDATE ... }` carries its guard in the LET that
      // built $src, so the loop is judged together with that LET.
      const letBodies = new Map<string, string>();
      for (const stmt of statements) {
        const line = oneLine(stmt);
        const bound = /^LET\s+\$(\w+)\s*=/i.exec(line);
        if (bound) letBodies.set(bound[1]!, line);
        const keyword = leadingKeyword(stmt);
        const loop = keyword === 'FOR' ? /^FOR\s+\$\w+\s+IN\s+\$(\w+)\b/i.exec(line) : null;
        const writes =
          WRITE_KEYWORDS.has(keyword) || (keyword === 'FOR' && WRITES_SOMEWHERE.test(line));
        if (!writes) continue;
        const source = loop ? (letBodies.get(loop[1]!) ?? '') : '';
        // A loop may guard either in the LET that built its source or in
        // an IF inside the body; a bare write must carry its own WHERE.
        const guarded =
          /\bWHERE\b/i.test(`${line} ${source}`) || (keyword === 'FOR' && /\bIF\b/i.test(line));
        if (guarded) continue;
        if (UNGUARDED_DATA_LEG_ALLOWLIST[file]) continue;
        offenders.push(`${file}: ${line.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the allowlist names only files that really are unguarded', () => {
    // A stale exemption is as bad as a missing one: it silently blesses
    // the next unguarded statement someone adds to that file.
    const stale: string[] = [];
    for (const file of Object.keys(UNGUARDED_DATA_LEG_ALLOWLIST)) {
      expect(files).toContain(file);
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const unguarded = splitStatements(sql).filter(
        (stmt) => WRITE_KEYWORDS.has(leadingKeyword(stmt)) && !/\bWHERE\b/i.test(oneLine(stmt)),
      );
      if (unguarded.length === 0) stale.push(file);
    }
    expect(stale).toEqual([]);
  });
});
