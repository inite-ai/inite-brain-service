import { Injectable } from '@nestjs/common';
import { sourceKindEnabled, sourceOAuthClientEnabled } from '../../common/source-plane-flags';
import { decodeWords } from '../../evidence/processing/adapters/mail-text';
import type {
  Connector,
  ConnectorCtx,
  EnumerateOptions,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
} from '../connector';
import { providerEndpoints } from '../oauth/oauth-providers';
import { cloudHttp, CloudHttpError, type CloudHttp } from './cloud-http';
import {
  admitCloudFile,
  admittedExtensions,
  classifyCloudFile,
  type AdmitGate,
} from './cloud-media';
import { mailTurnOf } from './mail-turn';
import { modalityOf } from './media';

/**
 * `gmail` — a Gmail mailbox (raw-evidence-sources-2026-09.md W4, mail)
 * through the Gmail REST API with a connected Google account
 * (`gmail.readonly`; the connector never labels, never deletes).
 *
 * Two shapes of the same mailbox:
 *  - conversation: one catalogue row per MESSAGE (a message never
 *    changes — its id is its revision), fetched raw (RFC 822) and reduced
 *    to one turn by mail-turn.ts; the thread id is the conversation, so
 *    a thread's messages land as one conversation's turns through the
 *    mention door, in any order, idempotently by Message-ID;
 *  - binary: one row per ATTACHMENT (`<message id>#<part id>`) of the
 *    messages the same listing names that carry one, judged by the
 *    fs / s3 media table on name, reported type and size, handed to
 *    the evidence plane.
 *
 * Listing: `messages.list` with the connection's own Gmail query plus
 * `after:<since>` — the operator's `since` on a first walk (default 90
 * days back), the checkpoint's walk time (less a day of overlap; the
 * engine drops what it already has) on an incremental one — newest
 * first, capped by `maxMessages`. Deletions ride the history feed
 * (`history.list` from the checkpoint's historyId, messageDeleted only);
 * a history id too old to serve (404) is logged and the deletions wait
 * for the next full walk. The history id is read from the profile at
 * the START of a walk so nothing between start and checkpoint is lost.
 *
 * Needs SOURCE_OAUTH_CLIENT (the grant) as well as SOURCE_KIND_GMAIL.
 */
export interface GmailConnectorConfig {
  /** Gmail search syntax narrowing what is read (`label:clients -category:promotions`). */
  query?: string | undefined;
  /** Label ids every message must carry (`INBOX`, `SENT`, a user label's id). */
  labelIds?: string[] | undefined;
  /** ISO date: the first walk reads mail after it. Default: 90 days back. */
  since?: string | undefined;
  /** Messages a run lists at most (newest first). Default 2000. */
  maxMessages?: number | undefined;
  includeSpamTrash?: boolean | undefined;
  /** Attachment entries: extensions admitted (default: the binary table) and the byte cap. */
  extensions?: string[] | undefined;
  maxFileBytes?: number | undefined;
}

const DEFAULT_SINCE_DAYS = 90;
const DEFAULT_MAX_MESSAGES = 2000;
const HARD_MAX_MESSAGES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 25 * 1024 * 1024;
const PAGE_SIZE = 500;
const OVERLAP_MS = 24 * 3600 * 1000;
const RAW_MAX_BYTES = 40 * 1024 * 1024;
const META_HEADERS = ['Subject', 'From', 'Date', 'In-Reply-To', 'References'];

interface GmailMessageStub {
  id: string;
  threadId: string;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

interface GmailMessage extends GmailMessageStub {
  internalDate?: string;
  sizeEstimate?: number;
  payload?: { headers?: Array<{ name: string; value: string }>; parts?: GmailPart[] } & GmailPart;
  raw?: string;
}

interface GmailCheckpoint {
  historyId?: string;
  since?: string;
  walkedAt?: string;
}

@Injectable()
export class GmailConnector implements Connector {
  readonly kind = 'gmail';
  readonly configExample = {
    query: '',
    labelIds: ['INBOX'],
    since: '2026-01-01',
    maxMessages: 2000,
  };
  readonly credentialHint = 'a connected Google account (oauth:<grant id>)';
  readonly oauth = {
    provider: 'google' as const,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  };

  enabled(): boolean {
    return sourceKindEnabled('gmail') && sourceOAuthClientEnabled();
  }

