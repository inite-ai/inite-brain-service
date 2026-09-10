import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Truth test for "the collector can see each replica".
 *
 * A single static scrape target (`inite-brain-service:3000`) is not a
 * broken config — it resolves, it answers, and it silently round-robins
 * over the replicas while labelling every sample with one identity. So the
 * failure is invisible: per-process series collapse into one flapping
 * line, and a dead replica is covered for by its siblings. These gates pin
 * the discovery, the label that distinguishes replicas, and the two alert
 * rules that only make sense once there is more than one.
 */

const ROOT = join(__dirname, '..');
const ALLOY = readFileSync(join(ROOT, 'monitoring', 'alloy', 'config.alloy'), 'utf8');
const RULES = readFileSync(
  join(ROOT, 'monitoring', 'grafana', 'provisioning', 'alerting', 'rules.yaml'),
  'utf8',
);
const MON_COMPOSE = readFileSync(join(ROOT, 'monitoring', 'docker-compose.yml'), 'utf8');

describe('alloy scrapes every brain replica', () => {
  it('discovers containers instead of pinning one service name', () => {
    expect(ALLOY).toMatch(/discovery\.docker "brain"/);
    expect(ALLOY).not.toMatch(/__address__\s*=\s*"inite-brain-service:3000"/);
  });

  it('filters by the compose service label, not a name substring', () => {
    expect(ALLOY).toMatch(/com\.docker\.compose\.service=inite-brain-service/);
  });

  it('labels each target with its container so replicas are distinguishable', () => {
    expect(ALLOY).toMatch(/__meta_docker_container_name/);
    expect(ALLOY).toMatch(/target_label\s*=\s*"instance"/);
  });

  it('keeps the job name every existing rule and panel matches on', () => {
    expect(ALLOY).toMatch(/replacement\s*=\s*"brain"/);
    expect(RULES).toMatch(/up\{job="brain"\}/);
  });

  it('scrapes exactly one endpoint per container', () => {
    // Docker discovery yields one target per (network, port); without both
    // keeps the same replica is scraped twice under two addresses.
    expect(ALLOY).toMatch(/regex\s*=\s*"traefik-global"\n\s*action\s*=\s*"keep"/);
    expect(ALLOY).toMatch(/__meta_docker_port_private/);
  });

  it('has the docker socket mounted read-only for that discovery', () => {
    expect(MON_COMPOSE).toMatch(/\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
  });
});

describe('alert rules survive more than one replica', () => {
  it('notices a replica that stops exporting', () => {
    // BrainScrapeDown cannot: with one of three gone the query still
    // returns two series, both 1.
    expect(RULES).toMatch(/uid: brain-replica-missing/);
    expect(RULES).toMatch(/count\(up\{job="brain"\} == 1\)/);
    expect(RULES).toMatch(/max_over_time\(count\(up\{job="brain"\} == 1\)\[6h:1m\]\)/);
  });

  it('aggregates the lease-holder gauge instead of reading one replica', () => {
    expect(RULES).toMatch(/expr: max\(brain_changefeed_lag_records\)/);
  });

  it('still SUMS the leader gauge — that is how it counts leaders', () => {
    // Deliberately not max(): sum=0 means no leader, sum>1 a split brain.
    expect(RULES).toMatch(/expr: sum\(brain_worker_is_leader\) or vector\(0\)/);
  });
});
