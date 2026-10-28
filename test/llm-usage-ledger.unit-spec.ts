/**
 * The SDK-level token ledger: every chat and embedding call through a
 * patched client is counted under the model asked, and `/metrics` shows it.
 * Before it, 9 call sites spent tokens no counter saw (2026-10-28).
 */
import {
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
          calls: 2,
          inputTokens: 2400,
          cachedInputTokens: 2000,
          outputTokens: 160,
        },
        {
          kind: 'embed',
          model: 'text-embedding-3-small',
          calls: 1,
          inputTokens: 9,
          cachedInputTokens: 0,
          outputTokens: 0,
        },
      ]),
    );
  });

  it('a response without usage still counts the call', () => {
    recordLlmUsage('chat', 'm', undefined);
    expect(llmUsageSnapshot()[0]).toMatchObject({ calls: 1, inputTokens: 0, outputTokens: 0 });
  });

  it('a failed call is not counted and the error reaches the caller', async () => {
    const c = fakeClient();
    c.chat.completions.create.mockImplementationOnce(async () => {
      throw new Error('429');
    });
    withUsageLedger(c);
    await expect(c.chat.completions.create({ model: 'm' })).rejects.toThrow('429');
    expect(llmUsageSnapshot()).toHaveLength(0);
  });

  it('/metrics exposes the ledger as brain_llm_tokens', async () => {
    recordLlmUsage('chat', 'gpt-6-luna', { prompt_tokens: 50, completion_tokens: 5 });
    const { body } = await new MetricsService().serialize();
    expect(body).toContain('brain_llm_tokens{kind="chat",model="gpt-6-luna",type="input"} 50');
    expect(body).toContain('brain_llm_tokens{kind="chat",model="gpt-6-luna",type="output"} 5');
    expect(body).toContain('brain_llm_tokens{kind="chat",model="gpt-6-luna",type="calls"} 1');
  });
});
