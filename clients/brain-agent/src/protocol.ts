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

export class BrainAgentClient {
  private readonly base: string;

  constructor(
    private readonly opts: { baseUrl: string; apiKey: string; fetch?: FetchLike },
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

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'inite-brain-agent/0.1.0',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
