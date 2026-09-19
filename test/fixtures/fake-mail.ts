import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * Two loopback servers for the mail-connector suites:
 *  - HTTP: Google's OAuth (consent page → code; PKCE form token endpoint;
 *    userinfo) and the Gmail REST API the connector speaks — profile,
 *    messages.list (a Gmail-query subset: `after:<epoch>`,
 *    `has:attachment`, `label:x`), messages.get in metadata / full /
 *    raw formats, attachments.get, history.list (messageDeleted only);
 *  - TCP: an IMAP server speaking exactly the subset the brain's client
 *    sends — greeting, LOGIN (quoted or literal), EXAMINE, UID SEARCH
 *    (SINCE / UID), UID FETCH with UID / INTERNALDATE / RFC822.SIZE /
 *    BODY.PEEK[HEADER.FIELDS (…)] / BODY.PEEK[], LOGOUT — every literal
 *    the real thing would send.
 *
 * Messages are raw RFC 822 text; tests add and delete them between runs
 * and read `calls` / `imapCommands` to assert what the brain asked for.
 */
export interface FakeMailMessage {
  id: string;
  threadId: string;
  /** Epoch ms. */
  internalDate: number;
  labelIds: string[];
  raw: string;
  /** Attachments the `full` format names (`raw` carries them too). */
  attachments?: Array<{ partId: string; filename: string; mimeType: string; data: Buffer }>;
}

export interface FakeImapMessage {
  uid: number;
  /** `dd-Mon-yyyy HH:MM:SS +0000`. */
  internalDate: string;
  raw: string;
}

export interface FakeMail {
  base: string;
  imapHost: string;
  imapPort: number;
  close(): Promise<void>;
  calls: Array<{ method: string; path: string; auth: string | null; body: string }>;
  imapCommands: string[];
  google: {
    codes: Set<string>;
    tokens: Set<string>;
    email: string;
    historyId: number;
    messages: Map<string, FakeMailMessage>;
    /** Deleted message ids with the history id the deletion happened at. */
    deleted: Array<{ id: string; historyId: number }>;
    /** History ids older than this are "too old" (404). */
    historyFloor: number;
    /** Smoke stands only: any bearer passes (another fake minted it). */
    anyBearer?: boolean;
  };
  imap: {
    user: string;
    password: string;
    mailboxes: Map<string, { uidValidity: number; messages: FakeImapMessage[] }>;
  };
}

