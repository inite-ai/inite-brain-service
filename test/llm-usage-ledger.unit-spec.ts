/**
 * The SDK-level token ledger: every chat and embedding call through a
 * patched client is counted under the model asked, and `/metrics` shows it.
 * Before it, 9 call sites spent tokens no counter saw (2026-10-28).
 */
import {
  callSite,
  llmUsageSnapshot,
  recordLlmUsage,
  resetLlmUsage,
  withUsageLedger,
} from '../src/ai/llm-usage-ledger';
import { MetricsService } from '../src/metrics/metrics.service';

function fakeClient() {
  return {
    chat: {
      completions: {
        create: jest.fn(async (_body: { model: string }) => ({
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 80,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        })),
      },
    },
    embeddings: {
      create: jest.fn(async (_body: { model: string }) => ({
        usage: { prompt_tokens: 0, total_tokens: 9 },
      })),
    },
  };
}

describe('llm usage ledger', () => {
  beforeEach(() => resetLlmUsage());

  it('counts chat and embedding calls made through a patched client', async () => {
    const c = fakeClient();
    withUsageLedger(c);
    await c.chat.completions.create({ model: 'gpt-6-luna' });
    await c.chat.completions.create({ model: 'gpt-6-luna' });
    await c.embeddings.create({ model: 'text-embedding-3-small' });
    const rows = llmUsageSnapshot();
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          kind: 'chat',
          model: 'gpt-6-luna',
          site: expect.any(String),
          calls: 2,
          errors: 0,
          inputTokens: 2400,
          cachedInputTokens: 2000,
          outputTokens: 160,
        },
        {
          kind: 'embed',
          model: 'text-embedding-3-small',
          site: expect.any(String),
          calls: 1,
          errors: 0,
          inputTokens: 9,
          cachedInputTokens: 0,
          outputTokens: 0,
        },
      ]),
    );
  });

  it('a response without usage still counts the call', () => {
    recordLlmUsage({ kind: 'chat', model: 'm' }, undefined);
    expect(llmUsageSnapshot()[0]).toMatchObject({ calls: 1, inputTokens: 0, outputTokens: 0 });
  });

  it('a failed call is counted as an error, not as usage, and still reaches the caller', async () => {
    const c = fakeClient();
    c.chat.completions.create.mockImplementationOnce(async () => {
      throw new Error('429');
    });
    withUsageLedger(c);
    await expect(c.chat.completions.create({ model: 'm' })).rejects.toThrow('429');
    expect(llmUsageSnapshot()).toEqual([
      expect.objectContaining({ model: 'm', calls: 0, errors: 1, inputTokens: 0 }),
    ]);
  });

  it('harness mode refuses every chat call before the network; embeddings pass', async () => {
    const prev = process.env.EXTRACTION_SOURCE;
    process.env.EXTRACTION_SOURCE = 'harness';
    try {
      const c = fakeClient();
      const chat = c.chat.completions.create;
      const embed = c.embeddings.create;
      withUsageLedger(c);
      await expect(c.chat.completions.create({ model: 'gpt-6-luna' })).rejects.toMatchObject({
        status: 403,
        code: 'harness_mode',
      });
      expect(chat).not.toHaveBeenCalled();
      await c.embeddings.create({ model: 'local' });
      expect(embed).toHaveBeenCalledTimes(1);
      expect(llmUsageSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'chat', model: 'gpt-6-luna', calls: 0, errors: 1 }),
        ]),
      );
    } finally {
      if (prev === undefined) delete process.env.EXTRACTION_SOURCE;
      else process.env.EXTRACTION_SOURCE = prev;
    }
  });

  it('/metrics exposes the ledger as brain_llm_tokens', async () => {
    recordLlmUsage(
      { kind: 'chat', model: 'gpt-6-luna', site: 'synthesize/verifier' },
      { prompt_tokens: 50, completion_tokens: 5 },
    );
    const { body } = await new MetricsService().serialize();
    const l = 'kind="chat",model="gpt-6-luna",site="synthesize/verifier"';
    expect(body).toContain(`brain_llm_tokens{${l},type="input"} 50`);
    expect(body).toContain(`brain_llm_tokens{${l},type="output"} 5`);
    expect(body).toContain(`brain_llm_tokens{${l},type="calls"} 1`);
    expect(body).toContain(`brain_llm_tokens{${l},type="errors"} 0`);
  });

  it('callSite names the first non-plumbing source file, src or dist', () => {
    const stack = [
      'Error',
      '    at h.create (/app/dist/ai/llm-usage-ledger.js:80:20)',
      '    at create (/app/dist/ai/openai-client.js:140:12)',
      '    at fn (/app/dist/synthesize/verifier.js:212:44)',
      '    at withGenAiCall (/app/dist/common/gen-ai-observability.js:130:9)',
    ].join('\n');
    expect(callSite(stack)).toBe('synthesize/verifier');
    expect(callSite('Error\n    at x (/repo/src/admin/scene-enricher.service.ts:90:7)')).toBe(
      'admin/scene-enricher.service',
    );
    expect(callSite('Error\n    at x (node:internal/process:1:1)')).toBe('unknown');
    expect(callSite(undefined)).toBe('unknown');
  });
});
