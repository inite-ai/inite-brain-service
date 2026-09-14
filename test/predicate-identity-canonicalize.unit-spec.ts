import { ConfigService } from '@nestjs/config';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { DEFAULT_FALLBACK } from '../src/ai/predicate-registry-internals/types';
import type { PredicateDefinition } from '../src/ai/predicate-registry-internals/types';

/**
 * Predicate identity adjudication in canonicalize().
 *
 * THE DEFECT. The similarity search was built from ACTIVE rows only —
 * `for (const { row, def } of all) { if (def.status !== 'active') continue; ... }`
 * — while every coined predicate lands as `proposed`. Measured on a live
 * memory-fitness tenant: 159 of 196 rows were proposed and all 159
 * carried a 1536-dim embedding no search could reach. So a coinage could
 * alias onto one of the 37 seeds and NEVER onto another coinage, and one
 * attribute ended up spread over `deploy_target`, `deploys_to` and
 * `deploys`; `queue_backend` beside `job_queue_backend`. Supersession is
 * per-predicate, so each fragment kept its own value active forever.
 *
 * WHY A JUDGE AND NOT A THRESHOLD. Measured over that vocabulary under
 * three embedding texts (coinage context, bare name, templated attribute
 * phrase), same-attribute pairs do NOT rank above different-attribute
 * pairs: the best variant puts `retry_policy`~`retry_attempts` (two
 * fields) at 0.790 and `pilot_launch_date`~`changed_launch_date` (one
 * field) at 0.721. No threshold exists. Cosine recall, though, is
 * excellent — the true partner ranked 1,2,1,1,2 — so it shortlists and
 * the judge decides.
 *
 * The fences pinned here are the ones that make that safe.
 */
function makeConfig(): ConfigService {
  return { get: <T>(_k: string, dflt?: T) => dflt as T } as unknown as ConfigService;
}

function def(over: Partial<PredicateDefinition>): PredicateDefinition {
  return { ...DEFAULT_FALLBACK, ...over } as PredicateDefinition;
}

/** Unit vector pointing at `deg` in the first two dimensions — lets a
 *  test state an exact cosine between two predicates. */
function vec(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [i, ai] of a.entries()) {
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return dot / Math.sqrt(na * nb);
}

interface Harness {
  svc: PredicateRegistryService;
  shortlists: string[][];
  created: Array<Record<string, unknown>>;
  /** Every (query, vars) pair the service sent to the DB. */
  queries: Array<{ q: string; vars?: Record<string, unknown> }>;
}

