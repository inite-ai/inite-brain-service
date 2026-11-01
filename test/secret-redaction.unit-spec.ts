import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIN_TOKEN_LENGTH,
  RANDOM_TOKEN_MISS_RATE,
  SECRET_MASK,
  redactSecrets,
} from '../src/common/secret-redaction';
import { redactPiiWithReport } from '../src/ingest/ingest-utils';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A seeded random base62 run — credential-shaped without being anyone's credential. */
function token(len: number, seed: number): string {
  let a = seed >>> 0;
  let s = '';
  for (let i = 0; i < len; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    s += BASE62[((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 62) | 0];
  }
  return s;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}
/**
 * Best of three runs in CPU time spent by this process (user + system), in
 * ms. Wall-clock time on a loaded machine counts the time other processes
 * held the cores and made these comparisons flaky; CPU time is what the
 * scan itself costs.
 */
function bestOf3(fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = process.cpuUsage();
    fn();
    const used = process.cpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}

/** Growth of the cost from n to 4n: ~4 when linear, ~16 when quadratic. */
function growth(make: (n: number) => string, n: number): number {
  const small = make(n);
  const large = make(4 * n);
  const tSmall = bestOf3(() => redactSecrets(small));
  const tLarge = bestOf3(() => redactSecrets(large));
  return tLarge / Math.max(tSmall, 1);
}
/** Scans that do real work; a loaded CI runner must not turn them into timeouts. */
const HEAVY_TIMEOUT_MS = 120_000;
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('redactSecrets', () => {
  it.each([
    ['a provider key with a prefix', `here's the key: ${'sk-' + 'proj-' + token(40, 1)} use it`],
    ['a personal access token', `token ${'gh' + 'p_' + token(36, 2)}`],
    ['a 40-char cloud secret', `AWS secret is ${token(40, 3)}`],
    ['a bare high-entropy token', token(32, 4)],
  ])('masks %s', (_label, text) => {
    const out = redactSecrets(text);
    expect(out.found).toBe(true);
    expect(out.text).toContain(SECRET_MASK);
    expect(out.text).not.toMatch(/[A-Za-z0-9]{24,}/);
  });

  it('masks a JWT whole', () => {
    const jwt = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'u1', iat: 1 })}.${token(43, 5)}`;
    expect(redactSecrets(`cookie=${jwt};`).text).toBe(`cookie=${SECRET_MASK};`);
  });

  it('masks the credential after Bearer and keeps the scheme', () => {
    const out = redactSecrets('Authorization: Bearer abc.def-ghi_jkl~mno+pqr');
    expect(out.text).toBe(`Authorization: Bearer ${SECRET_MASK}`);
  });

  it('masks a PEM private key block', () => {
    const pem = [
      '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
      token(64, 6),
      token(64, 7),
      '-----END ' + 'OPENSSH PRIVATE KEY-----',
    ].join('\n');
    expect(redactSecrets(`key:\n${pem}\nthanks`).text).toBe(`key:\n${SECRET_MASK}\nthanks`);
  });

  it(
    'scans a crafted run of JWT prefixes in linear time',
    () => {
      const hostile = (n: number) => 'eyJ-'.repeat(n);
      expect(redactSecrets(hostile(1_000)).text).toBe(hostile(1_000));
      expect(growth(hostile, 60_000)).toBeLessThan(8);
    },
    HEAVY_TIMEOUT_MS,
  );

  it('masks a JWT that follows other dotted text', () => {
    const jwt = `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u1' })}.${token(43, 11)}`;
    expect(redactSecrets(`v1.token.${jwt}.tail`).text).toBe(`v1.token.${SECRET_MASK}.tail`);
  });

  it(
    'scans unterminated PEM headers in linear time',
    () => {
      const hostile = (n: number) =>
        ('-----BEGIN ' + 'RSA PRIVATE KEY-----' + 'x'.repeat(40)).repeat(n);
      expect(redactSecrets(hostile(100)).found).toBe(false);
      expect(growth(hostile, 10_000)).toBeLessThan(8);
    },
    HEAVY_TIMEOUT_MS,
  );

  it.each([
    ['a git SHA', 'reverted 42054561b9e3c1d0a7f6e5d4c3b2a1908f7e6d5c in main'],
    ['a UUID', 'session 759048f0-75c5-4dab-81ce-c7432f9c8a54 ended'],
    ['a record id', 'see knowledge_fact:e8pzw7nsdbg2l5e9s598'],
    ['a long identifier', 'the extractorRunnerServiceInstanceFactory2 method'],
    ['a path', 'edit test/fact-valid-time-resolver.e2e-spec.ts and src/ingest/ingest-utils.ts'],
    ['a URL', 'docs at https://github.com/inite-ai/inite-brain-service/pull/861'],
    ['dates and prose', 'Moved to Lisbon on 2026-03-14; budget is 2500 now.'],
  ])('leaves %s alone', (_label, text) => {
    expect(redactSecrets(text)).toEqual({ text, found: false });
  });

  it(
    'catches random tokens of every length at the miss rate it is built for',
    () => {
      let missed = 0;
      let total = 0;
      for (let len = MIN_TOKEN_LENGTH; len <= 64; len++) {
        for (let seed = 0; seed < 25; seed++) {
          total += 1;
          if (!redactSecrets(token(len, len * 1000 + seed)).found) missed += 1;
        }
      }
      // Binomial slack over the α the null quantile is taken at.
      expect(missed / total).toBeLessThan(RANDOM_TOKEN_MISS_RATE * 3);
    },
    HEAVY_TIMEOUT_MS,
  );

  it(
    'flags no identifier, path or literal in this codebase',
    () => {
      const runs = new Set<string>();
      for (const file of sourceFiles(join(__dirname, '..', 'src'))) {
        for (const m of readFileSync(file, 'utf8').matchAll(/[A-Za-z0-9+/=_-]{20,}/g))
          runs.add(m[0]);
      }
      expect(runs.size).toBeGreaterThan(1000);
      const flagged = [...runs].filter((r) => redactSecrets(r).found);
      expect(flagged).toEqual([]);
    },
    HEAVY_TIMEOUT_MS,
  );
});

describe('redactPiiWithReport — credentials', () => {
  it('reports the secret class and masks the token before the digit rules see it', () => {
    const key = 'sk-' + token(48, 9);
    const { text, classes } = redactPiiWithReport(`mail me@x.io the key ${key}`);
    expect(text).toBe(`mail [EMAIL] the key ${SECRET_MASK}`);
    expect(classes.sort()).toEqual(['email', 'secret']);
  });
});