  async *enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const base = `${providerEndpoints('google').apiBase}/gmail/v1/users/me`;
    const cp = (opts.checkpoint ?? {}) as GmailCheckpoint;
    const walkStart = new Date();
    const profile = (await http.getJson(`${base}/profile`)) as { historyId?: string };
    const incremental = !opts.full && typeof cp.since === 'string';
    const since = incremental
      ? new Date(new Date(cp.since!).getTime() - OVERLAP_MS)
      : sinceOf(cfg, walkStart);
    const binary = ctx.connection.shape === 'binary';
    const gate: AdmitGate = {
      shape: 'binary',
      extensions: admittedExtensions('binary', cfg.extensions),
      maxBytes: byteCap(cfg),
    };
    const q = queryOf(cfg, since, binary);
    let listed = 0;
    for await (const stub of listMessages({ ctx, cfg, http, base, q })) {
      if (++listed > maxMessagesOf(cfg)) break;
      if (binary) {
        for (const item of await attachmentsOf({ http, base, stub, gate, ctx })) {
          yield { type: 'upsert', item };
        }
        continue;
      }
      yield { type: 'upsert', item: await describeMessage(http, base, stub) };
    }
    if (incremental && cp.historyId) {
      yield* deletions({ ctx, http, base, startHistoryId: cp.historyId });
    }
    const next: GmailCheckpoint = {
      ...(profile.historyId ? { historyId: String(profile.historyId) } : {}),
      since: walkStart.toISOString(),
      walkedAt: new Date().toISOString(),
    };
    yield { type: 'checkpoint', checkpoint: next as Record<string, unknown> };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    const http = httpOf(ctx);
    const base = `${providerEndpoints('google').apiBase}/gmail/v1/users/me`;
    if (ctx.connection.shape === 'binary') return fetchAttachment({ http, base, cfg, item });
    const msg = (await http.getJson(
      `${base}/messages/${encodeURIComponent(item.externalId)}?format=raw`,
    )) as GmailMessage;
    if (typeof msg.raw !== 'string')
      throw new Error(`gmail: message ${item.externalId} has no raw body`);
    const raw = Buffer.from(msg.raw, 'base64url');
    if (raw.length > RAW_MAX_BYTES)
      throw new Error(`gmail: message ${item.externalId} is too large`);
    const t = mailTurnOf(raw);
    return {
      shape: 'conversation',
      conversationId: msg.threadId || t.threadRoot || t.messageId || item.externalId,
      turns: [
        {
          ...t.turn,
          at: t.turn.at ?? item.modifiedAt,
          messageId: t.turn.messageId ?? item.externalId,
        },
      ],
    };
  }
}

// ── listing ───────────────────────────────────────────────────────────

async function* listMessages(p: {
  ctx: ConnectorCtx;
  cfg: GmailConnectorConfig;
  http: CloudHttp;
  base: string;
  q: string;
}): AsyncIterable<GmailMessageStub> {
  let token: string | undefined;
  do {
    if (p.ctx.signal.aborted) throw new Error('aborted');
    const url = new URL(`${p.base}/messages`);
    url.searchParams.set('q', p.q);
    url.searchParams.set('maxResults', String(PAGE_SIZE));
    for (const l of p.cfg.labelIds ?? []) url.searchParams.append('labelIds', l);
    if (p.cfg.includeSpamTrash) url.searchParams.set('includeSpamTrash', 'true');
    if (token) url.searchParams.set('pageToken', token);
    const page = (await p.http.getJson(url.toString())) as {
      messages?: GmailMessageStub[];
      nextPageToken?: string;
    };
    for (const m of page.messages ?? []) yield m;
    token = page.nextPageToken;
  } while (token);
}

/** The metadata call (headers only) → the catalogue row of a message. */
async function describeMessage(
  http: CloudHttp,
  base: string,
  stub: GmailMessageStub,
): Promise<ItemDescriptor> {
  const url = new URL(`${base}/messages/${encodeURIComponent(stub.id)}`);
  url.searchParams.set('format', 'metadata');
  for (const h of META_HEADERS) url.searchParams.append('metadataHeaders', h);
  const msg = (await http.getJson(url.toString())) as GmailMessage;
  const subject = decodeWords(headerOf(msg, 'Subject') ?? '').trim();
  const at = internalDateOf(msg);
  return {
    externalId: msg.id,
    title: subject || '(no subject)',
    originUri: `https://mail.google.com/mail/u/0/#all/${msg.threadId}`,
    mediaType: 'message/rfc822',
    ...(msg.sizeEstimate !== undefined ? { size: msg.sizeEstimate } : {}),
    // A message never changes once delivered: its id is its revision.
    revision: `id:${msg.id}`,
    ...(at ? { modifiedAt: at } : {}),
  };
}

/** The attachment rows of one message (`format=full` names the parts, not their bytes). */
async function attachmentsOf(p: {
  http: CloudHttp;
  base: string;
  stub: GmailMessageStub;
  gate: AdmitGate;
  ctx: ConnectorCtx;
}): Promise<ItemDescriptor[]> {
  const { gate, ctx } = p;
  const msg = (await p.http.getJson(
    `${p.base}/messages/${encodeURIComponent(p.stub.id)}?format=full`,
  )) as GmailMessage;
  const at = internalDateOf(msg);
  const subject = decodeWords(headerOf(msg, 'Subject') ?? '').trim();
  const out: ItemDescriptor[] = [];
  for (const part of leafParts(msg.payload)) {
    if (!part.filename || !part.body?.attachmentId || !part.partId) continue;
    const verdict = admitCloudFile(
      { name: part.filename, mediaType: part.mimeType, size: part.body.size },
      gate,
    );
    if (verdict === 'large') ctx.log(`skipped ${part.filename}: larger than the cap`);
    if (verdict !== 'admit') continue;
    const cls = classifyCloudFile({
      name: part.filename,
      mediaType: part.mimeType,
      shape: 'binary',
      extensions: gate.extensions,
    });
    out.push({
      externalId: `${msg.id}#${part.partId}`,
      title: part.filename,
      path: `${subject || msg.id}/${part.filename}`,
      originUri: `https://mail.google.com/mail/u/0/#all/${msg.threadId}`,
      mediaType: cls.mediaType,
      ...(part.body.size !== undefined ? { size: part.body.size } : {}),
      revision: `id:${msg.id}#${part.partId}`,
      ...(at ? { modifiedAt: at } : {}),
    });
  }
  return out;
}

