import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { ImapError } from './imap-error';
import { SocketReader } from './imap-reader';
import { assertConnectableHost } from './safe-fetch';

export { ImapError } from './imap-error';

/**
 * The IMAP the `imap` connector needs and nothing more, over a TLS
 * socket the egress guard admitted first (a plain socket only under the
 * private opt-in, like plain http): greeting, LOGIN, EXAMINE (read-only
 * — the brain never flags, moves or expunges), UID SEARCH, UID FETCH,
 * LOGOUT. No dependency: the response grammar the four commands answer
 * in — atoms, quoted strings, `{n}` literals, parenthesised lists,
 * `[…]` sections — is tokenised here (`tokenize`), and a FETCH record
 * is read as attribute pairs off that. What is NOT spoken: STARTTLS,
 * SASL beyond LOGIN, IDLE, CONDSTORE / QRESYNC (the connector keeps its
 * own UID watermark), modified-UTF-7 mailbox names.
 *
 * The password never appears in an error: a refused LOGIN is named as
 * such, and the socket's own errors carry the host only.
 */
export type ImapToken = string | null | Buffer | ImapToken[];

export interface ImapFetchRecord {
  seq: number;
  /** Attribute name (upper-cased; every `BODY[…]` section as `BODY`) → its token. */
  attrs: Map<string, ImapToken>;
}

export interface ImapConnectOptions {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
  allowPrivate?: boolean | undefined;
  signal: AbortSignal;
  timeoutMs?: number | undefined;
  /** Bytes a single command's answer may carry (a mailbox listing, a message). */
  maxResponseBytes?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

interface CommandResult {
  status: 'OK' | 'NO' | 'BAD';
  text: string;
  untagged: ImapToken[][];
}

export class ImapClient {
  private tagN = 0;
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    private readonly reader: SocketReader,
    private readonly opts: ImapConnectOptions,
  ) {}

  /** Connect, read the greeting, log in. */
  static async connect(opts: ImapConnectOptions): Promise<ImapClient> {
    await assertConnectableHost(opts.host, { allowPrivate: opts.allowPrivate, tls: opts.tls });
    const socket = await open(opts);
    const reader = new SocketReader(socket, opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    const client = new ImapClient(socket, reader, opts);
    try {
      const greeting = (await reader.readLine()).toString('latin1');
      if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) {
        throw new ImapError(`imap ${opts.host}: unexpected greeting`, 'protocol');
      }
      if (!/^\* PREAUTH\b/i.test(greeting)) await client.login();
      return client;
    } catch (err) {
      client.destroy();
      throw err;
    }
  }

  private async login(): Promise<void> {
    const r = await this.command(
      `LOGIN ${quote(this.opts.user)}`,
      needsLiteral(this.opts.password) ? Buffer.from(this.opts.password, 'utf8') : undefined,
      needsLiteral(this.opts.password) ? undefined : ` ${quote(this.opts.password)}`,
    );
    if (r.status !== 'OK') {
      throw new ImapError(
        `imap ${this.opts.host}: the mailbox login was refused (${r.status}) — check the user and the password (an app password where the provider requires one)`,
        'auth',
      );
    }
  }

  /** Open a mailbox read-only. */
  async examine(mailbox: string): Promise<{ uidValidity: number; exists: number }> {
    const r = await this.command(`EXAMINE ${quote(mailbox)}`);
    if (r.status !== 'OK') {
      throw new ImapError(
        `imap ${this.opts.host}: mailbox "${mailbox}" — ${r.status} ${r.text}`,
        'no',
      );
    }
    let uidValidity = 0;
    let exists = 0;
    for (const u of r.untagged) {
      const [, a, b] = u;
      if (typeof b === 'string' && b.toUpperCase() === 'EXISTS') exists = Number(a);
      if (typeof a === 'string' && a.toUpperCase() === 'OK' && typeof b === 'string') {
        const m = /^\[UIDVALIDITY (\d+)\]$/i.exec(b);
        if (m) uidValidity = Number(m[1]);
      }
    }
    return { uidValidity, exists };
  }

