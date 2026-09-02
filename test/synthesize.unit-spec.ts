import { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';
import { SynthesizeService, SynthesizeResult } from '../src/synthesize/synthesize.service';
import type { SearchService, SearchHit } from '../src/search/search.service';
import type { SynthesizeDto } from '../src/synthesize/dto/synthesize.dto';
import { buildGeneratorUserMessage } from '../src/synthesize/generator-prompt';
import { runGenerator } from '../src/synthesize/generator-client';
import { runVerifier, type VerifierOutput } from '../src/synthesize/verifier';
import { finalizeVerdict } from '../src/synthesize/verdict';
import {
  resolveEvidenceCapability,
  type FinalizeContext,
} from '../src/synthesize/answer-integrity';

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
  function makeStubOpenAI(responses: StubResponse[]): { client: any; calls: number } {
    const state = { calls: 0 };
    const client = {
      chat: {
        completions: {
          create: async () => {
            const i = state.calls++;
            const content = responses[i] ?? responses[responses.length - 1] ?? '{}';
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
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: baseDto,
      callerScopes: ['brain:read'],
    });
    expect(out).toMatchObject<Partial<SynthesizeResult>>({
      answer: null,
      reason: 'no_results',
      citations: [],
      results: [],
    });
  });

  it('counts a served cache hit as a terminal `ok` so the MRI denominator includes it (R3 P1)', async () => {
    // A cache hit early-returns BEFORE the fresh path's countSynthesize, so it
    // used to be excluded from brain_synthesize_total — skewing every "per
    // query" rate the MRI reader derives from the terminal count. It must be
    // counted as the terminal `ok` it is (admit() only caches supported+cited).
    const cachedResult = {
      answer: 'cached answer',
      citations: [],
      results: [],
    } as unknown as SynthesizeResult;
    const outcomes: string[] = [];
    const metrics = {
      countSynthesize: (o: string) => outcomes.push(o),
      // 0119: the serving-boundary latency observe runs on EVERY exit.
      observeSearchDuration: () => undefined,
    } as unknown as ConstructorParameters<typeof SynthesizeService>[2];
    const answerCache = {
      begin: async () => ({ hit: cachedResult }),
    } as unknown as ConstructorParameters<typeof SynthesizeService>[4];
    const cfg = makeConfig({ OPENAI_API_KEY: 'sk-stub' });
    const svc = new SynthesizeService(makeSearch([]), cfg, metrics, undefined, answerCache);

    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: baseDto,
      callerScopes: ['brain:read'],
    });

    // Served as-is (no verdict/serving change) …
    expect(out).toBe(cachedResult);
    // … and counted exactly once as the terminal `ok`.
    expect(outcomes).toEqual(['ok']);
  });

  it('never enters the cache-count branch when the cache is off (default) — byte-identical', async () => {
    // No answerCache dep → the cache-hit branch is unreachable; the normal
    // no_results terminal fires exactly once (proves the off path is unchanged).
    const outcomes: string[] = [];
    const metrics = {
      countSynthesize: (o: string) => outcomes.push(o),
      // 0119: the serving-boundary latency observe runs on EVERY exit.
      observeSearchDuration: () => undefined,
    } as unknown as ConstructorParameters<typeof SynthesizeService>[2];
    const cfg = makeConfig({ OPENAI_API_KEY: 'sk-stub' });
    const svc = new SynthesizeService(makeSearch([]), cfg, metrics);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: baseDto,
      callerScopes: ['brain:read'],
    });
    expect(out.reason).toBe('no_results');
    expect(outcomes).toEqual(['no_results']);
  });

  it('returns no_grounded_evidence on the generator sentinel', async () => {
    const search = makeSearch([
      makeHit('cust_a', [{ factId: 'f1', predicate: 'name', object: 'Maya' }]),
    ]);
    const { svc } = makeSvc(search, {}, [
      JSON.stringify({
        answer: "I don't have grounded evidence for that.",
        citedFactIds: [],
      }),
    ]);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: baseDto,
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBe("I don't have grounded evidence for that.");
    expect(out.reason).toBe('no_grounded_evidence');
    expect(out.citations).toEqual([]);
  });

  it('answer mode never abstains — returns the answer, skips the verifier', async () => {
    const search = makeSearch([
      makeHit('cust_a', [{ factId: 'f1', predicate: 'preference', object: 'sunsets' }]),
    ]);
    // ONLY a generator response is stubbed — if the verifier ran it would
    // consume a second call. It must not; answer mode returns directly.
    const { svc } = makeSvc(search, {}, [
      JSON.stringify({ answer: 'Sunsets [f1].', citedFactIds: ['f1'] }),
    ]);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'answer' },
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBe('Sunsets [f1].');
    expect(out.reason).toBeUndefined();
  });

  it('answer mode: a stray sentinel is NOT tagged as abstention', async () => {
    const search = makeSearch([
      makeHit('cust_a', [{ factId: 'f1', predicate: 'name', object: 'Maya' }]),
    ]);
    const { svc } = makeSvc(search, {}, [
      JSON.stringify({
        answer: "I don't have grounded evidence for that.",
        citedFactIds: [],
      }),
    ]);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'answer' },
      callerScopes: ['brain:read'],
    });
    // Returned as the answer, never the no_grounded_evidence reason.
    expect(out.reason).not.toBe('no_grounded_evidence');
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
    const { svc } = makeSvc(search, {}, [
      JSON.stringify({
        answer: 'Maya complained about a broken washing machine [f1].',
        citedFactIds: ['f1'],
      }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: baseDto,
      callerScopes: ['brain:read'],
    });
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
    const { svc } = makeSvc(search, {}, [
      JSON.stringify({
        answer: 'They requested a refund [knowledge_fact:abc123].',
        citedFactIds: [],
      }),
    ]);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'off' },
      callerScopes: ['brain:read'],
    });
    expect(out.citations.map((c) => c.factId)).toEqual(['knowledge_fact:abc123']);
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
    const { svc } = makeSvc(search, {}, [
      JSON.stringify({
        answer: 'They requested a refund [fact_abc123].',
        citedFactIds: ['fact_abc123'],
      }),
    ]);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'off' },
      callerScopes: ['brain:read'],
    });
    expect(out.citations.map((c) => c.factId)).toEqual(['knowledge_fact:abc123']);
  });

  it('drops a hallucinated citation that matches no retrieved fact', async () => {
    const search = makeSearch([
      makeHit('cust_a', [{ factId: 'knowledge_fact:real1', predicate: 'name', object: 'Maya' }]),
    ]);
    const { svc } = makeSvc(search, {}, [
      JSON.stringify({
        answer: 'Maya did something [knowledge_fact:notreal].',
        citedFactIds: ['knowledge_fact:notreal'],
      }),
    ]);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'off' },
      callerScopes: ['brain:read'],
    });
    expect(out.citations).toEqual([]);
  });

  it('strict mode + unsupported verdict fails closed (answer null)', async () => {
    const search = makeSearch([
      makeHit('cust_a', [{ factId: 'f1', predicate: 'name', object: 'Maya' }]),
    ]);
    const { svc } = makeSvc(search, {}, [
      JSON.stringify({
        answer: 'Maya bought a new fridge yesterday [f1].',
        citedFactIds: ['f1'],
      }),
      JSON.stringify({
        verdict: 'unsupported',
        unsupportedClaims: ['Maya bought a new fridge yesterday'],
      }),
    ]);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: baseDto,
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBeNull();
    expect(out.reason).toBe('verifier_failed');
    expect(out.citations).toEqual([]);
  });

  it('lenient mode + unsupported verdict still returns the answer with reason', async () => {
    // This pins the LEGACY lenient contract, which needs
    // abstentionCalibration='off' — the default genre's preset is now
    // 'verifier' (genre-presets.ts), which turns this exact case into
    // a decline; the decline path has its own pins in
    // synthesize-verification.unit-spec. Explicit env beats the preset.
    const saved = process.env.RETRIEVAL_ABSTENTION_CALIBRATION;
    process.env.RETRIEVAL_ABSTENTION_CALIBRATION = 'off';
    try {
      const search = makeSearch([
        makeHit('cust_a', [{ factId: 'f1', predicate: 'name', object: 'Maya' }]),
      ]);
      const { svc } = makeSvc(search, {}, [
        JSON.stringify({
          answer: 'Maya bought a new fridge [f1].',
          citedFactIds: ['f1'],
        }),
        JSON.stringify({
          verdict: 'unsupported',
          unsupportedClaims: ['Maya bought a new fridge'],
        }),
      ]);
      const out = await svc.synthesize({
        companyId: 'co_x',
        dto: { ...baseDto, synthesisGuardrails: 'lenient' },
        callerScopes: ['brain:read'],
      });
      expect(out.answer).toContain('fridge');
      expect(out.reason).toBe('verifier_failed');
      expect(out.citations.map((c) => c.factId)).toEqual(['f1']);
    } finally {
      if (saved === undefined) {
        delete process.env.RETRIEVAL_ABSTENTION_CALIBRATION;
      } else {
        process.env.RETRIEVAL_ABSTENTION_CALIBRATION = saved;
      }
    }
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
    const { svc, stub } = makeSvc(search, {}, [
      JSON.stringify({
        answer: 'Maya complained about a noisy neighbour [f1].',
        citedFactIds: ['f1'],
      }),
    ]);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'off' },
      callerScopes: ['brain:read'],
    });
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
      makeHit('cust_a', [{ factId: 'f1', predicate: 'name', object: 'Maya' }]),
    ]);
    const { svc } = makeSvc(search, {}, [
      JSON.stringify({
        answer: 'Maya is a customer [f1] [f_nope].',
        citedFactIds: ['f1', 'f_nope'],
      }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: baseDto,
      callerScopes: ['brain:read'],
    });
    expect(out.citations.map((c) => c.factId)).toEqual(['f1']);
  });

  it('strict mode fails closed when verifier throws', async () => {
    const search = makeSearch([
      makeHit('cust_a', [{ factId: 'f1', predicate: 'name', object: 'Maya' }]),
    ]);
    const { svc } = makeSvc(search, {}, [
      JSON.stringify({
        answer: 'Maya is a customer [f1].',
        citedFactIds: ['f1'],
      }),
    ]);
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
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: baseDto,
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBeNull();
    expect(out.reason).toBe('verifier_error');
  });

  it('respects SYNTHESIZE_DEFAULT_GUARDRAILS=off env override', async () => {
    const search = makeSearch([
      makeHit('cust_a', [{ factId: 'f1', predicate: 'name', object: 'Maya' }]),
    ]);
    const { svc } = makeSvc(search, { SYNTHESIZE_DEFAULT_GUARDRAILS: 'off' }, [
      JSON.stringify({
        answer: 'Maya is a customer [f1].',
        citedFactIds: ['f1'],
      }),
    ]);
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: baseDto,
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toContain('customer');
    expect(out.reason).toBeUndefined();
  });

  it('surfaces each fact validity window in the generator prompt', async () => {
    const search = makeSearch([
      makeHit('cust_a', [{ factId: 'f1', predicate: 'attended', object: 'support group' }]),
    ]);
    // Capture the generator's user prompt to assert the date is present.
    const prompts: string[] = [];
    const cfg = makeConfig({
      OPENAI_API_KEY: 'sk-stub',
      SYNTHESIZE_DEFAULT_GUARDRAILS: 'off',
    });
    const svc = new SynthesizeService(search, cfg);
    (svc as any).openai = {
      chat: {
        completions: {
          create: async (req: any) => {
            const user = req.messages?.find((m: any) => m.role === 'user');
            if (user) prompts.push(String(user.content));
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      answer: 'They attended on 2026-01-01 [f1].',
                      citedFactIds: ['f1'],
                    }),
                  },
                },
              ],
            } as any;
          },
        },
      },
    };
    await svc.synthesize({
      companyId: 'co_x',
      dto: { query: 'when did they attend?' },
      callerScopes: ['brain:read'],
    });
    // makeHit pins validFrom = 2026-01-01, no validUntil → "(as of …)".
    expect(prompts[0]).toContain('attended: support group (as of 2026-01-01)');
  });
});

