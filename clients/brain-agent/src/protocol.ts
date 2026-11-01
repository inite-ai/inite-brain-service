import type { AgentConnection, FetchedItem, ItemDelta, SourceEntry, SyncSummary } from './types.js';

/**
 * The agent protocol client — five calls on /v1/source-connections
 * (docs/source-plane.md § Agent). Plain fetch with a Bearer key; the
 * brain answers with what to fetch, and the agent never needs to know
 * how the catalogue is kept.
 */
export interface BeginRun {
  runId: string;
  full: boolean;
  checkpoint: Record<string, unknown> | null;
  contentPolicy: 'manifest' | 'text' | 'bytes';
  fetchBudget: number | null;
}

export interface DeltasResult {
  fetch: string[];
  seen: number;
  new: number;
  changed: number;
  unchanged: number;
  gone: number;
}

export interface ItemResult {
  status: 'ingested' | 'deduplicated' | 'failed' | 'skipped';
  error?: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** No `Retry-After` on a 429: exponential backoff with full jitter (Brooker, AWS Architecture Blog, 2015), base 1 s. */
const BACKOFF_BASE_MS = 1000;
/** …and up to this many tries before the sync gives up — the AWS SDKs' standard retry mode stops at 3. */
const BACKOFF_ATTEMPTS = 3;

/**
 * How long the brain asked to wait, in ms, or null when it did not say.
 * The throttler names one header per bucket — `Retry-After` for the
 * default, `Retry-After-expensive` for the other — and a request is let
 * through only when every bucket it counts against has room, so the
 * longest wait is the one that matters. RFC 9110 § 10.2.3: delay-seconds
 * or an HTTP-date.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  let wait: number | null = null;
  headers.forEach((value, name) => {
    if (!name.toLowerCase().startsWith('retry-after')) return;
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    if (Number.isFinite(ms) && ms >= 0) wait = Math.max(wait ?? 0, ms);
  });
  return wait;
}

export class BrainAgentClient {
  private readonly base: string;

  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey: string;
      fetch?: FetchLike;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
  }

  async listConnections(agentId: string): Promise<Array<{ connection: AgentConnection; source: SourceEntry | null }>> {
    const r = await this.call<{ connections: Array<{ connection: AgentConnection; source: SourceEntry | null }> }>(
      'GET',
      `/v1/source-connections?host=${encodeURIComponent(`agent:${agentId}`)}`,
    );
    return r.connections;
  }

  /** Presence + the folders this machine offers (the admin's folder picker). */
  checkIn(agentId: string, inv: object): Promise<{ ok: true }> {
    return this.call('PUT', `/v1/source-connections/agents/${encodeURIComponent(agentId)}`, inv);
  }

  begin(connectionId: string, body: { agentId: string; full?: boolean }): Promise<BeginRun> {
    return this.call('POST', `/v1/source-connections/${encodeURIComponent(connectionId)}/agent-runs`, body);
  }

  deltas(connectionId: string, runId: string, deltas: ItemDelta[]): Promise<DeltasResult> {
    return this.call('POST', `${this.runPath(connectionId, runId)}/deltas`, { deltas });
  }

  item(connectionId: string, runId: string, externalId: string, item: FetchedItem): Promise<ItemResult> {
    return this.call('POST', `${this.runPath(connectionId, runId)}/items`, { externalId, item });
  }

  finish(
    connectionId: string,
    runId: string,
    body: { status: 'succeeded' | 'failed'; error?: string; checkpoint?: Record<string, unknown> },
  ): Promise<SyncSummary> {
    return this.call('POST', `${this.runPath(connectionId, runId)}/finish`, body);
  }

  private runPath(connectionId: string, runId: string): string {
    return `/v1/source-connections/${encodeURIComponent(connectionId)}/agent-runs/${encodeURIComponent(runId)}`;
  }

  /**
   * One call, paced by the brain. A first sync of a large folder posts
   * one item per file and runs into the per-credential rate limit; the
   * throttler answers 429 before the handler runs, so the call is safe
   * to repeat, and the brain says when (`Retry-After`). Waiting that long
   * is what keeps a 10 000-file sync from failing at file 121. A 503
   * that names a wait is the same promise; one that does not, and every
   * other error, is the caller's to see.
   */
  private async call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      res = await doFetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'inite-brain-agent/0.1.0',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status !== 429 && res.status !== 503) break;
      const asked = retryAfterMs(res.headers);
      if (asked === null && (res.status === 503 || attempt >= BACKOFF_ATTEMPTS)) break;
      await res.text().catch(() => '');
      await sleep(asked ?? Math.random() * BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const j = json as { message?: unknown; error?: unknown } | null;
      const detail =
        typeof j?.message === 'string' ? j.message : typeof j?.error === 'string' ? j.error : text.slice(0, 200);
      throw new BrainApiError(res.status, `${method} ${path} → ${res.status}: ${detail}`);
    }
    return json as T;
  }
}

export class BrainApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BrainApiError';
  }
}
