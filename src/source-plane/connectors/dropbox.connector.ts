import { Injectable } from '@nestjs/common';
import { sourceKindEnabled, sourceOAuthClientEnabled } from '../../common/source-plane-flags';
import type {
  Connector,
  ConnectorCtx,
  EnumerateOptions,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
} from '../connector';
import { providerEndpoints } from '../oauth/oauth-providers';
import { CloudHttpError, cloudHttp, type CloudHttp } from './cloud-http';
import {
  admitCloudFile,
  admittedExtensions,
  classifyCloudFile,
  cloudMediaType,
  type AdmitGate,
} from './cloud-media';
import { looksBinary } from './fs.connector';
import { modalityOf } from './media';

/**
 * `dropbox` — a Dropbox folder (raw-evidence-sources-2026-09.md W4)
 * through the v2 API with the connected account's access token. One
 * folder (`path`, '' = the whole Dropbox) read recursively.
 *
 * Dropbox's cursor IS the change feed: `files/list_folder` walks the
 * folder and hands back a cursor; `list_folder/continue` from that
 * cursor later returns exactly what changed — files as upserts,
 * `deleted` entries as gone — so the checkpoint is the cursor and an
 * incremental run costs one call when nothing moved. A cursor Dropbox
 * has reset (409 `reset`) falls back to a fresh walk in the same run.
 * `rev` is the revision (content_hash beside it), `server_modified` the
 * source's clock, the fs / s3 media table decides what a shape admits.
 *
 * Needs SOURCE_OAUTH_CLIENT (the grant) as well as SOURCE_KIND_DROPBOX.
 */

export interface DropboxConnectorConfig {
  /** `/Folder/Sub` or '' for everything. */
  path?: string | undefined;
  extensions?: string[] | undefined;
  maxFiles?: number | undefined;
  maxFileBytes?: number | undefined;
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 64 * 1024 * 1024;
const PAGE_LIMIT = 2000;

interface DropboxEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  id?: string;
  name: string;
  path_lower?: string;
  path_display?: string;
  rev?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
  is_downloadable?: boolean;
}

interface ListPage {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
}

@Injectable()
export class DropboxConnector implements Connector {
  readonly kind = 'dropbox';
  readonly configExample = { path: '/Documents' };
  readonly credentialHint = 'a connected Dropbox account (oauth:<grant id>)';
  readonly oauth = {
    provider: 'dropbox' as const,
    scopes: ['files.metadata.read', 'files.content.read'],
  };

  enabled(): boolean {
    return sourceKindEnabled('dropbox') && sourceOAuthClientEnabled();
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const apiBase = providerEndpoints('dropbox').apiBase;
    const gate: AdmitGate = {
      shape: ctx.connection.shape,
      extensions: admittedExtensions(ctx.connection.shape, cfg.extensions),
      maxBytes: byteCap(cfg),
    };
    const maxFiles = cfg.maxFiles ?? DEFAULT_MAX_FILES;
    const stored = typeof opts.checkpoint?.cursor === 'string' ? opts.checkpoint.cursor : null;
    let page = await firstPage({
      ctx,
      http,
      apiBase,
      path: cfg.path ?? '',
      cursor: opts.full ? null : stored,
    });
    const tally = { emitted: 0, skippedLarge: 0 };
    for (;;) {
      if (ctx.signal.aborted) throw new Error('aborted');
      yield* deltasOf(page.entries, gate, { tally, maxFiles });
      if (!page.has_more || tally.emitted >= maxFiles) break;
      page = await continueFrom(http, apiBase, page.cursor);
    }
    if (tally.skippedLarge > 0)
      ctx.log(`dropbox walk skipped ${tally.skippedLarge} file(s) over maxFileBytes`);
    yield {
      type: 'checkpoint',
      checkpoint: { walkedAt: new Date().toISOString(), files: tally.emitted, cursor: page.cursor },
    };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const ep = providerEndpoints('dropbox');
    const shape = ctx.connection.shape;
    const got = await http.postBytes(`${ep.contentBase ?? ep.apiBase}/2/files/download`, {
      headers: { 'dropbox-api-arg': JSON.stringify({ path: item.externalId }) },
      maxBytes: byteCap(cfg),
    });
    const cls = classifyCloudFile({
      name: item.title ?? item.externalId,
      mediaType: item.mediaType ?? got.mediaType,
      shape,
      extensions: admittedExtensions(shape, cfg.extensions),
    });
    const occurredAt = item.modifiedAt;
    if (shape === 'binary') {
      return {
        shape: 'binary',
        bytes: got.bytes,
        mediaType: cls.mediaType,
        modality: modalityOf(cls.ext),
        occurredAt,
      };
    }
    if (looksBinary(got.bytes))
      throw new Error(`binary content in a text-shaped item: ${item.title ?? item.externalId}`);
    return {
      shape: 'document',
      text: got.bytes.toString('utf8'),
      title: item.title,
      occurredAt,
      kind: 'dropbox_file',
    };
  }
}

