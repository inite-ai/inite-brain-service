import { AsyncLocalStorage } from 'node:async_hooks';
import {
  classifyProviderFailure,
  SERVER_MODELS_NOTICE,
  serverModelsUnavailable,
  type ServerModelsNotice,
  type ProviderCapability,
  type ProviderFailureClass,
} from './provider-failure';

/**
 * Process-level health of the server's model providers (#945 phase 1).
 *
 * Every provider call site records its outcome here: the OpenAI chat
 * router, the decision plane (Jev), the remote bge-m3 embedder and the
 * OpenAI embedder. Three readers:
 *
 *  - `/metrics` reads the failure counts at scrape time
 *    (`brain_provider_failures_total{capability,class}`, the
 *    migration-failure-metrics idiom — no DI edge into the clients);
 *  - `about_brain` / `workspace_status` read the per-capability state;
 *  - a request scope (`withProviderFailureScope`) collects the failures
 *    one stage of one request ran into, so `synthesize` can tell "the
 *    auditor judged the answer unsupported" from "part of the audit could
 *    not run because the provider refused".
 *
 * State is kept per (capability, source): the incident had Jev (OpenRouter)
 * refusing while OpenAI chat answered, and one source's success must not
 * clear another's failure. A capability is degraded while any of its
 * sources' latest outcome is an unavailability failure (billing, key,
 * quota, outage). Holds ids, classes and timestamps only — never a key,
 * a prompt or a provider's error body.
 */

export interface ProviderOutcome {
  capability: ProviderCapability;
  /** A short provider id: 'openai', 'jev', 'remote-bge-m3', 'openai-embed'. */
  source: string;
}

interface SourceState {
  /** The class and time of the latest failure, while no success followed it. */
  failing?: { cls: ProviderFailureClass; at: number };
}

export interface ScopedProviderFailure {
  capability: ProviderCapability;
  cls: ProviderFailureClass;
}

const failureCounts = new Map<string, number>();
const sources = new Map<string, SourceState & { capability: ProviderCapability }>();
const scope = new AsyncLocalStorage<ScopedProviderFailure[]>();

function sourceKey(o: ProviderOutcome): string {
  return `${o.capability}|${o.source}`;
}

/**
 * Record a failed provider call. Returns the class so the caller can act
 * on it without classifying twice. `harness` is not counted: the server
 * declining to spend a key is the configured behaviour, not a failure.
 * `scoped: false` keeps the failure out of the request scope — the chat
 * router passes it, because a primary refusal the fallback then served is
 * not a failure the answer saw.
 */
export function recordProviderFailure(
  outcome: ProviderOutcome & { err: unknown; scoped?: boolean },
): ProviderFailureClass {
  const cls = classifyProviderFailure(outcome.err);
  if (cls === 'harness') return cls;
  const countKey = `${outcome.capability}|${cls}`;
  failureCounts.set(countKey, (failureCounts.get(countKey) ?? 0) + 1);
  if (serverModelsUnavailable(cls)) {
    sources.set(sourceKey(outcome), {
      capability: outcome.capability,
      failing: { cls, at: Date.now() },
    });
    if (outcome.scoped !== false) noteInScope(outcome.capability, cls);
  }
  return cls;
}

/** Record a successful provider call: that source is healthy again. */
export function recordProviderSuccess(outcome: ProviderOutcome): void {
  const key = sourceKey(outcome);
  if (sources.get(key)?.failing) sources.set(key, { capability: outcome.capability });
}

/**
 * Note a failure in the current request scope only (no count, no state):
 * for a caller that catches an error a client already recorded, such as a
 * verifier call the chat router refused.
 */
export function noteProviderFailureInScope(
  capability: ProviderCapability,
  err: unknown,
): ProviderFailureClass {
  const cls = classifyProviderFailure(err);
  if (serverModelsUnavailable(cls)) noteInScope(capability, cls);
  return cls;
}

function noteInScope(capability: ProviderCapability, cls: ProviderFailureClass): void {
  scope.getStore()?.push({ capability, cls });
}

/**
 * Run `fn` and return, beside its value, every unavailability failure a
 * provider call inside it ran into. Scopes nest: an inner scope's failures
 * are copied to the outer one.
 */
export async function withProviderFailureScope<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; failures: ScopedProviderFailure[] }> {
  const failures: ScopedProviderFailure[] = [];
  const outer = scope.getStore();
  try {
    const value = await scope.run(failures, fn);
    return { value, failures };
  } finally {
    outer?.push(...failures);
  }
}

/** The failure counts since boot, keyed `capability|class` — read by the metric. */
export function providerFailureCounts(): ReadonlyMap<string, number> {
  return failureCounts;
}

export interface CapabilityHealth {
  state: 'ok' | 'degraded';
  /** The failure class of the oldest still-failing source. */
  failure?: ProviderFailureClass;
  /** ISO time that source started failing. */
  since?: string;
}

export interface ServerModelsHealth {
  state: 'ok' | 'degraded';
  capabilities: Record<ProviderCapability, CapabilityHealth>;
  /** ISO time the earliest still-failing source started failing. */
  since?: string;
}

function capabilityHealth(capability: ProviderCapability): CapabilityHealth {
  let oldest: { cls: ProviderFailureClass; at: number } | undefined;
  for (const s of sources.values()) {
    if (s.capability !== capability || !s.failing) continue;
    if (!oldest || s.failing.at < oldest.at) oldest = s.failing;
  }
  if (!oldest) return { state: 'ok' };
  return { state: 'degraded', failure: oldest.cls, since: new Date(oldest.at).toISOString() };
}

/** The per-capability state `about_brain` and `workspace_status` report. */
export function serverModelsHealth(): ServerModelsHealth {
  const capabilities = { embed: capabilityHealth('embed'), chat: capabilityHealth('chat') };
  const since = [capabilities.embed.since, capabilities.chat.since]
    .filter((s): s is string => s !== undefined)
    .sort()[0];
  return {
    state: since ? 'degraded' : 'ok',
    capabilities,
    ...(since ? { since } : {}),
  };
}

/**
 * What `about_brain` and `workspace_status` show as `serverModels`: the
 * health above, plus the notice while degraded so an agent reading the
 * status learns the way around it in the same call.
 */
export function serverModelsStatus(): ServerModelsHealth & { notice?: ServerModelsNotice } {
  const health = serverModelsHealth();
  return health.state === 'degraded' ? { ...health, notice: SERVER_MODELS_NOTICE } : health;
}

/** Test seam: forget every recorded outcome. */
export function resetProviderHealth(): void {
  failureCounts.clear();
  sources.clear();
}
