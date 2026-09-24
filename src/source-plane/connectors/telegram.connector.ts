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
import { cloudHttp, CloudHttpError, type CloudHttp } from './cloud-http';

/**
 * `telegram` — the groups, supergroups and channels a Telegram BOT is in
 * (raw-evidence-sources doctrine 2: chat is conversation-shaped),
 * through the Bot API's `getUpdates` with the bot token as the
 * credential. A bot sees what arrives after it joined (privacy mode
 * off, or the bot an admin) and Telegram keeps an update for 24 hours:
 * the brain is the consumer — every run acknowledges what it read by
 * moving the offset, and nothing can be re-read. So the connector is a
 * FEED (`readsOnlyNew`): the engine never marks anything gone, a full
 * walk is the same as an incremental one, and a message that is no
 * longer in the run's own cache cannot be fetched again.
 *
 * One catalogue row per message (`<chat id>/<message id>`); the
 * revision is the edit date, else the date. A message is one turn: the
 * sender's name (the channel's title for a channel post) as the
 * speaker, text or caption as the text, media named. The conversation is
 * the chat — or the forum topic (`<chat>/<thread id>`) when there is one.
 *
 * Needs SOURCE_KIND_TELEGRAM. SOURCE_TELEGRAM_API_BASE (dev/test) swaps
 * api.telegram.org for a fake; the fetch then needs the private opt-in.
 * A bot with a webhook set answers 409 to getUpdates — remove it first.
 */
export interface TelegramConnectorConfig {
  /** Chat ids, `@usernames` or titles to keep; empty = every chat the bot sees. */
  chats?: string[] | undefined;
  /** Updates read per run at most. Default 2000. */
  maxMessages?: number | undefined;
}

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

/** A Bot API message, as much of it as a turn needs. */
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  sender_chat?: TgChat;
  chat: TgChat;
  date: number;
  edit_date?: number;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: { file_name?: string };
  video?: { file_name?: string };
  audio?: { file_name?: string; title?: string };
  voice?: unknown;
  sticker?: { emoji?: string };
  video_note?: unknown;
  contact?: unknown;
  location?: unknown;
  poll?: { question?: string };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  edited_channel_post?: TgMessage;
}

interface TelegramCheckpoint {
  offset?: number;
  walkedAt?: string;
}

const DEFAULT_MAX = 2000;
const HARD_MAX = 20_000;
const PAGE = 100;
const TITLE_MAX = 80;
const TURN_MAX = 16_000;
const DEFAULT_API_BASE = 'https://api.telegram.org';

@Injectable()
export class TelegramConnector implements Connector {
  readonly kind = 'telegram';
  readonly readsOnlyNew = true;
  readonly configExample = { chats: ['@acme_team', '-1001234567890'] };
  readonly credentialHint = 'the bot token from @BotFather (123456:ABC-…)';
  private readonly runs = new Map<string, Map<string, TgMessage>>();

  enabled(): boolean {
    return sourceKindEnabled('telegram');
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const cache = this.cache(ctx);
    const cp = (opts.checkpoint ?? {}) as TelegramCheckpoint;
    let offset = typeof cp.offset === 'number' ? cp.offset : undefined;
    let read = 0;
    const max = Math.min(Math.max(1, cfg.maxMessages ?? DEFAULT_MAX), HARD_MAX);
    for (;;) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const url = new URL(`${botBase(ctx)}/getUpdates`);
      url.searchParams.set('limit', String(PAGE));
      url.searchParams.set('timeout', '0');
      url.searchParams.set(
        'allowed_updates',
        JSON.stringify(['message', 'edited_message', 'channel_post', 'edited_channel_post']),
      );
      if (offset !== undefined) url.searchParams.set('offset', String(offset));
      const page = okOf(await getUpdates(http, url.toString(), ctx)) as { result?: TgUpdate[] };
      const updates = page.result ?? [];
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post;
        if (!m || !wanted(cfg, m.chat)) continue;
        if (!(m.text ?? m.caption ?? '').trim() && !hasMedia(m)) continue;
        const id = `${String(m.chat.id)}/${String(m.message_id)}`;
        cache.set(id, m);
        yield { type: 'upsert', item: describe(m) };
      }
      read += updates.length;
      if (updates.length < PAGE || read >= max) break;
    }
    const checkpoint: TelegramCheckpoint = {
      ...(offset !== undefined ? { offset } : {}),
      walkedAt: new Date().toISOString(),
    };
    yield { type: 'checkpoint', checkpoint: checkpoint as Record<string, unknown> };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const m = this.cache(ctx).get(item.externalId);
    if (!m) {
      throw new Error(
        `telegram: message ${item.externalId} was read in an earlier run — a bot cannot re-read history`,
      );
    }
    const thread = m.message_thread_id;
    return {
      shape: 'conversation',
      conversationId: thread
        ? `tg:${String(m.chat.id)}/${String(thread)}`
        : `tg:${String(m.chat.id)}`,
      turns: [turnOf(m)],
    };
  }

  async endRun(ctx: ConnectorCtx): Promise<void> {
    this.runs.delete(ctx.connection.id);
  }

  private cache(ctx: ConnectorCtx): Map<string, TgMessage> {
    const existing = this.runs.get(ctx.connection.id);
    if (existing) return existing;
    const fresh = new Map<string, TgMessage>();
    this.runs.set(ctx.connection.id, fresh);
    return fresh;
  }
}

// ── rows and turns ────────────────────────────────────────────────────

