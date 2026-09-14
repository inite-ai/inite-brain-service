import { PredicateConsolidationService } from '../src/admin/predicate-consolidation.service';

/**
 * Predicate consolidation — the pass that replaced a write-path decision.
 *
 * Canonicalization used to happen once, at coinage, from a shortlist of
 * three. That shape is order-dependent (whichever variant the extractor
 * coined first became the canon, and a predicate coined BEFORE its
 * sibling could never merge with it), retroactively blind (a tenant's
 * 133 already-coined predicates are never reconsidered) and local (each
 * decision saw three candidates, never the vocabulary). Measured on a
 * battery tenant, the write-path judge merged 24 predicates and left the
 * rest exactly as they were.
 *
 * CESI clusters the whole vocabulary; EDC calls its third stage
 * POST-HOC; DIAL-KG's third outcome is "merge with variants ALREADY
 * PRESENT". This is that pass, as leader (canopy) clustering rather than
 * the agglomerative kind — HAC merges CLUSTERS, so a chain of
 * locally-plausible links (A~B, B~C) silently equates A and C, and for
 * predicates that means quietly destroying an attribute.
 */
interface Row {
  predicateId: string;
  status: 'active' | 'proposed';
  facts?: number;
  sample?: string;
}

function harness(rows: Row[], pick: (c: string, cands: readonly string[]) => string | null) {
  const asked: Array<{ candidate: string; block: string[] }> = [];
  const aliased: Array<{ from: string; to: string }> = [];
  const surreal = {
    withCompany: async (_c: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: (q: string) => {
          if (q.includes('FROM knowledge_predicate')) {
            return Promise.resolve([
              rows.map((r) => ({ predicateId: r.predicateId, status: r.status })),
            ]);
          }
          if (q.includes('FROM knowledge_fact')) {
            return Promise.resolve([
              rows
                .filter((r) => (r.facts ?? 0) > 0)
                .map((r) => ({ predicate: r.predicateId, n: r.facts, sample: r.sample })),
            ]);
          }
          return Promise.resolve([[]]);
        },
      }),
  };
  const registry = {
    alias: (_c: string, from: string, to: string) => {
      aliased.push({ from, to });
      return Promise.resolve({ def: null, factsRepointed: rows.find((r) => r.predicateId === from)?.facts ?? 0 });
    },
  };
  const judge = {
    isAvailable: () => true,
    sameAttributeAs: (candidate: string, _ctx: string, block: readonly string[]) => {
      asked.push({ candidate, block: [...block] });
      return Promise.resolve(pick(candidate, block));
    },
  };
  const svc = new PredicateConsolidationService(
    surreal as never,
    registry as never,
    judge as never,
  );
  return { svc, asked, aliased };
}

