import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One loopback server that plays Slack (OAuth v2 consent → code, the
 * form token endpoint answering the bot token, `auth.test`,
 * `conversations.list` / `.history` / `.replies`, `users.info` — every
 * failure as Slack does it: HTTP 200 with `ok: false`) and the Telegram
 * Bot API (`/bot<token>/getUpdates` with offset acknowledgement and the
 * 24-hour window, `ok: false` with an error_code) for the chat-connector
 * suites, reached through SOURCE_OAUTH_SLACK_BASE_URL /
 * SOURCE_TELEGRAM_API_BASE under SOURCE_EGRESS_ALLOW_PRIVATE.
 */
export interface SlackFakeMessage {
  ts: string;
  user?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  edited?: { ts: string };
  files?: Array<{ name: string }>;
  username?: string;
}

export interface FakeChat {
  base: string;
  close(): Promise<void>;
  calls: Array<{ method: string; path: string; auth: string | null; body: string }>;
  slack: {
    codes: Set<string>;
    tokens: Set<string>;
    teamId: string;
    teamName: string;
    teamUrl: string;
    users: Record<string, { name: string; real_name: string }>;
    channels: Array<{ id: string; name: string; is_member: boolean; is_private?: boolean }>;
    /** Channel id → messages (any order; served newest first). */
    messages: Record<string, SlackFakeMessage[]>;
    /** Answered once instead of that method's next result (`missing_scope`, `ratelimited`, …). */
    nextError: { method: string; error: string } | null;
  };
  telegram: {
    token: string;
    /** Updates in order of update_id. */
    updates: Array<Record<string, unknown> & { update_id: number }>;
    /** Set → getUpdates answers 409 (a webhook is set). */
    webhookSet: boolean;
  };
}