function describe(m: TgMessage): ItemDescriptor {
  const body = (m.text ?? m.caption ?? '').trim();
  const firstLine = body.split('\n')[0]?.trim() ?? '';
  const title =
    firstLine.length > 0
      ? firstLine.slice(0, TITLE_MAX)
      : `${mediaWords(m)[0] ?? 'message'} in ${chatName(m.chat)}`;
  const at = m.edit_date ?? m.date;
  return {
    externalId: `${String(m.chat.id)}/${String(m.message_id)}`,
    title,
    path: `${chatName(m.chat)}/${String(m.message_id)}`,
    originUri: permalink(m),
    mediaType: 'text/plain',
    revision: `d:${String(at)}`,
    modifiedAt: new Date(at * 1000).toISOString(),
  };
}

export function turnOf(m: TgMessage): ConversationTurn {
  const body = (m.text ?? m.caption ?? '').trim();
  const media = mediaWords(m).map((w) => `[attachment: ${w}]`);
  const text = [body, media.join('\n')].filter((s) => s.length > 0).join('\n\n');
  return {
    text: text.slice(0, TURN_MAX),
    speaker: speakerOf(m),
    at: new Date(m.date * 1000).toISOString(),
    messageId: String(m.message_id),
  };
}

/** The sender's name; a channel post speaks as the channel. */
export function speakerOf(m: TgMessage): string {
  if (m.from && !(m.from.is_bot && m.sender_chat)) {
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ').trim();
    return name || (m.from.username ? `@${m.from.username}` : String(m.from.id));
  }
  return chatName(m.sender_chat ?? m.chat);
}

function chatName(c: TgChat): string {
  const person = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return c.title || person || (c.username ? `@${c.username}` : String(c.id));
}

/** What a message carries besides text, by kind (and name when Telegram gives one). */
function mediaWords(m: TgMessage): string[] {
  const out: string[] = [];
  if (m.photo) out.push('photo');
  if (m.document) out.push(m.document.file_name ?? 'document');
  if (m.video) out.push(m.video.file_name ?? 'video');
  if (m.audio) out.push(m.audio.file_name ?? m.audio.title ?? 'audio');
  if (m.voice) out.push('voice message');
  if (m.video_note) out.push('video message');
  if (m.sticker) out.push(`sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ''}`);
  if (m.contact) out.push('contact');
  if (m.location) out.push('location');
  if (m.poll) out.push(`poll: ${m.poll.question ?? ''}`.trim());
  return out;
}

function hasMedia(m: TgMessage): boolean {
  return mediaWords(m).length > 0;
}

/** `https://t.me/<username>/<id>` for a public chat, `https://t.me/c/<internal id>/<id>` for a private supergroup. */
function permalink(m: TgMessage): string {
  if (m.chat.username) return `https://t.me/${m.chat.username}/${String(m.message_id)}`;
  const raw = String(m.chat.id);
  const internal = raw.startsWith('-100') ? raw.slice(4) : raw.replace(/^-/, '');
  return `https://t.me/c/${internal}/${String(m.message_id)}`;
}

function wanted(cfg: TelegramConnectorConfig, chat: TgChat): boolean {
  const keep = (cfg.chats ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (keep.length === 0) return true;
  const names = [
    String(chat.id),
    chat.username ? `@${chat.username.toLowerCase()}` : '',
    chat.username?.toLowerCase() ?? '',
    (chat.title ?? '').toLowerCase(),
  ];
  return keep.some((k) => names.includes(k));
}

/**
 * One call. The token rides in the PATH, so it would otherwise appear in
 * every error the HTTP layer raises — it is masked before the message
 * leaves, and a 401 is named as what it is here (a bad bot token, not a
 * "connected account").
 */
async function getUpdates(http: CloudHttp, url: string, ctx: ConnectorCtx): Promise<unknown> {
  try {
    return await http.getJson(url);
  } catch (err) {
    if (err instanceof CloudHttpError && err.status === 401)
      throw new Error('telegram: the bot token was rejected (401) — check it');
    const token = ctx.connection.credential ?? '';
    const message = (err as Error).message ?? String(err);
    throw new Error(token ? message.split(token).join('***') : message);
  }
}

/** The Bot API answers 200 with `ok: false` and a description. */
function okOf(body: unknown): Record<string, unknown> {
  const r = (body ?? {}) as Record<string, unknown>;
  if (r.ok === false) {
    const code = Number(r.error_code);
    const desc = String(r.description ?? 'error');
    if (code === 401) throw new Error('telegram: the bot token was rejected (401) — check it');
    if (code === 409)
      throw new Error(
        `telegram: ${desc} — a webhook is set on this bot; remove it (deleteWebhook) to poll`,
      );
    throw new Error(`telegram: ${desc}`);
  }
  return r;
}

function configOf(ctx: ConnectorCtx): TelegramConnectorConfig {
  return ctx.connection.config as TelegramConnectorConfig;
}

/** api.telegram.org, or the dev override (a fake — private egress). */
export function telegramApi(env: NodeJS.ProcessEnv = process.env): {
  base: string;
  private: boolean;
} {
  const override = env.SOURCE_TELEGRAM_API_BASE?.trim();
  return override
    ? { base: override.replace(/\/$/, ''), private: true }
    : { base: DEFAULT_API_BASE, private: false };
}

function botBase(ctx: ConnectorCtx): string {
  const token = ctx.connection.credential;
  if (!token) throw new Error('telegram: no bot token on this connection');
  return `${telegramApi().base}/bot${token}`;
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token) throw new Error('telegram: no bot token on this connection');
  // The token rides in the path (the Bot API's way), never as a bearer.
  return cloudHttp({ token, bearer: false, private: telegramApi().private, signal: ctx.signal });
}