export async function startFakeMail(): Promise<FakeMail> {
  let serial = 0;
  const f: FakeMail = {
    base: '',
    imapHost: '127.0.0.1',
    imapPort: 0,
    close: async () => undefined,
    calls: [],
    imapCommands: [],
    google: {
      codes: new Set(),
      tokens: new Set(),
      email: 'mike@example.test',
      historyId: 1000,
      messages: new Map(),
      deleted: [],
      historyFloor: 1,
    },
    imap: { user: 'mike@example.test', password: 'app-pass-w0rd', mailboxes: new Map() },
  };
  const http: Server = createServer((req, res) => {
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
        route(f, req, res, body, () => `tok_${++serial}`);
      } catch (e) {
        json(res, 500, { error: (e as Error).message });
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  f.base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const tcp: TcpServer = createTcpServer((socket) => imapSession(f, socket));
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  f.imapPort = (tcp.address() as AddressInfo).port;
  f.close = async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  };
  return f;
}

/** A message from its headers and body, the raw RFC 822 text the fakes serve. */
export function rfc822(p: {
  from: string;
  to?: string;
  subject: string;
  date: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  body: string;
  attachments?: Array<{ filename: string; mimeType: string; data: Buffer }>;
}): string {
  const headers = [
    `From: ${p.from}`,
    `To: ${p.to ?? 'mike@example.test'}`,
    `Subject: ${p.subject}`,
    `Date: ${p.date}`,
    `Message-ID: <${p.messageId}>`,
    ...(p.inReplyTo ? [`In-Reply-To: <${p.inReplyTo}>`] : []),
    ...(p.references && p.references.length > 0
      ? [`References: ${p.references.map((r) => `<${r}>`).join(' ')}`]
      : []),
    'MIME-Version: 1.0',
  ];
  if (!p.attachments || p.attachments.length === 0) {
    return [...headers, 'Content-Type: text/plain; charset=utf-8', '', p.body].join('\r\n');
  }
  const boundary = 'b0undary42';
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    p.body,
    ...p.attachments.flatMap((a) => [
      `--${boundary}`,
      `Content-Type: ${a.mimeType}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      a.data.toString('base64'),
    ]),
    `--${boundary}--`,
  ];
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join(
    '\r\n',
  );
}

// ── HTTP: Google OAuth + Gmail ────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function route(
  f: FakeMail,
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  mint: () => string,
): void {
  const url = new URL(req.url ?? '/', f.base);
  const p = url.pathname;
  const m = req.method ?? 'GET';
  if (m === 'GET' && p === '/o/oauth2/v2/auth') {
    if (!url.searchParams.get('code_challenge'))
      return json(res, 400, { error: 'no PKCE challenge' });
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    const code = `g_code_${f.google.codes.size + 1}`;
    f.google.codes.add(code);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><body><h2>Fake Google (scope ${escapeHtml(url.searchParams.get('scope') ?? '')})</h2><p><a id="allow" href="${escapeHtml(back.toString())}">Allow</a></p></body></html>`,
    );
    return;
  }
  if (m === 'POST' && p === '/token') {
    const params = new URLSearchParams(body);
    const grant = params.get('grant_type');
    if (grant === 'authorization_code') {
      if (!f.google.codes.has(params.get('code') ?? ''))
        return json(res, 400, { error: 'invalid_grant' });
      if (!params.get('code_verifier')) return json(res, 400, { error: 'invalid_request' });
      f.google.codes.delete(params.get('code')!);
    } else if (grant !== 'refresh_token' || !params.get('refresh_token')?.startsWith('rt_')) {
      return json(res, 400, { error: 'invalid_grant' });
    }
    const access = mint();
    f.google.tokens.add(access);
    return json(res, 200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: `rt_${access}`,
      scope: params.get('scope') ?? '',
    });
  }
  if (m === 'POST' && p === '/revoke') return json(res, 200, {});
  const bearer = (req.headers.authorization ?? '').startsWith('Bearer ')
    ? (req.headers.authorization ?? '').slice(7)
    : '';
  if (!f.google.anyBearer && !f.google.tokens.has(bearer))
    return json(res, 401, { error: { message: 'invalid token' } });
  if (p === '/oauth2/v3/userinfo') return json(res, 200, { email: f.google.email, sub: '1' });
  if (p.startsWith('/gmail/v1/users/me'))
    return gmail(f, url, res, p.slice('/gmail/v1/users/me'.length));
  return json(res, 404, { error: { message: `no route ${p}` } });
}

function gmail(f: FakeMail, url: URL, res: ServerResponse, rest: string): void {
  const g = f.google;
  if (rest === '/profile')
    return json(res, 200, {
      emailAddress: g.email,
      historyId: String(g.historyId),
      messagesTotal: g.messages.size,
    });
  if (rest === '/messages') {
    const q = url.searchParams.get('q') ?? '';
    const labels = url.searchParams.getAll('labelIds');
    const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
    const needAttachment = /\bhas:attachment\b/.test(q);
    const label = /\blabel:(\S+)/.exec(q)?.[1];
    const all = [...g.messages.values()]
      .filter((x) => x.internalDate >= after)
      .filter((x) => !needAttachment || (x.attachments?.length ?? 0) > 0)
      .filter((x) => !label || x.labelIds.includes(label.toUpperCase()))
      .filter((x) => labels.every((l) => x.labelIds.includes(l)))
      .sort((a, b) => b.internalDate - a.internalDate);
    const max = Number(url.searchParams.get('maxResults') ?? 100);
    const start = Number(url.searchParams.get('pageToken') ?? 0);
    const page = all.slice(start, start + max);
    return json(res, 200, {
      messages: page.map((x) => ({ id: x.id, threadId: x.threadId })),
      ...(start + max < all.length ? { nextPageToken: String(start + max) } : {}),
      resultSizeEstimate: all.length,
    });
  }
  if (rest === '/history') {
    const start = Number(url.searchParams.get('startHistoryId') ?? 0);
    if (start < g.historyFloor) return json(res, 404, { error: { message: 'history too old' } });
    const history = g.deleted
      .filter((d) => d.historyId > start)
      .map((d) => ({
        id: String(d.historyId),
        messagesDeleted: [{ message: { id: d.id, threadId: '' } }],
      }));
    return json(res, 200, { history, historyId: String(g.historyId) });
  }
  const att = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(rest);
  if (att) {
    const msg = g.messages.get(decodeURIComponent(att[1]!));
    const a = msg?.attachments?.find((x) => `att_${x.partId}` === decodeURIComponent(att[2]!));
    if (!a) return json(res, 404, { error: { message: 'no attachment' } });
    return json(res, 200, { size: a.data.length, data: a.data.toString('base64url') });
  }
  const one = /^\/messages\/([^/]+)$/.exec(rest);
  if (one) {
    const msg = g.messages.get(decodeURIComponent(one[1]!));
    if (!msg) return json(res, 404, { error: { message: 'not found' } });
    const format = url.searchParams.get('format') ?? 'full';
    const base = {
      id: msg.id,
      threadId: msg.threadId,
      labelIds: msg.labelIds,
      internalDate: String(msg.internalDate),
      sizeEstimate: msg.raw.length,
    };
    if (format === 'raw')
      return json(res, 200, { ...base, raw: Buffer.from(msg.raw, 'utf8').toString('base64url') });
    const headers = headersOf(msg.raw);
    if (format === 'metadata') {
      const wanted = url.searchParams.getAll('metadataHeaders').map((h) => h.toLowerCase());
      return json(res, 200, {
        ...base,
        payload: {
          headers: headers.filter(
            (h) => wanted.length === 0 || wanted.includes(h.name.toLowerCase()),
          ),
        },
      });
    }
    return json(res, 200, {
      ...base,
      payload: {
        partId: '',
        mimeType: msg.attachments?.length ? 'multipart/mixed' : 'text/plain',
        headers,
        parts: [
          {
            partId: '0',
            mimeType: 'text/plain',
            filename: '',
            body: { size: 10, data: 'aGVsbG8' },
          },
          ...(msg.attachments ?? []).map((a) => ({
            partId: a.partId,
            mimeType: a.mimeType,
            filename: a.filename,
            body: { attachmentId: `att_${a.partId}`, size: a.data.length },
          })),
        ],
      },
    });
  }
  return json(res, 404, { error: { message: `no gmail route ${rest}` } });
}

