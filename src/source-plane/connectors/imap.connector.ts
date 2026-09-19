import { Injectable } from '@nestjs/common';
import { sourceKindEnabled } from '../../common/source-plane-flags';
import { decodeWords, parseMail } from '../../evidence/processing/adapters/mail-text';
import type {
  Connector,
  ConnectorCtx,
  EnumerateOptions,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
} from '../connector';
import { ImapClient, imapDate, internalDateOf, sequenceSet } from './imap-client';
import { idOf, mailTurnOf } from './mail-turn';

/**
 * `imap` — any mailbox over IMAP (raw-evidence-sources-2026-09.md W4,
 * mail: "generic IMAP"): a host, a user and an app password, read-only.
 * One catalogue row per message; the Message-ID is the row's id (the
 * same message in two mailboxes is one row) and — a message never
 * changes — its revision; the RFC 5092 URL
 * `imap://user@host/INBOX;UIDVALIDITY=n/;UID=m` is the row's origin
 * AND how fetch finds it again. A message is one turn of the thread
 * its References name (mail-turn.ts).
 *
 * Walk: per mailbox, `UID SEARCH SINCE <since>` (the operator's date,
 * default 90 days back), the newest `maxMessages` of them, their
 * headers in one `UID FETCH … BODY.PEEK[HEADER.FIELDS (…)]`. The
 * checkpoint keeps each mailbox's UIDVALIDITY and highest UID; an
 * incremental run fetches `<highest+1>:*` only, and a mailbox whose
 * UIDVALIDITY moved is walked again. What was deleted is found by a
 * full walk (the engine marks what a full walk did not re-emit gone);
 * the connector never expunges anything.
 *
 * Not spoken: STARTTLS (TLS on 993, or a plain socket under the private
 * opt-in), OAuth over IMAP, attachments as evidence (a binary-shaped
 * entry is refused by name — the `gmail` connector has them).
 *
 * Needs SOURCE_KIND_IMAP; the password is the connection's credential.
 */
export interface ImapConnectorConfig {
  host: string;
  /** Default 993 (TLS), 143 without. */
  port?: number | undefined;
  /** Default true. False needs the private opt-in, like plain http. */
  tls?: boolean | undefined;
  user: string;
  /** Default ['INBOX']. */
  mailboxes?: string[] | undefined;
  /** ISO date: the first walk reads mail after it. Default: 90 days back. */
  since?: string | undefined;
  /** Messages a mailbox contributes per run at most (newest first). Default 2000. */
  maxMessages?: number | undefined;
  allowPrivate?: boolean | undefined;
}

interface MailboxMark {
  uidValidity: number;
  lastUid: number;
}

interface ImapCheckpoint {
  boxes?: Record<string, MailboxMark>;
  walkedAt?: string;
}

const DEFAULT_SINCE_DAYS = 90;
const DEFAULT_MAX_MESSAGES = 2000;
const HARD_MAX_MESSAGES = 20_000;
const FETCH_BATCH = 500;
const MESSAGE_MAX_BYTES = 40 * 1024 * 1024;
const HEADER_ITEMS =
  'UID INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID IN-REPLY-TO REFERENCES)]';
const MAILBOX_NAME = /^[\x20-\x7e]{1,200}$/;

@Injectable()
export class ImapConnector implements Connector {
  readonly kind = 'imap';
  readonly configExample = {
    host: 'imap.example.com',
    port: 993,
    user: 'me@example.com',
    mailboxes: ['INBOX'],
    since: '2026-01-01',
  };
  readonly credentialHint = 'the mailbox password (an app password where the provider issues one)';
  private readonly sessions = new Map<string, Promise<ImapClient>>();

