/**
 * Unit coverage for DomainRoutingService — the pre-retrieval domain
 * signal (SEARCH_DOMAIN_ROUTING_ENABLED). Cosine grouping by pack
 * namespace, threshold, vocab cap/degradation, fail-open, versionHash
 * cache-bust, and the caller-predicate skip (asserted at the call site
 * in search.service, checked here via isEnabled/getDomainSignal).
 */
import { DomainRoutingService } from '../src/ai/domain-routing.service';
import type {
  PredicateSnapshot,
  PredicateDefinition,
} from '../src/ai/predicate-registry-internals/types';

// A unit vector along axis `axis` of dimension `dim` — cosine with
// another unit axis vector is 1.0 if same axis, 0.0 otherwise, so we can
// steer per-domain affinity deterministically.
function axisVec(axis: number, dim = 8): number[] {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

function def(
  predicateId: string,
  over: Partial<PredicateDefinition> = {},
): PredicateDefinition {
  return {
    predicateId,
    displayLabel: predicateId,
    description: `${predicateId}. TYPE: a thing. VALUE: verbatim.`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
    ...over,
  };
}

function snapshot(
  defs: PredicateDefinition[],
  embeddings: Map<string, number[]>,
  versionHash = 'v1',
): PredicateSnapshot {
  return {
    versionHash,
    active: defs,
    byId: new Map(defs.map((d) => [d.predicateId, d])),
    aliasMap: new Map(),
    embeddings,
    extractionProfiles: [],
  };
}

function makeService(
  snap: PredicateSnapshot,
  embed: (q: string) => number[],
): DomainRoutingService {
  const registry = {
    getSnapshot: jest.fn().mockResolvedValue(snap),
  };
  const embedder = {
    embed: jest.fn(async (q: string) => embed(q)),
  };
  return new DomainRoutingService(
    registry as never,
    embedder as never,
  );
}

const ENV_KEYS = [
  'SEARCH_DOMAIN_ROUTING_ENABLED',
  'SEARCH_DOMAIN_ROUTING_MODE',
  'SEARCH_DOMAIN_ROUTING_MIN_SIM',
  'SEARCH_DOMAIN_ROUTER_VOCAB_MAX',
  'SEARCH_DOMAIN_BOOST_ALPHA',
];

describe('DomainRoutingService', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SEARCH_DOMAIN_ROUTING_ENABLED = '1';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const twoPackSnap = () => {
    const defs = [
      def('name'), // core
      def('status'), // core
      def('persona__life_event'),
      def('persona__felt'),
      def('real_estate__zoned_as'),
    ];
    const emb = new Map<string, number[]>([
      ['persona__life_event', axisVec(0)],
      ['persona__felt', axisVec(0)],
      ['real_estate__zoned_as', axisVec(1)],
      // core predicates have no embeddings here — they never form a domain
    ]);
    return snapshot(defs, emb);
  };

  it('returns null when the flag is off', async () => {
    process.env.SEARCH_DOMAIN_ROUTING_ENABLED = '0';
    const svc = makeService(twoPackSnap(), () => axisVec(0));
    expect(svc.isEnabled()).toBe(false);
    expect(await svc.getDomainSignal('c1', 'anything')).toBeNull();
  });

  it('returns null when the tenant has no pack predicates', async () => {
    const snap = snapshot(
      [def('name'), def('status')],
      new Map(),
    );
    const svc = makeService(snap, () => axisVec(0));
    expect(await svc.getDomainSignal('c1', 'hi there')).toBeNull();
  });

  it('groups predicates by pack namespace and matches by cosine', async () => {
    // Query embedding aligned with axis-0 → persona domain matches, real_estate doesn't.
    const svc = makeService(twoPackSnap(), () => axisVec(0));
    const sig = await svc.getDomainSignal('c1', 'how did the marathon feel');
    expect(sig).not.toBeNull();
    const persona = sig!.affinities.find((a) => a.domain === 'persona');
    const estate = sig!.affinities.find((a) => a.domain === 'real_estate');
    expect(persona!.sim).toBeCloseTo(1, 6);
    expect(estate!.sim).toBeCloseTo(0, 6);
    expect(sig!.matched.map((m) => m.domain)).toEqual(['persona']);
    // Boost input carries persona predicates only.
    expect(sig!.boost).not.toBeNull();
    expect(Object.keys(sig!.boost!.simByPredicate).sort()).toEqual([
      'persona__felt',
      'persona__life_event',
    ]);
    // narrowTo = core ∪ matched-domain predicates; core never excluded.
    expect(sig!.narrowTo).toEqual(
      expect.arrayContaining(['name', 'status', 'persona__life_event', 'persona__felt']),
    );
    expect(sig!.narrowTo).not.toContain('real_estate__zoned_as');
  });

  it('no domain above threshold → null boost + null narrowTo', async () => {
    process.env.SEARCH_DOMAIN_ROUTING_MIN_SIM = '0.9';
    // Query orthogonal to both domains.
    const svc = makeService(twoPackSnap(), () => axisVec(5));
    const sig = await svc.getDomainSignal('c1', 'unrelated');
    expect(sig!.matched).toEqual([]);
    expect(sig!.boost).toBeNull();
    expect(sig!.narrowTo).toBeNull();
  });

  it('lists pack predicates individually under the vocab cap', async () => {
    const svc = makeService(twoPackSnap(), () => axisVec(0));
    const sig = await svc.getDomainSignal('c1', 'q');
    const ids = sig!.vocab.entries.map((e) => e.id).sort();
    expect(ids).toEqual([
      'persona__felt',
      'persona__life_event',
      'real_estate__zoned_as',
    ]);
    expect(sig!.vocab.entries.every((e) => e.expandTo === undefined)).toBe(true);
  });

  it('degrades to one domain-level entry per pack past the cap', async () => {
    process.env.SEARCH_DOMAIN_ROUTER_VOCAB_MAX = '2';
    const svc = makeService(twoPackSnap(), () => axisVec(0));
    const sig = await svc.getDomainSignal('c1', 'q');
    const ids = sig!.vocab.entries.map((e) => e.id).sort();
    expect(ids).toEqual(['persona', 'real_estate']);
    const persona = sig!.vocab.entries.find((e) => e.id === 'persona');
    expect(persona!.expandTo).toEqual(
      expect.arrayContaining(['persona__life_event', 'persona__felt']),
    );
  });

  it('vocab version tracks the snapshot versionHash (cache-bust)', async () => {
    const snap = twoPackSnap();
    (snap as { versionHash: string }).versionHash = 'abc123';
    const svc = makeService(snap, () => axisVec(0));
    const sig = await svc.getDomainSignal('c1', 'q');
    expect(sig!.vocab.version).toBe('abc123');
    expect(sig!.version).toBe('abc123');
  });

  it('fails open (null) when the embedder throws', async () => {
    const svc = makeService(twoPackSnap(), () => {
      throw new Error('embed down');
    });
    expect(await svc.getDomainSignal('c1', 'q')).toBeNull();
  });

  it('mode() reflects SEARCH_DOMAIN_ROUTING_MODE', () => {
    const svc = makeService(twoPackSnap(), () => axisVec(0));
    expect(svc.mode()).toBe('boost');
    process.env.SEARCH_DOMAIN_ROUTING_MODE = 'filter';
    expect(svc.mode()).toBe('filter');
    process.env.SEARCH_DOMAIN_ROUTING_MODE = 'bogus';
    expect(svc.mode()).toBe('boost');
  });
});