function headersOf(raw: string): Array<{ name: string; value: string }> {
  const head = raw.split(/\r?\n\r?\n/)[0] ?? '';
  return head
    .replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf(':');
      return i > 0 ? { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : null;
    })
    .filter((h): h is { name: string; value: string } => h !== null);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

// ── TCP: IMAP ─────────────────────────────────────────────────────────

function imapSession(f: FakeMail, socket: Socket): void {
  let buf = '';
  let loggedIn = false;
  let selected: string | null = null;
  let pendingLiteral: { tag: string; cmd: string; args: string; need: number } | null = null;
  const send = (s: string): void => {
    socket.write(`${s}\r\n`);
  };
  send('* OK Fake IMAP ready');
  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString('latin1');
    for (;;) {
      if (pendingLiteral) {
        if (buf.length < pendingLiteral.need + 2) return;
        const literal = buf.slice(0, pendingLiteral.need);
        buf = buf.slice(pendingLiteral.need + 2);
        const { tag, cmd, args } = pendingLiteral;
        pendingLiteral = null;
        handle(tag, cmd, `${args} ${quoteImap(Buffer.from(literal, 'latin1').toString('utf8'))}`);
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      f.imapCommands.push(line.replace(/(LOGIN "[^"]*") .*$/i, '$1 <redacted>'));
      const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
      if (!m) {
        send('* BAD malformed');
        continue;
      }
      const [, tag, cmd, args = ''] = m;
      const lit = /\{(\d+)\}$/.exec(args);
      if (lit) {
        pendingLiteral = {
          tag: tag!,
          cmd: cmd!,
          args: args.slice(0, lit.index).trim(),
          need: Number(lit[1]),
        };
        send('+ go ahead');
        continue;
      }
      handle(tag!, cmd!, args);
    }
  });
  socket.on('error', () => undefined);

  function handle(tag: string, cmd: string, args: string): void {
    const upper = cmd.toUpperCase();
    if (upper === 'LOGIN') {
      const [user, pass] = unquoteAll(args);
      if (user === f.imap.user && pass === f.imap.password) {
        loggedIn = true;
        return send(`${tag} OK LOGIN completed`);
      }
      return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
    }
    if (upper === 'LOGOUT') {
      send('* BYE see you');
      send(`${tag} OK LOGOUT completed`);
      socket.end();
      return;
    }
    if (upper === 'CAPABILITY') {
      send('* CAPABILITY IMAP4rev1 UIDPLUS');
      return send(`${tag} OK done`);
    }
    if (!loggedIn) return send(`${tag} NO not logged in`);
    if (upper === 'EXAMINE' || upper === 'SELECT') {
      const [name] = unquoteAll(args);
      const box = f.imap.mailboxes.get(name ?? '');
      if (!box) return send(`${tag} NO [NONEXISTENT] no such mailbox`);
      selected = name!;
      send(`* ${String(box.messages.length)} EXISTS`);
      send('* 0 RECENT');
      send(`* OK [UIDVALIDITY ${String(box.uidValidity)}] UIDs valid`);
      send(
        `* OK [UIDNEXT ${String(Math.max(0, ...box.messages.map((x) => x.uid)) + 1)}] Predicted next UID`,
      );
      return send(`${tag} OK [READ-ONLY] EXAMINE completed`);
    }
    const box = selected ? f.imap.mailboxes.get(selected) : undefined;
    if (!box) return send(`${tag} NO no mailbox selected`);
    if (upper === 'UID') {
      const sub = /^(SEARCH|FETCH) (.*)$/i.exec(args);
      if (!sub) return send(`${tag} BAD unknown UID command`);
      if (sub[1]!.toUpperCase() === 'SEARCH') {
        const uids = searchUids(box.messages, sub[2]!);
        send(`* SEARCH${uids.map((u) => ` ${String(u)}`).join('')}`);
        return send(`${tag} OK SEARCH completed`);
      }
      const fm = /^(\S+) \((.*)\)$/.exec(sub[2]!);
      if (!fm) return send(`${tag} BAD fetch syntax`);
      const wanted = uidsOfSet(fm[1]!, box.messages);
      for (const msg of box.messages) {
        if (!wanted.has(msg.uid)) continue;
        const seq = box.messages.indexOf(msg) + 1;
        socket.write(`* ${String(seq)} FETCH (${fetchItems(msg, fm[2]!)})\r\n`);
      }
      return send(`${tag} OK FETCH completed`);
    }
    if (upper === 'NOOP') return send(`${tag} OK NOOP`);
    return send(`${tag} BAD unknown command ${cmd}`);
  }
}

function fetchItems(msg: FakeImapMessage, items: string): string {
  const out: string[] = [];
  const upper = items.toUpperCase();
  if (/\bUID\b/.test(upper)) out.push(`UID ${String(msg.uid)}`);
  if (upper.includes('INTERNALDATE')) out.push(`INTERNALDATE "${msg.internalDate}"`);
  if (upper.includes('RFC822.SIZE'))
    out.push(`RFC822.SIZE ${String(Buffer.byteLength(msg.raw, 'latin1'))}`);
  const hf = /BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\]/i.exec(items);
  if (hf) {
    const names = hf[1]!.split(/\s+/).map((n) => n.toLowerCase());
    const head = (msg.raw.split(/\r?\n\r?\n/)[0] ?? '')
      .split(/\r?\n(?![ \t])/)
      .filter((line) => names.includes(line.slice(0, line.indexOf(':')).trim().toLowerCase()))
      .join('\r\n');
    const literal = `${head}\r\n\r\n`;
    out.push(
      `BODY[HEADER.FIELDS (${hf[1]})] {${String(Buffer.byteLength(literal, 'latin1'))}}\r\n${literal}`,
    );
  } else if (/BODY\.PEEK\[\]/i.test(items)) {
    out.push(`BODY[] {${String(Buffer.byteLength(msg.raw, 'latin1'))}}\r\n${msg.raw}`);
  }
  return out.join(' ');
}