async function listFolder(http: CloudHttp, apiBase: string, path: string): Promise<ListPage> {
  return (await http.postJson(`${apiBase}/2/files/list_folder`, {
    path: normalizePath(path),
    recursive: true,
    include_deleted: false,
    include_non_downloadable_files: false,
    limit: PAGE_LIMIT,
  })) as ListPage;
}

async function continueFrom(http: CloudHttp, apiBase: string, cursor: string): Promise<ListPage> {
  return (await http.postJson(`${apiBase}/2/files/list_folder/continue`, { cursor })) as ListPage;
}

/** Dropbox wants '' for the root and a leading slash otherwise. */
export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function isCursorReset(e: unknown): boolean {
  return e instanceof CloudHttpError && e.status === 409 && /reset/.test(e.message);
}

/** The stored cursor continued, else (or when Dropbox reset it) the folder walked afresh. */
async function firstPage(p: {
  ctx: ConnectorCtx;
  http: CloudHttp;
  apiBase: string;
  path: string;
  cursor: string | null;
}): Promise<ListPage> {
  if (p.cursor) {
    try {
      return await continueFrom(p.http, p.apiBase, p.cursor);
    } catch (e) {
      if (!isCursorReset(e)) throw e;
      p.ctx.log('dropbox cursor was reset by the service — walking the folder again');
    }
  }
  return listFolder(p.http, p.apiBase, p.path);
}

/** One page's entries as deltas: files admitted by the gate, deletions as gone, folders skipped. */
function* deltasOf(
  entries: DropboxEntry[],
  gate: AdmitGate,
  run: { tally: { emitted: number; skippedLarge: number }; maxFiles: number },
): Iterable<ItemDelta> {
  const { tally, maxFiles } = run;
  for (const e of entries) {
    if (tally.emitted >= maxFiles) return;
    if (e['.tag'] === 'deleted') {
      // A deleted entry carries no id: the catalogue knows it by path.
      if (e.path_lower) yield { type: 'gone', externalId: e.path_lower };
      continue;
    }
    if (e['.tag'] !== 'file' || !e.path_lower || e.is_downloadable === false) continue;
    const verdict = admitCloudFile({ name: e.name, size: e.size }, gate);
    if (verdict === 'large') tally.skippedLarge++;
    if (verdict !== 'admit') continue;
    tally.emitted++;
    yield { type: 'upsert', item: describe(e) };
  }
}

/** The path is the identity (a deleted entry names only its path), the rev the revision. */
function describe(e: DropboxEntry): ItemDescriptor {
  const path = e.path_lower ?? '';
  return {
    externalId: path,
    title: e.name,
    path: e.path_display ?? path,
    originUri: `dropbox://${path}`,
    mediaType: cloudMediaType(e.name, null),
    ...(e.size !== undefined ? { size: e.size } : {}),
    revision: e.rev
      ? `rev:${e.rev}`
      : e.content_hash
        ? `hash:${e.content_hash}`
        : (e.server_modified ?? 'unknown'),
    ...(e.server_modified ? { modifiedAt: e.server_modified } : {}),
  };
}

function configOf(ctx: ConnectorCtx): DropboxConnectorConfig {
  return ctx.connection.config as DropboxConnectorConfig;
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token) throw new Error('dropbox connector: no connected Dropbox account on this connection');
  return cloudHttp({ token, private: providerEndpoints('dropbox').private, signal: ctx.signal });
}

function byteCap(cfg: DropboxConnectorConfig): number {
  const v = cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return Math.min(Math.max(1, v), HARD_MAX_FILE_BYTES);
}
