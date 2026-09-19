import { Injectable } from '@nestjs/common';
import { htmlToText } from '../../common/html-text';
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

/**
 * `confluence` — the pages (and, when asked, blog posts) of a
 * Confluence Cloud site (raw-evidence-sources-2026-09.md W4, "a wiki"),
 * read as documents with the connected Atlassian account's token
 * through the v2 REST API at `api.atlassian.com/ex/confluence/<cloud
 * id>`. The site is one of the account's accessible resources
 * (`config.site` names it by host or name when there are several);
 * `spaceKeys` narrows the walk to spaces. The listing comes newest
 * modification first — an incremental run stops at the first page not
 * modified after the checkpoint, a full run walks everything and what
 * is no longer listed (deleted, archived, moved out of scope) the brain
 * marks gone. The version number is the revision; the storage-format
 * body (XHTML) is reduced to text the way every HTML is.
 *
 * Needs SOURCE_OAUTH_CLIENT (the grant) as well as SOURCE_KIND_CONFLUENCE.
 */

export interface ConfluenceConnectorConfig {
  /** `acme.atlassian.net`, its URL, or the site's name — when the account reaches several. */
  site?: string | undefined;
  spaceKeys?: string[] | undefined;
  includeBlogposts?: boolean | undefined;
  maxPages?: number | undefined;
}

const DEFAULT_MAX_PAGES = 5000;
const PAGE_LIMIT = 250;
const CONTENT_MAX_BYTES = 8 * 1024 * 1024;

interface Resource {
  id: string;
  name?: string;
  url?: string;
  scopes?: string[];
}

interface ContentSummary {
  id: string;
  status?: string;
  title?: string;
  spaceId?: string;
  version?: { number?: number; createdAt?: string };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

interface Listing<T> {
  results: T[];
  _links?: { next?: string; base?: string };
}

@Injectable()
export class ConfluenceConnector implements Connector {
  readonly kind = 'confluence';
  readonly configExample = { spaceKeys: ['ENG'] };
  readonly credentialHint = 'a connected Atlassian account (oauth:<grant id>)';
  readonly oauth = {
    provider: 'atlassian' as const,
    scopes: ['read:page:confluence', 'read:space:confluence', 'read:blogpost:confluence'],
  };

  enabled(): boolean {
    return sourceKindEnabled('confluence') && sourceOAuthClientEnabled();
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const site = await siteOf(http, cfg, ctx);
    const spaceIds = await spaceIdsOf({ http, site, keys: cfg.spaceKeys ?? [], ctx });
    const maxPages = cfg.maxPages ?? DEFAULT_MAX_PAGES;
    const since = typeof opts.checkpoint?.since === 'string' ? opts.checkpoint.since : null;
    const incremental = !opts.full && since !== null;
    let newest: string | null = since;
    let count = 0;
    let stopped = false;
    const kinds: Array<'pages' | 'blogposts'> = cfg.includeBlogposts
      ? ['pages', 'blogposts']
      : ['pages'];
    for (const kind of kinds) {
      for await (const c of listing({ http, site, kind, spaceIds, ctx })) {
        if (c.status && c.status !== 'current') continue;
        const modified = c.version?.createdAt ?? '';
        if (incremental && modified && modified <= since!) {
          stopped = true;
          break;
        }
        if (!newest || modified > newest) newest = modified;
        count++;
        yield { type: 'upsert', item: describe(kind, c, site) };
        if (count >= maxPages) {
          ctx.log(`confluence walk stopped at maxPages=${maxPages}`);
          break;
        }
      }
      if (count >= maxPages) break;
    }
    ctx.log(`confluence: ${count} item(s)${stopped ? ' since the checkpoint' : ''}`);
    yield {
      type: 'checkpoint',
      checkpoint: {
        walkedAt: new Date().toISOString(),
        pages: count,
        cloudId: site.id,
        ...(newest ? { since: newest } : {}),
      },
    };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const site = await siteOf(http, cfg, ctx);
    const [kind, id] = item.externalId.startsWith('blogpost:')
      ? ['blogposts', item.externalId.slice('blogpost:'.length)]
      : ['pages', item.externalId];
    const c = (await http.getJson(
      `${site.api}/${kind}/${encodeURIComponent(id!)}?body-format=storage`,
    )) as ContentSummary;
    const { body } = htmlToText(storageToHtml(c.body?.storage?.value ?? ''));
    const title = c.title ?? item.title;
    return {
      shape: 'document',
      text: [title ? `# ${title}` : '', body]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, CONTENT_MAX_BYTES),
      title,
      occurredAt: c.version?.createdAt ?? item.modifiedAt,
      kind: kind === 'blogposts' ? 'confluence_blogpost' : 'confluence_page',
    };
  }
}

interface Site {
  id: string;
  /** `https://acme.atlassian.net/wiki` — where page links point. */
  webBase: string;
  /** `…/ex/confluence/<cloud id>/wiki/api/v2` */
  api: string;
}

