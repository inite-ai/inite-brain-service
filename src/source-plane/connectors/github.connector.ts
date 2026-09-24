import { Injectable } from '@nestjs/common';
import { sourceKindEnabled } from '../../common/source-plane-flags';
import type {
  Connector,
  ConnectorCtx,
  ConversationTurn,
  EnumerateOptions,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
} from '../connector';
import { providerEndpoints } from '../oauth/oauth-providers';
import { cloudHttp, type CloudHttp } from './cloud-http';
import { admitCloudFile, admittedExtensions, type AdmitGate } from './cloud-media';
import { looksBinary } from './fs.connector';

/**
 * `github` — one repository on GitHub (or GitHub Enterprise Server)
 * through the REST API, as a connected GitHub account or with a token
 * (a fine-grained PAT with Contents: read + Issues: read + Pull
 * requests: read, a classic `repo` token, or an App installation
 * token). Read-only: the brain never comments, labels or closes.
 *
 * One repository, two shapes — the same pair `code_memory` already has
 * for a clone, now without one:
 *  - conversation: every ISSUE and PULL REQUEST of the repository is one
 *    conversation (`gh:<owner>/<repo>#<number>`) whose turns are the
 *    body and then every comment, each speaking as its author. The
 *    listing (`/issues?state=all&sort=updated`) returns both — GitHub
 *    models a PR as an issue — so `includePullRequests: false` is what
 *    drops them. `updated_at` is the revision: a new comment, an edit or
 *    a state change re-runs the door and the thread lands again, whole.
 *  - document: the text files of the default branch (or `ref`) — README,
 *    `docs/**`, ADRs, changelogs — from one recursive tree call, the
 *    blob sha as the revision, fetched through the blob API. The same
 *    media table as a folder decides what is text.
 *
 * Incremental: the issues listing carries `since` = the checkpoint's
 * walk time (GitHub's `since` is "updated at or after", so the last
 * item is re-listed and lands unchanged); the tree is re-read whole and
 * the engine's revision diff does the rest — a tree call is one request.
 * A full walk marks what is gone (a deleted issue, a removed file).
 *
 * Needs SOURCE_KIND_GITHUB; a connected account needs SOURCE_OAUTH_CLIENT
 * + SOURCE_OAUTH_GITHUB_CLIENT_ID as well.
 */
export interface GithubConnectorConfig {
  /** `owner/name`. */
  repo: string;
  /** GitHub Enterprise Server's API origin (`https://ghe.acme.test/api/v3`); absent = github.com. */
  baseUrl?: string | undefined;
  /** Branch or tag the documents are read from; absent = the repository's default branch. */
  ref?: string | undefined;
  /** Conversation entry: also read pull requests (default true). */
  includePullRequests?: boolean | undefined;
  /** Conversation entry: only issues with every one of these labels. */
  labels?: string[] | undefined;
  /** ISO date: the first walk reads what changed after it. Default: 180 days back. */
  since?: string | undefined;
  /** Conversation entry: issues per run at most (newest change first). Default 1000. */
  maxItems?: number | undefined;
  /** Document entry: path prefixes to keep (`docs/`, `adr/`); empty = the whole tree. */
  paths?: string[] | undefined;
  extensions?: string[] | undefined;
  maxFiles?: number | undefined;
  maxFileBytes?: number | undefined;
  allowPrivate?: boolean | undefined;
}

interface GithubUser {
  login?: string;
  name?: string;
  type?: string;
}

interface GithubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  user?: GithubUser;
  labels?: Array<{ name?: string } | string>;
  comments?: number;
  html_url?: string;
  created_at: string;
  updated_at: string;
  pull_request?: { url?: string };
}

interface GithubComment {
  id: number;
  user?: GithubUser;
  body?: string | null;
  created_at: string;
  html_url?: string;
}

interface GithubTreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface GithubCheckpoint {
  since?: string;
  walkedAt?: string;
}

