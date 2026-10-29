import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Production moves on a release and only on a release. The engine deploy
 * used to fire on every green push to main that touched the image (a
 * paths allowlist), so prod ran whatever was merged last and a release was
 * only a changelog entry. Now release-please.yml calls the deploy in the
 * run that cut the release; a merge runs CI and nothing else.
 *
 * Both directions are pinned: the deploy has no push trigger (a merge
 * cannot reach prod), and the release run calls it exactly when a release
 * was created (a release cannot silently skip prod). The call is a
 * workflow_call because the release is created with GITHUB_TOKEN, which
 * never triggers another workflow.
 */
const ROOT = join(__dirname, '..');
const DEPLOY = readFileSync(join(ROOT, '.github/workflows/deploy-brain.yml'), 'utf8');
const RELEASE = readFileSync(join(ROOT, '.github/workflows/release-please.yml'), 'utf8');

/** The top-level `on:` block of a workflow, comments dropped. */
function onBlock(workflow: string): string {
  const block = /\non:\n((?:(?: {2}.*)?\n)+?)(?=\S)/.exec(`\n${workflow}`);
  if (!block?.[1]) throw new Error('no on: block found');
  return block[1]
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/** One job of a workflow, by name, as text up to the next job. */
function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no ${name} job`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('engine deploy trigger', () => {
  it('a merge to main cannot reach production: the deploy has no push trigger', () => {
    const on = onBlock(DEPLOY);
    expect(on).not.toMatch(/^\s{2}push:/m);
    expect(on).not.toMatch(/^\s{2}(pull_request|schedule|workflow_run):/m);
  });

  it('is called by the release run, and runnable by hand (deploy, restart, logs, rollback)', () => {
    const on = onBlock(DEPLOY);
    expect(on).toMatch(/^\s{2}workflow_call:/m);
    expect(on).toMatch(/^\s{2}workflow_dispatch:/m);
  });

  it('the release run calls the deploy exactly when it created a release', () => {
    const deploy = job(RELEASE, 'deploy');
    expect(deploy).toContain('uses: ./.github/workflows/deploy-brain.yml');
    expect(deploy).toContain("needs.release-please.outputs.release_created == 'true'");
    expect(deploy).toContain('secrets: inherit');
    // verify reads CI's run and downloads its deploy manifest.
    expect(deploy).toMatch(/actions: read/);
  });

  it('a release call deploys like the old push did: every job treats it as action=deploy', () => {
    // In a called workflow event_name is the caller's (push), never
    // workflow_dispatch, and inputs.action is empty — which the deploy
    // script reads as deploy.
    expect(DEPLOY).not.toContain("github.event_name == 'push'");
    expect(DEPLOY).toContain("github.event_name != 'workflow_dispatch'");
    expect(DEPLOY).toContain('action=${ACTION:-deploy}');
  });
});