  enabled(): boolean {
    return sourceKindEnabled('imap');
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    if (ctx.connection.shape === 'binary') {
      throw new Error(
        'imap: attachments as evidence are not read over IMAP yet — connect the mailbox as conversations',
      );
    }
    const cfg = configOf(ctx);
    const client = await this.session(ctx);
    const cp = (opts.checkpoint ?? {}) as ImapCheckpoint;
    const boxes: Record<string, MailboxMark> = {};
    for (const name of mailboxesOf(cfg)) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const { uidValidity } = await client.examine(name);
      const known = opts.full ? undefined : cp.boxes?.[name];
      const incremental = known !== undefined && known.uidValidity === uidValidity;
      const uids = incremental
        ? (await client.uidSearch(`UID ${String(known.lastUid + 1)}:*`)).filter(
            (u) => u > known.lastUid,
          )
        : (await client.uidSearch(`SINCE ${imapDate(sinceOf(cfg))}`)).slice(-maxMessagesOf(cfg));
      let lastUid = incremental ? known.lastUid : 0;
      for (let i = 0; i < uids.length; i += FETCH_BATCH) {
        const batch = uids.slice(i, i + FETCH_BATCH);
        const records = await client.uidFetch(sequenceSet(batch), HEADER_ITEMS);
        for (const r of records) {
          const uid = Number(r.attrs.get('UID'));
          if (!Number.isFinite(uid) || uid <= 0) continue;
          lastUid = Math.max(lastUid, uid);
          const header = r.attrs.get('BODY');
          yield {
            type: 'upsert',
            item: describe({
              cfg,
              mailbox: name,
              uidValidity,
              uid,
              header: Buffer.isBuffer(header) ? header : Buffer.alloc(0),
              internalDate: internalDateOf(r.attrs.get('INTERNALDATE')),
              size: Number(r.attrs.get('RFC822.SIZE')),
            }),
          };
        }
      }
      boxes[name] = { uidValidity, lastUid };
    }
    const next: ImapCheckpoint = { boxes, walkedAt: new Date().toISOString() };
    yield { type: 'checkpoint', checkpoint: next as Record<string, unknown> };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const at = locatorOf(item);
    if (!at) throw new Error(`imap: "${item.externalId}" has no mailbox locator`);
    const client = await this.session(ctx);
    await client.examine(at.mailbox);
    const [record] = await client.uidFetch(String(at.uid), 'UID BODY.PEEK[]');
    const raw = record?.attrs.get('BODY');
    if (!Buffer.isBuffer(raw) || raw.length === 0)
      throw new Error(
        `imap: message ${item.externalId} is no longer at ${at.mailbox}/${String(at.uid)}`,
      );
    if (raw.length > MESSAGE_MAX_BYTES)
      throw new Error(`imap: message ${item.externalId} is too large`);
    const t = mailTurnOf(raw);
    return {
      shape: 'conversation',
      conversationId: t.threadRoot ?? t.messageId ?? item.externalId,
      turns: [
        {
          ...t.turn,
          at: t.turn.at ?? item.modifiedAt,
          messageId: t.turn.messageId ?? item.externalId,
        },
      ],
    };
  }

  async endRun(ctx: ConnectorCtx): Promise<void> {
    const pending = this.sessions.get(ctx.connection.id);
    if (!pending) return;
    this.sessions.delete(ctx.connection.id);
    const client = await pending.catch(() => null);
    await client?.logout();
  }

  /** One logged-in session per run, opened on first use, closed by endRun. */
  private session(ctx: ConnectorCtx): Promise<ImapClient> {
    const existing = this.sessions.get(ctx.connection.id);
    if (existing) return existing;
    const cfg = configOf(ctx);
    const password = ctx.connection.credential;
    if (!password) throw new Error('imap connector: no password on this connection');
    const tls = cfg.tls !== false;
    const opened = ImapClient.connect({
      host: cfg.host,
      port: cfg.port ?? (tls ? 993 : 143),
      tls,
      user: cfg.user,
      password,
      allowPrivate: cfg.allowPrivate,
      signal: ctx.signal,
      maxResponseBytes: MESSAGE_MAX_BYTES,
    });
    this.sessions.set(ctx.connection.id, opened);
    return opened;
  }
}

// ── rows ──────────────────────────────────────────────────────────────

function describe(p: {
  cfg: ImapConnectorConfig;
  mailbox: string;
  uidValidity: number;
  uid: number;
  header: Buffer;
  internalDate: string | null;
  size: number;
}): ItemDescriptor {
  const h = parseMail(p.header).headers;
  const messageId = idOf(h.get('Message-ID'));
  const subject = decodeWords(h.get('Subject') ?? '').trim();
  const locator = `${encodeMailbox(p.mailbox)};UIDVALIDITY=${String(p.uidValidity)}/;UID=${String(p.uid)}`;
  const externalId = messageId ?? `${p.mailbox}/${String(p.uidValidity)}/${String(p.uid)}`;
  const dated = dateOf(h.get('Date')) ?? p.internalDate;
  return {
    externalId,
    title: subject || '(no subject)',
    originUri: `imap://${encodeURIComponent(p.cfg.user)}@${p.cfg.host}/${locator}`,
    mediaType: 'message/rfc822',
    ...(Number.isFinite(p.size) && p.size > 0 ? { size: p.size } : {}),
    // A message never changes: its id is its revision (the UID when it has none).
    revision: messageId ? `m:${messageId}` : `uid:${locator}`,
    ...(dated ? { modifiedAt: dated } : {}),
  };
}

/** The mailbox + UID a row was catalogued at: its RFC 5092 origin URL. */
export function locatorOf(item: ItemDescriptor): { mailbox: string; uid: number } | null {
  const m = /^imap:\/\/[^/]*\/(.+);UIDVALIDITY=\d+\/;UID=(\d+)$/.exec(item.originUri ?? '');
  if (m) return { mailbox: decodeURIComponent(m[1]!), uid: Number(m[2]) };
  return null;
}

function encodeMailbox(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/');
}

function dateOf(v: string | undefined): string | null {
  if (!v) return null;
  const d = new Date(v.replace(/\s*\([^)]*\)\s*$/, ''));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mailboxesOf(cfg: ImapConnectorConfig): string[] {
  const names = (cfg.mailboxes ?? ['INBOX']).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const n of names) {
    if (!MAILBOX_NAME.test(n) || n.includes('"') || n.includes('\\'))
      throw new Error(`imap: mailbox name "${n}" is not a plain ASCII name`);
  }
  return names.length > 0 ? names : ['INBOX'];
}

function sinceOf(cfg: ImapConnectorConfig): Date {
  if (cfg.since) {
    const d = new Date(cfg.since);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(Date.now() - DEFAULT_SINCE_DAYS * 24 * 3600 * 1000);
}

function maxMessagesOf(cfg: ImapConnectorConfig): number {
  return Math.min(Math.max(1, cfg.maxMessages ?? DEFAULT_MAX_MESSAGES), HARD_MAX_MESSAGES);
}

function configOf(ctx: ConnectorCtx): ImapConnectorConfig {
  const cfg = ctx.connection.config as unknown as ImapConnectorConfig;
  if (typeof cfg.host !== 'string' || cfg.host.trim().length === 0)
    throw new Error('imap: config.host is required');
  if (typeof cfg.user !== 'string' || cfg.user.trim().length === 0)
    throw new Error('imap: config.user is required');
  return { ...cfg, host: cfg.host.trim(), user: cfg.user.trim() };
}
