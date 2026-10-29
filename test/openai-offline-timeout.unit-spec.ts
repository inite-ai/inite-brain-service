import type OpenAI from 'openai';
import { withOfflineTimeout } from '../src/ai/openai-client';

/** A flex-tier call carries its own timeout; a request-path call is untouched. */
describe('withOfflineTimeout', () => {
  function client() {
    const seen: unknown[] = [];
    const c = {
      chat: {
        completions: {
          create: (_body: unknown, opts?: unknown) => {
            seen.push(opts);
            return Promise.resolve({});
          },
        },
      },
    } as unknown as OpenAI;
    return { c, seen };
  }

  it('gives a flex call the offline timeout', async () => {
    const { c, seen } = client();
    withOfflineTimeout(c, 180_000);
    await c.chat.completions.create(
      { model: 'm', messages: [], service_tier: 'flex' } as never,
      {
        signal: undefined,
      } as never,
    );
    expect(seen[0]).toEqual({ timeout: 180_000, maxRetries: 1, signal: undefined });
  });

  it("keeps a caller's own timeout and retries, and leaves standard calls alone", async () => {
    const { c, seen } = client();
    withOfflineTimeout(c, 180_000);
    await c.chat.completions.create(
      { model: 'm', messages: [], service_tier: 'flex' } as never,
      { timeout: 5, maxRetries: 0 } as never,
    );
    await c.chat.completions.create({ model: 'm', messages: [] } as never);
    expect(seen).toEqual([{ timeout: 5, maxRetries: 0 }, undefined]);
  });
});
