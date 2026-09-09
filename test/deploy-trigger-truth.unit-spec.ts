import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The engine deploy fires on an ALLOWLIST of paths. An allowlist has a
 * failure mode a denylist does not: forgetting an entry means the deploy
 * silently does NOT run, and a merged fix sits in main believing itself
 * shipped. That is strictly worse than the over-deploying it replaced.
 *
 * These gates buy the allowlist back by deriving it from the two files that
 * actually decide what the engine is: the Dockerfile (what enters the image)
 * and the landing workflow (what belongs to somebody else). A path that
 * starts shipping without joining the trigger fails here rather than in a
 * confusing "why is prod still on the old build" afternoon.
 */
const ROOT = join(__dirname, '..');
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const DEPLOY = readFileSync(join(ROOT, '.github/workflows/deploy-brain.yml'), 'utf8');
const LANDING = readFileSync(join(ROOT, '.github/workflows/deploy-brain-landing.yml'), 'utf8');

/** The `paths:` block of a workflow's push trigger, as bare glob strings. */
function triggerPaths(workflow: string): string[] {
  const block = /\n    paths:\n((?:\s*(?:#[^\n]*|- '[^']+')\n)+)/.exec(workflow);
  if (!block?.[1]) throw new Error('no push paths: block found');
  return [...block[1].matchAll(/- '([^']+)'/g)].map((m) => m[1]!);
}

/**
 * Sources of every COPY in the builder stage, ignoring --from=… copies
 * (those move artefacts between stages and never read the repo).
 */
function dockerfileCopySources(): string[] {
  return [...DOCKERFILE.matchAll(/^COPY (?!--from=)(.+)$/gm)]
    .flatMap((m) => m[1]!.trim().split(/\s+/).slice(0, -1))
    .map((src) => src.replace(/\*$/, ''))
    .filter((src) => src !== '.');
}

/**
 * Does the allowlist cover this repo path? `dir/**` covers both the
 * directory itself and everything under it — a Dockerfile writes
 * `COPY src ./src`, naming the directory bare, while a trigger glob names
 * its contents.
 */
function covered(paths: string[], file: string): boolean {
  return paths.some((p) => {
    if (!p.endsWith('/**')) return p === file;
    const dir = p.slice(0, -3);
    return file === dir || file.startsWith(`${dir}/`);
  });
}

describe('engine deploy trigger', () => {
  const paths = triggerPaths(DEPLOY);

  it('covers every path the Dockerfile copies into the image', () => {
    // The self-maintaining property: a new COPY is a Dockerfile edit, and
    // Dockerfile is itself in the allowlist — so the commit that starts
    // shipping a path also trips the trigger. This asserts the steady state.
    const uncovered = dockerfileCopySources().filter((src) => !covered(paths, src));
    expect(uncovered).toEqual([]);
  });

  it('watches the Dockerfile itself, which is what makes the list self-maintaining', () => {
    expect(paths).toContain('Dockerfile');
  });

  it('watches its own workflow file', () => {
    // The deploy generates its compose file and its entire enablement env
    // inline, so a change to this workflow IS a change to production.
    expect(paths).toContain('.github/workflows/deploy-brain.yml');
  });

  it('does not fire on anything the landing deploy owns', () => {
    // The whole point of the split: a landing or admin-panel edit must not
    // rebuild and redeploy the engine. Admin lives at
    // brain-landing/app/[lang]/admin, inside the landing's Next app, so it
    // is covered by the same ownership.
    const landingOwned = triggerPaths(LANDING).filter((p) => p.endsWith('/**'));
    const overlap = landingOwned.filter((owned) =>
      paths.some((p) => p.startsWith(owned.slice(0, -2)) || owned.startsWith(p.replace('/**', ''))),
    );
    expect(overlap).toEqual([]);
  });

  it('does not fire on docs, plans or the monitoring stack', () => {
    // These were the original ignore list. Under an allowlist they are
    // excluded by construction — this pins that the property survived the
    // inversion, since re-adding them would be a silent regression.
    for (const file of [
      'docs/operations.md',
      'README.md',
      '.planning/roadmap.md',
      'monitoring/grafana/provisioning/alerting/rules.yaml',
      'brain-landing/app/[lang]/admin/config/page.tsx',
      'skills/brain/SKILL.md',
    ]) {
      expect(covered(paths, file)).toBe(false);
    }
  });
});