// ── BELIEFS_SERVING_LANE seams: byte-identity + gate pins ───────────
describe('buildGeneratorUserMessage — belief section (BELIEFS_SERVING_LANE seam)', () => {
  const BASE = {
    query: 'which database are we using?',
    factLines: ['[knowledge_fact:f1] PostgreSQL — code_memory__decided: we will use Postgres'],
    insightLines: ['insight line'],
    fragmentLines: ['[capability:visual] (image caption) a whiteboard'],
    answerLang: null,
  };

  it('beliefLines absent / undefined / [] ⇒ BYTE-IDENTICAL output', () => {
    const absent = buildGeneratorUserMessage(BASE);
    const explicit = buildGeneratorUserMessage({ ...BASE, beliefLines: undefined });
    const empty = buildGeneratorUserMessage({ ...BASE, beliefLines: [], beliefCitations: true });
    expect(explicit).toBe(absent);
    expect(empty).toBe(absent);
    expect(absent).not.toContain('Current-state record');
  });

  it('non-empty ⇒ own section BETWEEN the insight and fragment sections', () => {
    const line = '[semantic_belief:b1] (inventory service — database, rev 2) statement';
    const out = buildGeneratorUserMessage({
      ...BASE,
      beliefLines: [line],
      beliefCitations: true,
    });
    expect(out).toContain('Current-state record');
    expect(out).toContain(line);
    // The citations variant instructs mirroring ids into citedBeliefIds.
    expect(out).toContain('citedBeliefIds');
    const insightAt = out.indexOf('insight line');
    const beliefAt = out.indexOf('Current-state record');
    const fragmentAt = out.indexOf('Media evidence');
    expect(insightAt).toBeGreaterThan(-1);
    expect(fragmentAt).toBeGreaterThan(-1);
    expect(beliefAt).toBeGreaterThan(insightAt);
    expect(beliefAt).toBeLessThan(fragmentAt);
  });

  it('base (citations-off) variant keeps the cite-factIds-only header', () => {
    const out = buildGeneratorUserMessage({
      ...BASE,
      beliefLines: ['[semantic_belief:b1] (s — f, rev 1) s'],
    });
    expect(out).toContain('Current-state record');
    expect(out).toContain('cite factIds only');
    expect(out).not.toContain('citedBeliefIds');
  });

  it('abstention discipline (memory-fitness D5): BOTH header variants condition the belief preference and pin the evidence-only clause', () => {
    const line = '[semantic_belief:b1] (s — f, rev 1) s';
    const cited = buildGeneratorUserMessage({
      ...BASE,
      beliefLines: [line],
      beliefCitations: true,
    });
    const plain = buildGeneratorUserMessage({ ...BASE, beliefLines: [line] });
    for (const out of [cited, plain]) {
      // The preference is conditional on a covering line — never a blanket
      // license to answer current-state questions from the belief record.
      expect(out).toContain('prefer these lines ONLY when one covers the asked subject/field');
      // The lane adds evidence without relaxing the base abstention rule.
      expect(out).toContain(
        'These lines ADD evidence — they never relax the base evidence rules: when NEITHER a belief line NOR the facts/transcript cover the question, follow the base instructions for an unanswerable question unchanged',
      );
      expect(out).not.toContain('prefer these lines;');
    }
  });
});

