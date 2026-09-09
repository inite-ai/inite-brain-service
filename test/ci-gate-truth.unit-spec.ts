import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Truth test for the `build-test` aggregating gate (scripts/ci/gate.mjs).
 *
 * `build-test` is a REQUIRED status check on main (alongside supply-chain,
 * trufflehog and lint) and only a repo admin can change that list. The name
 * therefore has to survive the split of the old monolith into parallel
 * jobs, attached to a job that judges rather than tests.
 *
 * Two ways that arrangement goes wrong, both silent, both checked here:
 *
 *   1. A new job is added to ci.yml and nobody adds it to the gate's
 *      `needs:`. It reports its own red X, main's protection does not
 *      require it by name, and the PR merges green. The gate must know
 *      about every job.
 *
 *   2. The gate reads results without expectations. GitHub reports
 *      `skipped` both for "your `if:` said no" and for "your dependency
 *      failed", so a gate that accepts every `skipped` passes a PR whose
 *      jobs never ran. The expectation table fixes that, and this test
 *      pins the table to the YAML so the two cannot drift.
 */

const ROOT = join(__dirname, '..');
const CI_YML = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const GATE_SRC = readFileSync(join(ROOT, 'scripts', 'ci', 'gate.mjs'), 'utf8');
const GATE = join(ROOT, 'scripts', 'ci', 'gate.mjs');

/** The required-check name that branch protection pins. Do not rename. */
const GATE_JOB = 'build-test';

/**
 * Jobs deliberately outside the gate, with the reason each is exempt.
 * Anything not listed here and not in the gate's table fails the test.
 */
const UNGATED: Record<string, string> = {
  'build-test': 'is the gate itself',
  changes: 'is the gate’s own input, judged separately',
  'supply-chain': 'is its own required status check, gated by name on main',
  'real-e2e': 'runs only on manual dispatch with a real OpenAI key',
  'quality-eval': 'runs only on the nightly schedule or manual dispatch',
};

/** Top-level job ids, in file order. */
function ciJobNames(): string[] {
  const jobsBlock = CI_YML.slice(CI_YML.indexOf('\njobs:'));
  return [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1] ?? '');
}

/** The raw text of one job's block. */
function jobBlock(name: string): string {
  const start = CI_YML.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = CI_YML.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Bucket names referenced by a job's `if:` condition. */
function bucketsInJobCondition(name: string): string[] {
  const block = jobBlock(name);
  return [...block.matchAll(/needs\.changes\.outputs\.([a-z]+)/g)].map((m) => m[1] ?? '');
}

/** The expectation table the gate script judges against. */
function gateExpectations(): Record<string, string> {
  const block = /export const EXPECTATIONS = \{([^}]*)\}/.exec(GATE_SRC);
  expect(block).not.toBeNull();
  const table: Record<string, string> = {};
  for (const entry of (block?.[1] ?? '').matchAll(/'?([a-z][a-z0-9-]*)'?\s*:\s*'([a-z]+)'/g)) {
    table[entry[1] ?? ''] = entry[2] ?? '';
  }
  return table;
}

