import { ConfigService } from '@nestjs/config';
import { LlmSummaryGenerator } from '../src/dreams/llm-summary.generator';
import type { FactToSummarize } from '../src/compaction/summary-generator';

/**
 * Unit coverage for LlmSummaryGenerator. Real OpenAI is not in the
 * loop — we replace the openai field after construction. Tests
 * focus on: config gating, concat fallback shape, LLM happy path,
 * LLM failure → concat path, length cap.
 */
describe('LlmSummaryGenerator', () => {
  function svc(env: Record<string, string | undefined>): LlmSummaryGenerator {
    const cfg = {
      get: <T>(key: string, dflt?: T) => (env[key] ?? dflt) as T,
      getOrThrow: <T>(key: string) => {
        const v = env[key];
        if (v === undefined) throw new Error(`missing ${key}`);
        return v as unknown as T;
      },
    } as unknown as ConfigService;
    return new LlmSummaryGenerator(cfg);
  }

  function fact(
    day: string,
    predicate: string,
    object: string,
  ): FactToSummarize {
    return {
      factId: `f_${day}`,
      predicate,
      object,
      validFrom: `${day}T00:00:00Z`,
      confidence: 0.9,
    };
  }

  it('returns empty string on empty input regardless of mode', async () => {
    const g = svc({});
    expect(await g.generate([])).toBe('');
    const enabled = svc({ DREAMS_LLM_SUMMARY_ENABLED: '1', OPENAI_API_KEY: 'sk' });
    expect(await g.generate([])).toBe('');
    expect(await enabled.generate([])).toBe('');
  });

  it('falls back to concat when DREAMS_LLM_SUMMARY_ENABLED!=1', async () => {
    const g = svc({});
    const out = await g.generate([
      fact('2026-01-15', 'tier', 'gold'),
      fact('2026-04-01', 'tier', 'platinum'),
    ]);
    expect(out).toBe('[2026-01-15] tier: gold | [2026-04-01] tier: platinum');
  });

  it('falls back to concat when OPENAI_API_KEY is missing even with flag on', async () => {
    const g = svc({ DREAMS_LLM_SUMMARY_ENABLED: '1' });
    const out = await g.generate([fact('2026-01-15', 'tier', 'gold')]);
    expect(out).toBe('[2026-01-15] tier: gold');
  });

  it('uses LLM output when call succeeds', async () => {
    const g = svc({
      DREAMS_LLM_SUMMARY_ENABLED: '1',
      OPENAI_API_KEY: 'sk',
    });
    (g as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: 'Tier upgraded gold → platinum on 2026-04-01.',
                },
              },
            ],
          }),
        },
      },
    };
    const out = await g.generate([
      fact('2026-01-15', 'tier', 'gold'),
      fact('2026-04-01', 'tier', 'platinum'),
    ]);
    expect(out).toBe('Tier upgraded gold → platinum on 2026-04-01.');
  });

  it('falls back to concat on LLM exception', async () => {
    const g = svc({
      DREAMS_LLM_SUMMARY_ENABLED: '1',
      OPENAI_API_KEY: 'sk',
    });
    (g as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('rate limited');
          },
        },
      },
    };
    const out = await g.generate([fact('2026-01-15', 'tier', 'gold')]);
    expect(out).toBe('[2026-01-15] tier: gold');
  });

  it('falls back to concat on empty LLM response', async () => {
    const g = svc({
      DREAMS_LLM_SUMMARY_ENABLED: '1',
      OPENAI_API_KEY: 'sk',
    });
    (g as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: '' } }] }),
        },
      },
    };
    const out = await g.generate([fact('2026-01-15', 'tier', 'gold')]);
    expect(out).toBe('[2026-01-15] tier: gold');
  });

  it('caps overlong LLM output at 400 chars', async () => {
    const long = 'x'.repeat(800);
    const g = svc({
      DREAMS_LLM_SUMMARY_ENABLED: '1',
      OPENAI_API_KEY: 'sk',
    });
    (g as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: long } }],
          }),
        },
      },
    };
    const out = await g.generate([fact('2026-01-15', 'tier', 'gold')]);
    expect(out.length).toBe(400);
    expect(out.endsWith('...')).toBe(true);
  });

  it('concat fallback caps at 8000 chars', async () => {
    const g = svc({});
    // 1000 facts × 35 chars each ≈ 35k.
    const many: FactToSummarize[] = [];
    for (let i = 0; i < 1000; i++) {
      many.push(
        fact(
          `2026-${String((i % 12) + 1).padStart(2, '0')}-01`,
          'tier',
          'gold',
        ),
      );
    }
    const out = await g.generate(many);
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out.endsWith('...')).toBe(true);
  });
});
