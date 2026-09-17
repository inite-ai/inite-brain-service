import { Injectable } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { PackMcpHttpSourceSpec } from '../../ai/domain-packs/manifest';
import { sourceKindEnabled } from '../../common/source-plane-flags';
import type {
  Connector,
  ConnectorCtx,
  EnumerateOptions,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
} from '../connector';
import { modalityOfMediaType } from './media';
import { guardedFetch } from './safe-fetch';

/**
 * `mcp` — the harvester (raw-evidence-sources-2026-09.md W2): an MCP
 * server's RESOURCES read as a source. MCP is the source plane's only
 * third-party seam: a CRM, a wiki, a ticket tracker or a drive that
 * speaks MCP (there are hundreds) is connected without brain learning
 * its API — `resources/list` is the catalogue, `resources/read` the
 * fetch, `annotations.lastModified` the revision. A pack declares the
 * entry (`kind: 'mcp', transport: 'http'`), pinning the server's URL when
 * the publisher operates it, or leaving it to the operator
 * (`config.url`) for the generic "my server" case; consent at install
 * covers either. Nothing runs on the agent here — stdio transports are
 * the local agent's (W3).
 *
 * Trust boundary. The server is a peer, not a pack: it supplies DATA
 * (resources) that enter the ordinary doors with the connection's own
 * recorder and stamp — never tools, never prompts. Every request leaves
 * through the egress guard (`guardedFetch`: each URL checked, redirects
 * never followed, the private-host double opt-in as everywhere), the
 * catalogue is capped (`maxResources`), a resource's text is capped
 * (`maxBytes`), and the bearer is the connection credential — or, for
 * `auth: install_secret`, the pack's own install secret (the publisher-
 * operated case). `auth: oauth` is W4 and fails by name today.
 *
 * Polling, not subscriptions: `resources/list` is re-walked every run
 * (`walksEverything` — what the listing no longer carries is gone). A
 * resource without `lastModified` gets a time-bucket revision so it is
 * re-read every `refetchHours`; the store's content hash makes an
 * unchanged re-read a dedup, not a duplicate. Resource TEMPLATES are not
 * enumerable without arguments and are skipped (documented).
 *
 * One client session per run: `enumerate` opens it, `fetch` reuses it,
 * the engine's `endRun` closes it.
 */
export interface McpConnectorConfig {
  /** Operator-named server (only when the pack entry pins no url). */
  url?: string | undefined;
  allowPrivate?: boolean | undefined;
  /** Keep only resources whose URI starts with one of these. */
  uriPrefixes?: string[] | undefined;
  /** Keep only these MIME types (prefix match, e.g. 'text/'). */
  mimeTypes?: string[] | undefined;
  maxResources?: number | undefined;
  /** Text kept per resource. */
  maxBytes?: number | undefined;
  /** Re-read cadence for resources that carry no lastModified. */
  refetchHours?: number | undefined;
  /** Bearer scheme override: 'bearer' (default) | 'header:<Name>'. */
  authScheme?: string | undefined;
}

const DEFAULT_MAX_RESOURCES = 5_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_REFETCH_HOURS = 24;
const REQUEST_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: 'inite-brain-source', version: '1.0.0' };

interface Session {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

@Injectable()
export class McpConnector implements Connector {
  readonly kind = 'mcp';
  readonly walksEverything = true;
  readonly configExample = {
    url: 'https://mcp.example.com/mcp',
    uriPrefixes: ['wiki://'],
    mimeTypes: ['text/'],
    maxResources: DEFAULT_MAX_RESOURCES,
  };
  readonly credentialHint = 'bearer token the server expects (omit for auth: none / install_secret)';

  private readonly sessions = new Map<string, Session>();

  enabled(): boolean {
    return sourceKindEnabled('mcp');
  }