/** Job ids listed in the gate job's `needs:`. */
function gateNeeds(): string[] {
  const block = jobBlock(GATE_JOB);
  const needs = /needs:\s*\[([^\]]*)\]/.exec(block);
  expect(needs).not.toBeNull();
  return (needs?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Run the real gate with a synthetic needs payload; return its exit code. */
function runGate(
  needs: Record<string, { result: string }>,
  selection: { engine: boolean; web: boolean },
): number {
  try {
    execFileSync('node', [GATE], {
      env: {
        ...process.env,
        GATE_NEEDS: JSON.stringify(needs),
        GATE_ENGINE: String(selection.engine),
        GATE_WEB: String(selection.web),
      },
      encoding: 'utf8',
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

/** A full green payload for the given selection. */
function allGreen(selection: {
  engine: boolean;
  web: boolean;
}): Record<string, { result: string }> {
  const needs: Record<string, { result: string }> = { changes: { result: 'success' } };
  for (const [job, bucket] of Object.entries(gateExpectations())) {
    const expected = bucket === 'engine' ? selection.engine : selection.web;
    needs[job] = { result: expected ? 'success' : 'skipped' };
  }
  return needs;
}

describe('the required check keeps its name and covers every job', () => {
  it('ci.yml still defines a job literally named build-test', () => {
    // Renaming this deletes a required status check from main's protection.
    // GitHub's failure mode is the dangerous one: the branch stops
    // requiring the gate rather than blocking on it.
    expect(ciJobNames()).toContain(GATE_JOB);
  });

  it('the gate needs every job that is not explicitly exempt', () => {
    const judged = new Set(gateNeeds());
    const missing = ciJobNames().filter((job) => !judged.has(job) && !(job in UNGATED));
    expect(missing).toEqual([]);
  });

  it('the gate does not need a job that no longer exists', () => {
    const defined = new Set(ciJobNames());
    expect(gateNeeds().filter((job) => !defined.has(job))).toEqual([]);
  });

  it('every judged job has an expectation, and every expectation a job', () => {
    const table = gateExpectations();
    const judged = gateNeeds().filter((job) => job !== 'changes');
    expect(Object.keys(table).sort()).toEqual([...judged].sort());
  });
});

describe('the expectation table matches the conditions in the YAML', () => {
  it('each job gates on exactly the bucket the table says it does', () => {
    for (const [job, bucket] of Object.entries(gateExpectations())) {
      const buckets = bucketsInJobCondition(job);
      expect(buckets.length).toBeGreaterThan(0);
      expect(new Set(buckets)).toEqual(new Set([bucket]));
    }
  });

  it('the gate job itself runs unconditionally', () => {
    // Without always(), the gate inherits the default "skip if a dependency
    // failed" behaviour and never reports at all — which on a required
    // check reads as perpetually pending, not as failed.
    expect(jobBlock(GATE_JOB)).toMatch(/if:\s*always\(\)/);
  });
});

describe('skipped-because-irrelevant passes, skipped-because-broken does not', () => {
  it('passes when every relevant job succeeded', () => {
    expect(runGate(allGreen({ engine: true, web: true }), { engine: true, web: true })).toBe(0);
  });

  it('passes a docs-only change where every job legitimately skipped', () => {
    expect(runGate(allGreen({ engine: false, web: false }), { engine: false, web: false })).toBe(0);
  });

  it('passes an engine-only change where the web job legitimately skipped', () => {
    expect(runGate(allGreen({ engine: true, web: false }), { engine: true, web: false })).toBe(0);
  });

  it('FAILS when a relevant job came back skipped because a dependency broke', () => {
    // This is the case the naive contains(needs.*.result, 'failure') idiom
    // lets through, and the reason this gate exists at all.
    const needs = allGreen({ engine: true, web: true });
    const victim = Object.keys(gateExpectations()).find((j) => gateExpectations()[j] === 'engine');
    expect(victim).toBeDefined();
    needs[victim as string] = { result: 'skipped' };
    expect(runGate(needs, { engine: true, web: true })).toBe(1);
  });

  it('FAILS when a relevant job failed outright', () => {
    const needs = allGreen({ engine: true, web: true });
    needs['engine-unit'] = { result: 'failure' };
    expect(runGate(needs, { engine: true, web: true })).toBe(1);
  });

  it('FAILS when change detection itself failed', () => {
    const needs = allGreen({ engine: true, web: true });
    needs['changes'] = { result: 'failure' };
    expect(runGate(needs, { engine: true, web: true })).toBe(1);
  });

  it('FAILS closed when it is handed no results at all', () => {
    expect(runGate({}, { engine: true, web: true })).toBe(1);
  });

  it('tolerates a job that ran despite not being required to', () => {
    // Change detection erring on the side of running more is never a
    // gate failure; erring on the side of running less always is.
    const needs = allGreen({ engine: false, web: false });
    needs['engine-unit'] = { result: 'success' };
    expect(runGate(needs, { engine: false, web: false })).toBe(0);
  });
});
