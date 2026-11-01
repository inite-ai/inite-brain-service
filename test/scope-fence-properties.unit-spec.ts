/**
 * Properties of the scope fence (ground rule 2: never weaken tenancy or
 * per-user scope), checked over generated records and principals rather
 * than a handful of hand-picked rows. Seeded, so a failure reproduces;
 * no dependency, so nothing new ships.
 *
 *  1. A tenant-global row (`scope = []`) is visible to every principal.
 *  2. Holding more tags never hides a row (principal monotonicity).
 *  3. A record with more tags is never visible to more principals.
 *  4. A malformed or unknown-namespace tag hides the row from every
 *     scoped principal (fail closed).
 *  5. One user never sees a row carrying another user's tag.
 *  6. A tenant-wide principal sees every row.
 *  7. The SQL fence a search leg appends keeps exactly the rows
 *     `visibleUnderScope` keeps, for a user-bound principal.
 */
import { TENANT_WIDE, scopeFenceSql, visibleUnderScope } from '../src/auth/scope-visibility';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20261101);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const USERS = ['u1', 'u2', 'u3'];
const VALID = [...USERS.map((u) => `user:${u}`), 'team:gl1:sre', 'team:gl1:ops', 'org:acme'];
const MALFORMED = ['nonsense', 'user:', ':u1', 'galaxy:u1', 'circle'];

function tags(n: number, pool: readonly string[]): string[] {
  const out = new Set<string>();
  while (out.size < n) out.add(pick(pool));
  return [...out];
}
const RUNS = 2000;

describe('scope fence — properties over generated rows and principals', () => {
  it('1. a tenant-global row is visible to every principal', () => {
    for (let i = 0; i < RUNS; i++) {
      expect(visibleUnderScope([], tags(Math.floor(rnd() * 4), VALID))).toBe(true);
    }
    expect(visibleUnderScope([], TENANT_WIDE)).toBe(true);
  });

  it('2. holding more tags never hides a row', () => {
    for (let i = 0; i < RUNS; i++) {
      const record = tags(Math.floor(rnd() * 3), VALID);
      const principal = tags(Math.floor(rnd() * 3), VALID);
      const wider = [...new Set([...principal, ...tags(1 + Math.floor(rnd() * 2), VALID)])];
      if (visibleUnderScope(record, principal)) {
        expect(visibleUnderScope(record, wider)).toBe(true);
      }
    }
  });

  it('3. a record with more tags is never visible to more principals', () => {
    for (let i = 0; i < RUNS; i++) {
      const record = tags(Math.floor(rnd() * 3), VALID);
      const narrower = [...new Set([...record, ...tags(1, VALID)])];
      const principal = tags(Math.floor(rnd() * 4), VALID);
      if (visibleUnderScope(narrower, principal)) {
        expect(visibleUnderScope(record, principal)).toBe(true);
      }
    }
  });

  it('4. a malformed or unknown tag hides the row from every scoped principal', () => {
    for (let i = 0; i < RUNS; i++) {
      const bad = pick(MALFORMED);
      const record = [...tags(Math.floor(rnd() * 2), VALID), bad];
      // Even a principal that "holds" the bad string does not see the row.
      const principal = [...tags(Math.floor(rnd() * 4), VALID), bad];
      expect(visibleUnderScope(record, principal)).toBe(false);
    }
  });

  it("5. one user never sees a row carrying another user's tag", () => {
    for (let i = 0; i < RUNS; i++) {
      const [a, b] = tags(2, USERS);
      const record = [
        `user:${b}`,
        ...tags(
          Math.floor(rnd() * 2),
          VALID.filter((t) => !t.startsWith('user:')),
        ),
      ];
      const principal = [
        `user:${a}`,
        ...tags(
          Math.floor(rnd() * 3),
          VALID.filter((t) => t !== `user:${b}`),
        ),
      ];
      expect(visibleUnderScope(record, principal)).toBe(false);
    }
  });

  it('6. a tenant-wide principal sees every row', () => {
    for (let i = 0; i < RUNS; i++) {
      const record = tags(Math.floor(rnd() * 3), [...VALID, ...MALFORMED]);
      expect(visibleUnderScope(record, TENANT_WIDE)).toBe(true);
    }
  });
});

describe('scope fence — the SQL a search leg appends agrees with the semantics', () => {
  const saved = process.env.SCOPE_TAGS_ENABLED;
  beforeAll(() => {
    process.env.SCOPE_TAGS_ENABLED = '1';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.SCOPE_TAGS_ENABLED;
    else process.env.SCOPE_TAGS_ENABLED = saved;
  });

  /** Evaluates the fence shapes scopeFenceSql emits against one row's scope. */
  function evaluate(clause: string, params: Record<string, unknown>, scope: string[]): boolean {
    const eq = /^AND \(scope = \[\] OR scope = \[\$(\w+)\]\)$/.exec(clause);
    if (eq) return scope.length === 0 || (scope.length === 1 && scope[0] === params[eq[1]!]);
    const inside = /^AND \(scope = \[\] OR scope ALLINSIDE \$(\w+)\)$/.exec(clause);
    if (inside) {
      const held = params[inside[1]!] as string[];
      return scope.length === 0 || scope.every((t) => held.includes(t));
    }
    throw new Error(`unexpected fence shape: ${clause}`);
  }

  it('7. for a user-bound principal, the clause keeps exactly the visible rows', () => {
    for (let i = 0; i < RUNS; i++) {
      const user = pick(USERS);
      const { clause, params } = scopeFenceSql(user);
      const record = tags(Math.floor(rnd() * 3), [...VALID, ...MALFORMED]);
      expect(evaluate(clause, params, record)).toBe(visibleUnderScope(record, [`user:${user}`]));
    }
  });

  it('a tenant-wide caller gets no clause: the tenant boundary is the database', () => {
    expect(scopeFenceSql(undefined)).toEqual({ clause: '', params: {} });
  });
});
