import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Truth test for the two deploy-state races the 2026-09-09 runtime audit
 * reproduced (F2, F3). It does not assert on the workflow's prose: it
 * EXTRACTS the real shell fragments out of deploy-brain.yml and runs them
 * over a temp directory with stub `docker` / `docker-compose` binaries, so
 * what is verified is the code the self-hosted runner executes.
 *
 * F2 — a finalize that arrived after another run had redeployed used to
 *      `cp .pending-image .last-good-image`, declaring an image nothing
 *      had verified to be the last known-good.
 * F3 — a manual rollback read `.last-good-image`, which after a green
 *      release IS the running release, and then overwrote `.previous-image`
 *      with it — destroying the only pointer to the version before.
 */

const ROOT = join(__dirname, '..');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'deploy-brain.yml'), 'utf8');

/**
 * A step's `run:` script, dedented exactly as the YAML block scalar hands
 * it to the runner (the body is uniformly indented ten spaces).
 */
function stepScript(name: string): string {
  const start = WORKFLOW.indexOf(`      - name: ${name}\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = WORKFLOW.slice(start + 1);
  const end = rest.search(/\n {6}(?:- name:|#)/);
  const block = end < 0 ? rest : rest.slice(0, end);
  const runIdx = block.indexOf('run: |\n');
  expect(runIdx).toBeGreaterThan(-1);
  return block.slice(runIdx + 'run: |\n'.length).replace(/^ {10}/gm, '');
}

const DEPLOY = stepScript('Deploy to server');

/** The part of the deploy step between two literal markers. */
function fragment(from: string, to: string): string {
  const start = DEPLOY.indexOf(from);
  const end = DEPLOY.indexOf(to);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return DEPLOY.slice(start, end);
}

/** Image selection + state writes: the F3 fragment. */
const SELECT_IMAGE = () => fragment('PREVIOUS_IMAGE=""', '# Brain talks');
/** The generator for the replica helpers the later steps and finalize source. */
const WRITE_LIB = () => fragment('tee deploy-lib.sh', '. ./deploy-lib.sh');

/**
 * A box: a project dir with the REAL generated `deploy-lib.sh` and stub
 * `docker` / `docker-compose` on PATH. The stubs answer only what these
 * fragments ask — which containers exist, whether they run, and what image
 * they were created from.
 */
interface Box {
  dir: string;
  env: NodeJS.ProcessEnv;
}

function writeDockerStub(dir: string, imageFile: string): void {
  const bin = join(dir, 'bin');
  // `docker inspect -f '{{.State.Status}}' <ids…>` prints one line per
  // container id it was given; every other format answers with the image
  // the containers were created from.
  writeFileSync(
    join(bin, 'docker'),
    '#!/bin/sh\ncase "$*" in\n' +
      '  *State.Status*)\n' +
      '    for a in "$@"; do\n' +
      '      case "$a" in -*|*\'{{\'*|inspect|image) ;; *) echo running ;; esac\n' +
      '    done ;;\n' +
      `  *) cat '${imageFile}' ;;\n` +
      'esac\nexit 0\n',
  );
  chmodSync(join(bin, 'docker'), 0o755);
}

function makeBox(state: { replicaIds?: string[]; runningImage?: string }): Box {
  const dir = mkdtempSync(join(tmpdir(), 'brain-deploy-race-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const ids = state.replicaIds ?? ['cid1'];
  const imageFile = join(dir, 'running-image');
  writeFileSync(imageFile, state.runningImage ?? '');
  writeFileSync(
    join(bin, 'docker-compose'),
    '#!/bin/sh\ncase "$1 $2" in\n' +
      `  "ps -q") printf '%s\\n' ${ids.map((i) => `'${i}'`).join(' ')} ;;\n` +
      '  *) : ;;\nesac\nexit 0\n',
  );
  chmodSync(join(bin, 'docker-compose'), 0o755);
  writeDockerStub(dir, imageFile);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    PROJECT_DIR: dir,
    PROJECT_NAME: 'inite-brain-service',
    PORT: '3000',
    BRAIN_REPLICAS: String(ids.length),
    GITHUB_ENV: join(dir, 'github-env'),
    GITHUB_OUTPUT: join(dir, 'github-output'),
  };
  // The helpers the finalize steps source are the ones the deploy step
  // generates — extracted and run, not re-typed here.
  execFileSync('bash', ['-c', WRITE_LIB()], { cwd: dir, env, encoding: 'utf8' });
  return { dir, env };
}

function runFragment(
  frag: string,
  box: Box,
  env: Record<string, string>,
): {
  code: number;
  out: string;
} {
  try {
    const out = execFileSync('bash', ['-c', frag], {
      cwd: box.dir,
      env: { ...box.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

const A = 'acme/brain@sha256:' + 'a'.repeat(64);
const B = 'acme/brain@sha256:' + 'b'.repeat(64);
const C = 'acme/brain@sha256:' + 'c'.repeat(64);

describe('the generated replica helpers', () => {
  it('count RUNNING containers instead of grepping compose prose', () => {
    const box = makeBox({ replicaIds: ['cid1', 'cid2', 'cid3'] });
    const lib = readFileSync(join(box.dir, 'deploy-lib.sh'), 'utf8');
    expect(lib).toContain('DESIRED_REPLICAS="3"');
    const out = execFileSync('bash', ['-c', '. ./deploy-lib.sh && running_replicas'], {
      cwd: box.dir,
      env: box.env,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('3');
  });
});

describe('F2: a superseded finalize promotes nothing', () => {
  const promote = () => stepScript('Promote this image to last-known-good');

  it('refuses to promote an image another run left pending', () => {
    // Run A deployed A and passed smoke. Before A finalized, manual run B
    // deployed B and overwrote .pending-image. A's finalize must not
    // declare B — which nothing has verified — the last known-good.
    const box = makeBox({ runningImage: B });
    writeFileSync(join(box.dir, '.pending-image'), B);
    writeFileSync(join(box.dir, '.last-good-image'), 'image-G');
    const r = runFragment(promote(), box, { TXN_IMAGE: A });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/superseded/);
    expect(readFileSync(join(box.dir, '.last-good-image'), 'utf8')).toBe('image-G');
    expect(existsSync(join(box.dir, '.good-image-history'))).toBe(false);
  });

  it('refuses to promote when the replicas are running a different image', () => {
    // .pending-image is still ours, but another run has already replaced
    // the containers, so the smoke test passed against something else.
    const box = makeBox({ runningImage: C });
    writeFileSync(join(box.dir, '.pending-image'), A);
    const r = runFragment(promote(), box, { TXN_IMAGE: A });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/superseded/);
    expect(existsSync(join(box.dir, '.last-good-image'))).toBe(false);
  });

  it('promotes its own image and appends it to the history exactly once', () => {
    const box = makeBox({ runningImage: A, replicaIds: ['cid1', 'cid2', 'cid3'] });
    writeFileSync(join(box.dir, '.pending-image'), A);
    expect(runFragment(promote(), box, { TXN_IMAGE: A }).code).toBe(0);
    expect(runFragment(promote(), box, { TXN_IMAGE: A }).code).toBe(0);
    expect(readFileSync(join(box.dir, '.last-good-image'), 'utf8')).toBe(A);
    expect(readFileSync(join(box.dir, '.good-image-history'), 'utf8').trim().split('\n')).toEqual([
      A,
    ]);
  });

  it('keeps only the last five confirmed-good digests', () => {
    const box = makeBox({ runningImage: '' });
    const digests = Array.from(
      { length: 7 },
      (_, i) => `acme/brain@sha256:${String(i).repeat(64)}`,
    );
    for (const d of digests) {
      writeFileSync(join(box.dir, '.pending-image'), d);
      writeFileSync(join(box.dir, 'running-image'), d);
      expect(runFragment(promote(), box, { TXN_IMAGE: d }).code).toBe(0);
    }
    const history = readFileSync(join(box.dir, '.good-image-history'), 'utf8').trim().split('\n');
    expect(history).toEqual(digests.slice(-5));
  });
});

describe('F2: a superseded rollback restarts nothing', () => {
  const rollback = () => stepScript('Roll back to the previous image');

  it('exits successfully without touching a newer run’s release', () => {
    const box = makeBox({ runningImage: C });
    writeFileSync(join(box.dir, 'docker-compose.yml'), `services:\n  brain:\n    image: ${C}\n`);
    writeFileSync(join(box.dir, '.last-good-image'), A);
    const r = runFragment(rollback(), box, { TXN_IMAGE: B });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/superseded/);
    // The compose file still pins what the newer run deployed.
    expect(readFileSync(join(box.dir, 'docker-compose.yml'), 'utf8')).toContain(C);
  });
});

describe('F3: a manual rollback steps back', () => {
  function boxRunning(image: string): Box {
    const b = makeBox({ runningImage: image });
    writeFileSync(join(b.dir, 'docker-compose.yml'), `services:\n  brain:\n    image: ${image}\n`);
    return b;
  }

  it('never re-selects the running release, even when it is the newest good one', () => {
    // The reproduced scenario: B went green (so it is both the newest
    // confirmed-good digest and what is running), then a latent
    // regression prompts a rollback.
    const b = boxRunning(B);
    writeFileSync(join(b.dir, '.good-image-history'), `${A}\n${B}\n`);
    writeFileSync(join(b.dir, '.previous-image'), A);
    const r = runFragment(SELECT_IMAGE(), b, {
      ACTION: 'rollback',
      IMAGE_FROM_CI: '',
      IMAGE_INPUT: '',
    });
    expect(r.code).toBe(0);
    expect(readFileSync(join(b.dir, '.pending-image'), 'utf8')).toBe(A);
    // And the only pointer to the version before is untouched until the
    // rollback has answered /ready.
    expect(readFileSync(join(b.dir, '.previous-image'), 'utf8')).toBe(A);
    expect(readFileSync(join(b.dir, '.previous-image.staged'), 'utf8')).toBe(B);
  });

  it('refuses a digest that never passed both gates', () => {
    const b = boxRunning(B);
    writeFileSync(join(b.dir, '.good-image-history'), `${A}\n${B}\n`);
    const r = runFragment(SELECT_IMAGE(), b, {
      ACTION: 'rollback',
      IMAGE_FROM_CI: '',
      IMAGE_INPUT: C,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not in the confirmed-good history/);
  });

  it('accepts an explicit digest that did', () => {
    const b = boxRunning(B);
    writeFileSync(join(b.dir, '.good-image-history'), `${C}\n${A}\n${B}\n`);
    const r = runFragment(SELECT_IMAGE(), b, {
      ACTION: 'rollback',
      IMAGE_FROM_CI: '',
      IMAGE_INPUT: C,
    });
    expect(r.code).toBe(0);
    expect(readFileSync(join(b.dir, '.pending-image'), 'utf8')).toBe(C);
  });

  it('refuses when the only confirmed-good digest is the running one', () => {
    const b = boxRunning(B);
    writeFileSync(join(b.dir, '.good-image-history'), `${B}\n`);
    const r = runFragment(SELECT_IMAGE(), b, {
      ACTION: 'rollback',
      IMAGE_FROM_CI: '',
      IMAGE_INPUT: '',
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no earlier verified release/);
  });

  it('records the transaction so a later finalize can tell whose it is', () => {
    const b = boxRunning(A);
    const r = runFragment(SELECT_IMAGE(), b, {
      ACTION: '',
      IMAGE_FROM_CI: B,
      IMAGE_INPUT: '',
      GITHUB_RUN_ID: '4242',
      GITHUB_RUN_ATTEMPT: '1',
      BRAIN_REPLICAS: '3',
    });
    expect(r.code).toBe(0);
    const txn = readFileSync(join(b.dir, '.deploy-txn'), 'utf8');
    expect(txn).toContain('run_id=4242');
    expect(txn).toContain(`image=${B}`);
    expect(txn).toContain(`previous=${A}`);
    expect(txn).toContain('replicas=3');
    // A normal deploy DOES move .previous-image immediately: the automatic
    // rollback needs it even when the readiness gate fails.
    expect(readFileSync(join(b.dir, '.previous-image'), 'utf8')).toBe(A);
  });
});
