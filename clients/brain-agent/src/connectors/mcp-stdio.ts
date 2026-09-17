import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AgentConnector, ConnectorCtx, EnumerateOptions, FetchedItem, ItemDelta, ItemDescriptor, Modality } from '../types.js';

/**
 * `mcp` over stdio — the agent SPAWNS the MCP server the pack named
 * (`transport: 'stdio'`, `command` + `args`, consented at install) and
 * harvests its resources exactly as the brain's own `mcp` connector
 * harvests an http server: resources/list is the catalogue, resources/
 * read the fetch, lastModified the revision. The process is the
 * operator's own (an Obsidian vault server, a local notes server, a
 * filesystem server) and dies with the run.
 */
export interface McpStdioConfig {
  uriPrefixes?: string[];
  mimeTypes?: string[];
  maxResources?: number;
  maxBytes?: number;
  refetchHours?: number;
  /** Extra environment for the spawned server (never secrets on the brain). */
  env?: Record<string, string>;
}

const DEFAULT_MAX_RESOURCES = 5_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_REFETCH_HOURS = 24;
const REQUEST_TIMEOUT_MS = 30_000;

export class McpStdioAgentConnector implements AgentConnector {
  readonly kind = 'mcp';
  readonly walksEverything = true;
  private readonly sessions = new Map<string, Client>();

  async *enumerate(ctx: ConnectorCtx, _opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = ctx.connection.config as McpStdioConfig;
    const client = await this.session(ctx, cfg);
    const max = Math.max(1, cfg.maxResources ?? DEFAULT_MAX_RESOURCES);
    const bucket = `t:${Math.floor(Date.now() / ((cfg.refetchHours ?? DEFAULT_REFETCH_HOURS) * 3_600_000))}`;
    let cursor: string | undefined;
    let kept = 0;
    let listed = 0;
    do {
      const page = await client.listResources(cursor ? { cursor } : {}, { timeout: REQUEST_TIMEOUT_MS });
      for (const r of page.resources) {
        listed++;
        if (!admit(cfg, r.uri, r.mimeType)) continue;
        if (++kept > max) {
          ctx.log(`mcp: maxResources ${max} reached — listing truncated`);
          yield { type: 'checkpoint', checkpoint: { listed, kept: kept - 1, truncated: true, walkedAt: new Date().toISOString() } };
          return;
        }
        const lastModified = r.annotations?.lastModified;
        yield {
          type: 'upsert',
          item: {
            externalId: r.uri,
            originUri: r.uri,
            title: r.title ?? r.name,
            ...(r.mimeType ? { mediaType: r.mimeType } : {}),
            ...(typeof r.size === 'number' ? { size: r.size } : {}),
            revision: lastModified ? `lm:${lastModified}` : bucket,
            ...(lastModified ? { modifiedAt: lastModified } : {}),
          },
        };
      }
      cursor = page.nextCursor;
    } while (cursor);
    yield { type: 'checkpoint', checkpoint: { listed, kept, walkedAt: new Date().toISOString() } };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = ctx.connection.config as McpStdioConfig;
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
    if (ctx.connection.shape === 'binary') {
      if (!blob) throw new Error(`resource ${item.externalId} carries no blob — a text resource needs a document-shaped entry`);
      if (blob.bytes.length > maxBytes) throw new Error(`resource ${item.externalId} over maxBytes`);
      return {
        shape: 'binary',
        bytesBase64: blob.bytes.toString('base64'),
        mediaType: blob.mediaType,
        modality: modalityOf(blob.mediaType),
        ...(item.modifiedAt ? { occurredAt: item.modifiedAt } : {}),
      };
    }
    let text = texts.join('\n\n');
    if (text.length === 0 && blob && blob.mediaType.startsWith('text/')) text = blob.bytes.toString('utf8');
    if (text.length === 0) throw new Error(`resource ${item.externalId} carries no text — needs a binary-shaped entry`);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`resource ${item.externalId} over maxBytes`);
    return {
      shape: 'document',
      text,
      ...(item.title ? { title: item.title } : {}),
      ...(item.modifiedAt ? { occurredAt: item.modifiedAt } : {}),
      kind: 'mcp_resource',
    };
  }

  async endRun(ctx: ConnectorCtx): Promise<void> {
    const c = this.sessions.get(ctx.connection.id);
    if (!c) return;
    this.sessions.delete(ctx.connection.id);
    await c.close();
  }

  private async session(ctx: ConnectorCtx, cfg: McpStdioConfig): Promise<Client> {
    const existing = this.sessions.get(ctx.connection.id);
    if (existing) return existing;
    const s = ctx.source;
    if (!s || s.kind !== 'mcp' || s.transport !== 'stdio' || !s.command) {
      throw new Error(`mcp: pack "${ctx.connection.packId}" declares no stdio MCP source "${ctx.connection.sourceId}"`);
    }
    // The pack names the program; argv is an array, never a shell line.
    const [command, ...declaredArgs] = s.command.split(/\s+/).filter(Boolean);
    if (!command) throw new Error('mcp: empty command');
    const client = new Client({ name: 'inite-brain-agent', version: '0.1.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command,
      args: [...declaredArgs, ...(s.args ?? [])],
      env: { ...filteredEnv(), ...(cfg.env ?? {}) },
      stderr: 'ignore',
    });
    await client.connect(transport);
    this.sessions.set(ctx.connection.id, client);
    return client;
  }
}

/** The spawned server inherits PATH and HOME, not this process's secrets. */
function filteredEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA']) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function admit(cfg: McpStdioConfig, uri: string, mimeType: string | undefined): boolean {
  if (cfg.uriPrefixes && cfg.uriPrefixes.length > 0 && !cfg.uriPrefixes.some((p) => uri.startsWith(p))) return false;
  if (cfg.mimeTypes && cfg.mimeTypes.length > 0) {
    if (!mimeType) return false;
    const lower = mimeType.toLowerCase();
    if (!cfg.mimeTypes.some((m) => lower.startsWith(m.toLowerCase()))) return false;
  }
  return true;
}

function modalityOf(mediaType: string): Modality {
  const t = mediaType.split(';')[0]!.trim().toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  return 'document';
}
