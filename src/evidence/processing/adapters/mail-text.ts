import { htmlToText } from '../../../common/html-text';

/**
 * An RFC 5322 / MIME message reduced to text, without a dependency: the
 * header block unfolded and RFC 2047 words decoded, the multipart tree
 * walked (bounded) for the first text/plain body — else the first
 * text/html body through the shared HTML reduction — with
 * quoted-printable / base64 transfer encodings and the declared charset
 * honoured, and attachments listed by name only (their bytes are never
 * read, never output). Nested message/rfc822 parts are walked like any
 * multipart branch.
 *
 * Output shape (stable — it is the rendering contract):
 *
 *   From: …
 *   To: …
 *   Cc: …
 *   Date: …
 *   Subject: …
 *
 *   <body>
 *
 *   [attachment: name (type, n bytes)]
 */

export interface MailLimits {
  /** MIME parts walked at most, across the whole tree. */
  maxParts?: number | undefined;
  /** Multipart nesting depth. */
  maxDepth?: number | undefined;
}

const DEFAULT_MAX_PARTS = 200;
const DEFAULT_MAX_DEPTH = 8;
const HEADER_LINES = ['From', 'To', 'Cc', 'Date', 'Subject'] as const;

export interface MailHeaders {
  /** The header's value, unfolded, RFC 2047 words NOT decoded (see `decodeWords`). */
  get(name: string): string | undefined;
}

interface Part {
  headers: MailHeaders;
  body: Buffer;
}

export interface MailAttachment {
  name: string;
  mediaType: string;
  size: number;
  /** Present when the parse was asked to keep bytes (the mail connectors' attachment items). */
  bytes?: Buffer | undefined;
}

/** A message parsed once: headers, the body as text, the attachments. */
export interface ParsedMail {
  headers: MailHeaders;
  /** The first text/plain body, else the first text/html body reduced to text; '' when none. */
  body: string;
  attachments: MailAttachment[];
}

interface Found {
  plain?: string | undefined;
  html?: string | undefined;
  attachments: MailAttachment[];
  parts: number;
  keepBytes: boolean;
}

export function mailText(raw: Buffer, limits: MailLimits = {}): string {
  const parsed = parseMail(raw, limits);
  const lines: string[] = [];
  for (const name of HEADER_LINES) {
    const v = parsed.headers.get(name);
    if (v !== undefined && v.trim().length > 0) lines.push(`${name}: ${decodeWords(v)}`);
  }
  const out = [lines.join('\n')];
  if (parsed.body.trim().length > 0) out.push(parsed.body.trim());
  if (parsed.attachments.length > 0)
    out.push(
      parsed.attachments
        .map((a) => `[attachment: ${a.name} (${a.mediaType}, ${String(a.size)} bytes)]`)
        .join('\n'),
    );
  return out.filter((s) => s.length > 0).join('\n\n');
}

/**
 * The parse behind `mailText`, for a caller that needs the parts apart
 * (a mail connector: the headers for the thread, the body for the turn,
 * an attachment's bytes for the evidence plane).
 */
export function parseMail(
  raw: Buffer,
  limits: MailLimits & { keepBytes?: boolean } = {},
): ParsedMail {
  const root = splitMessage(raw);
  const found: Found = { attachments: [], parts: 0, keepBytes: limits.keepBytes === true };
  walk(root, found, {
    depth: 0,
    maxParts: limits.maxParts ?? DEFAULT_MAX_PARTS,
    maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH,
  });
  const body = found.plain ?? (found.html !== undefined ? htmlToText(found.html).body : '');
  return { headers: root.headers, body, attachments: found.attachments };
}

