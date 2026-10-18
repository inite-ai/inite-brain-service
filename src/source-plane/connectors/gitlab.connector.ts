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
 * `gitlab` — one project on GitLab (gitlab.com or a self-managed
 * instance) through the v4 API, as a connected GitLab account or with a
 * personal / project / group access token (`read_api`, or `read_user` +
 * `read_api`). Read-only: the brain never comments, labels or closes.
 *
 * The forge shape `github` already has (W4.8), on the other forge:
 *  - conversation: every ISSUE and MERGE REQUEST is one conversation
 *    whose turns are the description and then every note, each speaking
 *    as its author. ⚡Unlike GitHub, GitLab counts issues and merge
 *    requests SEPARATELY and lists them at separate endpoints — issue
 *    #5 and merge request !5 are two different threads, so the
 *    conversation id carries GitLab's own sigil (`gl:<project>#5` vs
 *    `gl:<project>!5`) and the two are walked one after the other.
 *    ⚡A note may be the activity feed rather than a comment ("changed
 *    the description", "assigned to @x"): GitLab marks those
 *    `system: true` and they are not turns. `updated_at` is the
 *    revision — a new note, an edit or a state change re-runs the door
 *    and the thread lands again, whole.
 *  - document: the text files of the default branch (or `ref`) — README,
 *    `docs/**`, ADRs, changelogs — from the recursive tree listing, the
 *    blob id (sha) as the revision, fetched through the blobs API. The
 *    same media table as a folder decides what is text. ⚡A GitLab tree
 *    entry carries no size, so the byte cap is applied when the blob
 *    arrives rather than before it is asked for.
 *
 * Incremental: both listings carry `updated_after` = the checkpoint's
 * walk time; the tree is re-read whole and the engine's revision diff
 * does the rest. A full walk marks what is gone (a deleted issue, a
 * removed file).
 *
 * Self-managed: `config.baseUrl` is the instance ("https://gitlab.acme.test",
 * with or without the `/api/v4` suffix) and the token is that instance's.
 * Connecting an ACCOUNT on a self-managed instance is the operator's
 * choice for the whole deployment — SOURCE_OAUTH_GITLAB_LOGIN_URL moves
 * the authorize, token, identity and API origins together, because an
 * app registered on one GitLab issues tokens only that GitLab honours.
 *
 * Needs SOURCE_KIND_GITLAB; a connected account needs SOURCE_OAUTH_CLIENT
 * + SOURCE_OAUTH_GITLAB_CLIENT_ID as well.
 */
export interface GitlabConnectorConfig {
  /** `group/name`, a nested `group/sub/name`, or the project's numeric id. */
  project: string;
  /** The instance ("https://gitlab.acme.test" or ".../api/v4"); absent = gitlab.com. */
  baseUrl?: string | undefined;
  /** Branch or tag the documents are read from; absent = the project's default branch. */
  ref?: string | undefined;
  /** Conversation entry: also read merge requests (default true). */
  includeMergeRequests?: boolean | undefined;
  /** Conversation entry: only threads with every one of these labels. */
  labels?: string[] | undefined;
  /** ISO date: the first walk reads what changed after it. Default: 180 days back. */
  since?: string | undefined;
  /** Conversation entry: threads per run at most (newest change first). Default 1000. */
  maxItems?: number | undefined;
  /** Document entry: path prefixes to keep (`docs/`, `adr/`); empty = the whole tree. */
  paths?: string[] | undefined;
  extensions?: string[] | undefined;
  maxFiles?: number | undefined;
  maxFileBytes?: number | undefined;
  allowPrivate?: boolean | undefined;
}

interface GitlabUser {
  username?: string;
  name?: string;
  bot?: boolean;
}

interface GitlabThread {
  iid: number;
  title: string;
  description?: string | null;
  state?: string;
  author?: GitlabUser;
  labels?: string[];
  user_notes_count?: number;
  web_url?: string;
  created_at: string;
  updated_at: string;
}

interface GitlabNote {
  id: number;
  author?: GitlabUser;
  body?: string | null;
  system?: boolean;
  created_at: string;
}

interface GitlabTreeEntry {
  id: string;
  path: string;
  name?: string;
  type: string;
}

interface GitlabCheckpoint {
  since?: string;
  walkedAt?: string;
}

/** The two things a GitLab project is talked about in. */
type ThreadKind = 'issue' | 'mr';

const KINDS: Record<ThreadKind, { path: string; sigil: string; word: string }> = {
  issue: { path: 'issues', sigil: '#', word: 'Issue' },
  mr: { path: 'merge_requests', sigil: '!', word: 'MR' },
};

const DEFAULT_SINCE_DAYS = 180;
const DEFAULT_MAX_ITEMS = 1000;
const HARD_MAX_ITEMS = 20_000;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const HARD_MAX_FILE_BYTES = 8 * 1024 * 1024;
const PAGE = 100;
const NOTES_MAX = 500;
const TREE_PAGES_MAX = 200;
const TURN_MAX = 16_000;
const PROJECT = /^(\d+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)$/;

@Injectable()
export class GitlabConnector implements Connector {
  readonly kind = 'gitlab';
  readonly configExample = { project: 'acme/handbook', paths: ['docs/'], since: '2026-01-01' };
  readonly credentialHint =
    'a connected GitLab account (oauth:<grant id>), or an access token with read_api on the project';
  readonly oauth = {
    provider: 'gitlab' as const,
    scopes: ['read_api'],
    optional: true,
  };

  enabled(): boolean {
    return sourceKindEnabled('gitlab');
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const walkStart = new Date();
    if (ctx.connection.shape === 'document') {
      yield* this.documents({ ctx, cfg, http });
    } else {
      const cp = (opts.checkpoint ?? {}) as GitlabCheckpoint;
      const since = !opts.full && cp.since ? new Date(cp.since) : sinceOf(cfg);
      const budget = { left: maxItemsOf(cfg) };
      yield* this.threads({ ctx, cfg, http, since, kind: 'issue', budget });
      if (cfg.includeMergeRequests !== false)
        yield* this.threads({ ctx, cfg, http, since, kind: 'mr', budget });
    }
    const next: GitlabCheckpoint = {
      since: walkStart.toISOString(),
      walkedAt: new Date().toISOString(),
    };
    yield { type: 'checkpoint', checkpoint: next as Record<string, unknown> };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    if (ctx.connection.shape === 'document') return fetchDocument({ http, cfg, item });
    const [head, tail] = item.externalId.split('/');
    const kind: ThreadKind = head === 'mr' ? 'mr' : 'issue';
    const iid = Number(tail);
    if (head !== 'mr' && head !== 'issue')
      throw new Error(`gitlab: "${item.externalId}" is not a thread id`);
    if (!Number.isFinite(iid)) throw new Error(`gitlab: "${item.externalId}" has no iid`);
    const thread = (await http.getJson(
      `${base(cfg)}/${KINDS[kind].path}/${String(iid)}`,
    )) as GitlabThread;
    const notes = (thread.user_notes_count ?? 1) > 0 ? await notesOf({ http, cfg, kind, iid }) : [];
    return {
      shape: 'conversation',
      conversationId: conversationId(cfg, kind, iid),
      turns: turnsOf(kind, thread, notes),
    };
  }

  /** Issues, then merge requests, newest change first, under one shared cap. */
  private async *threads(p: {
    ctx: ConnectorCtx;
    cfg: GitlabConnectorConfig;
    http: CloudHttp;
    since: Date;
    kind: ThreadKind;
    budget: { left: number };
  }): AsyncIterable<ItemDelta> {
    for (let page = 1; p.budget.left > 0; page++) {
      if (p.ctx.signal.aborted) throw new Error('aborted');
      const url = new URL(`${base(p.cfg)}/${KINDS[p.kind].path}`);
      url.searchParams.set('scope', 'all');
      url.searchParams.set('state', 'all');
      url.searchParams.set('order_by', 'updated_at');
      url.searchParams.set('sort', 'desc');
      url.searchParams.set('updated_after', p.since.toISOString());
      url.searchParams.set('per_page', String(PAGE));
      url.searchParams.set('page', String(page));
      if (p.cfg.labels && p.cfg.labels.length > 0)
        url.searchParams.set('labels', p.cfg.labels.join(','));
      const batch = (await p.http.getJson(url.toString())) as GitlabThread[];
      if (!Array.isArray(batch) || batch.length === 0) return;
      for (const thread of batch) {
        if (p.budget.left <= 0) return;
        p.budget.left -= 1;
        yield { type: 'upsert', item: describeThread(p.cfg, p.kind, thread) };
      }
      if (batch.length < PAGE) return;
    }
  }

  /** The text files of one tree, judged by the fs media table. */
  private async *documents(p: {
    ctx: ConnectorCtx;
    cfg: GitlabConnectorConfig;
    http: CloudHttp;
  }): AsyncIterable<ItemDelta> {
    const ref = p.cfg.ref ?? (await defaultBranch(p.http, p.cfg));
    const gate: AdmitGate = {
      shape: 'document',
      extensions: admittedExtensions('document', p.cfg.extensions),
      maxBytes: byteCap(p.cfg),
    };
    const prefixes = (p.cfg.paths ?? []).map((s) => s.replace(/^\//, ''));
    let emitted = 0;
    for (let page = 1; page <= TREE_PAGES_MAX; page++) {
      if (p.ctx.signal.aborted) throw new Error('aborted');
      const batch = await treePage({ http: p.http, cfg: p.cfg, ref, page });
      if (batch.length === 0) return;
      for (const entry of batch) {
        if (entry.type !== 'blob') continue;
        if (prefixes.length > 0 && !prefixes.some((prefix) => entry.path.startsWith(prefix)))
          continue;
        // A GitLab tree entry has no size: only the name is judged here,
        // the byte cap lands on the blob itself.
        if (admitCloudFile({ name: entry.path }, gate) !== 'admit') continue;
        if (++emitted > (p.cfg.maxFiles ?? DEFAULT_MAX_FILES)) {
          p.ctx.log(`gitlab: stopped at ${String(emitted - 1)} files (maxFiles)`);
          return;
        }
        yield { type: 'upsert', item: describeFile(p.cfg, ref, entry) };
      }
      if (batch.length < PAGE) return;
    }
    p.ctx.log('gitlab: the tree is longer than this connector walks — some files were not listed');
  }
}

// ── the API ───────────────────────────────────────────────────────────

async function defaultBranch(http: CloudHttp, cfg: GitlabConnectorConfig): Promise<string> {
  const project = (await http.getJson(base(cfg))) as { default_branch?: string };
  return project.default_branch ?? 'main';
}

async function treePage(p: {
  http: CloudHttp;
  cfg: GitlabConnectorConfig;
  ref: string;
  page: number;
}): Promise<GitlabTreeEntry[]> {
  const url = new URL(`${base(p.cfg)}/repository/tree`);
  url.searchParams.set('ref', p.ref);
  url.searchParams.set('recursive', 'true');
  url.searchParams.set('per_page', String(PAGE));
  url.searchParams.set('page', String(p.page));
  const batch = (await p.http.getJson(url.toString())) as GitlabTreeEntry[];
  return Array.isArray(batch) ? batch : [];
}

async function notesOf(p: {
  http: CloudHttp;
  cfg: GitlabConnectorConfig;
  kind: ThreadKind;
  iid: number;
}): Promise<GitlabNote[]> {
  const out: GitlabNote[] = [];
  for (let page = 1; out.length < NOTES_MAX; page++) {
    const url = new URL(`${base(p.cfg)}/${KINDS[p.kind].path}/${String(p.iid)}/notes`);
    url.searchParams.set('sort', 'asc');
    url.searchParams.set('order_by', 'created_at');
    url.searchParams.set('per_page', String(PAGE));
    url.searchParams.set('page', String(page));
    const batch = (await p.http.getJson(url.toString())) as GitlabNote[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

async function fetchDocument(p: {
  http: CloudHttp;
  cfg: GitlabConnectorConfig;
  item: ItemDescriptor;
}): Promise<FetchedItem> {
  const sha = p.item.revision?.replace(/^blob:/, '');
  if (!sha) throw new Error(`gitlab: ${p.item.externalId} has no blob sha`);
  const blob = (await p.http.getJson(
    `${base(p.cfg)}/repository/blobs/${encodeURIComponent(sha)}`,
  )) as { content?: string; encoding?: string; size?: number };
  if (typeof blob.content !== 'string') throw new Error(`gitlab: blob ${sha} has no content`);
  const bytes =
    blob.encoding === 'base64'
      ? Buffer.from(blob.content, 'base64')
      : Buffer.from(blob.content, 'utf8');
  if (bytes.length > byteCap(p.cfg))
    throw new Error(`gitlab: ${p.item.externalId} exceeds the cap`);
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

/** GitLab's own notation: `group/project#5` is an issue, `group/project!5` a merge request. */
export function conversationId(cfg: GitlabConnectorConfig, kind: ThreadKind, iid: number): string {
  return `gl:${cfg.project}${KINDS[kind].sigil}${String(iid)}`;
}

function describeThread(
  cfg: GitlabConnectorConfig,
  kind: ThreadKind,
  thread: GitlabThread,
): ItemDescriptor {
  const n = String(thread.iid);
  return {
    externalId: `${kind}/${n}`,
    title: `${KINDS[kind].sigil}${n} ${thread.title}`,
    path: `${kind}/${n}`,
    originUri: thread.web_url ?? `https://gitlab.com/${cfg.project}/-/${KINDS[kind].path}/${n}`,
    mediaType: 'text/markdown',
    revision: `u:${thread.updated_at}`,
    modifiedAt: thread.updated_at,
  };
}

function describeFile(
  cfg: GitlabConnectorConfig,
  ref: string,
  entry: GitlabTreeEntry,
): ItemDescriptor {
  return {
    externalId: `file/${entry.path}`,
    title: entry.name ?? entry.path.split('/').pop() ?? entry.path,
    path: entry.path,
    originUri: `https://gitlab.com/${cfg.project}/-/blob/${ref}/${entry.path}`,
    mediaType: 'text/plain',
    revision: `blob:${entry.id}`,
  };
}

/**
 * The thread as turns: the description first (its author), then every
 * note GitLab did not write itself. An empty description is not a turn —
 * a title-only issue still gets its title, which rides on the first turn
 * so the thread is readable alone.
 */
export function turnsOf(
  kind: ThreadKind,
  thread: GitlabThread,
  notes: GitlabNote[],
): ConversationTurn[] {
  const head = [`${KINDS[kind].word} ${KINDS[kind].sigil}${String(thread.iid)}: ${thread.title}`];
  const description = (thread.description ?? '').trim();
  if (description.length > 0) head.push(description);
  const turns: ConversationTurn[] = [
    {
      text: head.join('\n\n').slice(0, TURN_MAX),
      speaker: authorOf(thread.author),
      at: thread.created_at,
      messageId: `${kind}-${String(thread.iid)}`,
    },
  ];
  for (const note of notes) {
    // GitLab files its activity feed as notes too ("changed the
    // description", "assigned to @x"): that is not what anyone said.
    if (note.system === true) continue;
    const text = (note.body ?? '').trim();
    if (text.length === 0) continue;
    turns.push({
      text: text.slice(0, TURN_MAX),
      speaker: authorOf(note.author),
      at: note.created_at,
      messageId: `note-${String(note.id)}`,
    });
  }
  return turns;
}

/** A person's name, else their username; a service account says so. */
export function authorOf(user: GitlabUser | undefined): string {
  if (!user) return 'unknown author';
  const username = user.username ?? 'unknown';
  const name = user.name?.trim();
  if (user.bot === true) return `${username} (bot)`;
  return name && name.length > 0 ? name : username;
}

// ── helpers ───────────────────────────────────────────────────────────

/** The project's API root: the instance, `/api/v4`, the URL-encoded project path. */
function base(cfg: GitlabConnectorConfig): string {
  return `${apiRoot(cfg)}/projects/${encodeURIComponent(cfg.project)}`;
}

function apiRoot(cfg: GitlabConnectorConfig): string {
  if (!cfg.baseUrl) return providerEndpoints('gitlab').apiBase;
  const trimmed = cfg.baseUrl.replace(/\/+$/, '');
  return /\/api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/api/v4`;
}

function sinceOf(cfg: GitlabConnectorConfig): Date {
  if (cfg.since) {
    const d = new Date(cfg.since);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(Date.now() - DEFAULT_SINCE_DAYS * 24 * 3600 * 1000);
}

function maxItemsOf(cfg: GitlabConnectorConfig): number {
  return Math.min(Math.max(1, cfg.maxItems ?? DEFAULT_MAX_ITEMS), HARD_MAX_ITEMS);
}

function byteCap(cfg: GitlabConnectorConfig): number {
  return Math.min(Math.max(1, cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES), HARD_MAX_FILE_BYTES);
}

function configOf(ctx: ConnectorCtx): GitlabConnectorConfig {
  const cfg = ctx.connection.config as unknown as GitlabConnectorConfig;
  const project = typeof cfg.project === 'string' ? cfg.project.trim().replace(/^\/|\/$/g, '') : '';
  if (!PROJECT.test(project))
    throw new Error('gitlab: config.project must be "group/name" or the project id');
  return { ...cfg, project };
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token) throw new Error('gitlab: no connected account or token on this connection');
  const cfg = ctx.connection.config as unknown as GitlabConnectorConfig;
  const ep = providerEndpoints('gitlab');
  return cloudHttp({
    token,
    // A self-managed GitLab is the operator's own host — the private
    // opt-in covers it, the way a self-hosted wiki is covered on url.
    private: ep.private || cfg.allowPrivate === true,
    signal: ctx.signal,
  });
}
