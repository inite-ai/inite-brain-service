import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Truth test for "build once, deploy that artifact".
 *
 * The property being defended is narrow and easy to lose by accident:
 * the image running in production must be the image CI built and
 * smoke-tested, identified by digest. Every plausible regression here is
 * silent — swapping the digest back to `:latest` still deploys something
 * that works, and nobody notices that "what CI approved" and "what is
 * running" have come apart again until they disagree.
 *
 * So this pins the shape rather than the behaviour: the deploy does not
 * build, the compose image is not a tag, CI publishes a manifest, and the
 * manifest reader refuses everything it should refuse.
 */

const ROOT = join(__dirname, '..');
const DEPLOY = readFileSync(join(ROOT, '.github', 'workflows', 'deploy-brain.yml'), 'utf8');
const CI = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const READER = join(ROOT, 'scripts', 'ci', 'read-deploy-manifest.mjs');

/** Run the manifest reader over a manifest body; return its exit code. */
function readManifest(body: string | null, expectedSha: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-manifest-'));
  const manifestPath = join(dir, 'deploy-manifest.json');
  if (body !== null) writeFileSync(manifestPath, body);
  const outPath = join(dir, 'github_output');
  writeFileSync(outPath, '');

  try {
    execFileSync('node', [READER], {
      env: {
        ...process.env,
        MANIFEST_PATH: manifestPath,
        EXPECTED_SHA: expectedSha,
        GITHUB_OUTPUT: outPath,
      },
      encoding: 'utf8',
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

describe('the deploy consumes an artifact instead of producing one', () => {
  it('deploy-brain.yml no longer builds or pushes an image', () => {
    // A rebuild on the deploy runner is what broke the identity between
    // "tested" and "running" in the first place.
    expect(DEPLOY).not.toMatch(/docker\/build-push-action/);
    expect(DEPLOY).not.toMatch(/\bpush:\s*true\b/);
  });

  it('the compose file pins the resolved digest, not a floating tag', () => {
    // Two `image:` keys live in this file: the verify job's output, and
    // the one written into the compose heredoc. Both must be the resolved
    // digest — never a literal tag.
    const images = [...DEPLOY.matchAll(/^\s+image:\s*(.+)$/gm)].map((m) => (m[1] ?? '').trim());
    expect(images).toContain('${IMAGE_REF}');
    for (const image of images) {
      expect(image).toMatch(/^\$\{/);
    }
    // The specific regression this forbids: going back to :latest, which
    // resolves to whatever the registry holds at pull time.
    expect(DEPLOY).not.toMatch(/image:[^\n]*:latest/);
  });

  it('the deploy waits for CI on this commit before resolving anything', () => {
    expect(DEPLOY).toMatch(/scripts\/ci\/await-ci\.mjs/);
    // Ordering matters: the artifact download uses the run id the wait
    // produced, so a download placed before the wait would read a stale run.
    expect(DEPLOY.indexOf('await-ci.mjs')).toBeLessThan(DEPLOY.indexOf('download-artifact'));
  });

  it('the deploy job will not run unless verification succeeded', () => {
    expect(DEPLOY).toMatch(/needs\.verify\.result == 'success'/);
  });
});

describe('CI publishes exactly what the deploy expects to find', () => {
  it('records a deploy manifest and uploads it under the agreed name', () => {
    expect(CI).toMatch(/deploy-manifest\.json/);
    expect(CI).toMatch(/name:\s*deploy-manifest/);
    // Without this the artifact silently uploads empty and the deploy
    // fails much later, at digest resolution, with a worse message.
    expect(CI).toMatch(/if-no-files-found:\s*error/);
  });

  it('smoke-tests the published digest, not the local build cache', () => {
    // The pull-back is what makes "CI tested this exact artifact" true
    // rather than merely likely.
    expect(CI).toMatch(/Pull back the published digest/);
  });
});

describe('the manifest reader refuses every unverified image', () => {
  const SHA = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);
  const good = JSON.stringify({
    sha: SHA,
    image: 'acme/inite-brain-service@sha256:' + 'c'.repeat(64),
    digest: 'sha256:' + 'c'.repeat(64),
  });

  it('accepts a digest-pinned manifest for the right commit', () => {
    expect(readManifest(good, SHA)).toBe(0);
  });

  it('refuses a manifest belonging to another commit', () => {
    expect(readManifest(good, OTHER)).toBe(1);
  });

  it('refuses a tag-pinned image', () => {
    const tagged = JSON.stringify({ sha: SHA, image: 'acme/inite-brain-service:latest' });
    expect(readManifest(tagged, SHA)).toBe(1);
  });

  it('refuses a missing manifest rather than defaulting to something', () => {
    expect(readManifest(null, SHA)).toBe(1);
  });

  it('refuses a corrupt manifest', () => {
    expect(readManifest('{not json', SHA)).toBe(1);
  });
});
