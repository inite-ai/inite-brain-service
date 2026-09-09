import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Truth test for CI change detection (scripts/ci/change-buckets.mjs).
 *
 * The hazard this exists to prevent: a path-based filter that misses an
 * entry SILENTLY SKIPS the gate that would have caught the regression.
 * deploy-brain.yml's allowlist (#516) is guarded by deriving its
 * expectations from the Dockerfile, because the Dockerfile mechanically
 * answers "what enters the image". Nothing mechanically answers "what
 * could break a gate" — a spec may read any file in the repo — so this
 * test derives the answer from the specs themselves.
 *
 * The classifier is exercised as a SUBPROCESS, not an import: that is the
 * exact entrypoint CI runs, exit code included, and it sidesteps ESM/CJS
 * interop between an .mjs script and a ts-jest CommonJS test module.
 */

const ROOT = join(__dirname, '..');
const CLASSIFY = join(ROOT, 'scripts', 'ci', 'classify-changes.mjs');

/** Run the real classifier over a changed-file list; return its outputs. */
function classify(files: string[]): { engine: boolean; web: boolean; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ci-buckets-'));
  const outFile = join(dir, 'github_output');
  writeFileSync(outFile, '');

  const log = execFileSync('node', [CLASSIFY], {
    input: files.join('\n'),
    env: { ...process.env, GITHUB_OUTPUT: outFile },
    encoding: 'utf8',
  });

  const written = readFileSync(outFile, 'utf8');
  return {
    engine: /^engine=true$/m.test(written),
    web: /^web=true$/m.test(written),
    log,
  };
}

/**
 * Every repo-relative path a spec reads via `__dirname`-anchored joins.
 *
 * Two shapes appear in this repo and both are matched:
 *   join(__dirname, '..', 'docs', 'openapi.json')
 *   join(__dirname, '../src/db/migrations')
 * Only the leading literal segments are reconstructed — a path built from
 * a variable stops the walk, which is safe: a partial prefix still lands
 * in the right bucket, and bucket membership is all this test asks.
 */
function specReadPaths(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const specDir = join(ROOT, 'test');

  for (const name of readdirSync(specDir)) {
    if (!name.endsWith('-spec.ts')) continue;
    const source = readFileSync(join(specDir, name), 'utf8');

    // `[^)]*` rather than a repeated `(?:'…'\s*,?\s*)+` group: the latter
    // nests two optional-whitespace quantifiers inside a `+`, which is the
    // classic exponential-backtracking shape (CodeQL js/redos flagged it,
    // correctly). A path literal never contains `)`, so a flat negated
    // class captures the same argument list in linear time.
    for (const call of source.matchAll(/__dirname\s*,([^)]*)\)/g)) {
      const literals = [...(call[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
      const segments: string[] = [];
      for (const literal of literals) {
        for (const part of literal.split('/')) {
          if (part === '' || part === '.') continue;
          if (part === '..') {
            segments.pop();
            continue;
          }
          segments.push(part);
        }
      }
      if (segments.length === 0) continue;
      const path = segments.join('/');
      const owners = found.get(path) ?? [];
      owners.push(`test/${name}`);
      found.set(path, owners);
    }
  }

  return found;
}

describe('CI change detection is deny-list shaped and cannot silently skip a gate', () => {
  it('classifies an unrecognised path as engine, so a new directory runs everything', () => {
    const { engine } = classify(['some-brand-new-top-level-thing/file.ts']);
    expect(engine).toBe(true);
  });

  it('runs nothing for a docs-only change', () => {
    const { engine, web } = classify(['docs/architecture.md', 'README.md']);
    expect(engine).toBe(false);
    expect(web).toBe(false);
  });

  it('runs nothing engine-side for a monitoring-only change', () => {
    const { engine, web } = classify(['monitoring/alerts/rules.yml']);
    expect(engine).toBe(false);
    expect(web).toBe(false);
  });

  it('runs only the web gates for a landing-only change', () => {
    const { engine, web } = classify(['brain-landing/app/[lang]/page.tsx']);
    expect(engine).toBe(false);
    expect(web).toBe(true);
  });

  it('runs only the engine gates for a src-only change', () => {
    const { engine, web } = classify(['src/search/search.service.ts']);
    expect(engine).toBe(true);
    expect(web).toBe(false);
  });

  it('runs everything when the CI workflow itself changes', () => {
    // A pipeline edit whose own verdict you cannot see on the PR that
    // introduces it is unreviewable.
    const { engine, web } = classify(['.github/workflows/ci.yml']);
    expect(engine).toBe(true);
    expect(web).toBe(true);
  });

  it('runs everything when the change-detection scripts themselves change', () => {
    const { engine, web } = classify(['scripts/ci/change-buckets.mjs']);
    expect(engine).toBe(true);
    expect(web).toBe(true);
  });

  it('treats an empty diff as "run everything", never as "skip everything"', () => {
    const { engine, web } = classify([]);
    expect(engine).toBe(true);
    expect(web).toBe(true);
  });

  it('classifies a mixed change as the union of its buckets', () => {
    const { engine, web } = classify(['src/app.module.ts', 'brain-landing/next.config.ts']);
    expect(engine).toBe(true);
    expect(web).toBe(true);
  });
});

describe('no gate-bearing file hides inside a skip bucket', () => {
  /**
   * THE load-bearing assertion. Every path a spec reads must run the
   * engine gates when it changes. If a spec starts reading docs/, this
   * fails and names both the path and the spec — the skip bucket is then
   * either wrong or needs a SKIP_EXCEPTIONS entry.
   */
  it('every path read by a spec still triggers the engine gates', () => {
    const offenders: string[] = [];

    for (const [path, owners] of specReadPaths()) {
      if (!existsSync(join(ROOT, path))) continue;
      const { engine } = classify([path]);
      if (!engine) offenders.push(`${path} (read by ${owners.join(', ')})`);
    }

    expect(offenders).toEqual([]);
  });

  it('the known exceptions are real — each is inside a skip bucket and read by a spec', () => {
    // Guards the other direction: SKIP_EXCEPTIONS must not rot into a
    // dumping ground of paths nobody reads, which would quietly widen
    // the engine trigger back to "everything" and defeat the point.
    const source = readFileSync(join(ROOT, 'scripts', 'ci', 'change-buckets.mjs'), 'utf8');
    const block = /export const SKIP_EXCEPTIONS = \[([^\]]*)\]/.exec(source);
    expect(block).not.toBeNull();

    const exceptions = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(exceptions.length).toBeGreaterThan(0);

    const read = specReadPaths();
    for (const exception of exceptions) {
      expect(existsSync(join(ROOT, exception))).toBe(true);
      expect(read.has(exception)).toBe(true);
    }
  });
});
