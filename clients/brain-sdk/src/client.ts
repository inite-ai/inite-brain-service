/**
 * The typed client every other adapter in this package is built on.
 *
 * Deliberately small. Brain's REST surface has sixty-odd paths; an SDK
 * that mirrored all of them would be a second contract to keep in sync
 * with the first, and the OpenAPI document already generates whatever
 * anyone needs for the long tail. What belongs in a hand-written client
 * is the handful of calls an agent actually makes in a loop — remember,
 * recall, answer, what-changed — with the per-user scope threaded
 * through so nobody has to remember it on each call.
 */

import type {
  EntityProfile,
  EntityTimeline,
  IngestFactResponse,
  IngestMentionResponse,
  ProblemDetails,
  SearchFact,
  SearchHit,
  SearchResponse,
  SynthesisReason,
  SynthesizeResponse,
  TimelineEvent,
} from './contracts.js';

export interface RetryOptions {
  /** Retries after the first attempt. Default 3; 0 turns retrying off. */
  retries?: number;
  /** First backoff step in ms; each retry doubles it, with full jitter. Default 500. */
  baseDelayMs?: number;
  /**
   * The longest single wait. A `Retry-After` past it is not slept on: the
   * error goes to the caller, who can decide to wait that long. Default 30 000.
   */
  maxDelayMs?: number;
}