function searchUids(messages: FakeImapMessage[], criteria: string): number[] {
  const uidSet = /^UID (\S+)$/i.exec(criteria);
  if (uidSet) return [...uidsOfSet(uidSet[1]!, messages)].sort((a, b) => a - b);
  const since = /SINCE (\S+)/i.exec(criteria);
  const floor = since
    ? new Date(since[1]!.replace(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/, '$1 $2 $3')).getTime()
    : 0;
  return messages
    .filter(
      (m) =>
        new Date(
          m.internalDate.replace(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/, '$1 $2 $3'),
        ).getTime() >= floor,
    )
    .map((m) => m.uid)
    .sort((a, b) => a - b);
}

/** `1:3,7,10:*` over the mailbox's UIDs. */
function uidsOfSet(set: string, messages: FakeImapMessage[]): Set<number> {
  const max = Math.max(0, ...messages.map((m) => m.uid));
  const out = new Set<number>();
  for (const piece of set.split(',')) {
    const [a, b] = piece.split(':');
    const lo = Number(a);
    const hi = b === undefined ? lo : b === '*' ? max : Number(b);
    for (const m of messages) {
      // RFC 3501: `n:*` with n above the highest UID still matches the highest.
      if (
        (m.uid >= Math.min(lo, hi) && m.uid <= Math.max(lo, hi)) ||
        (b === '*' && m.uid === max && lo > max)
      )
        out.add(m.uid);
    }
  }
  return out;
}

function unquoteAll(args: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const m of args.matchAll(re))
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? ''));
  return out;
}

function quoteImap(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}
