import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Truth test for post-deploy verification and the way back.
 *
 * Two properties, both of which regress silently:
 *
 *   1. Each service's smoke test asserts the routes IT owns. On the
 *      shared brain.inite.ai host, Traefik gives /health to the BACKEND
 *      router (PathPrefix, priority 200) and everything else to the
 *      landing's Host-only catch-all. The landing's deploy used to assert
 *      /health, so it was gating its own release on the engine's health —
 *      and a green landing deploy said nothing about landing.
 *
 *   2. A deploy that fails verification has somewhere to go. Before this,
 *      a failed probe dumped logs, exited 1, and left the broken
 *      container running.
 */

const ROOT = join(__dirname, '..');
const SMOKE = join(ROOT, 'scripts', 'ci', 'smoke.mjs');
const BRAIN = readFileSync(join(ROOT, '.github', 'workflows', 'deploy-brain.yml'), 'utf8');
const LANDING = readFileSync(
  join(ROOT, '.github', 'workflows', 'deploy-brain-landing.yml'),
  'utf8',
);
const SMOKE_SRC = readFileSync(SMOKE, 'utf8');

/** Paths one surface asserts, read out of the script's own table. */
function surfacePaths(surface: string): string[] {
  const block = new RegExp(`${surface}: \\[([\\s\\S]*?)\\n  \\]`).exec(SMOKE_SRC);
  expect(block).not.toBeNull();
  return [...(block?.[1] ?? '').matchAll(/path: '([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('each surface smoke-tests only what it owns', () => {
  it('the landing does not assert /health, which Traefik routes to the engine', () => {
    expect(surfacePaths('landing')).not.toContain('/health');
    // And the old inline curl loop that did assert it is gone.
    expect(LANDING).not.toMatch(/for path in[^\n]*\/health/);
  });

  it('the landing still asserts every artifact it publishes', () => {
    const paths = surfacePaths('landing');
    for (const required of ['/en', '/skills.tar.gz', '/install.sh', '/openapi.json']) {
      expect(paths).toContain(required);
    }
  });

  it('the engine asserts more than liveness', () => {
    const paths = surfacePaths('brain');
    expect(paths).toContain('/health');
    // /ready is the load balancer's contract: if its router rule is
    // missing the healthcheck 404s, Traefik marks every replica down and
    // the domain serves nothing. Asserting it through the domain is the
    // only place that bug is visible before real traffic finds it.
    expect(paths).toContain('/ready');
    // The point of the change: a route whose 401 proves the API is
    // mounted and fail-closed. /health alone proves only that Nest bound
    // a port.
    expect(paths).toContain('/v1/search');
    expect(SMOKE_SRC).toMatch(/expect: \[401\]/);
  });

  it('both deploys run the smoke test as a blocking job', () => {
    expect(BRAIN).toMatch(/SMOKE_SURFACE: brain/);
    expect(LANDING).toMatch(/SMOKE_SURFACE: landing/);
    // The engine's external check used to be continue-on-error, i.e. it
    // could notice a broken deploy and pass anyway.
    expect(BRAIN).not.toMatch(/External health probe \(warning-only\)/);
  });
});

describe('a failed deploy has a way back', () => {
  it('the engine deploy records what it is replacing before replacing it', () => {
    expect(BRAIN).toMatch(/\.previous-image/);
    expect(BRAIN).toMatch(/\.pending-image/);
  });

  it('last-known-good is promoted only after the smoke test passed', () => {
    const promote = /Promote this image to last-known-good[\s\S]*?run: \|/.exec(BRAIN);
    expect(promote).not.toBeNull();
    expect(promote?.[0]).toMatch(/needs\.smoke\.result == 'success'/);
  });

  it('rollback triggers when the deploy or the smoke test actually failed', () => {
    expect(BRAIN).toMatch(/needs\.deploy\.result == 'failure'/);
    expect(BRAIN).toMatch(/needs\.smoke\.result == 'failure'/);
  });

  it('rollback does NOT trigger when the deploy was merely skipped', () => {
    // `verify` failing (red CI, no manifest) skips `deploy`, which is also
    // "not success". Rolling back then would restart production over a
    // deploy that never happened — nothing was touched, so nothing needs
    // undoing. The condition must test for failure, not for non-success.
    const start = BRAIN.indexOf('Roll back to the previous image');
    const condition = BRAIN.slice(start, start + 400);
    expect(condition).not.toMatch(/result != 'success'/);
  });

  it('the rollback re-verifies readiness instead of trusting the restart', () => {
    // A rollback that is not itself verified is just a second unverified
    // deploy. The step is the last in the file, so take it to the end.
    const start = BRAIN.indexOf('Roll back to the previous image');
    expect(start).toBeGreaterThan(-1);
    const rollback = BRAIN.slice(start);
    expect(rollback).toMatch(/\/ready/);
    expect(rollback).toMatch(/docker-compose up -d/);
  });

  it('a rollback is reachable by hand without editing the box', () => {
    expect(BRAIN).toMatch(/deploy \| restart \| logs \| rollback/);
    expect(BRAIN).toMatch(/inputs\.action == 'rollback'/);
  });
});

describe('only one run at a time may resolve the deploy transaction', () => {
  it('every production-mutating run shares one concurrency group', () => {
    // Keying the group by github.event_name gave a push deploy and a
    // manual dispatch a group each — i.e. the two racers ran in parallel
    // over the same state files (audit F2).
    const block = /\nconcurrency:\n((?:  .*\n)+)/.exec(BRAIN);
    expect(block).not.toBeNull();
    const body = block?.[1] ?? '';
    expect(body).toMatch(/group: deploy-brain-production/);
    expect(body).not.toMatch(/github\.event_name/);
  });

  it('queues instead of cancelling a run mid-transaction', () => {
    // The state machine spans deploy → smoke → finalize. A cancel between
    // them leaves a half-applied transaction with nobody to resolve it.
    expect(BRAIN).toMatch(/cancel-in-progress: false/);
  });

  it('records a transaction with the run id at deploy time', () => {
    expect(BRAIN).toMatch(/\.deploy-txn/);
    expect(BRAIN).toMatch(/run_id=\$\{GITHUB_RUN_ID\}/);
  });

  it('promote and rollback both refuse a transaction that is not theirs', () => {
    const guard = /- name: Read the deployment transaction[\s\S]*?- name: Promote/.exec(BRAIN);
    expect(guard?.[0]).toMatch(/superseded by run/);
    for (const step of [
      'Promote this image to last-known-good',
      'Roll back to the previous image',
    ]) {
      const start = BRAIN.indexOf(`- name: ${step}`);
      expect(start).toBeGreaterThan(-1);
      // The `if:` on the step, i.e. everything up to its `run:`.
      const condition = BRAIN.slice(start, BRAIN.indexOf('run: |', start));
      expect(condition).toMatch(/steps\.txn\.outputs\.ours == '1'/);
    }
  });

  it('promote also checks that what is RUNNING is this run’s image', () => {
    const start = BRAIN.indexOf('- name: Promote this image to last-known-good');
    const promote = BRAIN.slice(start, BRAIN.indexOf('- name: Roll back', start));
    expect(promote).toMatch(/all_replicas_run_image "\$TXN_IMAGE"/);
    // Smoke passing against the domain is only evidence about this
    // release if this release is what the replicas serve.
    expect(promote).toMatch(/superseded, not touching state/);
  });
});

describe('a manual rollback steps back rather than sideways', () => {
  it('never targets the digest that is already running', () => {
    // .last-good-image after a green release IS the running release, so
    // reading it re-selected the very thing being rolled back (audit F3).
    const start = BRAIN.indexOf('if [ "${ACTION}" = "rollback" ]; then');
    expect(start).toBeGreaterThan(-1);
    const select = BRAIN.slice(start, BRAIN.indexOf('printf', start));
    expect(select).toMatch(/\.good-image-history/);
    expect(select).toMatch(/grep -vxF "\$\{PREVIOUS_IMAGE:-__none__\}"/);
    expect(select).not.toMatch(/cat \.last-good-image/);
  });

  it('keeps the way back until the rollback has proven itself', () => {
    expect(BRAIN).toMatch(/\.previous-image\.staged/);
    const commit = BRAIN.indexOf('- name: Commit the rollback pointers');
    expect(commit).toBeGreaterThan(-1);
    // Ordering is the property: the pointer moves only after the gate.
    expect(BRAIN.indexOf('- name: Internal readiness gate')).toBeLessThan(commit);
  });

  it('bounds the confirmed-good history', () => {
    expect(BRAIN).toMatch(/tail -n 5 \.good-image-history/);
  });
});

describe('the smoke script fails closed', () => {
  function run(env: Record<string, string>): number {
    try {
      execFileSync('node', [SMOKE], {
        env: { ...process.env, ...env, SMOKE_REACH_ATTEMPTS: '1', SMOKE_REACH_DELAY_SECONDS: '0' },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? -1;
    }
  }

  it('refuses an unknown surface rather than passing vacuously', () => {
    expect(run({ SMOKE_BASE_URL: 'https://example.invalid', SMOKE_SURFACE: 'nope' })).toBe(1);
  });

  it('refuses a missing base URL', () => {
    expect(run({ SMOKE_BASE_URL: '', SMOKE_SURFACE: 'brain' })).toBe(1);
  });

  it('fails when the host never answers', () => {
    // .invalid is reserved by RFC 2606 and never resolves, so this
    // exercises the unreachable path without touching the network.
    expect(run({ SMOKE_BASE_URL: 'https://brain.invalid', SMOKE_SURFACE: 'brain' })).toBe(1);
  });
});
