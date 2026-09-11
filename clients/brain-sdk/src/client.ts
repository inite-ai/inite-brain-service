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
  /** Milliseconds before a request is abandoned. Default 30 000. */
  timeoutMs?: number;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface RememberResult {
  skipped: boolean;
  reason?: string;
  extractedEntityIds: string[];
  extractedFactIds: string[];
}

export interface RecallFact {
  factId: string;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  validUntil?: string;
  status: string;
}

export interface RecallHit {
  entityId: string;
  entityType: string;
  canonicalName: string;
  facts: RecallFact[];
  score: number;
}

export interface AnswerResult {
  answer: string;
  citations?: unknown[];
  evidenceCitations?: unknown[];
}

export interface TimelineEvent {
  [key: string]: unknown;
}

const DEFAULT_BASE = 'https://brain.inite.ai';
const DEFAULT_TIMEOUT = 30_000;

export class BrainError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BrainError';
  }
}

export class Brain {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: BrainOptions) {
    if (!options.apiKey) throw new Error('brain: apiKey is required');
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** The tenant-scoped user every call carries, if one was configured. */
  get userId(): string | undefined {
    return this.options.userId;
  }

  async request<T>(
    path: string,
    init: { method: string; body?: unknown; query?: Record<string, string | undefined> },
  ): Promise<T> {
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${url}`, {
        method: init.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(this.scoped(init.body)) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new BrainError(
          `brain ${init.method} ${url} → ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
          res.status,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
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
    return this.request<{ factId: string | null; outcome: string }>('/v1/ingest/fact', {
      method: 'POST',
      body: fact,
    });
  }

  /** Hybrid retrieval — vector + BM25, reranked, with each hit's facts. */
  async recall(query: string, options: { limit?: number; asOf?: string } = {}) {
    const out = await this.request<{ results: RecallHit[] }>('/v1/search', {
      method: 'POST',
      body: { query, limit: options.limit ?? 8, ...(options.asOf ? { asOf: options.asOf } : {}) },
    });
    return out.results;
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
    return this.request<{ entityId: string; events: TimelineEvent[] }>(
      `/v1/entities/${encodeURIComponent(entityId)}/timeline`,
      {
        method: 'GET',
        query: { since: options.since, until: options.until },
      },
    );
  }

  /** An entity's current facts, external refs and type. */
  entity(entityId: string, options: { asOf?: string } = {}) {
    return this.request<{
      entityId: string;
      type: string;
      canonicalName: string;
      facts: RecallFact[];
    }>(`/v1/entities/${encodeURIComponent(entityId)}`, {
      method: 'GET',
      query: { asOf: options.asOf },
    });
  }
}

export function createBrain(options: BrainOptions): Brain {
  return new Brain(options);
}