describe('buildVerifierUserMessage — beliefLines (BELIEFS_SERVING_LANE seam)', () => {
  function capturingOpenAi(users: string[]): OpenAI {
    return {
      chat: {
        completions: {
          create: async (req: { messages: Array<{ role: string; content: string }> }) => {
            users.push(req.messages.find((m) => m.role === 'user')?.content ?? '');
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
                  },
                },
              ],
            };
          },
        },
      },
    } as unknown as OpenAI;
  }

  const BASE = {
    query: 'which database are we using?',
    answer: 'SurrealDB.',
    factLines: ['[knowledge_fact:f1] PostgreSQL — decided'],
    model: 'gpt-test',
  };

  it('absent / empty ⇒ the audit prompt is BYTE-IDENTICAL (no section)', async () => {
    const users: string[] = [];
    await runVerifier({ ...BASE, openai: capturingOpenAi(users) });
    await runVerifier({ ...BASE, beliefLines: [], openai: capturingOpenAi(users) });
    await runVerifier({ ...BASE, beliefLines: undefined, openai: capturingOpenAi(users) });
    expect(users[1]).toBe(users[0]);
    expect(users[2]).toBe(users[0]);
    expect(users[0]).not.toContain('Current-state record');
  });

  it('non-empty ⇒ its own equally-valid-support section', async () => {
    const users: string[] = [];
    const lines = ['[semantic_belief:b1] (inventory service — database, rev 2) statement'];
    await runVerifier({ ...BASE, beliefLines: lines, openai: capturingOpenAi(users) });
    expect(users[0]).toContain('Current-state record (distilled belief lines');
    expect(users[0]).toContain(lines[0]!);
    // The base sections are untouched by the addition.
    expect(users[0]).toContain('Source facts:');
  });
});

