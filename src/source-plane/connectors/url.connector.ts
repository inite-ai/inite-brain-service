import { Injectable } from '@nestjs/common';
import { sourceKindEnabled } from '../../common/source-plane-flags';
import type {
  Connector,
  ConnectorCtx,
  EnumerateOptions,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
} from '../connector';
import { RobotsCache } from './robots';
import { safeFetch } from './safe-fetch';

/**
 * `url` — web pages and sitemaps (raw-evidence-sources-2026-09.md W1):
 * a public site, a self-hosted wiki, a docs portal. Items are the URLs
 * a sitemap lists (sitemap indexes are followed one level) plus the
 * URLs named outright; every run re-walks the sitemaps
 * (`walksEverything`), so a page that left the sitemap is gone.
 *
 * Revision, in order of trust: the sitemap's `<lastmod>`, else the
 * server's ETag / Last-Modified from a HEAD (one per URL per run,
 * bounded by maxPages), else a time bucket (`refetchHours`) so a page
 * with no hints is still re-read on a cadence instead of never.
 *
 * Content: HTML is reduced to text here (scripts, styles and tags
 * stripped, entities decoded, whitespace collapsed; the richer office /
 * html adapters are W1c); text/* and JSON pass through; a PDF is handed
 * to the binary shape when the connection declares it, refused otherwise.
 *
 * Fences: every request goes through safeFetch (egress guard on every
 * hop, manual redirects, size and time caps); robots.txt `Disallow`
 * rules for `*` and our agent are honoured per host; `sameHostOnly`
 * (default) keeps a sitemap from enumerating another host; private
 * hosts need the double opt-in (SOURCE_EGRESS_ALLOW_PRIVATE +
 * `allowPrivate`); a credential rides as `Authorization: Bearer` (or
 * `Basic` for `authScheme: 'basic'`, credential `user:pass`).
 */

export interface UrlConnectorConfig {
  urls?: string[] | undefined;
  sitemaps?: string[] | undefined;
  maxPages?: number | undefined;
  sameHostOnly?: boolean | undefined;
  allowPrivate?: boolean | undefined;
  /** 'bearer' (default when a credential is set) | 'basic' | 'header:<Name>' */
  authScheme?: string | undefined;
  refetchHours?: number | undefined;
  maxBytes?: number | undefined;
  /** Politeness delay between requests, ms. */
  delayMs?: number | undefined;
  ignoreRobots?: boolean | undefined;
}

const DEFAULT_MAX_PAGES = 500;
const DEFAULT_REFETCH_HOURS = 24;

interface Seed {
  url: string;
  lastmod?: string | undefined;
}

@Injectable()
export class UrlConnector implements Connector {
  readonly kind = 'url';
  readonly walksEverything = true;

  enabled(): boolean {
    return sourceKindEnabled('url');
  }

  async *enumerate(ctx: ConnectorCtx, _opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const fetchOpts = {
      allowPrivate: cfg.allowPrivate,
      signal: ctx.signal,
      headers: authHeaders(ctx, cfg),
    };
    const maxPages = cfg.maxPages ?? DEFAULT_MAX_PAGES;
    const seeds = await collectSeeds(cfg, fetchOpts, maxPages);
    const robots = new RobotsCache(fetchOpts, cfg.ignoreRobots === true);
    let emitted = 0;
    for (const seed of seeds.values()) {
      if (ctx.signal.aborted) throw new Error('aborted');
      if (emitted >= maxPages) break;
      if (!(await robots.allows(seed.url))) continue;
      const revision = seed.lastmod ?? (await serverRevision(seed.url, fetchOpts, cfg));
      emitted++;
      yield {
        type: 'upsert',
        item: {
          externalId: seed.url,
          originUri: seed.url,
          path: new URL(seed.url).pathname,
          revision,
          ...(seed.lastmod ? { modifiedAt: isoOrUndefined(seed.lastmod) } : {}),
        },
      };
      if (cfg.delayMs) await sleep(cfg.delayMs, ctx.signal);
    }
    yield {
      type: 'checkpoint',
      checkpoint: { walkedAt: new Date().toISOString(), pages: emitted },
    };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const res = await safeFetch(item.externalId, {
      allowPrivate: cfg.allowPrivate,
      signal: ctx.signal,
      headers: authHeaders(ctx, cfg),
      maxBytes: cfg.maxBytes,
    });
    if (res.status < 200 || res.status >= 300)
      throw new Error(`HTTP ${res.status} from ${item.externalId}`);
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const lastModified = res.headers.get('last-modified');
    const occurredAt = isoOrUndefined(lastModified ?? undefined) ?? item.modifiedAt;
    if (contentType.includes('application/pdf')) {
      if (ctx.connection.shape !== 'binary') {
        throw new Error(`PDF at ${item.externalId} needs a binary-shaped source entry`);
      }
      return {
        shape: 'binary',
        bytes: res.body,
        mediaType: 'application/pdf',
        modality: 'document',
        occurredAt,
      };
    }
    const text = res.body.toString('utf8');
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      const { title, body } = htmlToText(text);
      return {
        shape: 'document',
        text: body,
        title: title ?? item.title,
        occurredAt,
        kind: 'web_page',
      };
    }
    if (
      contentType.startsWith('text/') ||
      contentType.includes('json') ||
      contentType.includes('xml')
    ) {
      return { shape: 'document', text, title: item.title, occurredAt, kind: 'web_page' };
    }
    throw new Error(`unsupported content-type "${contentType}" at ${item.externalId}`);
  }
}

