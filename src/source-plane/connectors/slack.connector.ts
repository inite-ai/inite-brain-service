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

/**
 * `slack` — the channels of a Slack workspace (raw-evidence-sources
 * doctrine 2: chat is conversation-shaped) through the Web API as the
 * connected workspace's bot token (OAuth v2, or a bot token pasted as
 * the credential). The bot reads only the channels it is a member of
 * (`/invite @bot`); the rest are named in the log and skipped.
 *
 * One catalogue row per MESSAGE (`<channel>/<ts>`); the revision is
 * the ts plus the edit's ts, so an edit re-runs the door (the episode
 * store keeps the first capture of a message id — an edit is a new
 * revision on the row, not a rewritten turn). A message is one turn:
 * the author's name as the speaker, mrkdwn reduced to text (`<@U…>` →
 * @name, `<#C…|name>` → #name, links to `label (url)`), files named. The
 * conversation is the channel — or the thread (`<channel>/<thread ts>`)
 * for a root with replies and its replies.
 *
 * Walk: `conversations.list` (public + private, members only), then
 * per channel `conversations.history` newest first from `oldest` — the
 * operator's `since` (default 30 days back) on a first walk, the
 * checkpoint's newest ts on an incremental one — capped by
 * `maxMessages`; a root with replies is followed into
 * `conversations.replies`. Replies to threads older than the checkpoint
 * surface on a full walk. Deletions surface on a full walk.
 *
 * Needs SOURCE_KIND_SLACK; a connected workspace needs SOURCE_OAUTH_CLIENT
 * + SOURCE_OAUTH_SLACK_CLIENT_ID as well.
 */
export interface SlackConnectorConfig {
  /** Channel names (without `#`) or ids to read; empty = every channel the bot is in. */
  channels?: string[] | undefined;
  /** ISO date: the first walk reads messages after it. Default: 30 days back. */
  since?: string | undefined;
  /** Messages a channel contributes per run at most (newest first). Default 2000. */
  maxMessages?: number | undefined;
  /** Follow roots with replies into their threads. Default true. */
  includeThreads?: boolean | undefined;
}

interface SlackChannel {
  id: string;
  name: string;
  is_member?: boolean;
  is_archived?: boolean;
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  edited?: { ts?: string };
  files?: Array<{ name?: string; title?: string }>;
}

interface SlackIdentity {
  teamId: string;
  teamUrl: string;
}

interface SlackCheckpoint {
  channels?: Record<string, { latest: string }>;
  walkedAt?: string;
}

/** What a run keeps between enumerate and fetch: the messages seen and the names resolved. */
interface RunState {
  identity: SlackIdentity | null;
  users: Map<string, string>;
  messages: Map<string, { channel: string; message: SlackMessage }>;
}

const DEFAULT_SINCE_DAYS = 30;
const DEFAULT_MAX_MESSAGES = 2000;
const HARD_MAX_MESSAGES = 20_000;
const PAGE = 200;
const TITLE_MAX = 80;
const TURN_MAX = 16_000;
/** Subtypes that are channel housekeeping, not what anyone said. */
const SKIPPED_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'pinned_item',
  'unpinned_item',
]);

@Injectable()
export class SlackConnector implements Connector {
  readonly kind = 'slack';
  readonly configExample = { channels: ['general', 'sales'], since: '2026-01-01' };
  readonly credentialHint =
    'a connected Slack workspace (oauth:<grant id>), or a bot token (xoxb-…) of an app installed there';
  readonly oauth = {
    provider: 'slack' as const,
    scopes: ['channels:history', 'channels:read', 'groups:history', 'groups:read', 'users:read'],
    optional: true,
  };
  private readonly runs = new Map<string, RunState>();