export async function startFakeChat(): Promise<FakeChat> {
  let serial = 0;
  const f: FakeChat = {
    base: '',
    close: async () => undefined,
    calls: [],
    slack: {
      codes: new Set(),
      tokens: new Set(),
      teamId: 'T0ACME',
      teamName: 'Acme',
      teamUrl: 'https://acme.slack.com/',
      users: {},
      channels: [],
      messages: {},
      nextError: null,
    },
    telegram: { token: '123456:ABC-bot-token', updates: [], webhookSet: false },
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      f.calls.push({
        method: req.method ?? '',
        path: req.url ?? '',
        auth: req.headers.authorization ?? null,
        body,
      });
      try {
        route(f, req, res, body, () => `xoxb-${++serial}`);
      } catch (e) {
        json(res, 500, { ok: false, error: (e as Error).message });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  f.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return f;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function route(
  f: FakeChat,
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  mint: () => string,
): void {
  const url = new URL(req.url ?? '/', f.base);
  const p = url.pathname;
  const m = req.method ?? 'GET';
  // ── Slack OAuth v2 ──
  if (p === '/oauth/v2/authorize') {
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    const code = `sl_code_${f.slack.codes.size + 1}`;
    f.slack.codes.add(code);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><body><h2>Fake Slack (scope ${escapeHtml(url.searchParams.get('scope') ?? '')})</h2><p><a id="allow" href="${escapeHtml(back.toString())}">Allow</a></p></body></html>`,
    );
    return;
  }
  if (m === 'POST' && p === '/api/oauth.v2.access') {
    const params = new URLSearchParams(body);
    if (params.get('client_id') !== 'sl-client' || params.get('client_secret') !== 'sl-secret')
      return json(res, 200, { ok: false, error: 'invalid_client_id' });
    if (!f.slack.codes.has(params.get('code') ?? ''))
      return json(res, 200, { ok: false, error: 'invalid_code' });
    f.slack.codes.delete(params.get('code')!);
    const token = mint();
    f.slack.tokens.add(token);
    return json(res, 200, {
      ok: true,
      access_token: token,
      token_type: 'bot',
      scope: 'channels:history,channels:read,groups:history,groups:read,users:read',
      bot_user_id: 'UBOT',
      team: { id: f.slack.teamId, name: f.slack.teamName },
      authed_user: { id: 'U1' },
    });
  }
  if (p.startsWith('/api/')) return slack(f, req, url, res, p.slice('/api/'.length));
  // ── Telegram Bot API ──
  const tg = /^\/bot([^/]+)\/(\w+)$/.exec(p);
  if (tg) return telegram(f, url, res, tg[1]!, tg[2]!);
  return json(res, 404, { ok: false, error: `no route ${p}` });
}

function slack(
  f: FakeChat,
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  method: string,
): void {
  const bearer = (req.headers.authorization ?? '').startsWith('Bearer ')
    ? (req.headers.authorization ?? '').slice(7)
    : '';
  if (!f.slack.tokens.has(bearer)) return json(res, 200, { ok: false, error: 'invalid_auth' });
  const s = f.slack;
  if (s.nextError?.method === method) {
    const { error } = s.nextError;
    s.nextError = null;
    return json(res, 200, {
      ok: false,
      error,
      ...(error === 'missing_scope' ? { needed: 'channels:history' } : {}),
    });
  }
  if (method === 'auth.test')
    return json(res, 200, {
      ok: true,
      url: s.teamUrl,
      team: s.teamName,
      user: 'brain',
      team_id: s.teamId,
      user_id: 'UBOT',
    });
  if (method === 'auth.revoke') return json(res, 200, { ok: true, revoked: true });
  if (method === 'conversations.list')
    return json(res, 200, {
      ok: true,
      channels: s.channels.map((c) => ({ ...c, is_archived: false })),
      response_metadata: { next_cursor: '' },
    });
  if (method === 'users.info') {
    const u = s.users[url.searchParams.get('user') ?? ''];
    if (!u) return json(res, 200, { ok: false, error: 'user_not_found' });
    return json(res, 200, { ok: true, user: { id: url.searchParams.get('user'), ...u } });
  }
  if (method === 'conversations.history' || method === 'conversations.replies') {
    const channel = url.searchParams.get('channel') ?? '';
    const ch = s.channels.find((c) => c.id === channel);
    if (!ch) return json(res, 200, { ok: false, error: 'channel_not_found' });
    if (!ch.is_member) return json(res, 200, { ok: false, error: 'not_in_channel' });
    const all = s.messages[channel] ?? [];
    if (method === 'conversations.replies') {
      const ts = url.searchParams.get('ts') ?? '';
      const thread = all
        .filter((x) => x.ts === ts || x.thread_ts === ts)
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      return json(res, 200, { ok: true, messages: thread, response_metadata: { next_cursor: '' } });
    }
    const oldest = Number(url.searchParams.get('oldest') ?? 0);
    const latest = url.searchParams.get('latest');
    const inclusive = url.searchParams.get('inclusive') === 'true';
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const roots = all
      .filter((x) => !x.thread_ts || x.thread_ts === x.ts)
      .filter((x) => (inclusive ? Number(x.ts) >= oldest : Number(x.ts) > oldest))
      .filter(
        (x) =>
          latest === null ||
          (inclusive ? Number(x.ts) <= Number(latest) : Number(x.ts) < Number(latest)),
      )
      .sort((a, b) => Number(b.ts) - Number(a.ts))
      .map((x) => ({
        type: 'message',
        ...x,
        ...(all.some((r) => r.thread_ts === x.ts && r.ts !== x.ts)
          ? { reply_count: all.filter((r) => r.thread_ts === x.ts && r.ts !== x.ts).length }
          : {}),
      }));
    const page = roots.slice(start, start + limit);
    return json(res, 200, {
      ok: true,
      messages: page,
      has_more: start + limit < roots.length,
      response_metadata: { next_cursor: start + limit < roots.length ? String(start + limit) : '' },
    });
  }
  return json(res, 200, { ok: false, error: 'unknown_method' });
}

function telegram(f: FakeChat, url: URL, res: ServerResponse, token: string, method: string): void {
  if (token !== f.telegram.token)
    return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
  if (method !== 'getUpdates')
    return json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
  if (f.telegram.webhookSet)
    return json(res, 409, {
      ok: false,
      error_code: 409,
      description:
        "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
    });
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 100);
  // Acknowledgement: everything below the offset is gone for good.
  f.telegram.updates = f.telegram.updates.filter((u) => u.update_id >= offset);
  const page = f.telegram.updates.filter((u) => u.update_id >= offset).slice(0, limit);
  return json(res, 200, { ok: true, result: page });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
