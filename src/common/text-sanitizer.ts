/**
 * Shared Unicode text sanitization — the one place that knows which
 * codepoint classes are used to smuggle invisible or re-ordered
 * instructions into text that later lands in an LLM context window.
 *
 * Two consumers, one strip primitive:
 *   - MCP pack-tool text (docs/mcp-pack-tools.md): `sanitizePackText`
 *     additionally collapses whitespace, trims, and caps length — that
 *     text is a short label rendered inline in a tool description.
 *   - Ingest bodies (INGEST_SANITIZE_UNICODE): `sanitizeIngestText`
 *     preserves layout (newlines, tabs) and length — a conversation
 *     turn / document paragraph must keep its structure.
 *
 * Pure module. No behavior change for the pack path: it re-exports the
 * same `sanitizePackText` the MCP surface has always used.
 */

// Control chars (C0/C1 minus \t \n \r), bidi overrides/isolates
// (U+202A-E, U+2066-69, U+200E/F, U+061C), zero-width + word joiners
// (U+200B-D, U+2060-64, U+FEFF) — the classes used to hide or re-order
// instructions. \t (U+0009), \n (U+000A), \r (U+000D) are deliberately
// NOT in the set: the pack path collapses them to single spaces, the
// ingest path keeps them as layout.
export const UNSAFE_UNICODE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F' +
    '\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
  'g',
);

/**
 * NFC-normalize and strip control/bidi/zero-width codepoints. The shared
 * primitive behind both public sanitizers. Idempotent; returns '' for
 * non-strings (matches the historical pack-text contract).
 */
export function stripUnsafeUnicode(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.normalize('NFC').replace(UNSAFE_UNICODE, '');
}

/**
 * Ingest-time sanitization (INGEST_SANITIZE_UNICODE): NFC-normalize and
 * strip invisibles while PRESERVING layout (\n \t \r survive) and full
 * length — no whitespace collapse, no cap. For free-text ingest bodies
 * where the original structure is load-bearing. Idempotent.
 *
 * Non-string inputs are returned unchanged: callers gate this on the
 * flag and pass raw field values, and a defensive '' here would corrupt
 * a legitimately non-string payload rather than sanitize text.
 */
export function sanitizeIngestText<T>(s: T): T {
  if (typeof s !== 'string') return s;
  return s.normalize('NFC').replace(UNSAFE_UNICODE, '') as unknown as T;
}

/**
 * MCP pack-tool text: NFC-normalize, strip control/bidi/zero-width,
 * collapse whitespace, trim, cap. Idempotent; returns '' for
 * non-strings. Byte-identical to the former pack-tool-render local copy.
 */
export function sanitizePackText(s: unknown, cap: number): string {
  return stripUnsafeUnicode(s)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}