  /** `UID SEARCH <criteria>` → the UIDs, ascending. */
  async uidSearch(criteria: string): Promise<number[]> {
    const r = await this.command(`UID SEARCH ${criteria}`);
    if (r.status !== 'OK')
      throw new ImapError(`imap ${this.opts.host}: search — ${r.status} ${r.text}`, 'no');
    const out: number[] = [];
    for (const u of r.untagged) {
      if (typeof u[1] === 'string' && u[1].toUpperCase() === 'SEARCH') {
        for (const t of u.slice(2))
          if (typeof t === 'string' && /^\d+$/.test(t)) out.push(Number(t));
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** `UID FETCH <set> (<items>)` → one record per message, in the order the server sent them. */
  async uidFetch(set: string, items: string): Promise<ImapFetchRecord[]> {
    const r = await this.command(`UID FETCH ${set} (${items})`);
    if (r.status !== 'OK')
      throw new ImapError(`imap ${this.opts.host}: fetch — ${r.status} ${r.text}`, 'no');
    const out: ImapFetchRecord[] = [];
    for (const u of r.untagged) {
      const [, seq, verb, list] = u;
      if (typeof verb !== 'string' || verb.toUpperCase() !== 'FETCH' || !Array.isArray(list))
        continue;
      const attrs = new Map<string, ImapToken>();
      for (let i = 0; i + 1 < list.length; i += 2) {
        const key = list[i];
        if (typeof key !== 'string') continue;
        const upper = key.toUpperCase();
        attrs.set(upper.startsWith('BODY[') ? 'BODY' : upper, list[i + 1] ?? null);
      }
      out.push({ seq: Number(seq), attrs });
    }
    return out;
  }

  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      await this.command('LOGOUT');
    } catch {
      // The server may drop the socket on BYE before the tagged line lands.
    } finally {
      this.destroy();
    }
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }

  /**
   * Send one command and collect its answer: every untagged line
   * (tokenised, literals inline) until the tagged status line. A
   * literal argument is sent after the server's `+` continuation.
   */
  private async command(cmd: string, literal?: Buffer, tail?: string): Promise<CommandResult> {
    if (this.closed) throw new ImapError(`imap ${this.opts.host}: connection closed`, 'network');
    const tag = `A${String(++this.tagN).padStart(4, '0')}`;
    this.socket.write(
      literal ? `${tag} ${cmd} {${String(literal.length)}}\r\n` : `${tag} ${cmd}${tail ?? ''}\r\n`,
    );
    const untagged: ImapToken[][] = [];
    for (;;) {
      if (this.opts.signal.aborted) throw new ImapError('aborted', 'network');
      const line = await this.readLogicalLine();
      const head = line[0];
      const text = typeof head === 'string' ? head : '';
      if (text.startsWith('+')) {
        if (literal) {
          this.socket.write(literal);
          this.socket.write('\r\n');
          literal = undefined;
        }
        continue;
      }
      if (text.startsWith(`${tag} `)) {
        const m = /^\S+ (OK|NO|BAD)\b\s*(.*)$/i.exec(text);
        if (!m)
          throw new ImapError(`imap ${this.opts.host}: malformed tagged response`, 'protocol');
        return {
          status: m[1]!.toUpperCase() as CommandResult['status'],
          text: (m[2] ?? '').slice(0, 300),
          untagged,
        };
      }
      if (text.startsWith('* ')) {
        const tokens = tokenize(line);
        if (typeof tokens[1] === 'string' && tokens[1].toUpperCase() === 'BYE') {
          throw new ImapError(`imap ${this.opts.host}: the server said BYE`, 'network');
        }
        untagged.push(tokens);
        continue;
      }
      throw new ImapError(`imap ${this.opts.host}: unexpected line`, 'protocol');
    }
  }

  /** A response line with its `{n}` literals pulled in as buffer segments. */
  private async readLogicalLine(): Promise<Array<string | Buffer>> {
    const segments: Array<string | Buffer> = [];
    for (;;) {
      const text = (await this.reader.readLine()).toString('latin1');
      segments.push(text);
      const m = /\{(\d+)\}$/.exec(text);
      if (!m) return segments;
      segments.push(await this.reader.readBytes(Number(m[1])));
    }
  }
}

// ── socket ────────────────────────────────────────────────────────────

function open(opts: ImapConnectOptions): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const onError = (err: Error) =>
      reject(new ImapError(`imap ${opts.host}:${String(opts.port)}: ${err.message}`, 'network'));
    const socket: Socket = opts.tls
      ? tlsConnect({ host: opts.host, port: opts.port, servername: opts.host }, () =>
          resolve(socket),
        )
      : netConnect({ host: opts.host, port: opts.port }, () => resolve(socket));
    socket.once('error', onError);
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timeout')));
    const onAbort = () => socket.destroy(new Error('aborted'));
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    socket.once('close', () => opts.signal.removeEventListener('abort', onAbort));
  });
}