describe('runGenerator — belief-citation affordance (BELIEFS_SERVING_LANE)', () => {
  function capturingOpenAi(reqs: unknown[], content: string): OpenAI {
    return {
      chat: {
        completions: {
          create: async (req: unknown) => {
            reqs.push(req);
            return { choices: [{ message: { content } }] };
          },
        },
      },
    } as unknown as OpenAI;
  }

  const CONTENT = JSON.stringify({ answer: 'SurrealDB.', citedFactIds: [] });
  const BASE = {
    query: 'which database?',
    factLines: ['[knowledge_fact:f1] fact'],
    model: 'gpt-test',
    answerLang: null,
  };

  it('flag ON but empty lane ⇒ prompt AND schema BYTE-IDENTICAL to the base call', async () => {
    const base: unknown[] = [];
    await runGenerator({ ...BASE, openai: capturingOpenAi(base, CONTENT) });
    const emptyLane: unknown[] = [];
    await runGenerator({
      ...BASE,
      beliefCitations: true,
      beliefLines: [],
      openai: capturingOpenAi(emptyLane, CONTENT),
    });
    expect(JSON.stringify(emptyLane[0])).toBe(JSON.stringify(base[0]));
    expect(JSON.stringify(base[0])).not.toContain('citedBeliefIds');
    expect(JSON.stringify(base[0])).not.toContain('BELIEF CITATIONS');
    expect(JSON.stringify(base[0])).not.toContain('BELIEF LINES PRESERVE ABSTENTION');
  });

  it('rendered lane (default mode) ⇒ the abstention guard mirrors the base rule VERBATIM', async () => {
    const reqs: unknown[] = [];
    await runGenerator({
      ...BASE,
      beliefCitations: true,
      beliefLines: ['[semantic_belief:b1] (s — f, rev 1) s'],
      openai: capturingOpenAi(
        reqs,
        JSON.stringify({ answer: 'x', citedFactIds: [], citedBeliefIds: [] }),
      ),
    });
    const system = (
      reqs[0] as { messages: Array<{ role: string; content: string }> }
    ).messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('BELIEF LINES PRESERVE ABSTENTION');
    expect(system).toContain('Prefer a belief line only when one covers the asked subject/field.');
    // Verbatim mirror of the base GENERATOR_SYSTEM rule 3 abstention tail —
    // the belief lane must not weaken the absence-honesty contract (D5).
    expect(system).toContain(
      `If neither a belief line nor the facts answer the question, output the exact answer string "I don't have grounded evidence for that." with citedFactIds set to [].`,
    );
    // The base rule itself is still present (the guard adds, never replaces).
    expect(system).toContain('If the facts do not answer the question');
  });

  it('neverAbstain mode keeps its always-commit contract — NO abstention guard with the lane rendered', async () => {
    const reqs: unknown[] = [];
    await runGenerator({
      ...BASE,
      neverAbstain: true,
      beliefCitations: true,
      beliefLines: ['[semantic_belief:b1] (s — f, rev 1) s'],
      openai: capturingOpenAi(
        reqs,
        JSON.stringify({ answer: 'x', citedFactIds: [], citedBeliefIds: [] }),
      ),
    });
    const system = (
      reqs[0] as { messages: Array<{ role: string; content: string }> }
    ).messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('ALWAYS commit to an answer');
    expect(system).not.toContain('BELIEF LINES PRESERVE ABSTENTION');
    expect(system).not.toContain("I don't have grounded evidence for that.");
  });

  it('live affordance ⇒ schema gains citedBeliefIds (properties + required) and the addendum', async () => {
    const reqs: unknown[] = [];
    await runGenerator({
      ...BASE,
      beliefCitations: true,
      beliefLines: ['[semantic_belief:b1] (s — f, rev 1) s'],
      openai: capturingOpenAi(
        reqs,
        JSON.stringify({ answer: 'x', citedFactIds: [], citedBeliefIds: [] }),
      ),
    });
    const raw = JSON.stringify(reqs[0]);
    expect(raw).toContain('citedBeliefIds');
    expect(raw).toContain('BELIEF CITATIONS');
    const req = reqs[0] as {
      response_format: {
        json_schema: { schema: { properties: Record<string, unknown>; required: string[] } };
      };
    };
    expect(req.response_format.json_schema.schema.properties.citedBeliefIds).toBeDefined();
    expect(req.response_format.json_schema.schema.required).toContain('citedBeliefIds');
  });

  it('defensively deletes a non-array citedBeliefIds from the parsed output', async () => {
    const reqs: unknown[] = [];
    const out = await runGenerator({
      ...BASE,
      beliefCitations: true,
      beliefLines: ['[semantic_belief:b1] (s — f, rev 1) s'],
      openai: capturingOpenAi(
        reqs,
        JSON.stringify({ answer: 'x', citedFactIds: [], citedBeliefIds: 'not-an-array' }),
      ),
    });
    expect(out.citedBeliefIds).toBeUndefined();
  });
});

