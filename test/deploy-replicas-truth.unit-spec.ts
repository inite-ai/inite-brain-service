import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Truth test for "the service is N identical replicas".
 *
 * Every property here is one a single-replica assumption silently
 * reintroduces: a `container_name` makes `--scale` an error, a published
 * host port makes the second container fail to bind, a `/health`
 * load-balancer probe keeps a degraded replica in rotation (it answers 200
 * while reporting itself degraded), a check that asks "is something up"
 * passes with one container out of three, and a per-replica model download
 * cannot finish inside the readiness gate.
 *
 * It also pins the five env pins that were deleted for restating a
 * default: a deploy file that restates defaults invites the next reader to
 * treat the value as deliberate.
 */

const ROOT = join(__dirname, '..');
const DEPLOY = readFileSync(join(ROOT, '.github', 'workflows', 'deploy-brain.yml'), 'utf8');
const COMPOSE = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');

/** The compose file the deploy generates on the box, as workflow source. */
const HEREDOC = (() => {
  const start = DEPLOY.indexOf('tee docker-compose.yml > /dev/null << EOF');
  const end = DEPLOY.indexOf('\n          EOF\n', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return DEPLOY.slice(start, end);
})();

describe('the generated compose can run N replicas', () => {
  it('does not name the container', () => {
    // container_name pins the service to exactly one container: compose
    // refuses `--scale` and `deploy.replicas` outright.
    expect(HEREDOC).not.toMatch(/^\s*container_name:/m);
  });

  it('declares the replica count and also passes it to --scale', () => {
    // deploy.replicas is honoured by compose v2 and ignored by v1; the
    // flag is honoured by both. The box runs `docker-compose`, so both.
    expect(HEREDOC).toMatch(/deploy:\s*\n\s*replicas: \$\{BRAIN_REPLICAS:-1\}/);
    expect(DEPLOY).toMatch(
      /up -d --remove-orphans --scale "\$\{PROJECT_NAME\}=\$\{BRAIN_REPLICAS\}"/,
    );
  });

  it('publishes no host port — Traefik reaches it over the network', () => {
    expect(HEREDOC).toMatch(/expose:/);
    expect(HEREDOC).not.toMatch(/^\s+ports:/m);
  });

  it('shares one model cache so replica 2 does not re-download 700MB', () => {
    expect(HEREDOC).toMatch(/brain-model-cache:\/app\/\.cache/);
    // And the named volume is declared, or compose refuses the file.
    expect(HEREDOC).toMatch(/volumes:\s*\n\s*brain-model-cache:/);
  });

  it('refuses a malformed replica count instead of quietly scaling to 1', () => {
    expect(DEPLOY).toMatch(/BRAIN_REPLICAS must be a positive integer/);
  });
});

describe('the edge routes on readiness', () => {
  it('points the load-balancer healthcheck at /ready', () => {
    expect(HEREDOC).toMatch(/loadbalancer\.healthcheck\.path=\/ready/);
    expect(HEREDOC).not.toMatch(/loadbalancer\.healthcheck\.path=\/health/);
    // A slow probe is a slow rotation; keep it seconds, not a quarter minute.
    expect(HEREDOC).toMatch(/loadbalancer\.healthcheck\.interval=3s/);
    expect(HEREDOC).toMatch(/loadbalancer\.healthcheck\.timeout=2s/);
  });

  it('routes /ready through the domain on BOTH routers', () => {
    // Without the router rule the healthcheck 404s and Traefik takes
    // every replica out of rotation — the failure mode is total.
    const rules = [...HEREDOC.matchAll(/routers\.\$\{PROJECT_NAME\}(-http)?\.rule=([^\n]+)/g)];
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule[2]).toContain('PathPrefix(\\`/ready\\`)');
    }
  });

  it('keeps the container healthcheck on liveness', () => {
    // Docker restarts on this one: recycling a container because its
    // embedder is still warming is a restart loop, not a repair.
    expect(HEREDOC).toMatch(/healthcheck:\s*\n\s*test:.*\/health/);
  });
});

describe('post-deploy checks count replicas instead of assuming one', () => {
  it('waits for the full desired count, not for "something is up"', () => {
    expect(DEPLOY).not.toMatch(/docker-compose ps \| grep -q "Up"/);
    expect(DEPLOY).toMatch(/running_replicas/);
    expect(DEPLOY).toMatch(/\[ "\$up" -ge "\$\{BRAIN_REPLICAS\}" \]/);
  });

  it('probes health, readiness and the rolled-back image on every replica', () => {
    expect(DEPLOY).toMatch(/await_all_replicas 90 \/health/);
    expect(DEPLOY).toMatch(/await_all_replicas 300 \/ready/);
    // The rollback verification is the third caller; it is the one that
    // used to accept a single ready container as a verified rollback.
    expect([...DEPLOY.matchAll(/await_all_replicas/g)].length).toBeGreaterThanOrEqual(4);
    expect(DEPLOY).toMatch(/--index="\$1"/);
  });

  it('asserts the running replicas are this run’s image', () => {
    expect(DEPLOY).toMatch(/all_replicas_run_image "\$\{IMAGE_REF\}"/);
  });
});

describe('the deploy env restates no defaults', () => {
  // Each was cross-checked against the reader in src/: provisioning
  // follows SEARCH_HNSW_ENABLED (hnsw-provision.service.ts), the probe and
  // the worker loop read envFlagNotDisabled (on unless =0), the lease
  // manager defaults to '1', and JOBS_QUEUE_MODE defaults to 'enqueue'.
  for (const pin of [
    'HNSW_PROVISION_ENABLED=1',
    'CAPABILITY_PROBE_ENABLED=1',
    'WORKER_LOOP_ENABLED=1',
    'LEASE_MANAGER_ENABLED=1',
    'JOBS_QUEUE_MODE=enqueue',
  ]) {
    it(`does not pin ${pin}`, () => {
      expect(DEPLOY).not.toContain(`\n          ${pin}\n`);
      expect(DEPLOY).not.toContain(`- ${pin}\n`);
    });
  }
});

describe('the repo compose is scalable too', () => {
  it('does not publish a fixed host port for the app', () => {
    const brain = COMPOSE.slice(
      COMPOSE.indexOf('\n  brain:'),
      COMPOSE.indexOf('\n  brain-worker:'),
    );
    expect(brain).toMatch(/expose:/);
    expect(brain).not.toMatch(/^\s+ports:/m);
  });

  it('documents the local-dev port mapping instead of deleting it', () => {
    expect(existsSync(join(ROOT, 'docker-compose.override.yml.example'))).toBe(true);
    const example = readFileSync(join(ROOT, 'docker-compose.override.yml.example'), 'utf8');
    expect(example).toMatch(/ports:/);
    expect(example).toMatch(/BRAIN_HOST_PORT/);
  });

  it('mounts the shared model cache', () => {
    expect(COMPOSE).toMatch(/brain-model-cache:\/app\/\.cache/);
    expect(COMPOSE).toMatch(/^volumes:\n(?:.*\n)*?  brain-model-cache:/m);
  });
});
