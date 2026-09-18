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
import { cloudHttp, type CloudHttp } from './cloud-http';
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
 * `gdrive` — Google Drive (raw-evidence-sources-2026-09.md W4) through
 * the Drive v3 REST API with the connected account's access token
 * (CredentialProvider hands it over in `credential`; the connector
 * never sees a refresh token). A connection reads one folder (`root` =
 * My Drive) and everything beneath it, or — `includeShared` — what is
 * shared with the account as well.
 *
 * Full run: a breadth-first `files.list` per folder, then
 * `changes.getStartPageToken` becomes the checkpoint. Incremental run:
 * `changes.list` from that token — a change under a known folder is an
 * upsert, a removal / trashing / move out of scope is gone, a new
 * subfolder joins the set the checkpoint carries (bounded; past the
 * cap the next run walks fully). Google-native documents have no bytes:
 * a document-shaped connection exports them as text (Docs → text/plain,
 * Sheets → CSV, Slides → text), a binary-shaped one as OOXML for the
 * evidence plane's processors. Every other file is judged by the fs /
 * s3 media table on its name and reported type.
 *
 * Needs SOURCE_OAUTH_CLIENT (the grant) as well as SOURCE_KIND_GDRIVE.
 */

export interface GDriveConnectorConfig {
  /** A folder id, or `root` (My Drive). Default root. */
  folderId?: string | undefined;
  /** A shared drive to read instead of My Drive. */
  driveId?: string | undefined;
  /** Also what is shared with the account (files and folders). */
  includeShared?: boolean | undefined;
  extensions?: string[] | undefined;
  maxFiles?: number | undefined;
  maxFileBytes?: number | undefined;
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Folders the incremental checkpoint may carry; beyond it the next run walks fully. */
const FOLDER_SET_CAP = 5000;
const PAGE_SIZE = 1000;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS =
  'id,name,mimeType,modifiedTime,size,md5Checksum,version,parents,trashed,webViewLink';

/** Google-native types and the export each shape takes. */
const GOOGLE_EXPORTS: Record<string, { text: string; binary: string; ext: string }> = {
  'application/vnd.google-apps.document': {
    text: 'text/plain',
    binary: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: 'docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    text: 'text/csv',
    binary: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  },
  'application/vnd.google-apps.presentation': {
    text: 'text/plain',
    binary: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: 'pptx',
  },
};

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
  version?: string;
  parents?: string[];
  trashed?: boolean;
  webViewLink?: string;
}

@Injectable()
export class GDriveConnector implements Connector {
  readonly kind = 'gdrive';
  readonly configExample = { folderId: 'root', includeShared: false };
  readonly credentialHint = 'a connected Google account (oauth:<grant id>)';
  readonly oauth = {
    provider: 'google' as const,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  };

  enabled(): boolean {
    return sourceKindEnabled('gdrive') && sourceOAuthClientEnabled();
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const gate: AdmitGate = {
      shape: ctx.connection.shape,
      extensions: admittedExtensions(ctx.connection.shape, cfg.extensions),
      maxBytes: byteCap(cfg),
    };
    const maxFiles = cfg.maxFiles ?? DEFAULT_MAX_FILES;
    const known = folderSetOf(opts.checkpoint);
    const pageToken =
      typeof opts.checkpoint?.pageToken === 'string' ? opts.checkpoint.pageToken : null;
    if (opts.full || !pageToken || !known) {
      yield* this.walk({ ctx, cfg, http, gate, maxFiles });
      return;
    }
    yield* this.changes({ ctx, cfg, http, gate, known, pageToken });
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const ep = providerEndpoints('google');
    const shape = ctx.connection.shape;
    const native = GOOGLE_EXPORTS[item.mediaType ?? ''];
    let bytes: Buffer;
    let mediaType: string;
    let ext: string;
    if (native) {
      mediaType = shape === 'binary' ? native.binary : native.text;
      ext = shape === 'binary' ? native.ext : native.text === 'text/csv' ? 'csv' : 'txt';
      const url = `${ep.apiBase}/drive/v3/files/${encodeURIComponent(item.externalId)}/export?mimeType=${encodeURIComponent(mediaType)}`;
      bytes = (await http.getBytes(url, { maxBytes: byteCap(cfg) })).bytes;
    } else {
      const url = `${ep.apiBase}/drive/v3/files/${encodeURIComponent(item.externalId)}?alt=media&supportsAllDrives=true`;
      const got = await http.getBytes(url, { maxBytes: byteCap(cfg) });
      bytes = got.bytes;
      const cls = classifyCloudFile({
        name: item.title ?? '',
        mediaType: item.mediaType ?? got.mediaType,
        shape,
        extensions: admittedExtensions(shape, cfg.extensions),
      });
      mediaType = cls.mediaType;
      ext = cls.ext;
    }
    const occurredAt = item.modifiedAt;
    if (shape === 'binary') {
      return { shape: 'binary', bytes, mediaType, modality: modalityOf(ext), occurredAt };
    }
    if (looksBinary(bytes))
      throw new Error(`binary content in a text-shaped item: ${item.title ?? item.externalId}`);
    return {
      shape: 'document',
      text: bytes.toString('utf8'),
      title: item.title,
      occurredAt,
      kind: 'drive_file',
    };
  }