export interface BrainOptions {
  /** A `brain_…` key, or any bearer credential brain accepts. */
  apiKey: string;
  /** Override for self-hosted deployments. */
  baseUrl?: string;
  /**
   * End-user every call is scoped to. Reads return workspace-wide memory
   * PLUS this user's rows; writes are fenced to them. Omitting it on
   * both sides is the workspace-wide mode, which is fail-closed rather
   * than a mistake — but mixing the two is: a fact written with a userId
   * is invisible to a read without one.
   */
  userId?: string;
  /** Milliseconds before one attempt is abandoned. Default 30 000. */
  timeoutMs?: number;
  /** Retrying of transient failures; see RetryOptions. */
  retry?: RetryOptions;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface BrainRequest {
  method: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  /**
   * Sent as `Idempotency-Key` on a write. One is generated per call when
   * omitted, and every retry of the call reuses it, so brain replays the
   * first answer instead of writing twice. Pass your own to make a retry
   * across process restarts safe too.
   */
  idempotencyKey?: string;
  /** Cancels the call, including any backoff wait. */
  signal?: AbortSignal;
}

/** `remember()`'s answer. */
export type RememberResult = IngestMentionResponse;
/** One fact of a recalled entity. */
export type RecallFact = SearchFact;
/** One entity `recall()` matched. */
export type RecallHit = SearchHit;
/** Why brain gave no answer. */
export type AnswerReason = SynthesisReason;
/** `answer()`'s answer. */
export type AnswerResult = SynthesizeResponse;
export type { TimelineEvent };

const DEFAULT_BASE = 'https://brain.inite.ai';
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY = 500;
const DEFAULT_MAX_DELAY = 30_000;

/** Statuses that say "the same request may work later" (RFC 9110 § 15). */
const TRANSIENT = new Set([408, 429, 502, 503, 504]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A failed call. `status` is the HTTP status (0 when no response came
 * back: network failure or timeout). When brain answered, `problem` is its
 * RFC 9457 body and `requestId` the correlation id to quote in a report.
 */
export class BrainError extends Error {
  readonly problem: ProblemDetails | undefined;
  readonly requestId: string | undefined;
  /** How long the server asked the caller to wait before retrying, in ms. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    readonly status: number,
    details: {
      problem?: ProblemDetails;
      requestId?: string;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'BrainError';
    this.problem = details.problem;
    this.requestId = details.requestId ?? details.problem?.requestId;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** The problem type URI (`about:blank` when the status says it all). */
  get type(): string | undefined {
    return this.problem?.type;
  }

  /** The human explanation brain gave, when it gave one. */
  get detail(): string | undefined {
    return this.problem?.detail;
  }
}

export class Brain {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: BrainOptions) {
    if (!options.apiKey) throw new Error('brain: apiKey is required');
    this.baseUrl = trimTrailingSlashes(options.baseUrl ?? DEFAULT_BASE);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The tenant-scoped user every call carries, if one was configured. */
  get userId(): string | undefined {
    return this.options.userId;
  }

  async request<T>(path: string, init: BrainRequest): Promise<T> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) search.set(key, value);
    }
    // A GET carries the user scope in the query string, since there is
    // no body to thread it into.
    if (init.body === undefined && this.options.userId && !search.has('userId')) {
      search.set('userId', this.options.userId);
    }
    const url = search.toString() ? `${path}?${search.toString()}` : path;
    const method = init.method.toUpperCase();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, application/problem+json',
      Authorization: `Bearer ${this.options.apiKey}`,
    };
    // The key makes a write safe to retry: brain stores the first answer
    // under it and replays that answer to every retry (IETF
    // draft-ietf-httpapi-idempotency-key-header).
    const idempotent = SAFE_METHODS.has(method);
    if (!idempotent)
      headers['Idempotency-Key'] = init.idempotencyKey ?? globalThis.crypto.randomUUID();
    const body = init.body === undefined ? undefined : JSON.stringify(this.scoped(init.body));

    const policy = this.options.retry ?? {};
    const retries = Math.max(0, policy.retries ?? DEFAULT_RETRIES);
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.exchange(url, { method, headers, body, signal: init.signal });
      if (outcome.ok) return outcome.value as T;
      const { error } = outcome;
      if (attempt >= retries || !isRetriable(error, idempotent)) throw error;
      const wait = backoff(attempt, error.retryAfterMs, policy);
      if (wait === null) throw error;
      await abortableSleep(this.sleep, wait, init.signal);
    }
  }

  /**
   * One attempt, as a value: the parsed body, or the error it ended in.
   * The caller's own cancellation is thrown instead, because no retry
   * should follow it.
   */
  private async exchange(
    url: string,
    init: Exchange,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: BrainError }> {
    let res: Response;
    try {
      res = await this.attempt(url, init);
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      const what =
        error instanceof Error && error.name === 'AbortError' ? 'timed out' : describe(error);
      return {
        ok: false,
        error: new BrainError(`brain ${init.method} ${url} → no response (${what})`, 0, {
          cause: error,
        }),
      };
    }
    if (!res.ok) return { ok: false, error: await toError(res, init.method, url) };
    const text = await res.text();
    return { ok: true, value: text ? JSON.parse(text) : undefined };
  }

  /** One HTTP exchange under the per-attempt timeout. */
  private async attempt(url: string, init: Exchange): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT);
    const onAbort = () => controller.abort();
    init.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetchImpl(`${this.baseUrl}${url}`, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Thread the configured user through every body, unless the caller
   * named one explicitly. Forgetting it on one side of a read/write pair
   * is the single most common way a memory integration silently returns
   * nothing, so the default is "always", not "when you remember".
   */
  private scoped(body: unknown): unknown {
    if (!this.options.userId || typeof body !== 'object' || body === null) return body;
    const record = body as Record<string, unknown>;
    return 'userId' in record ? record : { ...record, userId: this.options.userId };
  }

  /**
   * Text in, facts out. Brain captures the turn as an episode, extracts
   * entities and claims, and runs each through bitemporal conflict
   * resolution. `skipped: true` means the extractor found nothing worth
   * recording — normal for a greeting, not an error.
   */
  remember(text: string, options: { vertical?: string; conversationId?: string } = {}) {
    return this.request<RememberResult>('/v1/ingest/mention', {
      method: 'POST',
      body: {
        text,
        ...(options.vertical || options.conversationId
          ? {
              contextRef: {
                vertical: options.vertical ?? 'chat',
                ...(options.conversationId ? { conversationId: options.conversationId } : {}),
              },
            }
          : {}),
      },
    });
  }

  /** Record a claim you already know, and read what the resolver decided. */
  recordFact(fact: {
    entityRef: Record<string, string>;
    predicate: string;
    object: string;
    validFrom: string;
    source: Record<string, unknown>;
  }) {
    return this.request<IngestFactResponse>('/v1/ingest/fact', {
      method: 'POST',
      body: fact,
    });
  }

  /**
   * Hybrid retrieval — vector + BM25, reranked, with each hit's facts —
   * and the rest of the answer: `degraded` says when the ranking is
   * lexical-only, `linked` carries what connected sources said.
   */
  search(query: string, options: { limit?: number; asOf?: string } = {}) {
    return this.request<SearchResponse>('/v1/search', {
      method: 'POST',
      body: { query, limit: options.limit ?? 8, ...(options.asOf ? { asOf: options.asOf } : {}) },
    });
  }

  /** `search()`'s ranked hits alone. */
  async recall(query: string, options: { limit?: number; asOf?: string } = {}) {
    return (await this.search(query, options)).results;
  }

  /** An answer with citations, rather than a ranked list to read yourself. */
  answer(query: string, options: { limit?: number } = {}) {
    return this.request<AnswerResult>('/v1/synthesize', {
      method: 'POST',
      body: { query, ...(options.limit ? { limit: options.limit } : {}) },
    });
  }

  /**
   * One entity's bitemporal history — every recorded and retracted fact
   * on the transaction-time axis. The "what did we believe, and when did
   * we start believing it" call, which is the question a plain vector
   * store cannot answer at all.
   */
  timeline(entityId: string, options: { since?: string; until?: string } = {}) {
    return this.request<EntityTimeline>(`/v1/entities/${encodeURIComponent(entityId)}/timeline`, {
      method: 'GET',
      query: { since: options.since, until: options.until },
    });
  }

  /** An entity's current facts, external refs and type. */
  entity(entityId: string, options: { asOf?: string } = {}) {
    return this.request<EntityProfile>(`/v1/entities/${encodeURIComponent(entityId)}`, {
      method: 'GET',
      query: { asOf: options.asOf },
    });
  }
}

