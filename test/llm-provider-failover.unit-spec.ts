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
import { resetBreakers } from '../src/ai/circuit-breaker';
import { ProviderCircuitOpen } from '../src/ai/provider-circuit-open';

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

// The body OpenAI returned on 2026-09-25: the type says quota, the code is new.
const quota = Object.assign(new Error('429 You have no credits remaining'), {
  status: 429,
  type: 'insufficient_quota',
  code: 'credit_balance_exhausted',
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
    resetBreakers();
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

  it('a flex capacity 429 is not failed over to full price: the job reschedules', async () => {
    const busy = Object.assign(new Error('429 Resource unavailable'), { status: 429 });
    const { calls } = stubCreate(() => {
      throw busy;
    });
    const client = createOpenAiClient(config(env))!;
    const create = client.chat.completions.create as unknown as Create;
    await expect(create({ model: 'gpt-6-luna', service_tier: 'flex', messages: [] })).rejects.toBe(
      busy,
    );
    expect(calls.map((c) => c.baseURL.includes('openrouter'))).toEqual([false]);
    // A standard-tier 429 that outlived the SDK's retries still fails over.
    await create({ model: 'gpt-6-luna', messages: [] }).catch(() => undefined);
    expect(calls.map((c) => c.baseURL.includes('openrouter')).slice(1)).toEqual([false, true]);
  });

  it('without a fallback configured a call reaches the SDK once, body untouched', async () => {
    const { calls } = stubCreate(() => ({ ok: true }));
    const client = createOpenAiClient(config({ OPENAI_API_KEY: 'sk' }))!;
    await (client.chat.completions.create as unknown as Create)({
      model: 'gpt-6-luna',
      messages: [],
    });
    expect(calls).toEqual([
      { baseURL: 'https://api.openai.com/v1', model: 'gpt-6-luna', tier: undefined },
    ]);
  });

  it('a namespaced id is the same reasoning model', () => {
    expect(isReasoningModel('openai/gpt-6-luna')).toBe(true);
    expect(isReasoningModel('openai/gpt-5-chat-latest')).toBe(false);
  });

  describe('circuit breaker per (provider, model)', () => {
    const outage = Object.assign(new Error('503 upstream unavailable'), { status: 503 });
    const ask = (client: OpenAI) =>
      client.chat.completions.create({ model: 'gpt-6-luna', messages: [] } as never);

    it('after N provider failures the primary is skipped and the fallback serves at once', async () => {
      const { calls } = stubCreate((base) => {
        if (base.includes('openrouter')) return { ok: true };
        throw outage;
      });
      const client = createOpenAiClient(config({ ...env, LLM_BREAKER_FAILURES: '3' }))!;
      for (let i = 0; i < 3; i++) await ask(client);
      const primaryCalls = () => calls.filter((c) => !c.baseURL.includes('openrouter')).length;
      expect(primaryCalls()).toBe(3);
      await ask(client);
      await ask(client);
      // Open: the primary is not called; every call went to the fallback.
      expect(primaryCalls()).toBe(3);
      expect(calls.filter((c) => c.baseURL.includes('openrouter'))).toHaveLength(5);
    });

    it('without a fallback an open circuit fails fast, then a probe after the cool-down closes it', async () => {
      let healthy = false;
      const { calls } = stubCreate(() => {
        if (healthy) return { ok: true };
        throw outage;
      });
      const now = jest.spyOn(Date, 'now');
      let t = 1_000_000;
      now.mockImplementation(() => t);
      const client = createOpenAiClient(
        config({
          OPENAI_API_KEY: 'sk-primary',
          LLM_BREAKER_FAILURES: '2',
          LLM_BREAKER_COOLDOWN_MS: '1000',
        }),
      )!;
      await expect(ask(client)).rejects.toMatchObject({ status: 503 });
      await expect(ask(client)).rejects.toMatchObject({ status: 503 });
      await expect(ask(client)).rejects.toBeInstanceOf(ProviderCircuitOpen);
      expect(calls).toHaveLength(2);
      healthy = true;
      t += 1_001;
      await expect(ask(client)).resolves.toEqual({ ok: true });
      await expect(ask(client)).resolves.toEqual({ ok: true });
      expect(calls).toHaveLength(4);
    });

    it('a request-side 400 never opens the circuit', async () => {
      const bad = Object.assign(new Error('400 bad request'), { status: 400 });
      const { calls } = stubCreate(() => {
        throw bad;
      });
      const client = createOpenAiClient(
        config({ OPENAI_API_KEY: 'sk-primary', LLM_BREAKER_FAILURES: '2' }),
      )!;
      for (let i = 0; i < 4; i++) await expect(ask(client)).rejects.toMatchObject({ status: 400 });
      expect(calls).toHaveLength(4);
    });

    it('a flex capacity 429 never opens the circuit for standard calls', async () => {
      const flex = Object.assign(new Error('429 flex capacity'), { status: 429 });
      const { calls } = stubCreate((_b, body) => {
        if (body.service_tier === 'flex') throw flex;
        return { ok: true };
      });
      const client = createOpenAiClient(
        config({ OPENAI_API_KEY: 'sk-primary', LLM_BREAKER_FAILURES: '2' }),
      )!;
      for (let i = 0; i < 3; i++)
        await expect(
          client.chat.completions.create({
            model: 'gpt-6-luna',
            messages: [],
            service_tier: 'flex',
          } as never),
        ).rejects.toMatchObject({ status: 429 });
      await expect(ask(client)).resolves.toEqual({ ok: true });
      expect(calls).toHaveLength(4);
    });
  });
});
