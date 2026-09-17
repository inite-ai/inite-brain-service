import { ConfigService } from '@nestjs/config';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';

/**
 * `registry.alias()` moves the ROW and the FACTS.
 *
 * Slot identity runs on `(predicateAlias ?? predicate)` — the 0083
 * resolver's supersede/compete key, the search dedupe and diversity
 * keys, scoring. An alias that stops at the registry row therefore
 * leaves every already-written fact in a slot the canon cannot reach.
 * Measured exactly that way on a battery tenant: the vocabulary
 * correctly merged `deploy_target` and `deploys_to` into `deployed_to`,
 * and the corpus still served two active `Fly.io` facts.
 */
function harness(opts: { factsUnderNovel?: string[]; failBackfill?: boolean } = {}) {
  const queries: Array<{ q: string; vars?: Record<string, unknown> }> = [];
  const surreal = {
    withCompany: async (_c: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: (q: string, vars?: Record<string, unknown>) => {
          queries.push({ q, ...(vars ? { vars } : {}) });
          if (q.includes('FROM knowledge_fact') && q.includes('predicateAlias IS NONE')) {
            if (opts.failBackfill) return Promise.reject(new Error('planner exploded'));
            return Promise.resolve([opts.factsUnderNovel ?? []]);
          }
          if (q.includes('UPDATE knowledge_predicate')) {
            return Promise.resolve([[{ predicateId: 'deploy_target', status: 'aliased' }]]);
          }
          return Promise.resolve([[]]);
        },
      }),
  };
  const config = { get: <T>(_k: string, d?: T) => d as T } as unknown as ConfigService;
  const svc = new PredicateRegistryService(surreal as never, {} as never, config);
  return { svc, queries };
}

describe('registry.alias — carrying an alias onto already-written facts', () => {
  it('points the pre-existing facts at the canon', async () => {
    const h = harness({ factsUnderNovel: ['knowledge_fact:a', 'knowledge_fact:b'] });
    const out = await h.svc.alias('co_x', 'deploy_target', 'deployed_to');
    const update = h.queries.find((x) => x.q.includes('SET predicateAlias'));
    expect(update!.vars).toMatchObject({
      ids: ['knowledge_fact:a', 'knowledge_fact:b'],
      canon: 'deployed_to',
    });
    expect(out.factsRepointed).toBe(2);
  });

  it('selects the ids first and updates BY ID — the indexed-WHERE trap', async () => {
    // `predicate` is indexed, and on 3.2.4 an `UPDATE … WHERE` over an
    // indexed field is the silent no-op class: it reports success having
    // changed nothing, so a backfill written that way would LOOK correct.
    const h = harness({ factsUnderNovel: ['knowledge_fact:a'] });
    await h.svc.alias('co_x', 'deploy_target', 'deployed_to');
    const update = h.queries.find((x) => x.q.includes('SET predicateAlias'))!;
    expect(update.q).toContain('UPDATE $ids');
    expect(update.q).not.toMatch(/UPDATE\s+knowledge_fact\s+SET/);
    const select = h.queries.find((x) => x.q.includes('FROM knowledge_fact'))!;
    expect(select.q).toContain('SELECT VALUE id');
  });

  it('only fills an EMPTY alias — never re-points a fact that has one', async () => {
    const h = harness({ factsUnderNovel: ['knowledge_fact:a'] });
    await h.svc.alias('co_x', 'deploy_target', 'deployed_to');
    const select = h.queries.find((x) => x.q.includes('FROM knowledge_fact'))!;
    expect(select.q).toContain('predicateAlias IS NONE');
  });

  it('writes nothing when no earlier fact carries the coinage', async () => {
    const h = harness({ factsUnderNovel: [] });
    const out = await h.svc.alias('co_x', 'deploy_target', 'deployed_to');
    expect(h.queries.some((x) => x.q.includes('SET predicateAlias'))).toBe(false);
    expect(out.factsRepointed).toBe(0);
  });

  it('a failed backfill never fails the alias', async () => {
    const h = harness({ factsUnderNovel: ['knowledge_fact:a'], failBackfill: true });
    await expect(h.svc.alias('co_x', 'deploy_target', 'deployed_to')).resolves.toMatchObject({
      factsRepointed: 0,
    });
  });
});