const DEFAULT_SINCE_DAYS = 180;
const DEFAULT_MAX_ITEMS = 1000;
const HARD_MAX_ITEMS = 20_000;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const HARD_MAX_FILE_BYTES = 8 * 1024 * 1024;
const PAGE = 100;
const COMMENTS_MAX = 500;
const TURN_MAX = 16_000;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

@Injectable()
export class GithubConnector implements Connector {
  readonly kind = 'github';
  readonly configExample = { repo: 'acme/handbook', paths: ['docs/'], since: '2026-01-01' };
  readonly credentialHint =
    'a connected GitHub account (oauth:<grant id>), or a token with read access to the repository';
  readonly oauth = {
    provider: 'github' as const,
    scopes: ['repo'],
    optional: true,
  };

  enabled(): boolean {
    return sourceKindEnabled('github');
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const walkStart = new Date();
    if (ctx.connection.shape === 'document') {
      yield* this.documents({ ctx, cfg, http });
    } else {
      const cp = (opts.checkpoint ?? {}) as GithubCheckpoint;
      const since = !opts.full && cp.since ? new Date(cp.since) : sinceOf(cfg);
      yield* this.issues({ ctx, cfg, http, since });
    }
    const next: GithubCheckpoint = {
      since: walkStart.toISOString(),
      walkedAt: new Date().toISOString(),
    };
    yield { type: 'checkpoint', checkpoint: next as Record<string, unknown> };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    if (ctx.connection.shape === 'document') return fetchDocument({ http, cfg, item });
    const number = Number(item.externalId.split('/')[1]);
    if (!Number.isFinite(number))
      throw new Error(`github: "${item.externalId}" is not an issue id`);
    const issue = (await http.getJson(
      `${api(cfg)}/repos/${cfg.repo}/issues/${String(number)}`,
    )) as GithubIssue;
    const comments =
      (issue.comments ?? 0) > 0 ? await commentsOf({ http, cfg, number }) : ([] as GithubComment[]);
    return {
      shape: 'conversation',
      conversationId: `gh:${cfg.repo}#${String(number)}`,
      turns: turnsOf(issue, comments),
    };
  }

  /** Issues and pull requests changed since `since`, newest change first. */
  private async *issues(p: {
    ctx: ConnectorCtx;
    cfg: GithubConnectorConfig;
    http: CloudHttp;
    since: Date;
  }): AsyncIterable<ItemDelta> {
    const max = maxItemsOf(p.cfg);
    let seen = 0;
    for (let page = 1; ; page++) {
      if (p.ctx.signal.aborted) throw new Error('aborted');
      const url = new URL(`${api(p.cfg)}/repos/${p.cfg.repo}/issues`);
      url.searchParams.set('state', 'all');
      url.searchParams.set('sort', 'updated');
      url.searchParams.set('direction', 'desc');
      url.searchParams.set('since', p.since.toISOString());
      url.searchParams.set('per_page', String(PAGE));
      url.searchParams.set('page', String(page));
      if (p.cfg.labels && p.cfg.labels.length > 0)
        url.searchParams.set('labels', p.cfg.labels.join(','));
      const batch = (await p.http.getJson(url.toString())) as GithubIssue[];
      if (!Array.isArray(batch) || batch.length === 0) return;
      for (const issue of batch) {
        if (++seen > max) return;
        if (issue.pull_request && p.cfg.includePullRequests === false) continue;
        yield { type: 'upsert', item: describeIssue(p.cfg, issue) };
      }
      if (batch.length < PAGE) return;
    }
  }