  async *enumerate(ctx: ConnectorCtx, _opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const client = await this.session(ctx, cfg);
    const max = Math.max(1, cfg.maxResources ?? DEFAULT_MAX_RESOURCES);
    const bucket = `t:${Math.floor(Date.now() / ((cfg.refetchHours ?? DEFAULT_REFETCH_HOURS) * 3_600_000))}`;
    let cursor: string | undefined;
    let seen = 0;
    let listed = 0;
    do {
      const page = await client.listResources(cursor ? { cursor } : {}, { timeout: REQUEST_TIMEOUT_MS });
      for (const r of page.resources) {
        listed++;
        if (!admitResource(cfg, r.uri, r.mimeType)) continue;
        if (++seen > max) {
          ctx.log(`mcp: maxResources ${String(max)} reached — listing truncated`);
          yield { type: 'checkpoint', checkpoint: { listed, kept: seen - 1, truncated: true, walkedAt: new Date().toISOString() } };
          return;
        }
        const lastModified = r.annotations?.lastModified;
        yield {
          type: 'upsert',
          item: {
            externalId: r.uri,
            originUri: r.uri,
            title: r.title ?? r.name,
            mediaType: r.mimeType,
            size: r.size,
            revision: lastModified ? `lm:${lastModified}` : bucket,
            modifiedAt: lastModified,
          },
        };
      }
      cursor = page.nextCursor;
    } while (cursor);
    yield { type: 'checkpoint', checkpoint: { listed, kept: seen, walkedAt: new Date().toISOString() } };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const client = await this.session(ctx, cfg);
    const res = await client.readResource({ uri: item.externalId }, { timeout: REQUEST_TIMEOUT_MS });
    const maxBytes = cfg.maxBytes ?? DEFAULT_MAX_BYTES;
    const texts: string[] = [];
    let blob: { bytes: Buffer; mediaType: string } | null = null;
    for (const c of res.contents) {
      if ('text' in c && typeof c.text === 'string') texts.push(c.text);
      else if ('blob' in c && typeof c.blob === 'string' && !blob) {
        blob = { bytes: Buffer.from(c.blob, 'base64'), mediaType: c.mimeType ?? item.mediaType ?? 'application/octet-stream' };
      }
    }
    const occurredAt = item.modifiedAt;
    if (ctx.connection.shape === 'binary') {
      if (!blob) throw new Error(`resource ${item.externalId} carries no blob — a text resource needs a document-shaped entry`);
      if (blob.bytes.length > maxBytes) throw new Error(`resource ${item.externalId} over maxBytes`);
      return { shape: 'binary', bytes: blob.bytes, mediaType: blob.mediaType, modality: modalityOfMediaType(blob.mediaType), occurredAt };
    }
    let text = texts.join('\n\n');
    if (text.length === 0 && blob && blob.mediaType.startsWith('text/')) text = blob.bytes.toString('utf8');
    if (text.length === 0) {
      throw new Error(
        blob
          ? `resource ${item.externalId} is a ${blob.mediaType} blob — needs a binary-shaped entry`
          : `resource ${item.externalId} carries no content`,
      );
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`resource ${item.externalId} over maxBytes`);
    return { shape: 'document', text, title: item.title, occurredAt, kind: 'mcp_resource' };
  }

  async endRun(ctx: ConnectorCtx): Promise<void> {
    const s = this.sessions.get(ctx.connection.id);
    if (!s) return;
    this.sessions.delete(ctx.connection.id);
    await s.client.close();
  }

  private async session(ctx: ConnectorCtx, cfg: McpConnectorConfig): Promise<Client> {
    const existing = this.sessions.get(ctx.connection.id);
    if (existing) return existing.client;
    const entry = entryOf(ctx);
    const url = entry.url ?? cfg.url;
    if (!url) throw new Error('mcp connector: the pack entry pins no url and config.url is not set');
    if (entry.auth === 'oauth') throw new Error('mcp connector: auth "oauth" is not available yet (W4)');
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: guardedFetch({ allowPrivate: cfg.allowPrivate, signal: ctx.signal }),
      requestInit: { headers: authHeaders(ctx, cfg) },
    });
    // The SDK's .d.ts is self-inconsistent under exactOptionalPropertyTypes
    // (see src/mcp/mcp.controller.ts); the value is a valid Transport.
    await client.connect(transport as Transport);
    this.sessions.set(ctx.connection.id, { client, transport });
    return client;
  }
}

function entryOf(ctx: ConnectorCtx): PackMcpHttpSourceSpec {
  const s = ctx.connection.source;
  if (!s || s.kind !== 'mcp' || s.transport !== 'http') {
    throw new Error(
      `mcp connector: pack "${ctx.connection.packId}" no longer declares http MCP source "${ctx.connection.sourceId}"`,
    );
  }
  return s;
}

function configOf(ctx: ConnectorCtx): McpConnectorConfig {
  return ctx.connection.config as McpConnectorConfig;
}

function authHeaders(ctx: ConnectorCtx, cfg: McpConnectorConfig): Record<string, string> {
  const cred = ctx.connection.credential;
  if (!cred) return {};
  const scheme = cfg.authScheme ?? 'bearer';
  if (scheme.startsWith('header:')) return { [scheme.slice('header:'.length)]: cred };
  return { Authorization: `Bearer ${cred}` };
}

export function admitResource(cfg: McpConnectorConfig, uri: string, mimeType: string | undefined): boolean {
  if (cfg.uriPrefixes && cfg.uriPrefixes.length > 0 && !cfg.uriPrefixes.some((p) => uri.startsWith(p))) {
    return false;
  }
  if (cfg.mimeTypes && cfg.mimeTypes.length > 0) {
    if (!mimeType) return false;
    const lower = mimeType.toLowerCase();
    if (!cfg.mimeTypes.some((m) => lower.startsWith(m.toLowerCase()))) return false;
  }
  return true;
}
