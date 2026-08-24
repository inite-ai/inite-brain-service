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
  return stripUnsafeUnicode(s).replace(/\s+/g, ' ').trim().slice(0, cap);
}

// ─── Confusables / homoglyph risk signal (INGEST_CONFUSABLES_CHECK) ────────
//
// A curated, DELIBERATELY SMALL subset of the UTS-39 confusables data — the
// common Latin ↔ Cyrillic ↔ Greek homoglyphs used to spoof identifiers
// ("pаypal" with a Cyrillic а, "аdmin", "ѕсоре") — NOT the full UTS-39
// skeleton table. Each entry maps a LOWERCASE confusable code point to its
// ASCII/canonical target; the skeleton is computed AFTER a locale-invariant
// casefold, so only lowercase entries are ever consulted. The skeleton is a
// match KEY: it is NEVER stored and NEVER used to auto-merge or auto-block —
// the original surface always stays on the row. It exists so a caller can
// GROUP names by skeleton to surface a possible collision for human review.
const CONFUSABLE_MAP: Record<string, string> = {
  // Cyrillic → Latin (the dominant homoglyph vector).
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  і: 'i',
  ј: 'j',
  ԁ: 'd',
  һ: 'h',
  ӏ: 'l',
  ԛ: 'q',
  ԝ: 'w',
  // Greek → Latin.
  α: 'a',
  β: 'b',
  ε: 'e',
  ѵ: 'v',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ι: 'i',
  κ: 'k',
  μ: 'm',
  // A couple of common Latin diacritic look-alikes kept ASCII-folded.
  ⅼ: 'l',
  ⅰ: 'i',
};

const CONFUSABLE_SCRIPT_RES: ReadonlyArray<[keyof ScriptFlags, RegExp]> = [
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
];

interface ScriptFlags {
  latin: boolean;
  cyrillic: boolean;
  greek: boolean;
}

/**
 * Locale-INVARIANT simple casefold, used ONLY as a match key — the row
 * always keeps the original surface. Built on String.prototype.toLowerCase
 * (Unicode default case mapping, locale-INDEPENDENT — unlike
 * toLocaleLowerCase). KNOWN, DELIBERATE deviations from full Unicode
 * casefolding: Turkic dotless-ı / İ are NOT special-cased (that is exactly
 * the locale-invariance we want — a Turkish locale would fold I → ı), and ß
 * does NOT fold to "ss" (this is SIMPLE, not full, casefold — JS ships no
 * built-in full-casefolder). Documented so a caller never mistakes it for
 * UTS-39 §5 full casefolding. Returns '' for non-strings.
 */
export function localeInvariantCasefold(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.normalize('NFC').toLowerCase();
}

/**
 * UTS-39-style confusables skeleton over the CURATED map (not the full
 * table): strip invisibles, locale-invariant casefold, then map each
 * confusable code point to its canonical target. A match KEY only — never
 * stored, never auto-merges. Two names with the same skeleton are a
 * homoglyph-collision CANDIDATE for review, nothing more.
 */
export function confusableSkeleton(s: unknown): string {
  const folded = localeInvariantCasefold(stripUnsafeUnicode(s));
  let out = '';
  for (const ch of folded) out += CONFUSABLE_MAP[ch] ?? ch;
  return out;
}

const LATIN_ASCII_RE = /[a-z]/i;
const ASCII_WORD_RE = /^[a-z]+$/;

interface TokenRisk {
  /** The token mixes ≥2 of {Latin, Cyrillic, Greek} (classic homograph). */
  mixedScript: boolean;
  /** The token has NO ASCII-Latin letter yet its curated skeleton IS a full
   *  ASCII-Latin word — a single-script token masquerading as a Latin
   *  identifier (the pure-Cyrillic "paypal" IDN-homograph shape). */
  disguised: boolean;
}

/** Per-token homograph classification — the two per-NAME tells that hold
 *  WITHOUT a corpus (a cross-script skeleton collision still needs the
 *  corpus, which is why the skeleton is exposed for grouping). */
function classifyToken(token: string): TokenRisk {
  const seen: ScriptFlags = { latin: false, cyrillic: false, greek: false };
  for (const ch of token) {
    for (const [flag, re] of CONFUSABLE_SCRIPT_RES) {
      if (re.test(ch)) {
        seen[flag] = true;
        break;
      }
    }
  }
  const mixedScript = Number(seen.latin) + Number(seen.cyrillic) + Number(seen.greek) >= 2;
  const disguised = !LATIN_ASCII_RE.test(token) && ASCII_WORD_RE.test(confusableSkeleton(token));
  return { mixedScript, disguised };
}

/** Confusables risk profile for one identifier surface. */
export interface ConfusableRisk {
  /** Curated-map skeleton — the match key (never stored, never auto-merges).
   *  Exposed so a corpus tool can GROUP names by skeleton to surface a
   *  cross-script collision (the tell a single name cannot carry). */
  skeleton: string;
  /** A single token mixes ≥2 of {Latin, Cyrillic, Greek}. */
  mixedScript: boolean;
  /** A single non-Latin token skeletonizes to a full ASCII-Latin word. */
  disguisedScript: boolean;
  /** ≥1 curated confusable/homoglyph code point is present (informational —
   *  a legit single-script name trips this, so it is NOT the risk flag). */
  hasConfusables: boolean;
  /** The risk signal: mixedScript OR disguisedScript. RISK ONLY — the caller
   *  logs it for review and NEVER blocks or merges on it. A plain
   *  single-script name (ASCII, all-Cyrillic, all-Greek) is NOT flagged. */
  flagged: boolean;
}

/**
 * Compute the confusables risk signal for an identifier (an entity name).
 * Pure + side-effect-free; the ingest caller decides what to do with the
 * signal (log for review — never block, never auto-merge).
 */
export function analyzeConfusables(s: unknown): ConfusableRisk {
  const text = typeof s === 'string' ? s : '';
  const folded = localeInvariantCasefold(stripUnsafeUnicode(text));
  const skeleton = confusableSkeleton(text);
  const hasConfusables = [...folded].some((ch) => CONFUSABLE_MAP[ch] !== undefined);
  let mixedScript = false;
  let disguisedScript = false;
  for (const token of text.split(/\s+/)) {
    if (!token) continue;
    const risk = classifyToken(token);
    mixedScript ||= risk.mixedScript;
    disguisedScript ||= risk.disguised;
  }
  return {
    skeleton,
    mixedScript,
    disguisedScript,
    hasConfusables,
    flagged: mixedScript || disguisedScript,
  };
}