type FetchOpts = {
  allowPrivate: boolean | undefined;
  signal: AbortSignal;
  headers: Record<string, string>;
};

/** The URLs named outright plus every sitemap's, deduped, same-host by default. */
async function collectSeeds(
  cfg: UrlConnectorConfig,
  opts: FetchOpts,
  maxPages: number,
): Promise<Map<string, Seed>> {
  const seeds = new Map<string, Seed>();
  for (const u of cfg.urls ?? []) seeds.set(normalize(u), { url: normalize(u) });
  const hosts = new Set<string>([...seeds.keys()].map((u) => new URL(u).host));
  for (const sitemap of cfg.sitemaps ?? []) {
    hosts.add(new URL(sitemap).host);
    for (const seed of await readSitemap(sitemap, opts, 0)) {
      if (seeds.size >= maxPages) break;
      if (cfg.sameHostOnly !== false && !hosts.has(new URL(seed.url).host)) continue;
      seeds.set(seed.url, seed);
    }
  }
  return seeds;
}

function configOf(ctx: ConnectorCtx): UrlConnectorConfig {
  const cfg = ctx.connection.config as UrlConnectorConfig;
  const urls = (cfg.urls ?? []).length + (cfg.sitemaps ?? []).length;
  if (urls === 0) throw new Error('url connector: config.urls or config.sitemaps is required');
  for (const u of [...(cfg.urls ?? []), ...(cfg.sitemaps ?? [])]) new URL(u); // throws on garbage
  return cfg;
}

function authHeaders(ctx: ConnectorCtx, cfg: UrlConnectorConfig): Record<string, string> {
  const credential = ctx.connection.credential;
  if (!credential) return {};
  const scheme = cfg.authScheme ?? 'bearer';
  if (scheme === 'basic')
    return { authorization: `Basic ${Buffer.from(credential).toString('base64')}` };
  if (scheme.startsWith('header:')) return { [scheme.slice('header:'.length)]: credential };
  return { authorization: `Bearer ${credential}` };
}

function normalize(u: string): string {
  const url = new URL(u);
  url.hash = '';
  return url.toString();
}

/** `<loc>` entries of a sitemap or (one level of) a sitemap index. */
async function readSitemap(url: string, opts: FetchOpts, depth: number): Promise<Seed[]> {
  const res = await safeFetch(url, opts);
  if (res.status < 200 || res.status >= 300)
    throw new Error(`HTTP ${res.status} from sitemap ${url}`);
  const xml = res.body.toString('utf8');
  const out: Seed[] = [];
  if (/<sitemapindex[\s>]/i.test(xml)) {
    if (depth >= 1) return out;
    for (const child of locs(xml)) {
      try {
        out.push(...(await readSitemap(child.loc, opts, depth + 1)));
      } catch {
        // one unreadable child sitemap must not sink the walk
      }
    }
    return out;
  }
  for (const { loc, lastmod } of locs(xml)) {
    try {
      out.push({ url: normalize(loc), ...(lastmod ? { lastmod } : {}) });
    } catch {
      // a malformed <loc> is skipped
    }
  }
  return out;
}

/** Sitemaps are simple enough for a bounded regex: each <url>/<sitemap> block's loc + lastmod. */
export function locs(xml: string): Array<{ loc: string; lastmod?: string | undefined }> {
  const out: Array<{ loc: string; lastmod?: string | undefined }> = [];
  const block = /<(?:url|sitemap)\b[^>]*>([\s\S]*?)<\/(?:url|sitemap)>/gi;
  let m: RegExpExecArray | null;
  while ((m = block.exec(xml)) !== null) {
    const inner = m[1] ?? '';
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(inner)?.[1];
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i.exec(inner)?.[1];
    out.push({ loc: decodeEntities(loc), ...(lastmod ? { lastmod } : {}) });
  }
  return out;
}

async function serverRevision(
  url: string,
  opts: FetchOpts,
  cfg: UrlConnectorConfig,
): Promise<string> {
  try {
    const head = await safeFetch(url, { ...opts, method: 'HEAD', maxBytes: 1 });
    const etag = head.headers.get('etag');
    if (etag) return `etag:${etag.replace(/^W\//, '').replace(/"/g, '')}`;
    const lm = head.headers.get('last-modified');
    if (lm) {
      const iso = isoOrUndefined(lm);
      if (iso) return `lm:${iso}`;
    }
  } catch {
    // HEAD unsupported or refused — fall through to the time bucket
  }
  const hours = cfg.refetchHours ?? DEFAULT_REFETCH_HOURS;
  return `t:${Math.floor(Date.now() / (hours * 3_600_000))}`;
}

/** A conservative HTML → text reduction; the html adapter (W1c) is the richer path. */
export function htmlToText(html: string): { title: string | undefined; body: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let s = html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<title[\s\S]*?<\/title>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article|header|footer|blockquote|pre)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : undefined, body: s };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

function isoOrUndefined(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