/** The account's Confluence site: the one named, else the only one, else refuse by listing them. */
async function siteOf(
  http: CloudHttp,
  cfg: ConfluenceConnectorConfig,
  ctx: ConnectorCtx,
): Promise<Site> {
  const ep = providerEndpoints('atlassian');
  const resources = (await http.getJson(
    `${ep.apiBase}/oauth/token/accessible-resources`,
  )) as Resource[];
  const wanted = cfg.site?.trim().toLowerCase();
  const matches = (r: Resource): boolean => {
    if (!wanted) return true;
    const host = r.url ? new URL(r.url).host.toLowerCase() : '';
    return (
      host === wanted.replace(/^https?:\/\//, '').replace(/\/.*$/, '') ||
      (r.name ?? '').toLowerCase() === wanted
    );
  };
  const candidates = resources.filter(matches);
  if (candidates.length === 0) {
    throw new Error(
      `confluence: ${wanted ? `no site "${cfg.site}"` : 'no site'} among the account's ${resources.length} — ${resources.map((r) => r.url ?? r.name ?? r.id).join(', ') || 'none'}`,
    );
  }
  if (candidates.length > 1 && !wanted) {
    throw new Error(
      `confluence: the account reaches ${candidates.length} sites — name one in config.site: ${candidates.map((r) => r.url ?? r.name).join(', ')}`,
    );
  }
  const r = candidates[0]!;
  ctx.log(`confluence: site ${r.url ?? r.name ?? r.id}`);
  return {
    id: r.id,
    webBase: `${(r.url ?? '').replace(/\/$/, '')}/wiki`,
    api: `${ep.apiBase}/ex/confluence/${encodeURIComponent(r.id)}/wiki/api/v2`,
  };
}

/** The ids of the named spaces (all when none named); an unknown key is a named failure. */
async function spaceIdsOf(p: {
  http: CloudHttp;
  site: Site;
  keys: string[];
  ctx: ConnectorCtx;
}): Promise<string[]> {
  const { http, site, keys, ctx } = p;
  if (keys.length === 0) return [];
  const url = new URL(`${site.api}/spaces`);
  url.searchParams.set('keys', keys.join(','));
  url.searchParams.set('limit', String(PAGE_LIMIT));
  const got = (await http.getJson(url.toString())) as Listing<{
    id: string;
    key: string;
    name?: string;
  }>;
  const found = new Map(got.results.map((s) => [s.key.toUpperCase(), s]));
  const missing = keys.filter((k) => !found.has(k.toUpperCase()));
  if (missing.length > 0)
    throw new Error(`confluence: no space with key ${missing.join(', ')} on this site`);
  ctx.log(
    `confluence: spaces ${[...found.values()].map((s) => `${s.key} (${s.name ?? s.id})`).join(', ')}`,
  );
  return [...found.values()].map((s) => s.id);
}

/** Pages or blog posts, newest modification first, following `_links.next`. */
async function* listing(p: {
  http: CloudHttp;
  site: Site;
  kind: 'pages' | 'blogposts';
  spaceIds: string[];
  ctx: ConnectorCtx;
}): AsyncIterable<ContentSummary> {
  const { http, site, kind, spaceIds, ctx } = p;
  const first = new URL(`${site.api}/${kind}`);
  first.searchParams.set('limit', String(PAGE_LIMIT));
  first.searchParams.set('sort', '-modified-date');
  first.searchParams.set('status', 'current');
  if (spaceIds.length > 0) first.searchParams.set('space-id', spaceIds.join(','));
  let next: string | null = first.toString();
  while (next) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const page = (await http.getJson(next)) as Listing<ContentSummary>;
    for (const c of page.results) yield c;
    next = page._links?.next ? nextUrl(site, page._links.next) : null;
  }
}

/** `_links.next` is site-relative (`/wiki/api/v2/pages?cursor=…`): rooted at the site's API origin. */
export function nextUrl(site: Site, next: string): string {
  if (/^https?:\/\//i.test(next)) return next;
  const origin = site.api.slice(0, site.api.indexOf('/wiki/api/v2'));
  return `${origin}${next.startsWith('/') ? '' : '/'}${next}`;
}

/**
 * Storage format is XHTML with Confluence's own elements: code macros
 * carry their body in CDATA, page links name their target in an
 * attribute. Enough of it is turned into plain HTML for the shared
 * reducer to keep the text.
 */
export function storageToHtml(storage: string): string {
  return storage
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => escapeHtml(inner))
    .replace(/<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/?>/g, '$1')
    .replace(
      /<ac:structured-macro[^>]*ac:name="(code|noformat)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g,
      '<pre>$2</pre>',
    )
    .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/g, '')
    .replace(/<ac:(plain-text-body|rich-text-body)>/g, '<div>')
    .replace(/<\/ac:(plain-text-body|rich-text-body)>/g, '</div>')
    .replace(/<ac:task-status>complete<\/ac:task-status>/g, '[x] ')
    .replace(/<ac:task-status>incomplete<\/ac:task-status>/g, '[ ] ')
    .replace(/<\/ac:task>/g, '<br>')
    .replace(/<ac:emoticon[^>]*\/?>/g, '');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function describe(kind: 'pages' | 'blogposts', c: ContentSummary, site: Site): ItemDescriptor {
  const externalId = kind === 'blogposts' ? `blogpost:${c.id}` : c.id;
  const modified = c.version?.createdAt;
  return {
    externalId,
    ...(c.title ? { title: c.title } : {}),
    originUri: c._links?.webui
      ? `${site.webBase}${c._links.webui}`
      : `confluence://${site.id}/${externalId}`,
    mediaType: 'text/html',
    revision: c.version?.number !== undefined ? `v:${c.version.number}` : (modified ?? 'unknown'),
    ...(modified ? { modifiedAt: modified } : {}),
  };
}

function configOf(ctx: ConnectorCtx): ConfluenceConnectorConfig {
  return ctx.connection.config as ConfluenceConnectorConfig;
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token)
    throw new Error('confluence connector: no connected Atlassian account on this connection');
  return cloudHttp({ token, private: providerEndpoints('atlassian').private, signal: ctx.signal });
}
