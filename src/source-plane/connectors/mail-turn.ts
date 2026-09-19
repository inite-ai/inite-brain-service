import {
  decodeWords,
  parseMail,
  type MailHeaders,
  type ParsedMail,
} from '../../evidence/processing/adapters/mail-text';
import type { ConversationTurn } from '../connector';

/**
 * A mail message as one turn of a conversation (raw-evidence-sources
 * doctrine 2: mail threads are conversation-shaped and enter through
 * `ingest/mention` → episodes). Shared by the `gmail` and `imap`
 * connectors — the vendor decides how the bytes arrive, this decides
 * what a turn says:
 *
 *  - the speaker is the sender's display name, else the address's local part;
 *  - the text is the body less what the sender did not write — quoted
 *    replies (`> …`), the "On … wrote:" / "Original Message" /
 *    "Forwarded message" blocks and everything under them, the
 *    signature under `-- ` — and, for a thread starter (no
 *    In-Reply-To / References), the subject on top;
 *  - attachments are named, never inlined;
 *  - the message's own Message-ID is the turn's messageId; the thread is
 *    the first id in References, else In-Reply-To, else the message
 *    itself.
 */
export interface MailTurn {
  turn: ConversationTurn;
  subject: string;
  /** Message-ID without the angle brackets, when the message has one. */
  messageId: string | null;
  /** The thread's root Message-ID (References first, else In-Reply-To), null for a starter. */
  threadRoot: string | null;
  parsed: ParsedMail;
}

const MAX_TURN_CHARS = 16_000;

export function mailTurnOf(raw: Buffer, opts: { maxParts?: number | undefined } = {}): MailTurn {
  const parsed = parseMail(raw, { maxParts: opts.maxParts });
  const h = parsed.headers;
  const subject = decodeWords(h.get('Subject') ?? '').trim();
  const messageId = idOf(h.get('Message-ID'));
  const threadRoot = threadRootOf(h);
  const text = turnText({ parsed, subject, starter: threadRoot === null });
  const at = dateOf(h.get('Date'));
  return {
    turn: {
      text,
      speaker: speakerOf(h.get('From')),
      ...(at ? { at } : {}),
      ...(messageId ? { messageId } : {}),
    },
    subject,
    messageId,
    threadRoot,
    parsed,
  };
}

export function turnText(p: { parsed: ParsedMail; subject: string; starter: boolean }): string {
  const body = stripQuotes(p.parsed.body);
  const parts: string[] = [];
  if (p.starter && p.subject.length > 0) parts.push(`Subject: ${p.subject}`);
  if (body.length > 0) parts.push(body);
  if (p.parsed.attachments.length > 0)
    parts.push(p.parsed.attachments.map((a) => `[attachment: ${a.name}]`).join('\n'));
  return parts.join('\n\n').slice(0, MAX_TURN_CHARS);
}

/** The first id in References (the thread's root), else In-Reply-To, else null. */
export function threadRootOf(h: MailHeaders): string | null {
  const refs = idsOf(h.get('References'));
  if (refs[0]) return refs[0];
  return idOf(h.get('In-Reply-To'));
}

/** Angle-bracketed message ids in a header, in order. */
export function idsOf(v: string | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const m of v.matchAll(/<([^<>\s]+)>/g)) if (m[1]) out.push(m[1]);
  return out;
}

export function idOf(v: string | undefined): string | null {
  const ids = idsOf(v);
  if (ids[0]) return ids[0];
  const bare = v?.trim();
  return bare && /^[^\s<>]+@[^\s<>]+$/.test(bare) ? bare : null;
}

export interface MailAddress {
  name: string | null;
  address: string;
}

/** `Name <a@b>, "Other" <c@d>, e@f` → the addresses in order (names RFC 2047-decoded). */
export function addressesOf(v: string | undefined): MailAddress[] {
  if (!v) return [];
  const out: MailAddress[] = [];
  for (const piece of splitAddresses(decodeWords(v))) {
    const m = /^(.*?)<([^<>]+)>\s*$/.exec(piece);
    if (m) {
      const name = m[1]!.trim().replace(/^"|"$/g, '').trim();
      out.push({ name: name.length > 0 ? name : null, address: m[2]!.trim() });
    } else if (piece.trim().length > 0) {
      out.push({ name: null, address: piece.trim().replace(/^"|"$/g, '') });
    }
  }
  return out;
}

function splitAddresses(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of v) {
    if (ch === '"') quoted = !quoted;
    if (!quoted) {
      if (ch === '<') depth++;
      if (ch === '>') depth--;
      if (ch === ',' && depth <= 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim().length > 0) out.push(cur);
  return out;
}

/**
 * The sender's display name, else the local part of the address: an
 * address in the turn text would be redacted as PII by the episode
 * store (`[EMAIL]: …`), a name reads as a speaker.
 */
export function speakerOf(from: string | undefined): string {
  const [first] = addressesOf(from);
  if (!first) return 'unknown sender';
  if (first.name) return first.name;
  const local = first.address.split('@')[0]?.trim();
  return local && local.length > 0 ? local : first.address;
}

function dateOf(v: string | undefined): string | null {
  if (!v) return null;
  const d = new Date(v.replace(/\s*\([^)]*\)\s*$/, ''));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── what the sender did not write ─────────────────────────────────────

/** A line that opens a quoted block: the rest of the body is someone else's. */
const QUOTE_OPENERS: RegExp[] = [
  /^(On|Am|Le|El|Il)\b.{0,200}\b(wrote|schrieb|a écrit|escribió|ha scritto):?\s*$/,
  // `\b` is ASCII-only: a Cyrillic word is fenced by whitespace instead.
  /^.{0,200}(^|\s)(написал|написала|пишет|писал|писала)(\(а\))?:\s*$/,
  /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Message d'origine|Исходное сообщение)\s*-{2,}\s*$/i,
  /^-{2,}\s*(Forwarded message|Weitergeleitete Nachricht|Пересылаемое сообщение)\s*-{2,}\s*$/i,
  /^_{5,}\s*$/,
];

/**
 * The body less quoted replies and the signature. Lines that begin with
 * `>` are dropped wherever they are; from the first quote opener (or an
 * Outlook-style `From: … / Sent: …` header block) down, everything goes;
 * a `-- ` line ends the text. Blank runs collapse.
 */
export function stripQuotes(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (/^-- ?$/.test(line)) break;
    if (QUOTE_OPENERS.some((re) => re.test(trimmed))) break;
    if (isOutlookHeaderBlock(lines, i)) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line.replace(/\s+$/, ''));
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `From: x` followed within three lines by `Sent:` / `Date:` / `To:` — a pasted header block. */
function isOutlookHeaderBlock(lines: string[], i: number): boolean {
  if (!/^\s*(From|От|Von|De):\s.+/.test(lines[i] ?? '')) return false;
  for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
    if (/^\s*(Sent|Date|To|Отправлено|Кому|Gesendet|An|Envoyé|À):\s/.test(lines[j] ?? ''))
      return true;
  }
  return false;
}

/** `Re: Re: Fwd: subject` → `subject`, for a title that reads as the thread's. */
export function bareSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(/^(re|fw|fwd|aw|wg|tr|sv|vs|отв|ответ|пересл)\s*(\[\d+\])?\s*:\s*/i, '');
    if (next === s) return s;
    s = next;
  }
}