function harness(opts: {
  active?: Map<string, PredicateDefinition>;
  proposed?: Map<string, PredicateDefinition>;
  embeddings?: Map<string, number[]>;
  proposedEmbeddings?: Map<string, number[]>;
  pick?: (candidates: readonly string[]) => string | null;
  onQuery?: (q: string) => void;
  failSearch?: boolean;
  /** Record ids of already-written facts still carrying the raw coinage. */
  factsUnderNovel?: string[];
  /** Make the backfill's own query throw, and nothing else. */
  failBackfill?: boolean;
}): Harness {
  const shortlists: string[][] = [];
  const created: Array<Record<string, unknown>> = [];
  const queries: Array<{ q: string; vars?: Record<string, unknown> }> = [];
  const identityJudge = {
    sameAttributeAs: (_p: string, _c: string, candidates: readonly string[]) => {
      shortlists.push([...candidates]);
      return Promise.resolve(opts.pick ? opts.pick(candidates) : null);
    },
  };
  // The coined set's vectors live in the DB, never in the snapshot
  // (loadFresh OMITs them), so the candidate search is a query. This
  // stub answers it the way SurrealDB would: cosine, desc, LIMIT k.
  const surreal = {
    withCompany: async (_c: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: (
          q: string,
          vars?: {
            content?: Record<string, unknown>;
            q?: number[];
            self?: string;
            k?: number;
            novel?: string;
          },
        ) => {
          opts.onQuery?.(q);
          queries.push({ q, ...(vars ? { vars: vars as Record<string, unknown> } : {}) });
          if (vars?.content) created.push(vars.content);
          if (q.includes('FROM knowledge_fact') && q.includes('predicateAlias IS NONE')) {
            if (opts.failBackfill) return Promise.reject(new Error('planner exploded'));
            return Promise.resolve([opts.factsUnderNovel ?? []]);
          }
          if (q.includes(`status = 'proposed'`) && vars?.q) {
            if (opts.failSearch) return Promise.reject(new Error('planner exploded'));
            const rows = [...(opts.proposedEmbeddings ?? new Map<string, number[]>())]
              .filter(([pid]) => pid !== vars.self)
              .map(([predicateId, emb]) => ({ predicateId, score: cosine(vars.q!, emb) }))
              .sort((a, b) => b.score - a.score)
              .slice(0, vars.k ?? 3);
            return Promise.resolve([rows]);
          }
          return Promise.resolve([[]]);
        },
      }),
  };
  const embedder = { embed: () => Promise.resolve(vec(0)) };
  const svc = new PredicateRegistryService(
    surreal as never,
    embedder as never,
    makeConfig(),
    undefined,
    identityJudge as never,
  );
  const byId = opts.active ?? new Map<string, PredicateDefinition>();
  const policyById = new Map(byId);
  for (const [k, v] of opts.proposed ?? []) policyById.set(k, v);
  (svc as unknown as { cache: { set: (k: string, v: unknown) => void } }).cache.set('co_x', {
    snapshot: {
      byId,
      policyById,
      aliasMap: new Map(),
      knownIds: new Set([...byId.keys(), ...(opts.proposed?.keys() ?? [])]),
      embeddings: opts.embeddings ?? new Map(),
    },
    loadedAt: Date.now(),
  });
  return { svc, shortlists, created, queries };
}

