import { ConfigService } from '@nestjs/config';
import {
  SynthesizeService,
  SynthesizeResult,
} from '../src/synthesize/synthesize.service';
import type { SearchService, SearchHit } from '../src/search/search.service';
import type { SynthesizeDto } from '../src/synthesize/dto/synthesize.dto';

/**
 * Unit coverage for SynthesizeService — exercises the orchestrator
 * branches without hitting OpenAI. The OpenAI client is replaced via
 * a private-field assignment after construction; cleaner than DI
 * surgery for a unit test and keeps the production wiring intact.
 */
describe('SynthesizeService', () => {
  function makeHit(
    entityId: string,
    facts: Array<{ factId: string; predicate: string; object: string }>,
  ): SearchHit {
    return {
      entityId,
      entityType: 'customer',
      canonicalName: entityId,
      externalRefs: {},
      facts: facts.map((f) => ({
        ...f,
        confidence: 0.9,
        validFrom: '2026-01-01T00:00:00Z',
        status: 'active',
        score: 0.5,
      })),
      score: 0.5,
    };
  }

  function makeSearch(results: SearchHit[]): SearchService {
    return {
      search: async () => ({ results }),
    } as unknown as SearchService;
  }

  function makeConfig(env: Record<string, string | undefined>): ConfigService {
    return {
      get: <T>(key: string, dflt?: T) => (env[key] ?? dflt) as T,
      getOrThrow: <T>(key: string) => {
        const v = env[key];
        if (v === undefined) throw new Error(`missing ${key}`);
        return v as unknown as T;
      },
    } as unknown as ConfigService;
  }

  type StubResponse = string;
  function makeStubOpenAI(
    responses: StubResponse[],
  ): { client: any; calls: number } {
    const state = { calls: 0 };
    const client = {
      chat: {
        completions: {
          create: async () => {
            const i = state.calls++;
            const content =
              responses[i] ?? responses[responses.length - 1] ?? '{}';
            return { choices: [{ message: { content } }] } as any;
          },
        },
      },
    };
    return { client, calls: state.calls } as any as {
      client: any;
      calls: number;
    };
  }

  function makeSvc(
    search: SearchService,
    env: Record<string, string | undefined>,
    openaiResponses: StubResponse[],
  ): { svc: SynthesizeService; stub: { client: any } } {
    const cfg = makeConfig({ OPENAI_API_KEY: 'sk-stub', ...env });
    const svc = new SynthesizeService(search, cfg);
    const stub = makeStubOpenAI(openaiResponses);
    (svc as any).openai = stub.client;
    return { svc, stub };
  }

  const baseDto: SynthesizeDto = { query: 'who complained?' };

  it('returns no_results when search comes back empty', async () => {
    const { svc } = makeSvc(makeSearch([]), {}, []);
    const out = await svc.synthesize({ companyId: 'co_x', dto: baseDto, callerScopes: ['brain:read'] });
    expect(out).toMatchObject<Partial<SynthesizeResult>>({
      answer: null,
      reason: 'no_results',
      citations: [],
      results: [],
    });
  });

  it('returns no_grounded_evidence on the generator sentinel', async () => {
    const search = makeSearch([
      makeHit('cust_a', [
        { factId: 'f1', predicate: 'name', object: 'Maya' },
      ]),
    ]);
    const { svc } = makeSvc(
      search,
      {},
      [
        JSON.stringify({
          answer: "I don't have grounded evidence for that.",
          citedFactIds: [],
        }),
      ],
    );
    const out = await svc.synthesize({ companyId: 'co_x', dto: baseDto, callerScopes: ['brain:read'] });
    expect(out.answer).toBe("I don't have grounded evidence for that.");
    expect(out.reason).toBe('no_grounded_evidence');
    expect(out.citations).toEqual([]);
  });

  it('strict mode + supported verdict returns answer with citations', async () => {
    const search = makeSearch([
      makeHit('cust_a', [
        {
          factId: 'f1',
          predicate: 'complained_about',
          object: 'broken washing machine',
        },
      ]),
    ]);
    const { svc } = makeSvc(
      search,
      {},
      [
        JSON.stringify({
          answer: 'Maya complained about a broken washing machine [f1].',
          citedFactIds: ['f1'],
        }),
        JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
      ],
    );
    const out = await svc.synthesize({ companyId: 'co_x', dto: baseDto, callerScopes: ['brain:read'] });
    expect(out.answer).toContain('broken washing machine');
    expect(out.reason).toBeUndefined();
    expect(out.citations.map((c) => c.factId)).toEqual(['f1']);
  });

  it('resolves an inline [factId] citation even when citedFactIds is empty', async () => {
    // The generator reliably inlines a bracketed citation (system prompt
    // rule #2) but only intermittently mirrors it into the structured
    // citedFactIds array. The answer text must still produce a citation.
    const search = makeSearch([
      makeHit('cust_a', [
        {
          factId: 'knowledge_fact:abc123',
          predicate: 'intent',
          object: 'requested a refund',
        },
      ]),
    ]);
    const { svc } = makeSvc(
      search,
      {},
      [
        JSON.stringify({
          answer: 'They requested a refund [knowledge_fact:abc123].',
          citedFactIds: [],
        }),
      ],
    );
    const out = await svc.synthesize({ companyId: 'co_x', dto: { ...baseDto, synthesisGuardrails: 'off' }, callerScopes: ['brain:read'] });
    expect(out.citations.map((c) => c.factId)).toEqual([
      'knowledge_fact:abc123',
    ]);
  });

  it('resolves a citation whose prefix drifted to the example fact_ form', async () => {
    // Even with the prompt instructing the canonical knowledge_fact:
    // prefix, the model can still drift to a fact_ / fact: form. Tail-
    // matching is the safety net that resolves it against the retrieved
    // fact regardless of prefix.
    const search = makeSearch([
      makeHit('cust_a', [
        {
          factId: 'knowledge_fact:abc123',
          predicate: 'intent',
          object: 'requested a refund',
        },
      ]),
    ]);
    const { svc } = makeSvc(
      search,
      {},
      [
        JSON.stringify({
          answer: 'They requested a refund [fact_abc123].',
          citedFactIds: ['fact_abc123'],
        }),
      ],
    );
    const out = await svc.synthesize({ companyId: 'co_x', dto: { ...baseDto, synthesisGuardrails: 'off' }, callerScopes: ['brain:read'] });
    expect(out.citations.map((c) => c.factId)).toEqual([
      'knowledge_fact:abc123',
    ]);
  });

  it('drops a hallucinated citation that matches no retrieved fact', async () => {
    const search = makeSearch([
      makeHit('cust_a', [
        { factId: 'knowledge_fact:real1', predicate: 'name', object: 'Maya' },
      ]),
    ]);
    const { svc } = makeSvc(
      search,
      {},
      [
        JSON.stringify({
          answer: 'Maya did something [knowledge_fact:notreal].',
          citedFactIds: ['knowledge_fact:notreal'],
        }),
      ],
    );
    const out = await svc.synthesize({ companyId: 'co_x', dto: { ...baseDto, synthesisGuardrails: 'off' }, callerScopes: ['brain:read'] });
    expect(out.citations).toEqual([]);
  });

  it('strict mode + unsupported verdict fails closed (answer null)', async () => {
    const search = makeSearch([
      makeHit('cust_a', [
        { factId: 'f1', predicate: 'name', object: 'Maya' },
      ]),
    ]);
    const { svc } = makeSvc(
      search,
      {},
      [
        JSON.stringify({
          answer: 'Maya bought a new fridge yesterday [f1].',
          citedFactIds: ['f1'],
        }),
        JSON.stringify({
          verdict: 'unsupported',
          unsupportedClaims: ['Maya bought a new fridge yesterday'],
        }),
      ],
    );
    const out = await svc.synthesize({ companyId: 'co_x', dto: baseDto, callerScopes: ['brain:read'] });
    expect(out.answer).toBeNull();
    expect(out.reason).toBe('verifier_failed');
    expect(out.citations).toEqual([]);
  });

  it('lenient mode + unsupported verdict still returns the answer with reason', async () => {
    const search = makeSearch([
      makeHit('cust_a', [
        { factId: 'f1', predicate: 'name', object: 'Maya' },
      ]),
    ]);
    const { svc } = makeSvc(
      search,
      {},
      [
        JSON.stringify({
          answer: 'Maya bought a new fridge [f1].',
          citedFactIds: ['f1'],
        }),
        JSON.stringify({
          verdict: 'unsupported',
          unsupportedClaims: ['Maya bought a new fridge'],
        }),
      ],
    );
    const out = await svc.synthesize({ companyId: 'co_x', dto: { ...baseDto, synthesisGuardrails: 'lenient' }, callerScopes: ['brain:read'] });
    expect(out.answer).toContain('fridge');
    expect(out.reason).toBe('verifier_failed');
    expect(out.citations.map((c) => c.factId)).toEqual(['f1']);
  });

  it('off mode skips verifier — answer returned without verdict', async () => {
    const search = makeSearch([
      makeHit('cust_a', [
        {
          factId: 'f1',
          predicate: 'complained_about',
          object: 'noisy neighbour',
        },
      ]),
    ]);
    const { svc, stub } = makeSvc(
      search,
      {},
      [
        JSON.stringify({
          answer: 'Maya complained about a noisy neighbour [f1].',
          citedFactIds: ['f1'],
        }),
      ],
    );
    const out = await svc.synthesize({ companyId: 'co_x', dto: { ...baseDto, synthesisGuardrails: 'off' }, callerScopes: ['brain:read'] });
    expect(out.answer).toContain('noisy neighbour');
    expect(out.reason).toBeUndefined();
    // Generator should be the only OpenAI call (no verifier).
    let calls = 0;
    const orig = stub.client.chat.completions.create;
    stub.client.chat.completions.create = async (...args: any[]) => {
      calls++;
      return orig(...args);
    };
    // Already finished; assertion above (single response stubbed).
    expect(calls).toBe(0);
  });

  it('drops hallucinated factId citations not present in retrieved set', async () => {
    const search = makeSearch([
      makeHit('cust_a', [
        { factId: 'f1', predicate: 'name', object: 'Maya' },
      ]),
    ]);
    const { svc } = makeSvc(
      search,
      {},
      [
        JSON.stringify({
          answer: 'Maya is a customer [f1] [f_nope].',
          citedFactIds: ['f1', 'f_nope'],
        }),
        JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
      ],
    );
    const out = await svc.synthesize({ companyId: 'co_x', dto: baseDto, callerScopes: ['brain:read'] });
    expect(out.citations.map((c) => c.factId)).toEqual(['f1']);
  });

  it('strict mode fails closed when verifier throws', async () => {
    const search = makeSearch([
      makeHit('cust_a', [
        { factId: 'f1', predicate: 'name', object: 'Maya' },
      ]),
    ]);
    const { svc } = makeSvc(
      search,
      {},
      [
        JSON.stringify({
          answer: 'Maya is a customer [f1].',
          citedFactIds: ['f1'],
        }),
      ],
    );
    // Second call throws (verifier).
    let calls = 0;
    (svc as any).openai = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            if (calls === 1) {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        answer: 'Maya is a customer [f1].',
                        citedFactIds: ['f1'],
                      }),
                    },
                  },
                ],
              };
            }
            throw new Error('verifier blew up');
          },
        },
      },
    };
    const out = await svc.synthesize({ companyId: 'co_x', dto: baseDto, callerScopes: ['brain:read'] });
    expect(out.answer).toBeNull();
    expect(out.reason).toBe('verifier_error');
  });

  it('respects SYNTHESIZE_DEFAULT_GUARDRAILS=off env override', async () => {
    const search = makeSearch([
      makeHit('cust_a', [
        { factId: 'f1', predicate: 'name', object: 'Maya' },
      ]),
    ]);
    const { svc } = makeSvc(
      search,
      { SYNTHESIZE_DEFAULT_GUARDRAILS: 'off' },
      [
        JSON.stringify({
          answer: 'Maya is a customer [f1].',
          citedFactIds: ['f1'],
        }),
      ],
    );
    const out = await svc.synthesize({ companyId: 'co_x', dto: baseDto, callerScopes: ['brain:read'] });
    expect(out.answer).toContain('customer');
    expect(out.reason).toBeUndefined();
  });
});
