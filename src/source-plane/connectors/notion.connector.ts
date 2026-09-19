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
import { NOTION_VERSION, providerEndpoints } from '../oauth/oauth-providers';
import { CloudHttpError, cloudHttp, type CloudHttp } from './cloud-http';
import { blockText, propertiesText, titleOf, type NotionBlock } from './notion-text';

/**
 * `notion` — the pages a Notion integration was given access to
 * (raw-evidence-sources-2026-09.md W4, "a wiki"), read as documents
 * with the connected account's token. `POST /v1/search` is the
 * catalogue (every page and database row the integration may see,
 * newest edit first; `last_edited_time` is the revision), the page's
 * block tree — children fetched to a bounded depth — its text, its
 * properties (a database row's columns) the lines above it. An
 * incremental run stops at the first page edited no later than the
 * checkpoint; a full run walks everything, and what search no longer
 * lists (archived, trashed, access withdrawn) the brain marks gone.
 * `rootPageIds` narrows the walk to those pages' subtrees (child pages
 * followed instead of search).
 *
 * Needs SOURCE_OAUTH_CLIENT (the grant) as well as SOURCE_KIND_NOTION.
 */

export interface NotionConnectorConfig {
  /** Only these pages and what is under them (default: everything the integration can see). */
  rootPageIds?: string[] | undefined;
  maxPages?: number | undefined;
  /** Blocks read per page (the tree is cut there). */
  maxBlocks?: number | undefined;
}

const DEFAULT_MAX_PAGES = 5000;
const DEFAULT_MAX_BLOCKS = 2000;
const MAX_DEPTH = 8;
const PAGE_SIZE = 100;

interface NotionPage {
  object: 'page' | 'database';
  id: string;
  url?: string;
  last_edited_time?: string;
  created_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  properties?: Record<string, unknown>;
  title?: unknown;
  parent?: { type?: string; page_id?: string; database_id?: string; workspace?: boolean };
}

interface SearchPage {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

interface ChildrenPage {
  results: NotionBlock[];
  next_cursor: string | null;
  has_more: boolean;
}

@Injectable()
export class NotionConnector implements Connector {
  readonly kind = 'notion';
  readonly configExample = { rootPageIds: [] };
  readonly credentialHint = 'a connected Notion workspace (oauth:<grant id>)';
  readonly oauth = { provider: 'notion' as const, scopes: [] };

  enabled(): boolean {
    return sourceKindEnabled('notion') && sourceOAuthClientEnabled();
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const base = providerEndpoints('notion').apiBase;
    const maxPages = cfg.maxPages ?? DEFAULT_MAX_PAGES;
    const since = typeof opts.checkpoint?.since === 'string' ? opts.checkpoint.since : null;
    const incremental = !opts.full && since !== null;
    let newest: string | null = since;
    let count = 0;
    let stopped = false;
    const pages =
      cfg.rootPageIds && cfg.rootPageIds.length > 0
        ? subtrees({ http, base, roots: cfg.rootPageIds, ctx })
        : search(http, base, ctx);
    for await (const page of pages) {
      if (page.object !== 'page' || page.archived || page.in_trash) continue;
      const edited = page.last_edited_time ?? '';
      if (incremental && edited && edited <= since!) {
        // Search comes newest edit first: everything from here on is older than the checkpoint.
        stopped = true;
        break;
      }
      if (!newest || edited > newest) newest = edited;
      count++;
      yield { type: 'upsert', item: describe(page) };
      if (count >= maxPages) {
        ctx.log(`notion walk stopped at maxPages=${maxPages}`);
        break;
      }
    }
    ctx.log(`notion: ${count} page(s)${stopped ? ' since the checkpoint' : ''}`);
    yield {
      type: 'checkpoint',
      checkpoint: {
        walkedAt: new Date().toISOString(),
        pages: count,
        ...(newest ? { since: newest } : {}),
      },
    };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const base = providerEndpoints('notion').apiBase;
    const page = (await http.getJson(
      `${base}/v1/pages/${encodeURIComponent(item.externalId)}`,
    )) as NotionPage;
    const lines = propertiesText(page.properties);
    const body = await blocksText(
      http,
      { base, pageId: page.id },
      { maxBlocks: cfg.maxBlocks ?? DEFAULT_MAX_BLOCKS, signal: ctx.signal },
    );
    const title = titleOf(page.properties) ?? item.title;
    const text = [title ? `# ${title}` : '', ...lines, lines.length > 0 ? '' : '', body]
      .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
      .join('\n')
      .trim();
    return {
      shape: 'document',
      text,
      title,
      occurredAt: page.last_edited_time ?? item.modifiedAt,
      kind: 'notion_page',
    };
  }
}

/** Every page the integration can see, newest edit first. */
async function* search(
  http: CloudHttp,
  base: string,
  ctx: ConnectorCtx,
): AsyncIterable<NotionPage> {
  let cursor: string | null = null;
  for (;;) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const page = (await http.postJson(`${base}/v1/search`, {
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: PAGE_SIZE,
      ...(cursor ? { start_cursor: cursor } : {}),
    })) as SearchPage;
    for (const p of page.results) yield p;
    if (!page.has_more || !page.next_cursor) return;
    cursor = page.next_cursor;
  }
}

