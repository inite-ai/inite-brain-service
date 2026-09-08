import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_CATALOG } from '../src/admin/config-catalog.data';

/**
 * The space state machine says what it does — in BOTH directions.
 *
 * The finding (embedding-spaces-2026-09 §2 D2/D3): `activeSpaceFor` and
 * `targetSpaceFor` have zero callers outside their own class, so the
 * per-tenant cutover atomically flips a field nothing reads. An operator
 * could run the documented three-step migration to completion and change
 * nothing — while the two flags' catalogue entries, which are the
 * operator's contract and what GET /v1/admin/config serves, claimed that
 * "reads resolve the tenant's active space" and that dual-write produces
 * "new writes in BOTH the active and target space".
 *
 * The machinery is deliberately kept: it is exactly what programme items
 * E7-E9 reuse, and deleting it would throw away the state row, the atomic
 * cutover statement and the resolver that the migration path needs. What
 * is not kept is the pretence.
 *
 * This gate is two-way on purpose:
 *   - while the resolvers are unwired, the catalogue MUST warn;
 *   - the moment E9 wires them, the first assertion fails and forces the
 *     warning to be removed rather than left to rot into the opposite lie.
 */
const SRC = join(__dirname, '..', 'src');
const SERVICE = join(SRC, 'ai', 'embedder', 'embedding-space.service.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Prose about a resolver must not count as a call to it — neither in a
 * comment nor inside a description string (the catalogue entry this gate
 * checks names `targetSpaceFor()` in its own text, and the config-catalog
 * truth spec excludes that file for the same reason).
 */
const stripProse = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");

/** Files that CALL `resolver(` outside the class that defines it. */
function callersOf(resolver: string): string[] {
  const call = new RegExp(`\\b${resolver}\\s*\\(`);
  return walk(SRC)
    .filter((f) => f !== SERVICE && !f.endsWith('config-catalog.data.ts'))
    .filter((f) => call.test(stripProse(readFileSync(f, 'utf8'))))
    .map((f) => f.slice(SRC.length + 1));
}

const entry = (key: string) => CONFIG_CATALOG.find((e) => e.key === key)!;

describe('embedding-space wiring truth', () => {
  it('activeSpaceFor is still unwired, and EMBEDDING_SPACE_ACTIVE says so', () => {
    const callers = callersOf('activeSpaceFor');
    if (callers.length === 0) {
      // Unwired ⇒ the flag must not promise serving behaviour.
      expect(entry('EMBEDDING_SPACE_ACTIVE').description).toMatch(/NOT YET WIRED/);
    } else {
      // Wired (E9 landed) ⇒ the warning is now the lie. Remove it, and say
      // what the flag really does.
      expect(entry('EMBEDDING_SPACE_ACTIVE').description).not.toMatch(/NOT YET WIRED/);
    }
  });

  it('targetSpaceFor is still unwired, and EMBEDDING_SPACE_DUAL_WRITE says so', () => {
    const callers = callersOf('targetSpaceFor');
    if (callers.length === 0) {
      expect(entry('EMBEDDING_SPACE_DUAL_WRITE').description).toMatch(/NOT YET WIRED/);
    } else {
      expect(entry('EMBEDDING_SPACE_DUAL_WRITE').description).not.toMatch(/NOT YET WIRED/);
    }
  });

  it('the admin controller carries the same warning as the flags', () => {
    // The operator meets the flag description first and the route second;
    // they must not disagree.
    // Collapse the JSDoc leader + wrapping so the phrase is matched as
    // prose rather than as a particular line break.
    const controller = readFileSync(
      join(SRC, 'admin', 'admin-embedding-space.controller.ts'),
      'utf8',
    )
      .replace(/^\s*\*/gm, ' ')
      .replace(/\s+/g, ' ');
    const unwired = callersOf('activeSpaceFor').length === 0;
    expect(/have no callers outside their own class/.test(controller)).toBe(unwired);
  });
});
