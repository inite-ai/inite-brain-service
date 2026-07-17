/**
 * Unit coverage for the tenant-aware predicate router vocabulary
 * (domain-routed retrieval). A supplied vocab must: extend the strict
 * JSON schema + prompt with the pack predicates, fan a domain-level
 * weight out to its members, and key the LRU cache by vocab.version so a
 * pack install/upgrade busts it. Undefined vocab must be byte-identical
 * to the historical behaviour.
 */
import { PredicateRouterService } from '../src/ai/predicate-router.service';
import type { RouterVocabulary } from '../src/ai/domain-routing.service';

function makeRouter(create: jest.Mock): PredicateRouterService {
  const config = {
    get: (k: string, d?: string) => {
      if (k === 'SEARCH_PREDICATE_ROUTER_ENABLED') return '1';
      return d;
    },
  };
  const svc = new PredicateRouterService(config as never);
  // Replace the SDK client with a stub capturing the request.
  (svc as unknown as { openai: unknown }).openai = {
    chat: { completions: { create } },
  };
  return svc;
}

function reply(weights: Record<string, number>): { choices: unknown[] } {
  const predicates = { ...weights };
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            predicates,
            types: { customer: 1, staff: 0, asset: 0, project: 0, topic: 0, location: 0, other: 0 },
          }),
        },
      },
    ],
  };
}

const VOCAB: RouterVocabulary = {
  version: 'v1',
  entries: [
    { id: 'persona__life_event', label: 'life event', hint: 'a life episode' },
    { id: 'persona__felt', label: 'felt', hint: 'an emotion about a thing' },
  ],
};

describe('PredicateRouterService — tenant vocab', () => {
  it('adds pack predicate keys to the strict schema and prompt', async () => {
    const create = jest.fn().mockResolvedValue(
      reply({ persona__life_event: 1 }),
    );
    const svc = makeRouter(create);
    await svc.route('how did the marathon feel', VOCAB);

    const arg = create.mock.calls[0][0];
    const schemaProps =
      arg.response_format.json_schema.schema.properties.predicates.properties;
    expect(schemaProps).toHaveProperty('persona__life_event');
    expect(schemaProps).toHaveProperty('persona__felt');
    // Core vocab still present.
    expect(schemaProps).toHaveProperty('name');
    // Prompt lists the pack predicates.
    const sys = arg.messages[0].content as string;
    expect(sys).toContain('persona__life_event');
    expect(sys).toContain('installed domain packs');
  });

  it('returns weights on the namespaced pack keys', async () => {
    const create = jest.fn().mockResolvedValue(
      reply({ persona__felt: 0.7 }),
    );
    const svc = makeRouter(create);
    const out = await svc.route('feeling', VOCAB);
    expect(out?.predicates.weights.persona__felt).toBeGreaterThan(0);
  });

  it('fans a domain-level weight out to member predicates', async () => {
    const domainVocab: RouterVocabulary = {
      version: 'v2',
      entries: [
        {
          id: 'persona',
          label: 'persona',
          hint: 'persona pack',
          expandTo: ['persona__life_event', 'persona__felt'],
        },
      ],
    };
    // Sum ≈ 1 so normalizeDist leaves the 0.6 mass intact before fan-out.
    const create = jest
      .fn()
      .mockResolvedValue(reply({ persona: 0.6, name: 0.4 }));
    const svc = makeRouter(create);
    const out = await svc.route('q', domainVocab);
    // The pack-id key is removed; both members inherit the weight.
    expect(out?.predicates.weights.persona).toBeUndefined();
    expect(out?.predicates.weights.persona__life_event).toBeCloseTo(0.6, 6);
    expect(out?.predicates.weights.persona__felt).toBeCloseTo(0.6, 6);
  });

  it('caches by (query, vocab.version): same version hits, new version misses', async () => {
    const create = jest.fn().mockResolvedValue(reply({ name: 1 }));
    const svc = makeRouter(create);
    await svc.route('same query', VOCAB);
    await svc.route('same query', VOCAB); // cache hit
    expect(create).toHaveBeenCalledTimes(1);

    await svc.route('same query', { ...VOCAB, version: 'v9' }); // bust
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('undefined vocab uses only the core schema (no pack keys)', async () => {
    const create = jest.fn().mockResolvedValue(reply({ name: 1 }));
    const svc = makeRouter(create);
    await svc.route('who is Ada');
    const arg = create.mock.calls[0][0];
    const schemaProps =
      arg.response_format.json_schema.schema.properties.predicates.properties;
    expect(schemaProps).not.toHaveProperty('persona__life_event');
    expect(arg.messages[0].content).not.toContain('installed domain packs');
  });
});