  private async *walk(p: {
    ctx: ConnectorCtx;
    cfg: GDriveConnectorConfig;
    http: CloudHttp;
    gate: AdmitGate;
    maxFiles: number;
  }): AsyncIterable<ItemDelta> {
    const ep = providerEndpoints('google');
    const start = p.cfg.folderId?.trim() || 'root';
    const queue: string[] = [start];
    const folders = new Set<string>([start]);
    const tally = { emitted: 0, skippedLarge: 0 };
    const queries = (folderId: string): string[] => [
      `'${folderId}' in parents and trashed = false`,
      ...(folderId === start && p.cfg.includeShared
        ? ['sharedWithMe = true and trashed = false']
        : []),
    ];
    while (queue.length > 0 && tally.emitted < p.maxFiles) {
      for (const q of queries(queue.shift()!)) {
        for await (const f of listFiles({ ctx: p.ctx, cfg: p.cfg, http: p.http, ep, q })) {
          if (f.mimeType === FOLDER_MIME) {
            if (!f.trashed && !folders.has(f.id) && folders.size < FOLDER_SET_CAP) {
              folders.add(f.id);
              queue.push(f.id);
            }
            continue;
          }
          const delta = fileDelta(f, p.gate, tally);
          if (delta) yield delta;
          if (tally.emitted >= p.maxFiles) break;
        }
      }
    }
    if (tally.skippedLarge > 0)
      p.ctx.log(`gdrive walk skipped ${tally.skippedLarge} file(s) over maxFileBytes`);
    const tokenUrl = new URL(`${ep.apiBase}/drive/v3/changes/startPageToken`);
    tokenUrl.searchParams.set('supportsAllDrives', 'true');
    if (p.cfg.driveId) tokenUrl.searchParams.set('driveId', p.cfg.driveId);
    const startToken = (await p.http.getJson(tokenUrl.toString())) as { startPageToken?: string };
    yield {
      type: 'checkpoint',
      checkpoint: {
        walkedAt: new Date().toISOString(),
        files: tally.emitted,
        ...(startToken.startPageToken && folders.size < FOLDER_SET_CAP
          ? { pageToken: startToken.startPageToken, folders: [...folders] }
          : {}),
      },
    };
  }