  enabled(): boolean {
    return sourceKindEnabled('slack');
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const state = this.state(ctx);
    const identity = await this.identity(http, state);
    const cp = (opts.checkpoint ?? {}) as SlackCheckpoint;
    const channels = await listChannels({ http, ctx, wanted: cfg.channels ?? [] });
    const next: Record<string, { latest: string }> = {};
    const since = sinceOf(cfg);
    for (const ch of channels) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const known = opts.full ? undefined : cp.channels?.[ch.id];
      const oldest = known ? known.latest : String(Math.floor(since.getTime() / 1000));
      const mark = { latest: known?.latest ?? '0' };
      yield* this.walkChannel({ ctx, http, cfg, state, identity, channel: ch, oldest, mark });
      next[ch.id] = { latest: mark.latest };
    }
    const checkpoint: SlackCheckpoint = { channels: next, walkedAt: new Date().toISOString() };
    yield { type: 'checkpoint', checkpoint: checkpoint as Record<string, unknown> };
  }

  /** One channel newest first from `oldest`, roots with replies followed into their threads; `mark.latest` ends as the newest ts seen. */
  private async *walkChannel(p: {
    ctx: ConnectorCtx;
    http: CloudHttp;
    cfg: SlackConnectorConfig;
    state: RunState;
    identity: SlackIdentity | null;
    channel: SlackChannel;
    oldest: string;
    mark: { latest: string };
  }): AsyncIterable<ItemDelta> {
    const ch = p.channel;
    let count = 0;
    for await (const m of history({ http: p.http, ctx: p.ctx, channel: ch.id, oldest: p.oldest })) {
      if (++count > maxMessagesOf(p.cfg)) break;
      if (tsGreater(m.ts, p.mark.latest)) p.mark.latest = m.ts;
      if (!isSaid(m)) continue;
      p.state.messages.set(`${ch.id}/${m.ts}`, { channel: ch.id, message: m });
      yield { type: 'upsert', item: describe({ identity: p.identity, channel: ch, message: m }) };
      if (p.cfg.includeThreads === false || (m.reply_count ?? 0) === 0) continue;
      for await (const r of replies({ http: p.http, ctx: p.ctx, channel: ch.id, ts: m.ts })) {
        if (r.ts === m.ts || !isSaid(r)) continue;
        p.state.messages.set(`${ch.id}/${r.ts}`, { channel: ch.id, message: r });
        yield { type: 'upsert', item: describe({ identity: p.identity, channel: ch, message: r }) };
      }
    }
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const http = httpOf(ctx);
    const state = this.state(ctx);
    const identity = await this.identity(http, state);
    const [channel, ts] = item.externalId.split('/');
    if (!channel || !ts) throw new Error(`slack: "${item.externalId}" is not a message id`);
    const found =
      state.messages.get(item.externalId)?.message ??
      (await messageAt({ http, ctx, channel, ts, threadTs: threadOf(item) }));
    if (!found) throw new Error(`slack: message ${item.externalId} is no longer in the channel`);
    const speaker = await this.speakerOf(http, state, found);
    const text = await this.textOf(http, state, found);
    const thread = found.thread_ts ?? (found.reply_count ? found.ts : undefined);
    const team = identity?.teamId ?? 'team';
    return {
      shape: 'conversation',
      conversationId: thread ? `slack:${team}/${channel}/${thread}` : `slack:${team}/${channel}`,
      turns: [turnOf({ text, speaker, ts: found.ts })],
    };
  }

  async endRun(ctx: ConnectorCtx): Promise<void> {
    this.runs.delete(ctx.connection.id);
  }

  private state(ctx: ConnectorCtx): RunState {
    const existing = this.runs.get(ctx.connection.id);
    if (existing) return existing;
    const fresh: RunState = { identity: null, users: new Map(), messages: new Map() };
    this.runs.set(ctx.connection.id, fresh);
    return fresh;
  }

  /** `auth.test` once per run: the team id for conversation ids, the team URL for permalinks. */
  private async identity(http: CloudHttp, state: RunState): Promise<SlackIdentity | null> {
    if (state.identity) return state.identity;
    try {
      const r = (await http.getJson(`${apiBase()}/auth.test`)) as {
        ok?: boolean;
        team_id?: string;
        url?: string;
      };
      if (r.ok === false) return null;
      state.identity = { teamId: r.team_id ?? 'team', teamUrl: (r.url ?? '').replace(/\/$/, '') };
      return state.identity;
    } catch {
      return null;
    }
  }

  private async speakerOf(http: CloudHttp, state: RunState, m: SlackMessage): Promise<string> {
    if (m.user) return this.userName(http, state, m.user);
    return m.username ?? m.bot_profile?.name ?? 'bot';
  }

  private async userName(http: CloudHttp, state: RunState, id: string): Promise<string> {
    const known = state.users.get(id);
    if (known) return known;
    let name = id;
    try {
      const r = (await http.getJson(`${apiBase()}/users.info?user=${encodeURIComponent(id)}`)) as {
        ok?: boolean;
        user?: { name?: string; real_name?: string; profile?: { display_name?: string } };
      };
      if (r.ok !== false && r.user) {
        name = r.user.real_name || r.user.profile?.display_name || r.user.name || id;
      }
    } catch {
      // A user the bot may not see keeps their id.
    }
    state.users.set(id, name);
    return name;
  }

  /** mrkdwn → text, mentions resolved to names, files named. */
  private async textOf(http: CloudHttp, state: RunState, m: SlackMessage): Promise<string> {
    let text = m.text ?? '';
    const mentions = [
      ...new Set([...text.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]*)?>/g)].map((x) => x[1]!)),
    ];
    for (const id of mentions) {
      const name = await this.userName(http, state, id);
      text = text.replace(new RegExp(`<@${id}(?:\\|[^>]*)?>`, 'g'), `@${name}`);
    }
    return mrkdownToText(text, m.files ?? []);
  }
}