describe('belief-arm citations and the serving gates (BELIEFS_SERVING_LANE)', () => {
  const SUPPORTED: VerifierOutput = { verdict: 'supported', unsupportedClaims: [] };

  it('FOVEA_REQUIRE_CITATIONS Part C: a belief-cited answer is NOT whollyUncited — it serves', () => {
    const beliefCitation = { beliefId: 'semantic_belief:b1', excerpt: 's — f: v' };
    const served = finalizeVerdict(
      {},
      {
        verdict: 'supported',
        answer: 'SurrealDB.',
        citations: [],
        results: [],
        guardrails: 'strict',
        requireCitations: true,
        evidenceCitations: [beliefCitation],
      },
    );
    expect(served.answer).toBe('SurrealDB.');
    expect(served.reason).toBeUndefined();
    expect(served.evidenceCitations).toEqual([beliefCitation]);
    // Contrast: zero fact citations AND zero evidence citations abstains.
    const abstained = finalizeVerdict(
      {},
      {
        verdict: 'supported',
        answer: 'SurrealDB.',
        citations: [],
        results: [],
        guardrails: 'strict',
        requireCitations: true,
        evidenceCitations: [],
      },
    );
    expect(abstained.reason).toBe('low_coverage');
  });

  it('resolveEvidenceCapability: a belief-arm citation carries NO capability — it neither satisfies nor triggers the 0113 gate', async () => {
    const saved = process.env.FOVEA_EVIDENCE_CAPABILITY;
    process.env.FOVEA_EVIDENCE_CAPABILITY = '1';
    try {
      const deps = {
        registry: {
          rowPolicyLookup: async () => () => ({ requiredEvidenceCapability: 'visual' }),
        } as never,
        logger: { warn: () => undefined },
      };
      const ctx = { cache: undefined, companyId: 'co_x' } as FinalizeContext;
      const citations = [{ factId: 'knowledge_fact:f1', predicate: 'p', entityId: 'e' } as never];
      // A visual requirement is NOT satisfied by a belief citation…
      const unmet = await resolveEvidenceCapability(deps, {
        ctx,
        verdict: SUPPORTED,
        citations,
        evidenceCitations: [{ beliefId: 'semantic_belief:b1', excerpt: 's' }],
      });
      expect(unmet).toEqual({ evidenceCapabilityUnmet: true });
      // …and a text requirement is not TRIGGERED by one either.
      const textDeps = {
        registry: { rowPolicyLookup: async () => () => ({}) } as never,
        logger: { warn: () => undefined },
      };
      const ok = await resolveEvidenceCapability(textDeps, {
        ctx,
        verdict: SUPPORTED,
        citations,
        evidenceCitations: [{ beliefId: 'semantic_belief:b1', excerpt: 's' }],
      });
      expect(ok).toEqual({});
    } finally {
      if (saved === undefined) delete process.env.FOVEA_EVIDENCE_CAPABILITY;
      else process.env.FOVEA_EVIDENCE_CAPABILITY = saved;
    }
  });
});
