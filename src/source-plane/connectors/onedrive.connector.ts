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
 * `onedrive` — OneDrive and SharePoint document libraries (raw-evidence-
 * sources-2026-09.md W4) through Microsoft Graph with the connected
 * account's access token. One drive — the account's own (`/me/drive`),
 * a drive by id, or a SharePoint site's default library (`siteId`) —
 * and one folder in it (`folderPath`, '' = the root), read recursively.
 *
 * Graph's delta query is the change feed: the first call walks the
 * folder and ends with a `@odata.deltaLink`; the next run GETs that
 * link and receives only what changed — files as upserts, `deleted`
 * facets as gone. The link is the checkpoint; one Graph has expired
 * (410) starts a fresh walk in the same run. `quickXorHash` (else the
 * eTag) is the revision, `lastModifiedDateTime` the source's clock.
 * Bytes come from the item's pre-authenticated download URL, fetched
 * WITHOUT the bearer (it must never reach a storage host).
 *
 * Needs SOURCE_OAUTH_CLIENT (the grant) as well as SOURCE_KIND_ONEDRIVE.
 */

export interface OneDriveConnectorConfig {
  /** `/Documents/Team` under the drive root; '' = the root. */
  folderPath?: string | undefined;
  /** A drive by id (a colleague's, a group's) instead of the account's own. */
  driveId?: string | undefined;
  /** A SharePoint site — its default document library. */
  siteId?: string | undefined;
  extensions?: string[] | undefined;
  maxFiles?: number | undefined;
  maxFileBytes?: number | undefined;
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 64 * 1024 * 1024;
const PAGE_TOP = 500;

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  eTag?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  file?: { mimeType?: string; hashes?: { quickXorHash?: string; sha1Hash?: string } };
  folder?: { childCount?: number };
  deleted?: { state?: string };
  parentReference?: { path?: string };
}

interface DeltaPage {
  value?: DriveItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

@Injectable()
export class OneDriveConnector implements Connector {
  readonly kind = 'onedrive';
  readonly configExample = { folderPath: '/Documents' };
  readonly credentialHint = 'a connected Microsoft account (oauth:<grant id>)';
  readonly oauth = {
    provider: 'microsoft' as const,
    scopes: ['Files.Read.All', 'Sites.Read.All'],
  };

  enabled(): boolean {
    return sourceKindEnabled('onedrive') && sourceOAuthClientEnabled();
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const ep = providerEndpoints('microsoft');
    const gate: AdmitGate = {
      shape: ctx.connection.shape,
      extensions: admittedExtensions(ctx.connection.shape, cfg.extensions),
      maxBytes: byteCap(cfg),
    };
    const maxFiles = cfg.maxFiles ?? DEFAULT_MAX_FILES;
    const stored =
      typeof opts.checkpoint?.deltaLink === 'string' ? opts.checkpoint.deltaLink : null;
    const fresh = `${folderResource(ep.apiBase, cfg)}/delta?$top=${PAGE_TOP}`;
    let next: string | undefined = !opts.full && stored ? stored : fresh;
    let deltaLink: string | undefined;
    const tally = { emitted: 0, skippedLarge: 0 };
    while (next) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const page = await deltaPage({
        ctx,
        http,
        url: next,
        fallback: next === stored ? fresh : null,
      });
      yield* deltasOf(page.value ?? [], gate, { tally, maxFiles });
      deltaLink = page['@odata.deltaLink'] ?? deltaLink;
      next = tally.emitted < maxFiles ? page['@odata.nextLink'] : undefined;
    }
    if (tally.skippedLarge > 0)
      ctx.log(`onedrive walk skipped ${tally.skippedLarge} file(s) over maxFileBytes`);
    yield {
      type: 'checkpoint',
      checkpoint: {
        walkedAt: new Date().toISOString(),
        files: tally.emitted,
        ...(deltaLink ? { deltaLink } : {}),
      },
    };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const ep = providerEndpoints('microsoft');
    const shape = ctx.connection.shape;
    const meta = (await http.getJson(
      `${driveResource(ep.apiBase, cfg)}/items/${encodeURIComponent(item.externalId)}?$select=id,name,file,@microsoft.graph.downloadUrl`,
    )) as { '@microsoft.graph.downloadUrl'?: string; file?: { mimeType?: string } };
    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) throw new Error(`no download url for ${item.title ?? item.externalId}`);
    const got = await http.getBytes(downloadUrl, { maxBytes: byteCap(cfg), bearer: false });
    const cls = classifyCloudFile({
      name: item.title ?? '',
      mediaType: item.mediaType ?? meta.file?.mimeType ?? got.mediaType,
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
      kind: 'onedrive_file',
    };
  }
}

