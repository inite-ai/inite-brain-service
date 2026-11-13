/**
 * #945 phase 1: provider failures are classified, counted and reported,
 * so a provider refusal can be told apart from a judgment on the memory.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Registry } from 'prom-client';
import {
  classifyProviderFailure,
  providerStatusOf,
  serverModelsUnavailable,
  SERVER_MODELS_NOTICE,
} from '../src/ai/provider-failure';
import {
  noteProviderFailureInScope,
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderHealth,
  serverModelsHealth,
  serverModelsStatus,
  withProviderFailureScope,
} from '../src/ai/provider-health';
import { HarnessModeRefusal } from '../src/common/extraction-source';
import { TenantBudgetExceeded } from '../src/ai/tenant-llm-budget';
import { ProviderCircuitOpen } from '../src/ai/provider-circuit-open';
import { processGauges } from '../src/metrics/process-gauges';

const withStatus = (status: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`status ${status}`), { status, ...extra });

describe('classifyProviderFailure', () => {
  it.each([
    [402, 'billing'],
    [401, 'key'],
    [403, 'key'],
    [429, 'quota'],
    [500, 'outage'],
    [502, 'outage'],
    [503, 'outage'],
    [529, 'outage'],
    [400, 'other'],
    [422, 'other'],
  ] as const)('HTTP %i is %s', (status, cls) => {
    expect(classifyProviderFailure(withStatus(status))).toBe(cls);
  });

  it('reads an exhausted OpenAI account on a 429 as billing, not quota', () => {
    expect(classifyProviderFailure(withStatus(429, { type: 'insufficient_quota' }))).toBe(
      'billing',
    );
    expect(
      classifyProviderFailure(withStatus(429, { error: { code: 'credit_balance_exhausted' } })),
    ).toBe('billing');
  });

  it('reads the status the hand-rolled clients write into the message', () => {
    // The two production log lines of 2026-11-13.
    expect(classifyProviderFailure(new Error('jev 402: {"error":"Insufficient credits"}'))).toBe(
      'billing',
    );
    expect(classifyProviderFailure(new Error('remote bge-m3 answered 402: credits'))).toBe(
      'billing',
    );
    expect(providerStatusOf(new Error('minicheck HTTP 503'))).toBe(503);
  });

  it('keeps the deliberate harness refusal its own class', () => {
    expect(classifyProviderFailure(new HarnessModeRefusal())).toBe('harness');
  });

  it('a spent tenant budget is the workspace limit, not the provider quota', () => {
    expect(classifyProviderFailure(new TenantBudgetExceeded())).toBe('other');
  });

  it('network failures, timeouts and an open circuit are outages', () => {
    const fetchFailed = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    expect(classifyProviderFailure(fetchFailed)).toBe('outage');
    expect(classifyProviderFailure(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(
      'outage',
    );
    expect(
      classifyProviderFailure(Object.assign(new Error('c'), { name: 'APIConnectionError' })),
    ).toBe('outage');
    expect(classifyProviderFailure(new ProviderCircuitOpen('host|model'))).toBe('outage');
    expect(classifyProviderFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(
      'outage',
    );
  });

  it('anything else is other', () => {
    expect(classifyProviderFailure(new Error('empty verifier response'))).toBe('other');
    expect(classifyProviderFailure(undefined)).toBe('other');
    expect(classifyProviderFailure('boom')).toBe('other');
  });

  it('names exactly billing, key, quota and outage as "server models unavailable"', () => {
    expect(
      ['billing', 'key', 'quota', 'outage'].every((c) => serverModelsUnavailable(c as never)),
    ).toBe(true);
    expect(serverModelsUnavailable('harness')).toBe(false);
    expect(serverModelsUnavailable('other')).toBe(false);
    expect(serverModelsUnavailable(undefined)).toBe(false);
  });
});

describe('provider health record', () => {
  beforeEach(() => resetProviderHealth());

  it('starts ok', () => {
    expect(serverModelsHealth()).toEqual({
      state: 'ok',
      capabilities: { embed: { state: 'ok' }, chat: { state: 'ok' } },
    });
    expect(serverModelsStatus()).not.toHaveProperty('notice');
  });

  it('a billing failure degrades its capability until that source succeeds again', () => {
    recordProviderFailure({ capability: 'embed', source: 'remote-bge-m3', err: withStatus(402) });
    const degraded = serverModelsStatus();
    expect(degraded.state).toBe('degraded');
    expect(degraded.capabilities.embed).toMatchObject({ state: 'degraded', failure: 'billing' });
    expect(degraded.capabilities.chat).toEqual({ state: 'ok' });
    expect(degraded.since).toEqual(degraded.capabilities.embed.since);
    expect(degraded.notice).toEqual(SERVER_MODELS_NOTICE);

    recordProviderSuccess({ capability: 'embed', source: 'remote-bge-m3' });
    expect(serverModelsHealth().state).toBe('ok');
  });

  it("one source's success does not clear another's failure", () => {
    // The incident: Jev (OpenRouter) refused while OpenAI chat answered.
    recordProviderFailure({ capability: 'chat', source: 'jev', err: withStatus(402) });
    recordProviderSuccess({ capability: 'chat', source: 'api.openai.com' });
    expect(serverModelsHealth().capabilities.chat.state).toBe('degraded');
  });

  it('a malformed request or a harness refusal does not degrade anything', () => {
    recordProviderFailure({ capability: 'chat', source: 'x', err: withStatus(400) });
    recordProviderFailure({ capability: 'chat', source: 'x', err: new HarnessModeRefusal() });
    expect(serverModelsHealth().state).toBe('ok');
  });

  it('counts failures per capability and class on brain_provider_failures_total', async () => {
    recordProviderFailure({ capability: 'chat', source: 'jev', err: withStatus(402) });
    recordProviderFailure({ capability: 'chat', source: 'jev', err: withStatus(402) });
    recordProviderFailure({ capability: 'embed', source: 'openai-embed', err: withStatus(401) });
    recordProviderFailure({ capability: 'chat', source: 'x', err: withStatus(400) });
    recordProviderFailure({ capability: 'chat', source: 'x', err: new HarnessModeRefusal() });
    const registry = new Registry();
    processGauges(registry);
    const metric = await registry.getSingleMetric('brain_provider_failures_total')!.get();
    const byLabels = Object.fromEntries(
      metric.values.map((v) => [`${v.labels.capability}|${v.labels.class}`, v.value]),
    );
    expect(byLabels).toEqual({ 'chat|billing': 2, 'embed|key': 1, 'chat|other': 1 });
  });
});

describe('provider failure scope', () => {
  beforeEach(() => resetProviderHealth());

  it('collects the unavailability failures recorded inside it, and only those', async () => {
    recordProviderFailure({ capability: 'chat', source: 'jev', err: withStatus(402) });
    const { value, failures } = await withProviderFailureScope(async () => {
      recordProviderFailure({ capability: 'chat', source: 'jev', err: withStatus(402) });
      recordProviderFailure({ capability: 'chat', source: 'x', err: withStatus(400) });
      // The chat router's primary refusal: the fallback may still serve.
      recordProviderFailure({
        capability: 'chat',
        source: 'h',
        err: withStatus(500),
        scoped: false,
      });
      noteProviderFailureInScope('chat', withStatus(429));
      return 7;
    });
    expect(value).toBe(7);
    expect(failures).toEqual([
      { capability: 'chat', cls: 'billing' },
      { capability: 'chat', cls: 'quota' },
    ]);
  });

  it('is per async context: a concurrent request does not see another one', async () => {
    const [a, b] = await Promise.all([
      withProviderFailureScope(async () => {
        await new Promise((r) => setTimeout(r, 5));
        noteProviderFailureInScope('chat', withStatus(402));
      }),
      withProviderFailureScope(async () => {
        await new Promise((r) => setTimeout(r, 1));
      }),
    ]);
    expect(a.failures).toHaveLength(1);
    expect(b.failures).toHaveLength(0);
  });

  it('outside any scope, noting is a no-op', () => {
    expect(noteProviderFailureInScope('chat', withStatus(402))).toBe('billing');
  });
});

describe('ProviderBillingOrKeyFailing alert', () => {
  it('pages on any billing or key failure in the last 10 minutes', () => {
    const rules = readFileSync(
      join(__dirname, '..', 'monitoring', 'grafana', 'provisioning', 'alerting', 'rules.yaml'),
      'utf8',
    );
    const rule = rules.slice(rules.indexOf('title: ProviderBillingOrKeyFailing'));
    expect(rule.slice(0, 1500)).toMatch(/severity: critical/);
    expect(rule.slice(0, 1500)).toContain(
      'sum(increase(brain_provider_failures_total{class=~"billing|key"}[10m])) or vector(0)',
    );
  });
});