// ── grammar ───────────────────────────────────────────────────────────

/**
 * Tokenise one logical response line. Text segments alternate with the
 * literal buffers their trailing `{n}` announced; a literal is one
 * token. `(`…`)` nests; `[`…`]` is kept inside its atom (a `BODY[…]`
 * section, a `[UIDVALIDITY n]` code); `NIL` is null.
 */
export function tokenize(segments: Array<string | Buffer>): ImapToken[] {
  const root: ImapToken[] = [];
  const stack: ImapToken[][] = [root];
  for (const seg of segments) {
    if (Buffer.isBuffer(seg)) stack[stack.length - 1]!.push(seg);
    else tokenizeText(seg, stack);
  }
  return root;
}

/** One text segment's tokens onto the open list; `(` opens a list, `)` closes it. */
function tokenizeText(seg: string, stack: ImapToken[][]): void {
  let i = 0;
  while (i < seg.length) {
    const ch = seg[i]!;
    if (ch === ' ') {
      i++;
    } else if (ch === '(') {
      const list: ImapToken[] = [];
      stack[stack.length - 1]!.push(list);
      stack.push(list);
      i++;
    } else if (ch === ')') {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (ch === '"') {
      const q = readQuoted(seg, i);
      stack[stack.length - 1]!.push(q.value);
      i = q.end;
    } else if (ch === '{' && /^\{\d+\}$/.test(seg.slice(i))) {
      // The literal itself is the next segment.
      i = seg.length;
    } else {
      const a = readAtom(seg, i);
      stack[stack.length - 1]!.push(a.value.toUpperCase() === 'NIL' ? null : a.value);
      i = a.end;
    }
  }
}

/** `"…"` with `\` escapes, from the opening quote at `i`. */
function readQuoted(seg: string, i: number): { value: string; end: number } {
  let j = i + 1;
  let out = '';
  while (j < seg.length && seg[j] !== '"') {
    if (seg[j] === '\\' && j + 1 < seg.length) j++;
    out += seg[j];
    j++;
  }
  return { value: out, end: j + 1 };
}

/** An atom, `[…]` sections included (a `BODY[HEADER.FIELDS (…)]` key, a `[UIDVALIDITY n]` code). */
function readAtom(seg: string, i: number): { value: string; end: number } {
  let j = i;
  let depth = 0;
  while (j < seg.length) {
    const c = seg[j]!;
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (depth <= 0 && (c === ' ' || c === '(' || c === ')')) break;
    j++;
  }
  return { value: seg.slice(i, j), end: j };
}

/** A quoted string: `\` and `"` escaped. */
export function quote(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Non-ASCII or control characters cannot ride in a quoted string. */
function needsLiteral(s: string): boolean {
  return /[^\x20-\x7e]/.test(s) || s.includes('\r') || s.includes('\n');
}

/** `[1,2,3,7,8]` → `1:3,7:8` — the shortest sequence-set. */
export function sequenceSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = -1;
  let prev = -1;
  for (const u of sorted) {
    if (start === -1) {
      start = prev = u;
    } else if (u === prev + 1) {
      prev = u;
    } else {
      runs.push(start === prev ? String(start) : `${String(start)}:${String(prev)}`);
      start = prev = u;
    }
  }
  if (start !== -1) runs.push(start === prev ? String(start) : `${String(start)}:${String(prev)}`);
  return runs.join(',');
}

/** `dd-Mon-yyyy` for SEARCH SINCE. */
export function imapDate(d: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${String(d.getUTCDate())}-${months[d.getUTCMonth()]!}-${String(d.getUTCFullYear())}`;
}

/** `"01-Jan-2026 10:00:00 +0000"` → ISO, or null. */
export function internalDateOf(token: ImapToken | undefined): string | null {
  if (typeof token !== 'string') return null;
  const d = new Date(token.replace(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/, '$1 $2 $3'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