interface Exchange {
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

/**
 * Whether the same request may succeed later. No response at all, and the
 * transient statuses, always qualify: a write carries its Idempotency-Key,
 * so a retry cannot write twice. A 500 qualifies only for a read. A 409
 * qualifies only with a `Retry-After`, which is how brain marks "the first
 * request under this Idempotency-Key is still running", as opposed to a
 * conflict that will be the same answer next time.
 */
function isRetriable(error: BrainError, idempotent: boolean): boolean {
  if (error.status === 0 || TRANSIENT.has(error.status)) return true;
  if (error.status === 500) return idempotent;
  if (error.status === 409) return error.retryAfterMs !== undefined;
  return false;
}

/**
 * The wait before retry `attempt` (0-based): what the server asked for, or
 * exponential backoff with full jitter. null when the server asked for
 * longer than the caller is willing to wait in-process.
 */
function backoff(
  attempt: number,
  retryAfterMs: number | undefined,
  policy: RetryOptions,
): number | null {
  const max = policy.maxDelayMs ?? DEFAULT_MAX_DELAY;
  if (retryAfterMs !== undefined) return retryAfterMs > max ? null : retryAfterMs;
  const ceiling = Math.min(max, (policy.baseDelayMs ?? DEFAULT_BASE_DELAY) * 2 ** attempt);
  return Math.random() * ceiling;
}

function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, reject);
  });
}

/**
 * `Retry-After` in ms, as delay-seconds or an HTTP-date (RFC 9110 § 10.2.3).
 * Brain's rate limiter names a bucket's header `Retry-After-<bucket>`; the
 * longest of those counts when the plain header is absent.
 */
function retryAfterOf(headers: Headers): number | undefined {
  const values: string[] = [];
  const plain = headers.get('retry-after');
  if (plain !== null) values.push(plain);
  else
    headers.forEach((value, name) => {
      if (name.toLowerCase().startsWith('retry-after-')) values.push(value);
    });
  const waits = values.map(parseRetryAfter).filter((ms): ms is number => ms !== undefined);
  return waits.length ? Math.max(...waits) : undefined;
}

function parseRetryAfter(value: string): number | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** A failed response as a BrainError, reading the problem details when brain sent them. */
async function toError(res: Response, method: string, url: string): Promise<BrainError> {
  const text = await res.text().catch(() => '');
  let problem: ProblemDetails | undefined;
  try {
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (isProblem(parsed)) problem = parsed;
  } catch {
    // Not JSON: a proxy's HTML page, say. The text still goes in the message.
  }
  const said = problem?.detail ?? problem?.title ?? text.slice(0, 300);
  const requestId = problem?.requestId ?? res.headers.get('x-request-id') ?? undefined;
  const retryAfterMs = retryAfterOf(res.headers);
  return new BrainError(
    `brain ${method} ${url} → ${res.status}${said ? `: ${said}` : ''}`,
    res.status,
    {
      ...(problem ? { problem } : {}),
      ...(requestId ? { requestId } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  );
}

function isProblem(value: unknown): value is ProblemDetails {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.status === 'number' && typeof v.title === 'string';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBrain(options: BrainOptions): Brain {
  return new Brain(options);
}

/** A loop, not `/\/+$/`: that regex is quadratic on a run of slashes (CodeQL js/polynomial-redos). */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}
