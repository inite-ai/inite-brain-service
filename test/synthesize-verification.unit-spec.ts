import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SynthesizeService } from '../src/synthesize/synthesize.service';
import { runVerifier } from '../src/synthesize/verifier';
import type { SearchService } from '../src/search/search.service';
import type { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';

/**
 * Audit W5 (engine-architecture-audit-2026-08.md #22/#24/#26):
 *  - the verifier saw ONLY factLines, so quote-built answers were judged
 *    unsupported (strict dropped them) and quoted L0 content shipped with
 *    zero faithfulness scoring in every other mode;
 *  - a generator answer truncated at the token cap became
 *    `generator_error`, i.e. the exhaustive-list lanes silently abstained;
 *  - guardrails='answer' disabled the source-trust floor as collateral of
 *    disabling abstention.
 */
interface Captured {
  system: string;
  user: string;
}

function makeService(opts: {
  generatorContent: string;
  generatorFinish?: string;
  captured: Captured[];
}): SynthesizeService {
  const config = {
    get: (k: string, d?: string) => d,
    getOrThrow: () => 'sk',
  } as unknown as ConfigService;
  const search = {
    search: async () => ({ results: [] }),
  } as unknown as SearchService;
  const svc = new SynthesizeService(search, config);
  (svc as unknown as { openai: unknown }).openai = {
    chat: {
      completions: {
        create: async (req: { messages: Array<{ role: string; content: string }> }) => {
          opts.captured.push({
            system: req.messages[0]!.content,
            user: req.messages[1]!.content,
          });
          const isVerifier = req.messages[0]!.content.includes('auditor');
          return {
            choices: [
              {
                message: {
                  content: isVerifier
                    ? JSON.stringify({ verdict: 'supported' })
                    : opts.generatorContent,
                },
                finish_reason: isVerifier ? 'stop' : (opts.generatorFinish ?? 'stop'),
              },
            ],
          };
        },
      },
    },
  };
  return svc;
}

const HITS = [
  {
    entityId: 'knowledge_entity:e1',
    entityName: 'Alex',
    score: 0.9,
    facts: [
      {
        factId: 'knowledge_fact:f1',
        predicate: 'activities',
        object: 'Alex uses a token bucket for rate limiting',
        confidence: 0.9,
        score: 0.9,
        validFrom: '2026-01-01T00:00:00.000Z',
        status: 'active',
      },
    ],
  },
] as never;

/** Scripted auditor client for the runVerifier prompt-composition pins
 *  (the callVerifier adapter moved into fragment-zoom-seam.ts with the
 *  verify stage — verifyAndZoom now calls runVerifier directly, so the
 *  W5 #22 bundle shape is pinned at the module seam). */
function stubAuditor(captured: Captured[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async (req: { messages: Array<{ role: string; content: string }> }) => {
          captured.push({
            system: req.messages[0]!.content,
            user: req.messages[1]!.content,
          });
          return {
            choices: [
              {
                message: { content: JSON.stringify({ verdict: 'supported' }) },
                finish_reason: 'stop',
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;
}

describe('verifier sees the whole evidence bundle (W5 #22)', () => {
  it('transcript quotes reach the auditor prompt', async () => {
    const captured: Captured[] = [];
    await runVerifier({
      openai: stubAuditor(captured),
      query: 'What did you suggest?',
      answer: 'You suggested a token bucket',
      factLines: ['[knowledge_fact:f1] activities: …'],
      transcriptLines: ['[2026-01-01] Assistant: use a token bucket'],
      model: 'gpt-4o-mini',
    });
    const verifier = captured.find((c) => c.system.includes('auditor'));
    expect(verifier).toBeDefined();
    expect(verifier?.user).toContain('Source conversation turns');
    expect(verifier?.user).toContain('use a token bucket');
    expect(verifier?.system).toContain('ALL sections count as support');
  });

  it('without quotes the prompt is the facts-only shape (no empty sections)', async () => {
    const captured: Captured[] = [];
    await runVerifier({
      openai: stubAuditor(captured),
      query: 'q',
      answer: 'a',
      factLines: ['[knowledge_fact:f1] x'],
      transcriptLines: [],
      model: 'gpt-4o-mini',
    });
    const verifier = captured.find((c) => c.system.includes('auditor'));
    expect(verifier?.user).not.toContain('Source conversation turns');
    expect(verifier?.user).not.toContain('Computed date intervals');
  });
});

describe('truncated generator output is salvaged, not an error (W5 #24)', () => {
  it('finish_reason=length + broken JSON → the partial answer survives', async () => {
    const captured: Captured[] = [];
    const svc = makeService({
      // Strict-JSON body cut mid-string by the token cap.
      generatorContent: '{"answer": "1. debounce delay\\n2. API errors',
      generatorFinish: 'length',
      captured,
    });
    const out = await (
      svc as unknown as {
        callGenerator(a: Record<string, unknown>): Promise<{ answer: string }>;
      }
    ).callGenerator({
      query: 'list the order',
      factLines: ['[knowledge_fact:f1] x'],
      model: 'gpt-4o-mini',
      neverAbstain: false,
    });
    expect(out.answer).toContain('debounce delay');
    expect(out.answer).toContain('API errors');
  });

  it('broken JSON WITHOUT a length finish still throws (real corruption)', async () => {
    const captured: Captured[] = [];
    const svc = makeService({
      generatorContent: '{"answer": "half',
      generatorFinish: 'stop',
      captured,
    });
    await expect(
      (
        svc as unknown as {
          callGenerator(a: Record<string, unknown>): Promise<unknown>;
        }
      ).callGenerator({
        query: 'q',
        factLines: ['[knowledge_fact:f1] x'],
        model: 'gpt-4o-mini',
        neverAbstain: false,
      }),
    ).rejects.toThrow();
  });
});

describe('answer mode keeps the source-trust floor (W5 #26)', () => {
  it('the guardrail call drops the confidence floor, never the trust floor', () => {
    // Behavioural assertion is impossible without a scored corpus, so pin
    // the call shape at the source: 'answer' mode is about not abstaining,
    // and must not disable the orthogonal source-reputation filter.
    const src = readFileSync(
      join(__dirname, '..', 'src', 'synthesize', 'synthesize.service.ts'),
      'utf8',
    );
    const call = src.slice(
      src.indexOf('applyConformalGuardrail(evidence, {'),
      src.indexOf('});', src.indexOf('applyConformalGuardrail(evidence, {')),
    );
    expect(call).toContain('minCalibratedConfidence: answerMode ? 0');
    expect(call).toContain('minFactTrust: this.minFactTrust');
    expect(call).not.toContain('minFactTrust: answerMode ? 0');
  });

  it('prepareEvidence runs in both modes', () => {
    const captured: Captured[] = [];
    const svc = makeService({ generatorContent: '{}', captured });
    const prepare = (answerMode: boolean): unknown =>
      (
        svc as unknown as {
          prepareEvidence(hits: unknown, opts: Record<string, unknown>): unknown;
        }
      ).prepareEvidence(HITS, { answerMode, explain: false });
    expect(prepare(true)).toBeDefined();
    expect(prepare(false)).toBeDefined();
  });
});
