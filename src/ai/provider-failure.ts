/**
 * What kind of failure a model-provider call ended in (#945 phase 1).
 *
 * WHY. On 2026-11-13 from 15:03 UTC the platform's provider account
 * answered `402 Insufficient credits`. The embedder fell back to lexical
 * search, the decision plane returned nothing, and `synthesize` answered
 * "I don't have that in my memory" — an unpaid invoice read as an absence
 * of memory. The caller can only be told the truth once the failure is
 * named, and the remedy differs per class: top up the account (`billing`),
 * fix or rotate the key (`key`), wait or raise the limit (`quota`), wait
 * for the provider (`outage`).
 *
 * `harness` is its own class: HarnessModeRefusal is the server declining
 * to spend a key on purpose (#819), not a provider failing. A spent tenant
 * budget (TenantBudgetExceeded, 429) is the workspace's own limit, not the
 * provider's quota — `other`, and its caller already answers
 * `model_budget`. A request the provider rejected as malformed (400, 422)
 * is `other` too: a different key would be refused the same way.
 *
 * Pure: reads the error's own fields, never the network or the env.
 */
export type ProviderFailureClass = 'billing' | 'key' | 'quota' | 'outage' | 'harness' | 'other';

/** The two server-model capabilities a caller can lose. */
export type ProviderCapability = 'embed' | 'chat';

/** The classes that mean "the server's models are unavailable", as the caller is told. */
export const SERVER_MODELS_UNAVAILABLE: readonly ProviderFailureClass[] = [
  'billing',
  'key',
  'quota',
  'outage',
];

export function serverModelsUnavailable(cls: ProviderFailureClass | undefined): boolean {
  return cls !== undefined && SERVER_MODELS_UNAVAILABLE.includes(cls);
}

/**
 * OpenAI states an exhausted account in the error TYPE on a 429
 * (`insufficient_quota`); the code changed under it on 2026-09-25
 * (`credit_balance_exhausted`). Either is a billing failure, not a rate
 * limit — waiting does not fix it.
 */
const BILLING_MARKERS = new Set(['insufficient_quota', 'credit_balance_exhausted']);

/** Node/undici error codes that mean the provider could not be reached. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Error names that mean the call ran out of time or never connected. */
const OUTAGE_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'ProviderCircuitOpen',
]);

interface ErrorFields {
  status?: unknown;
  code?: unknown;
  type?: unknown;
  name?: unknown;
  message?: unknown;
  cause?: unknown;
  error?: { code?: unknown; type?: unknown };
}

function fieldsOf(err: unknown): ErrorFields {
  return err !== null && typeof err === 'object' ? (err as ErrorFields) : {};
}

/**
 * The HTTP status of a failed provider call: the SDK's own `status`, else
 * the status a hand-rolled client wrote into its message
 * (`jev 402: …`, `remote bge-m3 answered 402: …`).
 */
export function providerStatusOf(err: unknown): number | undefined {
  const e = fieldsOf(err);
  if (typeof e.status === 'number') return e.status;
  if (typeof e.message !== 'string') return undefined;
  const m = /\b(?:jev|answered|HTTP)\s+(\d{3})\b/.exec(e.message);
  return m ? Number(m[1]) : undefined;
}

function billingMarked(e: ErrorFields): boolean {
  return [e.code, e.type, e.error?.code, e.error?.type].some(
    (m) => typeof m === 'string' && BILLING_MARKERS.has(m),
  );
}

function unreachable(e: ErrorFields, depth = 0): boolean {
  if (typeof e.name === 'string' && OUTAGE_NAMES.has(e.name)) return true;
  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return true;
  if (e.name === 'TypeError' && e.message === 'fetch failed') return true;
  return depth < 3 && e.cause !== undefined && unreachable(fieldsOf(e.cause), depth + 1);
}

function fromStatus(status: number, e: ErrorFields): ProviderFailureClass {
  if (status === 402) return 'billing';
  if (status === 401 || status === 403) return 'key';
  if (status === 429) return billingMarked(e) ? 'billing' : 'quota';
  if (status === 529 || status >= 500) return 'outage';
  return 'other';
}

export function classifyProviderFailure(err: unknown): ProviderFailureClass {
  const e = fieldsOf(err);
  // A free plan's refusal (#945 phase 2) is the server declining too, not a bad key.
  if (e.code === 'harness_mode' || e.code === 'platform_models_not_included') return 'harness';
  if (e.code === 'tenant_budget_exceeded') return 'other';
  const status = providerStatusOf(err);
  if (status !== undefined) return fromStatus(status, e);
  return unreachable(e) ? 'outage' : 'other';
}

/**
 * What every response a server-model outage touched carries beside its
 * `degraded` list: the outage named, and the two ways around it that do
 * not depend on the platform's account.
 */
export interface ServerModelsNotice {
  code: 'server_models_unavailable' | 'platform_models_not_included';
  message: string;
}

export const SERVER_MODELS_NOTICE: ServerModelsNotice = {
  code: 'server_models_unavailable',
  message:
    "The server's model provider is unavailable, so this answer could not be checked. Use your own provider key (BYOK) or connect an agent in harness mode.",
};

/**
 * The tenant's plan does not include server-side models (#945 phase 2):
 * the server refused before the network, and the tenant's agent can do
 * the reading in harness mode.
 */
export const PLATFORM_MODELS_NOT_INCLUDED_NOTICE: ServerModelsNotice = {
  code: 'platform_models_not_included',
  message:
    'Your plan does not include server-side models. Connect an agent in harness mode, or add your own provider key (BYOK, coming soon).',
};