/** `/me/drive`, `/drives/{id}` or `/sites/{id}/drive`. */
export function driveResource(apiBase: string, cfg: OneDriveConnectorConfig): string {
  if (cfg.siteId) return `${apiBase}/sites/${encodeURIComponent(cfg.siteId)}/drive`;
  if (cfg.driveId) return `${apiBase}/drives/${encodeURIComponent(cfg.driveId)}`;
  return `${apiBase}/me/drive`;
}

/** The folder as a Graph resource: the root, or `root:/path:` (Graph's colon syntax). */
export function folderResource(apiBase: string, cfg: OneDriveConnectorConfig): string {
  const drive = driveResource(apiBase, cfg);
  const path = (cfg.folderPath ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!path) return `${drive}/root`;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${drive}/root:/${encoded}:`;
}

/** One delta page; a stored link Graph has expired (410) restarts from the fresh one. */
async function deltaPage(p: {
  ctx: ConnectorCtx;
  http: CloudHttp;
  url: string;
  fallback: string | null;
}): Promise<DeltaPage> {
  try {
    return (await p.http.getJson(p.url)) as DeltaPage;
  } catch (e) {
    if (p.fallback && e instanceof CloudHttpError && e.status === 410) {
      p.ctx.log('onedrive delta link expired — walking the folder again');
      return (await p.http.getJson(p.fallback)) as DeltaPage;
    }
    throw e;
  }
}

/** One page's items as deltas: files admitted by the gate, deleted facets as gone, folders skipped. */
function* deltasOf(
  items: DriveItem[],
  gate: AdmitGate,
  run: { tally: { emitted: number; skippedLarge: number }; maxFiles: number },
): Iterable<ItemDelta> {
  const { tally, maxFiles } = run;
  for (const item of items) {
    if (tally.emitted >= maxFiles) return;
    if (item.deleted) {
      yield { type: 'gone', externalId: item.id };
      continue;
    }
    if (!item.file) continue;
    const verdict = admitCloudFile(
      { name: item.name, mediaType: item.file.mimeType, size: item.size },
      gate,
    );
    if (verdict === 'large') tally.skippedLarge++;
    if (verdict !== 'admit') continue;
    tally.emitted++;
    yield { type: 'upsert', item: describe(item) };
  }
}

function describe(item: DriveItem): ItemDescriptor {
  const hash = item.file?.hashes?.quickXorHash ?? item.file?.hashes?.sha1Hash;
  const parentPath = item.parentReference?.path?.replace(/^.*?\/root:?/, '') ?? '';
  return {
    externalId: item.id,
    title: item.name,
    path: `${parentPath}/${item.name}`.replace(/\/+/g, '/'),
    ...(item.webUrl ? { originUri: item.webUrl } : {}),
    mediaType: cloudMediaType(item.name, item.file?.mimeType),
    ...(item.size !== undefined ? { size: item.size } : {}),
    revision: hash
      ? `xor:${hash}`
      : item.eTag
        ? `etag:${item.eTag}`
        : (item.lastModifiedDateTime ?? 'unknown'),
    ...(item.lastModifiedDateTime ? { modifiedAt: item.lastModifiedDateTime } : {}),
  };
}

function configOf(ctx: ConnectorCtx): OneDriveConnectorConfig {
  return ctx.connection.config as OneDriveConnectorConfig;
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token)
    throw new Error('onedrive connector: no connected Microsoft account on this connection');
  return cloudHttp({ token, private: providerEndpoints('microsoft').private, signal: ctx.signal });
}

function byteCap(cfg: OneDriveConnectorConfig): number {
  const v = cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return Math.min(Math.max(1, v), HARD_MAX_FILE_BYTES);
}
