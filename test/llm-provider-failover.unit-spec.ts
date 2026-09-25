/**
 * Chat completions fail over to a second provider when the primary refuses
 * for a reason about the account or the provider — measured on production
 * 2026-09-25: the OpenAI credit ran out three times and every answer,
 * extraction and audit returned generator_error until it was topped up.
 */
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  createOpenAiClient,
  isReasoningModel,
  resetProviderFailover,
} from '../src/ai/openai-client';

type Create = (body: Record<string, unknown>, opts?: unknown) => Promise<unknown>;

function config(env: Record<string, string>): ConfigService {
  return { get: (k: string, d?: string) => env[k] ?? d } as unknown as ConfigService;
}

/** Stub the two SDK clients' create by base URL (fallback host vs primary). */
function stubCreate(impl: (baseURL: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ baseURL: string; model: unknown; tier: unknown }> = [];
  const fake = function (this: unknown, body: unknown) {
    const b = body as Record<string, unknown>;
    const baseURL = (this as { _client: OpenAI })._client.baseURL;
    calls.push({ baseURL, model: b.model, tier: b.service_tier });
    return Promise.resolve(impl(baseURL, b));
  };
  const spy = jest
    .spyOn(OpenAI.Chat.Completions.prototype, 'create')
    .mockImplementation(fake as unknown as OpenAI.Chat.Completions['create']);
  return { calls, spy };
}

const quota = Object.assign(new Error('429 You have no credits remaining'), {
  status: 429,
  code: 'insufficient_quota',
});

const env = {
  OPENAI_API_KEY: 'sk-primary',
  OPENAI_FALLBACK_API_KEY: 'or-fallback',
  OPENAI_FALLBACK_BASE_URL: 'https://openrouter.example/api/v1',
};

describe('LLM provider failover', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetProviderFailover();
  });

  it('re-sends a quota-refused call to the fallback under the vendor namespace, then skips the primary', async () => {
    const { calls } = stubCreate((base) => {
      if (base.includes('openrouter')) return { ok: true };
      throw quota;
    });
    const client = createOpenAiClient(config(env))!;
    const create = client.chat.completions.create as unknown as Create;
    await expect(
      create({ model: 'gpt-6-luna', service_tier: 'flex', messages: [] }),
    ).resolves.toEqual({ ok: true });
    await create({ model: 'gpt-6-luna', messages: [] });
    expect(calls.map((c) => [c.baseURL.includes('openrouter'), c.model, c.tier])).toEqual([
      [false, 'gpt-6-luna', 'flex'],
      [true, 'openai/gpt-6-luna', undefined],
      // Inside the window the primary is not asked again.
      [true, 'openai/gpt-6-luna', undefined],
    ]);
  });

  it('a refusal about the request is the caller’s, not the fallback’s', async () => {
    const bad = Object.assign(new Error('400 bad request'), { status: 400 });
    const { calls } = stubCreate(() => {
      throw bad;
    });
    const client = createOpenAiClient(config(env))!;
    await expect(
      (client.chat.completions.create as unknown as Create)({ model: 'gpt-6-luna', messages: [] }),
    ).rejects.toBe(bad);
    expect(calls).toHaveLength(1);
  });

  it('without a fallback configured the client is the plain SDK client', () => {
    const client = createOpenAiClient(config({ OPENAI_API_KEY: 'sk' }))!;
    expect(Object.prototype.hasOwnProperty.call(client.chat.completions, 'create')).toBe(false);
  });

  it('a namespaced id is the same reasoning model', () => {
    expect(isReasoningModel('openai/gpt-6-luna')).toBe(true);
    expect(isReasoningModel('openai/gpt-5-chat-latest')).toBe(false);
  });
});