function walk(
  part: Part,
  found: Found,
  w: { depth: number; maxParts: number; maxDepth: number },
): void {
  if (++found.parts > w.maxParts) return;
  const ct = contentType(part.headers.get('Content-Type'));
  const disposition = (part.headers.get('Content-Disposition') ?? '').toLowerCase();
  const filename =
    paramOf(part.headers.get('Content-Disposition') ?? '', 'filename') ??
    paramOf(part.headers.get('Content-Type') ?? '', 'name');
  if (ct.type === 'multipart' && w.depth < w.maxDepth) {
    const boundary = ct.params.boundary;
    if (!boundary) return;
    for (const sub of splitMultipart(part.body, boundary)) {
      walk(splitMessage(sub), found, { ...w, depth: w.depth + 1 });
    }
    return;
  }
  if (ct.type === 'message' && ct.subtype === 'rfc822' && w.depth < w.maxDepth) {
    walk(splitMessage(decodeTransfer(part)), found, { ...w, depth: w.depth + 1 });
    return;
  }
  const isAttachment =
    disposition.startsWith('attachment') || (filename !== undefined && ct.type !== 'text');
  if (isAttachment) {
    const bytes = found.keepBytes ? decodeTransfer(part) : null;
    found.attachments.push({
      name: decodeWords(filename ?? 'unnamed'),
      mediaType: `${ct.type}/${ct.subtype}`,
      size: bytes ? bytes.length : part.body.length,
      ...(bytes ? { bytes } : {}),
    });
    return;
  }
  if (ct.type !== 'text') return;
  const text = decodeCharset(decodeTransfer(part), ct.params.charset);
  if (ct.subtype === 'plain' && found.plain === undefined) found.plain = text;
  else if (ct.subtype === 'html' && found.html === undefined) found.html = text;
}

// ── message structure ─────────────────────────────────────────────────

/** Split a message (or MIME part) into unfolded headers and its body. */
function splitMessage(raw: Buffer): Part {
  const text = raw.toString('latin1');
  const m = /\r?\n\r?\n/.exec(text);
  const headerText = m ? text.slice(0, m.index) : text;
  const bodyStart = m ? m.index + m[0].length : text.length;
  const map = new Map<string, string>();
  for (const line of headerText.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // First occurrence wins (a duplicated Subject is not two subjects).
    if (!map.has(key)) map.set(key, value);
  }
  return {
    headers: { get: (name) => map.get(name.toLowerCase()) },
    body: raw.subarray(Buffer.byteLength(text.slice(0, bodyStart), 'latin1')),
  };
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString('latin1');
  const marker = `--${boundary}`;
  const out: Buffer[] = [];
  let at = text.indexOf(marker);
  while (at !== -1) {
    const lineEnd = text.indexOf('\n', at);
    if (lineEnd === -1) break;
    const delimiterLine = text.slice(at, lineEnd);
    if (delimiterLine.startsWith(`${marker}--`)) break;
    const next = text.indexOf(`\n${marker}`, lineEnd);
    const end = next === -1 ? text.length : next;
    const chunk = text.slice(lineEnd + 1, end).replace(/\r$/, '');
    out.push(Buffer.from(chunk, 'latin1'));
    at = next === -1 ? -1 : next + 1;
  }
  return out;
}

// ── content-type / parameters ─────────────────────────────────────────

function contentType(v: string | undefined): {
  type: string;
  subtype: string;
  params: Record<string, string>;
} {
  const header = v ?? 'text/plain';
  const [mime = 'text/plain'] = header.split(';');
  const [type = 'text', subtype = 'plain'] = mime.trim().toLowerCase().split('/');
  const params: Record<string, string> = {};
  for (const key of ['boundary', 'charset']) {
    const p = paramOf(header, key);
    if (p !== undefined) params[key] = p;
  }
  return { type, subtype, params };
}

function paramOf(header: string, key: string): string | undefined {
  const re = new RegExp(`;\\s*${key}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i');
  const m = re.exec(header);
  const raw = m?.[1] ?? m?.[2];
  if (raw === undefined) return undefined;
  // RFC 2231 `key*=utf-8''encoded` form.
  const ext = /^([^']*)'[^']*'(.*)$/.exec(raw);
  if (ext && /\*=/.test(m?.[0] ?? '')) {
    try {
      return decodeURIComponent(ext[2] ?? '');
    } catch {
      return ext[2];
    }
  }
  return raw;
}

// ── encodings ─────────────────────────────────────────────────────────

function decodeTransfer(part: Part): Buffer {
  const enc = (part.headers.get('Content-Transfer-Encoding') ?? '7bit').trim().toLowerCase();
  if (enc === 'base64')
    return Buffer.from(part.body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(part.body.toString('latin1'));
  return part.body;
}

function decodeQuotedPrintable(s: string): Buffer {
  const bytes: number[] = [];
  const text = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x3d /* = */ && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(c & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** RFC 2047 encoded words: =?charset?B|Q?text?= */
export function decodeWords(v: string): string {
  return v
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (...m: string[]) => {
      const [, charset = 'utf-8', mode = 'q', text = ''] = m;
      const bytes =
        mode.toLowerCase() === 'b'
          ? Buffer.from(text, 'base64')
          : decodeQuotedPrintable(text.replace(/_/g, ' '));
      return decodeCharset(bytes, charset);
    })
    .trim();
}