async function fetchAttachment(p: {
  http: CloudHttp;
  base: string;
  cfg: GmailConnectorConfig;
  item: ItemDescriptor;
}): Promise<FetchedItem> {
  const [messageId, partId] = p.item.externalId.split('#');
  if (!messageId || !partId)
    throw new Error(`gmail: "${p.item.externalId}" is not an attachment id`);
  const msg = (await p.http.getJson(
    `${p.base}/messages/${encodeURIComponent(messageId)}?format=full`,
  )) as GmailMessage;
  const part = leafParts(msg.payload).find((x) => x.partId === partId);
  if (!part?.body?.attachmentId)
    throw new Error(`gmail: attachment ${p.item.externalId} is no longer on the message`);
  const got = (await p.http.getJson(
    `${p.base}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
  )) as { data?: string; size?: number };
  if (typeof got.data !== 'string')
    throw new Error(`gmail: attachment ${p.item.externalId} has no data`);
  const bytes = Buffer.from(got.data, 'base64url');
  if (bytes.length > byteCap(p.cfg))
    throw new Error(`gmail: attachment ${p.item.externalId} exceeds the cap`);
  const cls = classifyCloudFile({
    name: part.filename ?? p.item.title ?? '',
    mediaType: part.mimeType ?? p.item.mediaType,
    shape: 'binary',
    extensions: admittedExtensions('binary', p.cfg.extensions),
  });
  return {
    shape: 'binary',
    bytes,
    mediaType: cls.mediaType,
    modality: modalityOf(cls.ext),
    occurredAt: p.item.modifiedAt,
  };
}

/** Deleted messages since the checkpoint's history id; a stale id (404) is logged, not fatal. */
async function* deletions(p: {
  ctx: ConnectorCtx;
  http: CloudHttp;
  base: string;
  startHistoryId: string;
}): AsyncIterable<ItemDelta> {
  let token: string | undefined;
  const seen = new Set<string>();
  try {
    do {
      const url = new URL(`${p.base}/history`);
      url.searchParams.set('startHistoryId', p.startHistoryId);
      url.searchParams.set('historyTypes', 'messageDeleted');
      url.searchParams.set('maxResults', String(PAGE_SIZE));
      if (token) url.searchParams.set('pageToken', token);
      const page = (await p.http.getJson(url.toString())) as {
        history?: Array<{ messagesDeleted?: Array<{ message: GmailMessageStub }> }>;
        nextPageToken?: string;
      };
      for (const h of page.history ?? []) {
        for (const d of h.messagesDeleted ?? []) {
          if (seen.has(d.message.id)) continue;
          seen.add(d.message.id);
          yield { type: 'gone', externalId: d.message.id };
        }
      }
      token = page.nextPageToken;
    } while (token);
  } catch (err) {
    if (err instanceof CloudHttpError && err.status === 404) {
      p.ctx.log('gmail: the history id is too old for the feed — deletions wait for a full walk');
      return;
    }
    throw err;
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function leafParts(part: GmailPart | undefined): GmailPart[] {
  if (!part) return [];
  if (part.parts && part.parts.length > 0) return part.parts.flatMap(leafParts);
  return [part];
}

function headerOf(msg: GmailMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

function internalDateOf(msg: GmailMessage): string | null {
  const ms = Number(msg.internalDate);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function queryOf(cfg: GmailConnectorConfig, since: Date, attachments: boolean): string {
  const parts = [cfg.query?.trim() ?? '', `after:${String(Math.floor(since.getTime() / 1000))}`];
  if (attachments) parts.push('has:attachment');
  return parts.filter((s) => s.length > 0).join(' ');
}

function sinceOf(cfg: GmailConnectorConfig, now: Date): Date {
  if (cfg.since) {
    const d = new Date(cfg.since);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(now.getTime() - DEFAULT_SINCE_DAYS * 24 * 3600 * 1000);
}

function maxMessagesOf(cfg: GmailConnectorConfig): number {
  return Math.min(Math.max(1, cfg.maxMessages ?? DEFAULT_MAX_MESSAGES), HARD_MAX_MESSAGES);
}

function byteCap(cfg: GmailConnectorConfig): number {
  return Math.min(Math.max(1, cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES), HARD_MAX_FILE_BYTES);
}

function configOf(ctx: ConnectorCtx): GmailConnectorConfig {
  return ctx.connection.config as GmailConnectorConfig;
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token) throw new Error('gmail connector: no connected Google account on this connection');
  return cloudHttp({ token, private: providerEndpoints('google').private, signal: ctx.signal });
}