// ── the API ───────────────────────────────────────────────────────────

async function listChannels(p: {
  http: CloudHttp;
  ctx: ConnectorCtx;
  wanted: string[];
}): Promise<SlackChannel[]> {
  const want = new Set(
    p.wanted.map((s) => s.trim().replace(/^#/, '').toLowerCase()).filter(Boolean),
  );
  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`${apiBase()}/conversations.list`);
    url.searchParams.set('types', 'public_channel,private_channel');
    url.searchParams.set('exclude_archived', 'true');
    url.searchParams.set('limit', String(PAGE));
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = okOf(await p.http.getJson(url.toString()), 'conversations.list') as {
      channels?: SlackChannel[];
      response_metadata?: { next_cursor?: string };
    };
    for (const ch of page.channels ?? []) {
      const named =
        want.size === 0 || want.has(ch.name.toLowerCase()) || want.has(ch.id.toLowerCase());
      if (!named) continue;
      if (!ch.is_member) {
        p.ctx.log(`slack: #${ch.name} skipped — the bot is not a member (/invite it)`);
        continue;
      }
      out.push(ch);
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  for (const w of want) {
    if (!out.some((c) => c.name.toLowerCase() === w || c.id.toLowerCase() === w))
      p.ctx.log(`slack: channel "${w}" not found among the channels the bot can see`);
  }
  return out;
}

/** `conversations.history` newest first from `oldest` (exclusive). */
async function* history(p: {
  http: CloudHttp;
  ctx: ConnectorCtx;
  channel: string;
  oldest: string;
}): AsyncIterable<SlackMessage> {
  let cursor: string | undefined;
  do {
    if (p.ctx.signal.aborted) throw new Error('aborted');
    const url = new URL(`${apiBase()}/conversations.history`);
    url.searchParams.set('channel', p.channel);
    url.searchParams.set('oldest', p.oldest);
    url.searchParams.set('limit', String(PAGE));
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = okOf(await p.http.getJson(url.toString()), 'conversations.history') as {
      messages?: SlackMessage[];
      response_metadata?: { next_cursor?: string };
    };
    for (const m of page.messages ?? []) yield m;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

async function* replies(p: {
  http: CloudHttp;
  ctx: ConnectorCtx;
  channel: string;
  ts: string;
}): AsyncIterable<SlackMessage> {
  let cursor: string | undefined;
  do {
    const url = new URL(`${apiBase()}/conversations.replies`);
    url.searchParams.set('channel', p.channel);
    url.searchParams.set('ts', p.ts);
    url.searchParams.set('limit', String(PAGE));
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = okOf(await p.http.getJson(url.toString()), 'conversations.replies') as {
      messages?: SlackMessage[];
      response_metadata?: { next_cursor?: string };
    };
    for (const m of page.messages ?? []) yield m;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

/** One message by ts — a top-level one from history, a reply from its thread. */
async function messageAt(p: {
  http: CloudHttp;
  ctx: ConnectorCtx;
  channel: string;
  ts: string;
  threadTs: string | null;
}): Promise<SlackMessage | null> {
  if (p.threadTs && p.threadTs !== p.ts) {
    for await (const r of replies({
      http: p.http,
      ctx: p.ctx,
      channel: p.channel,
      ts: p.threadTs,
    })) {
      if (r.ts === p.ts) return r;
    }
    return null;
  }
  const url = new URL(`${apiBase()}/conversations.history`);
  url.searchParams.set('channel', p.channel);
  url.searchParams.set('latest', p.ts);
  url.searchParams.set('oldest', p.ts);
  url.searchParams.set('inclusive', 'true');
  url.searchParams.set('limit', '1');
  const page = okOf(await p.http.getJson(url.toString()), 'conversations.history') as {
    messages?: SlackMessage[];
  };
  return page.messages?.find((m) => m.ts === p.ts) ?? null;
}

/** Slack answers 200 with `ok: false`; the error is the operator's next step. */
function okOf(body: unknown, method: string): Record<string, unknown> {
  const r = (body ?? {}) as Record<string, unknown>;
  if (r.ok === false) {
    const err = String(r.error ?? 'error');
    if (err === 'invalid_auth' || err === 'token_revoked' || err === 'account_inactive')
      throw new Error(`slack: the workspace token was rejected (${err}) — reconnect it`);
    if (err === 'missing_scope')
      throw new Error(
        `slack: ${method} needs a scope the app was not granted (${String(r.needed ?? '')}) — reconnect with it`,
      );
    throw new Error(`slack: ${method} — ${err}`);
  }
  return r;
}

// ── rows and turns ────────────────────────────────────────────────────

function describe(p: {
  identity: SlackIdentity | null;
  channel: SlackChannel;
  message: SlackMessage;
}): ItemDescriptor {
  const m = p.message;
  // The catalogue's label reads like the turn will: mrkdwn reduced, though
  // a mention stays an id here — enumerate does not resolve names.
  const firstLine = mrkdownToText((m.text ?? '').split('\n')[0] ?? '', []).trim();
  const title = firstLine.length > 0 ? firstLine.slice(0, TITLE_MAX) : `#${p.channel.name} message`;
  const permalink = `${p.identity?.teamUrl || 'https://slack.com'}/archives/${p.channel.id}/p${m.ts.replace('.', '')}`;
  const thread =
    m.thread_ts && m.thread_ts !== m.ts ? `?thread_ts=${m.thread_ts}&cid=${p.channel.id}` : '';
  return {
    externalId: `${p.channel.id}/${m.ts}`,
    title,
    path: `#${p.channel.name}/${m.ts}`,
    originUri: `${permalink}${thread}`,
    mediaType: 'text/plain',
    revision: m.edited?.ts ? `ts:${m.ts}/e${m.edited.ts}` : `ts:${m.ts}`,
    modifiedAt: isoOfTs(m.edited?.ts ?? m.ts),
  };
}

function turnOf(p: { text: string; speaker: string; ts: string }): ConversationTurn {
  return {
    text: p.text.slice(0, TURN_MAX),
    speaker: p.speaker,
    at: isoOfTs(p.ts),
    messageId: p.ts,
  };
}

/** The thread a row belongs to, from the permalink the row carries. */
function threadOf(item: ItemDescriptor): string | null {
  const m = /[?&]thread_ts=([0-9.]+)/.exec(item.originUri ?? '');
  return m?.[1] ?? null;
}

/**
 * Slack mrkdwn to text: `<#C…|name>` → #name, `<!channel>` → @channel,
 * `<url|label>` → `label (url)`, bare `<url>` → url, HTML entities
 * decoded; the files a message carries are named after the text. A
 * mention the caller already resolved is gone by now — one it could not
 * (a user the bot cannot see, or the catalogue's title, which resolves
 * nothing) degrades to `@<name or id>` instead of leaking the markup.
 */
export function mrkdownToText(
  text: string,
  files: Array<{ name?: string; title?: string }>,
): string {
  let out = text
    .replace(/<#[A-Z0-9_]+\|([^>]*)>/g, '#$1')
    .replace(/<!(channel|here|everyone)>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9_]+\|@?([^>]*)>/g, '@$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/<@([A-Z0-9_]+)\|([^>]*)>/g, '@$2')
    .replace(/<@([A-Z0-9_]+)>/g, '@$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
  const named = files.map((f) => f.name ?? f.title).filter((n): n is string => !!n);
  if (named.length > 0) {
    out = [out, named.map((n) => `[attachment: ${n}]`).join('\n')]
      .filter((s) => s.length > 0)
      .join('\n\n');
  }
  return out;
}

function isSaid(m: SlackMessage): boolean {
  if (m.type !== undefined && m.type !== 'message') return false;
  if (m.subtype && SKIPPED_SUBTYPES.has(m.subtype)) return false;
  return (m.text ?? '').trim().length > 0 || (m.files?.length ?? 0) > 0;
}

function tsGreater(a: string, b: string): boolean {
  return Number(a) > Number(b);
}

function isoOfTs(ts: string): string {
  const ms = Math.round(Number(ts) * 1000);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
}

function sinceOf(cfg: SlackConnectorConfig): Date {
  if (cfg.since) {
    const d = new Date(cfg.since);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(Date.now() - DEFAULT_SINCE_DAYS * 24 * 3600 * 1000);
}

function maxMessagesOf(cfg: SlackConnectorConfig): number {
  return Math.min(Math.max(1, cfg.maxMessages ?? DEFAULT_MAX_MESSAGES), HARD_MAX_MESSAGES);
}

function apiBase(): string {
  return providerEndpoints('slack').apiBase;
}

function configOf(ctx: ConnectorCtx): SlackConnectorConfig {
  return ctx.connection.config as SlackConnectorConfig;
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token) throw new Error('slack: no connected workspace or bot token on this connection');
  return cloudHttp({ token, private: providerEndpoints('slack').private, signal: ctx.signal });
}