  /** The text files of one tree, judged by the fs media table. */
  private async *documents(p: {
    ctx: ConnectorCtx;
    cfg: GithubConnectorConfig;
    http: CloudHttp;
  }): AsyncIterable<ItemDelta> {
    const ref = p.cfg.ref ?? (await defaultBranch(p.http, p.cfg));
    const tree = (await p.http.getJson(
      `${api(p.cfg)}/repos/${p.cfg.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    )) as { tree?: GithubTreeEntry[]; truncated?: boolean };
    if (tree.truncated)
      p.ctx.log('github: the tree came back truncated — some files were not listed');
    const gate: AdmitGate = {
      shape: 'document',
      extensions: admittedExtensions('document', p.cfg.extensions),
      maxBytes: byteCap(p.cfg),
    };
    const prefixes = (p.cfg.paths ?? []).map((s) => s.replace(/^\//, ''));
    let emitted = 0;
    for (const entry of tree.tree ?? []) {
      if (entry.type !== 'blob') continue;
      if (prefixes.length > 0 && !prefixes.some((prefix) => entry.path.startsWith(prefix)))
        continue;
      const verdict = admitCloudFile({ name: entry.path, size: entry.size }, gate);
      if (verdict === 'large') p.ctx.log(`skipped ${entry.path}: larger than the cap`);
      if (verdict !== 'admit') continue;
      if (++emitted > (p.cfg.maxFiles ?? DEFAULT_MAX_FILES)) {
        p.ctx.log(`github: stopped at ${String(emitted - 1)} files (maxFiles)`);
        return;
      }
      yield { type: 'upsert', item: describeFile(p.cfg, ref, entry) };
    }
  }
}

// ── the API ───────────────────────────────────────────────────────────

async function defaultBranch(http: CloudHttp, cfg: GithubConnectorConfig): Promise<string> {
  const repo = (await http.getJson(`${api(cfg)}/repos/${cfg.repo}`)) as { default_branch?: string };
  return repo.default_branch ?? 'main';
}

async function commentsOf(p: {
  http: CloudHttp;
  cfg: GithubConnectorConfig;
  number: number;
}): Promise<GithubComment[]> {
  const out: GithubComment[] = [];
  for (let page = 1; out.length < COMMENTS_MAX; page++) {
    const url = new URL(`${api(p.cfg)}/repos/${p.cfg.repo}/issues/${String(p.number)}/comments`);
    url.searchParams.set('per_page', String(PAGE));
    url.searchParams.set('page', String(page));
    const batch = (await p.http.getJson(url.toString())) as GithubComment[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

async function fetchDocument(p: {
  http: CloudHttp;
  cfg: GithubConnectorConfig;
  item: ItemDescriptor;
}): Promise<FetchedItem> {
  const sha = p.item.revision?.replace(/^blob:/, '');
  if (!sha) throw new Error(`github: ${p.item.externalId} has no blob sha`);
  const blob = (await p.http.getJson(
    `${api(p.cfg)}/repos/${p.cfg.repo}/git/blobs/${encodeURIComponent(sha)}`,
  )) as { content?: string; encoding?: string; size?: number };
  if (typeof blob.content !== 'string') throw new Error(`github: blob ${sha} has no content`);
  const bytes =
    blob.encoding === 'base64'
      ? Buffer.from(blob.content, 'base64')
      : Buffer.from(blob.content, 'utf8');
  if (bytes.length > byteCap(p.cfg))
    throw new Error(`github: ${p.item.externalId} exceeds the cap`);
  if (looksBinary(bytes))
    throw new Error(`binary content in a text-shaped item: ${p.item.path ?? p.item.externalId}`);
  return {
    shape: 'document',
    text: bytes.toString('utf8'),
    title: p.item.title,
    occurredAt: p.item.modifiedAt,
    kind: 'repo_document',
  };
}

// ── rows and turns ────────────────────────────────────────────────────

function describeIssue(cfg: GithubConnectorConfig, issue: GithubIssue): ItemDescriptor {
  const kind = issue.pull_request ? 'pr' : 'issue';
  return {
    externalId: `issue/${String(issue.number)}`,
    title: `#${String(issue.number)} ${issue.title}`,
    path: `${kind}/${String(issue.number)}`,
    originUri:
      issue.html_url ??
      `https://github.com/${cfg.repo}/${kind === 'pr' ? 'pull' : 'issues'}/${String(issue.number)}`,
    mediaType: 'text/markdown',
    revision: `u:${issue.updated_at}`,
    modifiedAt: issue.updated_at,
  };
}

function describeFile(
  cfg: GithubConnectorConfig,
  ref: string,
  entry: GithubTreeEntry,
): ItemDescriptor {
  const name = entry.path.split('/').pop() ?? entry.path;
  return {
    externalId: `file/${entry.path}`,
    title: name,
    path: entry.path,
    originUri: `https://github.com/${cfg.repo}/blob/${ref}/${entry.path}`,
    mediaType: 'text/plain',
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    revision: `blob:${entry.sha}`,
  };
}

/**
 * The thread as turns: the body first (the issue's author), then every
 * comment in the order GitHub returns them (created_at ascending). An
 * empty body is not a turn — a title-only issue still gets its title,
 * which rides on the first turn so the thread is readable alone.
 */
export function turnsOf(issue: GithubIssue, comments: GithubComment[]): ConversationTurn[] {
  const head = [`${issue.pull_request ? 'PR' : 'Issue'} #${String(issue.number)}: ${issue.title}`];
  const body = (issue.body ?? '').trim();
  if (body.length > 0) head.push(body);
  const turns: ConversationTurn[] = [
    {
      text: head.join('\n\n').slice(0, TURN_MAX),
      speaker: authorOf(issue.user),
      at: issue.created_at,
      messageId: `issue-${String(issue.number)}`,
    },
  ];
  for (const c of comments) {
    const text = (c.body ?? '').trim();
    if (text.length === 0) continue;
    turns.push({
      text: text.slice(0, TURN_MAX),
      speaker: authorOf(c.user),
      at: c.created_at,
      messageId: `comment-${String(c.id)}`,
    });
  }
  return turns;
}

/** A person's name, else their login; a bot says so. */
export function authorOf(user: GithubUser | undefined): string {
  if (!user) return 'unknown author';
  const login = user.login ?? 'unknown';
  const name = user.name?.trim();
  if (user.type === 'Bot') return `${login} (bot)`;
  return name && name.length > 0 ? name : login;
}

// ── helpers ───────────────────────────────────────────────────────────

function api(cfg: GithubConnectorConfig): string {
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/$/, '');
  return providerEndpoints('github').apiBase;
}

function sinceOf(cfg: GithubConnectorConfig): Date {
  if (cfg.since) {
    const d = new Date(cfg.since);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(Date.now() - DEFAULT_SINCE_DAYS * 24 * 3600 * 1000);
}

function maxItemsOf(cfg: GithubConnectorConfig): number {
  return Math.min(Math.max(1, cfg.maxItems ?? DEFAULT_MAX_ITEMS), HARD_MAX_ITEMS);
}

function byteCap(cfg: GithubConnectorConfig): number {
  return Math.min(Math.max(1, cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES), HARD_MAX_FILE_BYTES);
}

function configOf(ctx: ConnectorCtx): GithubConnectorConfig {
  const cfg = ctx.connection.config as unknown as GithubConnectorConfig;
  const repo = typeof cfg.repo === 'string' ? cfg.repo.trim().replace(/^\/|\/$/g, '') : '';
  if (!REPO.test(repo)) throw new Error('github: config.repo must be "owner/name"');
  return { ...cfg, repo };
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token) throw new Error('github: no connected account or token on this connection');
  const cfg = ctx.connection.config as unknown as GithubConnectorConfig;
  const ep = providerEndpoints('github');
  return cloudHttp({
    token,
    // A GitHub Enterprise host is the operator's own — the private opt-in
    // covers it, the way a self-hosted wiki is covered on the url connector.
    private: ep.private || cfg.allowPrivate === true,
    signal: ctx.signal,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
}