describe('canonicalize — identity adjudication', () => {
  it('shortlists a PROPOSED predicate the old active-only search could not see', async () => {
    // 60° apart ⇒ cosine 0.5: far below the 0.85 auto-alias threshold,
    // above the 0.45 recall floor — precisely the band where the real
    // `deploy_target`~`deploys_to` pair (0.534) lives.
    const h = harness({
      proposed: new Map([
        [
          'queue_backend',
          def({ predicateId: 'queue_backend', semantics: 'single_active', status: 'proposed' }),
        ],
      ]),
      proposedEmbeddings: new Map([['queue_backend', vec(60)]]),
      pick: (c) => (c.includes('queue_backend') ? 'queue_backend' : null),
    });
    const d = await h.svc.canonicalize('co_x', 'job_queue_backend', 'job_queue_backend: NATS');
    expect(h.shortlists[0]).toEqual(['queue_backend']);
    expect(d).toMatchObject({ kind: 'aliased', canonicalId: 'queue_backend' });
  });

  it('the alias inherits the PROPOSED canon’s policy (byId alone would throw)', async () => {
    const h = harness({
      proposed: new Map([
        [
          'queue_backend',
          def({ predicateId: 'queue_backend', semantics: 'single_active', status: 'proposed' }),
        ],
      ]),
      proposedEmbeddings: new Map([['queue_backend', vec(60)]]),
      pick: () => 'queue_backend',
    });
    await h.svc.canonicalize('co_x', 'job_queue_backend', 'job_queue_backend: NATS');
    // The seed bootstrap CREATEs first, so pick the row by id.
    const row = h.created.find((c) => c.predicateId === 'job_queue_backend');
    expect(row).toMatchObject({
      predicateId: 'job_queue_backend',
      status: 'aliased',
      aliasedTo: 'queue_backend',
      semantics: 'single_active',
    });
  });

  it('a proposed row NEVER auto-aliases on cosine alone', async () => {
    // On the live tenant `retry_policy` sat at cosine 0.90 to the
    // proposed sentence-predicate `decided` — over the threshold. If
    // proposed embeddings fed the unadjudicated branch, that merge
    // would destroy the retry slot outright. Here the judge declines,
    // and a 0.98-cosine proposed neighbour still must not alias.
    const h = harness({
      proposed: new Map([['decided', def({ predicateId: 'decided', status: 'proposed' })]]),
      proposedEmbeddings: new Map([['decided', vec(10)]]), // cosine ≈ 0.985
      pick: () => null,
    });
    const d = await h.svc.canonicalize('co_x', 'retry_policy', 'retry_policy: exponential backoff');
    expect(d.kind).toBe('proposed');
  });

  it('an ACTIVE seed over the threshold still auto-aliases without consulting the judge', async () => {
    const h = harness({
      active: new Map([['status', def({ predicateId: 'status', semantics: 'single_active' })]]),
      embeddings: new Map([['status', vec(5)]]), // cosine ≈ 0.996
      pick: () => 'should-not-be-asked',
    });
    const d = await h.svc.canonicalize('co_x', 'lifecycle_status', 'lifecycle_status: active');
    expect(h.shortlists).toHaveLength(0);
    expect(d).toMatchObject({ kind: 'aliased', canonicalId: 'status' });
  });

  it('nothing above the recall floor ⇒ no call, propose as before', async () => {
    const h = harness({
      proposed: new Map([['unrelated', def({ predicateId: 'unrelated', status: 'proposed' })]]),
      proposedEmbeddings: new Map([['unrelated', vec(85)]]), // cosine ≈ 0.087
      pick: () => 'unrelated',
    });
    const d = await h.svc.canonicalize('co_x', 'payout_cutoff', 'payout_cutoff: 17:00');
    expect(h.shortlists).toHaveLength(0);
    expect(d.kind).toBe('proposed');
  });

  it('the candidate search is a BOUNDED DB query, not a snapshot scan', async () => {
    // The snapshot omits the coined set's vectors on purpose (0082: they
    // OOM'd the eval stand's SurrealDB). Pin both halves of that: the
    // query asks the DB for proposed rows with a dimension guard and a
    // LIMIT, and no proposed vector is ever read off the snapshot.
    const seen: string[] = [];
    const h = harness({
      proposed: new Map([
        ['queue_backend', def({ predicateId: 'queue_backend', status: 'proposed' })],
      ]),
      proposedEmbeddings: new Map([['queue_backend', vec(60)]]),
      pick: () => null,
      onQuery: (q) => seen.push(q),
    });
    await h.svc.canonicalize('co_x', 'job_queue_backend', 'job_queue_backend: NATS');
    const search = seen.find((q) => q.includes(`status = 'proposed'`));
    expect(search).toBeDefined();
    expect(search).toContain('vector::similarity::cosine');
    expect(search).toContain('array::len(embedding) = array::len($q)');
    expect(search).toContain('LIMIT $k');
    // The name filter is part of the contract, not a tuning detail:
    // without it the query materializes every coined row's 1536-dim
    // vector per novel predicate, which is what OOM-killed the stand's
    // SurrealDB (exit 137) while measuring this very change.
    expect(search).toContain('string::contains(predicateId, $t0)');
    const snapshot = (
      h.svc as unknown as { cache: { get: (k: string) => { snapshot: Record<string, unknown> } } }
    ).cache.get('co_x').snapshot;
    expect(snapshot.proposedEmbeddings).toBeUndefined();
  });

  it('a failed candidate search degrades to proposing, never to a throw', async () => {
    const h = harness({
      proposed: new Map([
        ['queue_backend', def({ predicateId: 'queue_backend', status: 'proposed' })],
      ]),
      proposedEmbeddings: new Map([['queue_backend', vec(60)]]),
      pick: () => 'queue_backend',
      failSearch: true,
    });
    const d = await h.svc.canonicalize('co_x', 'job_queue_backend', 'job_queue_backend: NATS');
    expect(h.shortlists).toHaveLength(0);
    expect(d.kind).toBe('proposed');
  });

  it('the shortlist is capped at 3 and ordered best-cosine-first, deterministically', async () => {
    const ids = ['queue_a50', 'queue_b55', 'queue_c60', 'queue_d65', 'queue_e70'];
    const h = harness({
      proposed: new Map(ids.map((id) => [id, def({ predicateId: id, status: 'proposed' })])),
      proposedEmbeddings: new Map([
        ['queue_a50', vec(50)],
        ['queue_b55', vec(55)],
        ['queue_c60', vec(60)],
        ['queue_d65', vec(65)],
        ['queue_e70', vec(70)], // cosine ≈ 0.342 — under the floor
      ]),
      pick: () => null,
    });
    await h.svc.canonicalize('co_x', 'queue_novel', 'queue_novel: v');
    expect(h.shortlists[0]).toEqual(['queue_a50', 'queue_b55', 'queue_c60']);
  });

  it('drops a close neighbour that shares no word with the coinage', async () => {
    // The live failure this guard exists for: `decided` sat inside the
    // recall floor of `fixed_retry_policy` and the judge merged them,
    // pouring every "X decided Y" fact into a single_active retry slot.
    const h = harness({
      proposed: new Map([
        ['fixed_retry_policy', def({ predicateId: 'fixed_retry_policy', status: 'proposed' })],
        ['retry_delay', def({ predicateId: 'retry_delay', status: 'proposed' })],
      ]),
      proposedEmbeddings: new Map([
        ['fixed_retry_policy', vec(20)], // closest by cosine
        ['retry_delay', vec(55)],
      ]),
      pick: (c) => c[0] ?? null,
    });
    const d = await h.svc.canonicalize('co_x', 'decided', 'decided: switch to exponential backoff');
    expect(h.shortlists).toHaveLength(0);
    expect(d.kind).toBe('proposed');
  });

  it('a coinage with no content tokens issues no candidate query at all', async () => {
    const seen: string[] = [];
    const h = harness({
      proposed: new Map([
        ['queue_backend', def({ predicateId: 'queue_backend', status: 'proposed' })],
      ]),
      proposedEmbeddings: new Map([['queue_backend', vec(60)]]),
      pick: () => 'queue_backend',
      onQuery: (q) => seen.push(q),
    });
    // 'v2' and 'id' are both under the three-character floor.
    const d = await h.svc.canonicalize('co_x', 'v2_id', 'v2_id: 7');
    expect(seen.some((q) => q.includes(`status = 'proposed'`))).toBe(false);
    expect(d.kind).toBe('proposed');
  });

  it('never shortlists the coinage against itself', async () => {
    const h = harness({
      proposed: new Map([['queue_novel', def({ predicateId: 'queue_novel', status: 'proposed' })]]),
      proposedEmbeddings: new Map([
        ['queue_novel', vec(0)],
        ['queue_other', vec(60)],
      ]),
      pick: () => null,
    });
    // `queue_novel` is in knownIds, so a repeat coinage short-circuits
    // before the search; ask about one that is not.
    await h.svc.canonicalize('co_x', 'queue_other2', 'queue_other2: v');
    expect(h.shortlists[0]).not.toContain('queue_other2');
  });

  it('with PREDICATE_IDENTITY_JUDGE cleared the judge is never consulted', async () => {
    process.env.PREDICATE_IDENTITY_JUDGE = '0';
    try {
      const h = harness({
        proposed: new Map([
          ['queue_backend', def({ predicateId: 'queue_backend', status: 'proposed' })],
        ]),
        proposedEmbeddings: new Map([['queue_backend', vec(60)]]),
        pick: () => 'queue_backend',
      });
      const d = await h.svc.canonicalize('co_x', 'job_queue_backend', 'job_queue_backend: NATS');
      expect(h.shortlists).toHaveLength(0);
      expect(d.kind).toBe('proposed');
    } finally {
      delete process.env.PREDICATE_IDENTITY_JUDGE;
    }
  });
});