  private async *changes(p: {
    ctx: ConnectorCtx;
    cfg: GDriveConnectorConfig;
    http: CloudHttp;
    gate: AdmitGate;
    known: Set<string>;
    pageToken: string;
  }): AsyncIterable<ItemDelta> {
    const ep = providerEndpoints('google');
    let token: string | undefined = p.pageToken;
    let newStart: string | undefined;
    const tally = { emitted: 0, skippedLarge: 0, gone: 0 };
    while (token) {
      if (p.ctx.signal.aborted) throw new Error('aborted');
      const url = new URL(`${ep.apiBase}/drive/v3/changes`);
      url.searchParams.set('pageToken', token);
      url.searchParams.set('pageSize', String(PAGE_SIZE));
      url.searchParams.set('includeRemoved', 'true');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      url.searchParams.set(
        'fields',
        `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
      );
      if (p.cfg.driveId) url.searchParams.set('driveId', p.cfg.driveId);
      const page = (await p.http.getJson(url.toString())) as {
        changes?: Array<{ fileId: string; removed?: boolean; file?: DriveFile }>;
        nextPageToken?: string;
        newStartPageToken?: string;
      };
      for (const c of page.changes ?? []) {
        const delta = changeDelta(c, { cfg: p.cfg, known: p.known, gate: p.gate, tally });
        if (delta) yield delta;
      }
      newStart = page.newStartPageToken ?? newStart;
      token = page.nextPageToken;
    }
    p.ctx.log(`gdrive changes: ${tally.emitted} upsert(s), ${tally.gone} gone`);
    yield {
      type: 'checkpoint',
      checkpoint: {
        walkedAt: new Date().toISOString(),
        ...(newStart && p.known.size < FOLDER_SET_CAP
          ? { pageToken: newStart, folders: [...p.known] }
          : {}),
      },
    };
  }
}

/**
 * One change as a delta: a removal / trashing / move out of scope is
 * gone, a subfolder joining the scope is remembered, a file in scope
 * that the gate admits is an upsert. Null = nothing to say.
 */
function changeDelta(
  c: { fileId: string; removed?: boolean; file?: DriveFile },
  s: {
    cfg: GDriveConnectorConfig;
    known: Set<string>;
    gate: AdmitGate;
    tally: { emitted: number; skippedLarge: number; gone: number };
  },
): ItemDelta | null {
  const f = c.file;
  if (c.removed || !f || f.trashed) {
    s.tally.gone++;
    return { type: 'gone', externalId: c.fileId };
  }
  const inScope = s.cfg.includeShared === true || (f.parents ?? []).some((id) => s.known.has(id));
  if (f.mimeType === FOLDER_MIME) {
    if (inScope && s.known.size < FOLDER_SET_CAP) s.known.add(f.id);
    return null;
  }
  if (!inScope) {
    s.tally.gone++;
    return { type: 'gone', externalId: f.id };
  }
  return fileDelta(f, s.gate, s.tally);
}

/** A live, non-folder file through the gate: an upsert, or nothing. */
function fileDelta(
  f: DriveFile,
  gate: AdmitGate,
  tally: { emitted: number; skippedLarge: number },
): ItemDelta | null {
  if (f.trashed) return null;
  const verdict = admitFile(f, gate);
  if (verdict === 'large') tally.skippedLarge++;
  if (verdict !== 'admit') return null;
  tally.emitted++;
  return { type: 'upsert', item: describe(f) };
}

/** Every file a `files.list` query returns, page after page. */
async function* listFiles(p: {
  ctx: ConnectorCtx;
  cfg: GDriveConnectorConfig;
  http: CloudHttp;
  ep: { apiBase: string };
  q: string;
}): AsyncIterable<DriveFile> {
  let token: string | undefined;
  do {
    if (p.ctx.signal.aborted) throw new Error('aborted');
    const url = new URL(`${p.ep.apiBase}/drive/v3/files`);
    url.searchParams.set('q', p.q);
    url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (p.cfg.driveId) {
      url.searchParams.set('corpora', 'drive');
      url.searchParams.set('driveId', p.cfg.driveId);
    }
    if (token) url.searchParams.set('pageToken', token);
    const page = (await p.http.getJson(url.toString())) as {
      files?: DriveFile[];
      nextPageToken?: string;
    };
    for (const f of page.files ?? []) yield f;
    token = page.nextPageToken;
  } while (token);
}

function admitFile(f: DriveFile, gate: AdmitGate): 'admit' | 'skip' | 'large' {
  if (GOOGLE_EXPORTS[f.mimeType]) return 'admit';
  if (f.mimeType.startsWith('application/vnd.google-apps.')) return 'skip';
  return admitCloudFile({ name: f.name, mediaType: f.mimeType, size: Number(f.size ?? 0) }, gate);
}

function describe(f: DriveFile): ItemDescriptor {
  const native = GOOGLE_EXPORTS[f.mimeType];
  const revision = f.md5Checksum
    ? `md5:${f.md5Checksum}`
    : f.version
      ? `v:${f.version}`
      : (f.modifiedTime ?? 'unknown');
  return {
    externalId: f.id,
    title: f.name,
    path: f.name,
    originUri: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
    mediaType: native ? f.mimeType : cloudMediaType(f.name, f.mimeType),
    ...(f.size !== undefined ? { size: Number(f.size) } : {}),
    revision,
    ...(f.modifiedTime ? { modifiedAt: f.modifiedTime } : {}),
  };
}

function folderSetOf(checkpoint: Record<string, unknown> | null): Set<string> | null {
  const raw = checkpoint?.folders;
  if (!Array.isArray(raw)) return null;
  return new Set(raw.map(String));
}

function configOf(ctx: ConnectorCtx): GDriveConnectorConfig {
  return ctx.connection.config as GDriveConnectorConfig;
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token) throw new Error('gdrive connector: no connected Google account on this connection');
  return cloudHttp({ token, private: providerEndpoints('google').private, signal: ctx.signal });
}

function byteCap(cfg: GDriveConnectorConfig): number {
  const v = cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return Math.min(Math.max(1, v), HARD_MAX_FILE_BYTES);
}