describe('PredicateConsolidationService', () => {
  it('merges a variant onto the MOST-USED name, not the first-seen one', async () => {
    // The write-path version canonized whichever arrived first. Here the
    // canon is the name the data actually speaks.
    const h = harness(
      [
        { predicateId: 'deploys_to', status: 'proposed', facts: 1, sample: 'Fly.io' },
        { predicateId: 'deployed_to', status: 'proposed', facts: 9, sample: 'AWS ECS Fargate' },
      ],
      () => 'deployed_to',
    );
    const r = await h.svc.run('co_x');
    expect(h.aliased).toEqual([{ from: 'deploys_to', to: 'deployed_to' }]);
    expect(r.merged).toBe(1);
    expect(r.factsRepointed).toBe(1);
  });

  it('reconsiders predicates coined long BEFORE the pass — the retroactive half', async () => {
    // Nothing here is newly coined; a write-path decision would examine
    // none of it.
    const h = harness(
      [
        { predicateId: 'queue_backend', status: 'proposed', facts: 4 },
        { predicateId: 'job_queue_backend', status: 'proposed', facts: 2 },
        { predicateId: 'uses_backend', status: 'proposed', facts: 1 },
      ],
      () => 'queue_backend',
    );
    const r = await h.svc.run('co_x');
    expect(r.merged).toBe(2);
    expect(h.aliased.map((a) => a.from).sort()).toEqual(['job_queue_backend', 'uses_backend']);
  });

  it('judges against a LEADER only — never transitively, so no chaining', async () => {
    // A~B and B~C must not equate A and C. Every question the judge is
    // asked names a leader, so a merge is always a claim about that pair.
    const h = harness(
      [
        { predicateId: 'retry_policy', status: 'proposed', facts: 5 },
        { predicateId: 'retry_delay', status: 'proposed', facts: 3 },
        { predicateId: 'retry_attempts', status: 'proposed', facts: 2 },
      ],
      () => null, // the judge says these are three different fields
    );
    const r = await h.svc.run('co_x');
    expect(r.merged).toBe(0);
    // Each later candidate is offered the leaders, never a merged member.
    expect(h.asked.map((a) => a.block)).toEqual([['retry_policy'], ['retry_policy', 'retry_delay']]);
  });

  it('never asks about a pair the blocking gate rejects', async () => {
    const h = harness(
      [
        { predicateId: 'fixed_retry_policy', status: 'proposed', facts: 5 },
        { predicateId: 'decided', status: 'proposed', facts: 4 },
      ],
      () => 'fixed_retry_policy',
    );
    const r = await h.svc.run('co_x');
    expect(h.asked).toEqual([]);
    expect(r.merged).toBe(0);
    expect(r.blocked).toBe(0);
  });

  it('an active seed can lead but is never aliased away', async () => {
    const h = harness(
      [
        { predicateId: 'service_port', status: 'active', facts: 0 },
        { predicateId: 'listens_on_port', status: 'proposed', facts: 3 },
      ],
      () => 'service_port',
    );
    const r = await h.svc.run('co_x');
    expect(r.examined).toBe(1); // the seed is not a candidate
    expect(h.aliased).toEqual([{ from: 'listens_on_port', to: 'service_port' }]);
  });

  it('a second run over an unchanged vocabulary writes nothing', async () => {
    // Idempotence: the first run's merges leave the candidate set, so a
    // replay finds the same leaders and no new candidates.
    const rows: Row[] = [
      { predicateId: 'queue_backend', status: 'proposed', facts: 4 },
      { predicateId: 'job_queue_backend', status: 'proposed', facts: 2 },
    ];
    const first = harness(rows, () => 'queue_backend');
    await first.svc.run('co_x');
    // What the DB would now hold: the merged row is 'aliased', so the
    // loader (active|proposed only) no longer returns it.
    const second = harness([rows[0]!], () => 'queue_backend');
    const r = await second.svc.run('co_x');
    expect(r.merged).toBe(0);
    expect(second.aliased).toEqual([]);
  });

  it('dryRun reports the merges it would make and writes none', async () => {
    const h = harness(
      [
        { predicateId: 'pilot_launch_date', status: 'proposed', facts: 6 },
        { predicateId: 'changed_launch_date', status: 'proposed', facts: 1 },
      ],
      () => 'pilot_launch_date',
    );
    const r = await h.svc.run('co_x', { dryRun: true });
    expect(r.merged).toBe(1);
    expect(r.merges).toEqual([
      { from: 'changed_launch_date', to: 'pilot_launch_date', facts: 1 },
    ]);
    expect(h.aliased).toEqual([]);
    expect(r.factsRepointed).toBe(0);
  });

  it('without a judge it is a reported no-op, never a partial merge', async () => {
    const h = harness([{ predicateId: 'a_thing', status: 'proposed', facts: 1 }], () => 'x');
    (h.svc as unknown as { judge: { isAvailable: () => boolean } }).judge.isAvailable = () => false;
    const r = await h.svc.run('co_x');
    expect(r).toMatchObject({ examined: 0, merged: 0, factsRepointed: 0 });
    expect(h.aliased).toEqual([]);
  });

  it('the candidate order is deterministic — fact count, then id', async () => {
    const h = harness(
      [
        { predicateId: 'zeta_launch_date', status: 'proposed', facts: 2 },
        { predicateId: 'alpha_launch_date', status: 'proposed', facts: 2 },
        { predicateId: 'pilot_launch_date', status: 'proposed', facts: 7 },
      ],
      () => null,
    );
    await h.svc.run('co_x');
    expect(h.asked.map((a) => a.candidate)).toEqual(['alpha_launch_date', 'zeta_launch_date']);
  });
});