/** The named pages and every child page under them (child_page blocks followed), each page read once. */
async function* subtrees(p: {
  http: CloudHttp;
  base: string;
  roots: string[];
  ctx: ConnectorCtx;
}): AsyncIterable<NotionPage> {
  const { http, base, roots, ctx } = p;
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const id = stack.pop()!;
    const key = id.replace(/-/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    let page: NotionPage;
    try {
      page = (await http.getJson(`${base}/v1/pages/${encodeURIComponent(id)}`)) as NotionPage;
    } catch (e) {
      if (e instanceof CloudHttpError && e.status === 404) {
        ctx.log(`notion: page ${id} is not shared with the integration — skipped`);
        continue;
      }
      throw e;
    }
    yield page;
    for await (const block of children(http, { base, blockId: page.id }, ctx.signal)) {
      if (block.type === 'child_page') stack.push(block.id);
    }
  }
}

async function* children(
  http: CloudHttp,
  at: { base: string; blockId: string },
  signal: AbortSignal,
): AsyncIterable<NotionBlock> {
  const { base, blockId } = at;
  let cursor: string | null = null;
  for (;;) {
    if (signal.aborted) throw new Error('aborted');
    const url = new URL(`${base}/v1/blocks/${encodeURIComponent(blockId)}/children`);
    url.searchParams.set('page_size', String(PAGE_SIZE));
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const page = (await http.getJson(url.toString())) as ChildrenPage;
    for (const b of page.results) yield b;
    if (!page.has_more || !page.next_cursor) return;
    cursor = page.next_cursor;
  }
}

/** The block tree as text, depth-first, children indented, cut at maxBlocks / MAX_DEPTH. */
export async function blocksText(
  http: CloudHttp,
  at: { base: string; pageId: string },
  limits: { maxBlocks: number; signal: AbortSignal },
): Promise<string> {
  const { base, pageId } = at;
  const lines: string[] = [];
  let read = 0;
  const walk = async (parent: string, depth: number): Promise<void> => {
    let numbered = 0;
    for await (const block of children(http, { base, blockId: parent }, limits.signal)) {
      if (read >= limits.maxBlocks) return;
      read++;
      numbered = block.type === 'numbered_list_item' ? numbered + 1 : 0;
      const own = blockText(block, numbered);
      if (own) lines.push(...own.split('\n').map((l) => `${'  '.repeat(depth)}${l}`));
      // A child page is its own document; a table's rows are its children.
      if (
        block.has_children &&
        block.type !== 'child_page' &&
        block.type !== 'child_database' &&
        depth < MAX_DEPTH
      ) {
        await walk(
          block.id,
          block.type === 'table' || block.type === 'column_list' || block.type === 'column'
            ? depth
            : depth + 1,
        );
      }
    }
  };
  await walk(pageId, 0);
  if (read >= limits.maxBlocks) lines.push(`[… cut at ${limits.maxBlocks} blocks]`);
  return lines.join('\n');
}

function describe(page: NotionPage): ItemDescriptor {
  const title = titleOf(page.properties);
  return {
    externalId: page.id,
    ...(title ? { title } : {}),
    originUri: page.url ?? `notion://page/${page.id}`,
    mediaType: 'text/markdown',
    revision: page.last_edited_time ? `lm:${page.last_edited_time}` : 'unknown',
    ...(page.last_edited_time ? { modifiedAt: page.last_edited_time } : {}),
  };
}

function configOf(ctx: ConnectorCtx): NotionConnectorConfig {
  return ctx.connection.config as NotionConnectorConfig;
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token) throw new Error('notion connector: no connected Notion workspace on this connection');
  return cloudHttp({
    token,
    private: providerEndpoints('notion').private,
    signal: ctx.signal,
    headers: { 'notion-version': NOTION_VERSION },
  });
}
