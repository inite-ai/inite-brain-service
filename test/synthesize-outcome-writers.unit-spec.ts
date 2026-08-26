/**
 * 0107 outcome-telemetry writer seams inside SynthesizeService, driven
 * with a mocked MemoryOutcomeService (no DB, no OpenAI):
 *   * selected_for_context fires once, after produceAnswer returns, for
 *     the FINAL factIndex keys;
 *   * used_in_answer + verifier_supported (meta { verdict }) fire in
 *     finalizeAndAdmit on a supported strict verdict;
 *   * the unverifiedReturn exit ('answer'/'off' guardrails) emits
 *     used_in_answer for the served citations — and NEVER
 *     verifier_supported (no verifier ran);
 *   * with the master flag off, nothing is emitted at any seam.
 */
import { ConfigService } from '@nestjs/config';
import { SynthesizeService } from '../src/synthesize/synthesize.service';
import type { SearchService, SearchHit } from '../src/search/search.service';
import type { SynthesizeDto } from '../src/synthesize/dto/synthesize.dto';
import type {
  MemoryOutcomeService,
  OutcomeEventInput,
} from '../src/outcomes/memory-outcome.service';

interface RecordedCall {
  companyId: string;
  events: OutcomeEventInput[];
}

function makeHit(entityId: string, factId: string): SearchHit {
  return {
    entityId,
    entityType: 'customer',
    canonicalName: entityId,
    externalRefs: {},
    facts: [
      {
        factId,
        predicate: 'name',
        object: 'Maya',
        confidence: 0.9,
        validFrom: '2026-01-01T00:00:00Z',
        status: 'active',
        score: 0.5,
      },
    ],
    score: 0.5,
  } as SearchHit;
}

function makeConfig(): ConfigService {
  return {
    get: <T>(_k: string, dflt?: T) => dflt as T,
    getOrThrow: <T>() => 'sk-stub' as unknown as T,
  } as unknown as ConfigService;
}

/** Generator answers with a citation; the verifier (system prompt names
 *  the auditor role) returns the requested verdict. */
function stubOpenAI(verdict: string) {
  return {
    chat: {
      completions: {
        create: async (req: { messages: Array<{ role: string; content: string }> }) => {
          const isVerifier = req.messages[0]!.content.includes('auditor');
          return {
            choices: [
              {
                message: {
                  content: isVerifier
                    ? JSON.stringify({ verdict })
                    : JSON.stringify({ answer: 'Maya [f1].', citedFactIds: ['f1'] }),
                },
                finish_reason: 'stop',
              },
            ],
          };
        },
      },
    },
  };
}

function makeSvc(verdict: string): { svc: SynthesizeService; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const outcomes = {
    recordOutcomes: (opts: RecordedCall) => {
      calls.push({ companyId: opts.companyId, events: opts.events });
    },
  } as unknown as MemoryOutcomeService;
  const search = {
    search: async () => ({ results: [makeHit('cust_a', 'f1')] }),
  } as unknown as SearchService;
  const svc = new SynthesizeService(
    search,
    makeConfig(),
    undefined, // metrics
    undefined, // evidenceCollector
    undefined, // answerCache
    undefined, // l3
    undefined, // focusSignal
    undefined, // lensSuppression
    undefined, // laneClassifier
    outcomes,
  );
  (svc as unknown as { openai: unknown }).openai = stubOpenAI(verdict);
  return { svc, calls };
}

const eventsOf = (calls: RecordedCall[]) => calls.flatMap((c) => c.events);
const named = (calls: RecordedCall[], event: string) =>
  eventsOf(calls).filter((e) => e.event === event);

const baseDto: SynthesizeDto = { query: 'what is her name?' };

describe('SynthesizeService — 0107 outcome writer seams', () => {
  beforeEach(() => {
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
  });
  afterAll(() => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
  });

  it('strict + supported: selected_for_context, then used_in_answer + verifier_supported', async () => {
    const { svc, calls } = makeSvc('supported');
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBe('Maya [f1].');

    const selected = named(calls, 'selected_for_context');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ subjectKind: 'fact', subjectId: 'f1' });

    const used = named(calls, 'used_in_answer');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ subjectId: 'f1' });

    const verified = named(calls, 'verifier_supported');
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({ subjectId: 'f1', meta: { verdict: 'supported' } });

    expect(calls.every((c) => c.companyId === 'co_x')).toBe(true);
  });

  it('strict + unsupported: used_in_answer still recorded at the finalize seam, NO verifier_supported', async () => {
    const { svc, calls } = makeSvc('unsupported');
    await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(named(calls, 'selected_for_context')).toHaveLength(1);
    expect(named(calls, 'used_in_answer')).toHaveLength(1);
    expect(named(calls, 'verifier_supported')).toHaveLength(0);
  });

  it("'answer' guardrails (unverifiedReturn exit): used_in_answer, never verifier_supported", async () => {
    const { svc, calls } = makeSvc('supported');
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'answer' },
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBe('Maya [f1].');
    expect(named(calls, 'selected_for_context')).toHaveLength(1);
    const used = named(calls, 'used_in_answer');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ subjectId: 'f1' });
    // No verifier ran — a use is never a VERIFIED use on this exit.
    expect(named(calls, 'verifier_supported')).toHaveLength(0);
  });

  it('master flag off: no seam emits anything (byte-identical)', async () => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    const { svc, calls } = makeSvc('supported');
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBe('Maya [f1].');
    expect(calls).toEqual([]);
  });
});
