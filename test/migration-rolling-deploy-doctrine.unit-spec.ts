/**
 * GATE: a migration must stay callable by the image it is rolling out
 * FROM, not only the one it is rolling out TO.
 *
 * During a rolling deploy both images serve at once, and the new image's
 * migrations land while the old one is still taking requests. Two
 * consequences, one enforceable here and one not:
 *
 * ENFORCED — stored-function signatures. `DEFINE FUNCTION OVERWRITE
 * fn::x(...)` replaces the deployed definition for BOTH images. Measured
 * against SurrealDB 3.2.4: a call passing more arguments than the
 * definition takes fails ("Incorrect arguments for function fn::t(). The
 * function expects 1 to 2 arguments"), while trailing `option<...>`
 * parameters may be omitted and arrive as NONE. So the safe shape is
 * append-only: every parameter the previous definition had must survive
 * at the same position with the same name and type, and anything added
 * must be trailing and optional. Renaming, retyping, reordering or
 * dropping a parameter breaks the old image mid-deploy — and, on a
 * rollback, breaks the older image against the newer schema.
 *
 * NOT ENFORCED — a migration that DROPS schema (`REMOVE INDEX`,
 * `REMOVE FIELD`, `REMOVE TABLE`) must ship one release AFTER the code
 * that declares or reads it is gone, so the still-running old image
 * never queries a field the new migration removed. Checking that needs
 * the PREVIOUS image's source to know what it still reads, which CI does
 * not have. It stays a review rule, recorded here so it is at least
 * written down next to the rule that is mechanised.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitStatements } from './surql-statements';

const MIGRATIONS_DIR = join(__dirname, '../src/db/migrations');

interface FnDefinition {
  file: string;
  name: string;
  params: string[];
}

/** `DEFINE FUNCTION [IF NOT EXISTS|OVERWRITE] fn::name($a: type, ...)`. */
const FN_HEAD =
  /^DEFINE\s+FUNCTION\s+(?:IF\s+NOT\s+EXISTS\s+|OVERWRITE\s+)?fn::([\w:]+)\s*\(([^)]*)\)/is;

function functionDefinitions(): FnDefinition[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.surql$/.test(f))
    .sort();
  const found: FnDefinition[] = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const stmt of splitStatements(sql)) {
      const head = FN_HEAD.exec(stmt.masked.trim());
      if (!head) continue;
      const params = head[2]!
        .split(',')
        .map((p) => p.trim().replace(/\s+/g, ' '))
        .filter((p) => p.length > 0);
      found.push({ file, name: head[1]!, params });
    }
  }
  return found;
}

describe('GATE: stored-function signatures are append-only across migrations', () => {
  const definitions = functionDefinitions();

  it('parses the stored functions out of the manifest', () => {
    expect(definitions.length).toBeGreaterThan(20);
    expect(definitions.some((d) => d.name === 'resolve_fact')).toBe(true);
  });

  it('never renames, retypes, reorders or drops a parameter', () => {
    const previous = new Map<string, FnDefinition>();
    const offenders: string[] = [];
    for (const def of definitions) {
      const before = previous.get(def.name);
      previous.set(def.name, def);
      if (!before) continue;
      for (let i = 0; i < before.params.length; i++) {
        const was = before.params[i];
        const now = def.params[i];
        if (was === now) continue;
        offenders.push(
          `fn::${def.name} argument ${i + 1} changed from '${was}' to '${now ?? '<dropped>'}' ` +
            `between ${before.file} and ${def.file}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only ever appends optional parameters', () => {
    const previous = new Map<string, FnDefinition>();
    const offenders: string[] = [];
    for (const def of definitions) {
      const before = previous.get(def.name);
      previous.set(def.name, def);
      if (!before) continue;
      for (const added of def.params.slice(before.params.length)) {
        // The old image calls with the old arity; a required trailing
        // parameter makes every one of those calls fail.
        if (!/:\s*option</i.test(added)) {
          offenders.push(
            `fn::${def.name} gained required argument '${added}' in ${def.file} ` +
              `(previous definition in ${before.file}); make it option<...>`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the redefined functions genuinely redefined (the gate has something to guard)', () => {
    const counts = new Map<string, number>();
    for (const def of definitions) counts.set(def.name, (counts.get(def.name) ?? 0) + 1);
    const redefined = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
    expect(redefined).toContain('resolve_fact');
  });
});