/**
 * The alias backfill — without it the merge is forward-only and buys
 * nothing on the case it exists for.
 *
 * Measured on a battery tenant: the judge correctly merged
 * `deploy_target` and `deploys_to` into `deployed_to`, and the corpus
 * still held TWO active `Fly.io` facts, one under `deploy_target` and
 * one under `deployed_to` — because a fact keeps the predicate string it
 * was written with. Slot identity runs on `(predicateAlias ?? predicate)`
 * in the 0083 resolver's supersede/compete key and in the search dedupe
 * and diversity keys, so those rows sat in a slot the canon could never
 * reach. The vocabulary shrank 150 → 133 and `d1-deploy` failed all
 * three runs anyway.
 */
describe('canonicalize — carrying an alias back to already-written facts', () => {
  const aliasedHarness = (factsUnderNovel: string[]) =>
    harness({
      proposed: new Map([['deployed_to', def({ predicateId: 'deployed_to', status: 'proposed' })]]),
      proposedEmbeddings: new Map([['deployed_to', vec(60)]]),
      pick: () => 'deployed_to',
      factsUnderNovel,
    });

  it('points the pre-existing facts at the canon', async () => {
    const h = aliasedHarness(['knowledge_fact:a', 'knowledge_fact:b']);
    await h.svc.canonicalize('co_x', 'deploy_target', 'deploy_target: Fly.io');
    const update = h.queries.find((x) => x.q.includes('SET predicateAlias'));
    expect(update).toBeDefined();
    expect(update!.vars).toMatchObject({
      ids: ['knowledge_fact:a', 'knowledge_fact:b'],
      canon: 'deployed_to',
    });
  });

  it('selects the ids first and updates BY ID — the indexed-WHERE trap', async () => {
    // `predicate` is indexed, and on 3.2.4 an `UPDATE … WHERE` over an
    // indexed field is the silent no-op class: it reports success having
    // changed nothing. A backfill that hit it would look like it worked.
    const h = aliasedHarness(['knowledge_fact:a']);
    await h.svc.canonicalize('co_x', 'deploy_target', 'deploy_target: Fly.io');
    const update = h.queries.find((x) => x.q.includes('SET predicateAlias'))!;
    expect(update.q).toContain('UPDATE $ids');
    expect(update.q).not.toMatch(/UPDATE\s+knowledge_fact\s+SET/);
    const select = h.queries.find((x) => x.q.includes('FROM knowledge_fact'))!;
    expect(select.q).toContain('SELECT VALUE id');
  });

  it('only fills an EMPTY alias — never re-points a fact that has one', async () => {
    const h = aliasedHarness(['knowledge_fact:a']);
    await h.svc.canonicalize('co_x', 'deploy_target', 'deploy_target: Fly.io');
    const select = h.queries.find((x) => x.q.includes('FROM knowledge_fact'))!;
    expect(select.q).toContain('predicateAlias IS NONE');
  });

  it('writes nothing when no earlier fact carries the coinage', async () => {
    const h = aliasedHarness([]);
    await h.svc.canonicalize('co_x', 'deploy_target', 'deploy_target: Fly.io');
    expect(h.queries.some((x) => x.q.includes('SET predicateAlias'))).toBe(false);
  });

  it('a failed backfill never fails the coinage', async () => {
    const h = harness({
      proposed: new Map([['deployed_to', def({ predicateId: 'deployed_to', status: 'proposed' })]]),
      proposedEmbeddings: new Map([['deployed_to', vec(60)]]),
      pick: () => 'deployed_to',
      factsUnderNovel: ['knowledge_fact:a'],
      failBackfill: true,
    });
    const d = await h.svc.canonicalize('co_x', 'deploy_target', 'deploy_target: Fly.io');
    expect(d).toMatchObject({ kind: 'aliased', canonicalId: 'deployed_to' });
  });
});
