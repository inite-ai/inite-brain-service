/**
 * Credential redaction for text that becomes memory. People paste keys and
 * tokens into the conversations brain remembers ("here's the key: sk-…"),
 * and a remembered credential is served back to every later reader of that
 * memory. The PII redactor masked emails, phones and long digit runs, but a
 * token passed through verbatim.
 *
 * Detection is by structure, never by a vendor-prefix list (a list is stale
 * the day a provider changes its format):
 *   - a PEM private-key block;
 *   - a JWT (three base64url segments, the first two JSON objects);
 *   - the credential after an HTTP `Bearer` scheme;
 *   - a token that is indistinguishable from random: a mixed-case run of the
 *     base64 / base64url alphabet that clears, at its own length, what a
 *     uniformly random string reaches with probability 1 − α/2 on each of
 *     two statistics — Shannon entropy and the rate at which consecutive
 *     characters change class (upper, lower, digit, symbol).
 *
 * Why tests against random strings and not detect-secrets' fixed 4.5
 * bits: entropy is bounded by log2(length), so a fixed limit misses most
 * short keys — a random 32-char base62 key averages 4.55 bits and a 24-char
 * one 4.24, so 4.5 lets about half of the first and nearly all of the
 * second through. The null distribution per length makes each decision a
 * false-negative rate instead of a tuned constant (α split over the two
 * statistics, Bonferroni). Entropy alone cannot tell a short random key
 * from an identifier like `ConfigInspectorService`; the class-change rate
 * can — a random base62 string changes class at ~0.6 of its positions,
 * camelCase at word boundaries only, paths and SNAKE_CASE almost never.
 * Mixed case is required because random credentials are mixed-case with
 * near certainty while ids minted lowercase (record ids) are random too.
 *
 * Runs shorter than MIN_TOKEN_LENGTH are not tested: at 20-odd characters
 * a random key and a PascalCase identifier overlap on both statistics,
 * while the credentials people paste are 32 characters and longer (GitHub
 * tokens 40, cloud secret keys 40, provider API keys 50 and up); the JWT,
 * PEM and Bearer rules have no length floor. Single-case runs (git SHAs,
 * UUIDs, record ids) are never tested. Random data that is not a secret —
 * an SRI integrity hash, a did:key — is masked too: by structure it cannot
 * be told apart, and the loss in remembered text is nil. Measured on the
 * repository's docs, tests, skills and landing content (1428 runs of 32+
 * characters), only such random data was flagged.
 */

const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';
const PEM_LABEL_TAIL = 'PRIVATE KEY-----';
/** A PEM label is short ("OPENSSH PRIVATE KEY"); the cap keeps the header check constant-time. */
const PEM_LABEL_MAX = 40;
/** Dot-joined chains of base64url segments; one class per segment and a literal dot between, so the scan is linear. */
const DOTTED_CHAIN = /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g;
const JWT_SEGMENT_MIN = 8;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
/** Shortest run the random-token test judges (see the module note). */
export const MIN_TOKEN_LENGTH = 32;
const TOKEN_RUN = new RegExp(`[A-Za-z0-9+/=_-]{${MIN_TOKEN_LENGTH},}`, 'g');

/** Share of truly random tokens the entropy test may miss. */
export const RANDOM_TOKEN_MISS_RATE = 0.01;
const NULL_SAMPLES = 2000;
/**
 * Longest length the null distribution is simulated at. Both quantiles
 * rise with length, so a longer run judged against this floor is judged
 * more leniently, never more strictly — and the simulation stays bounded
 * whatever a caller sends (an unbounded length would cost NULL_SAMPLES ×
 * length per new size).
 */
const NULL_MAX_LENGTH = 128;

export const SECRET_MASK = '[SECRET]';

/** Shannon entropy of `s`, in bits per character. */
export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** mulberry32 — a seeded generator, so the null quantiles are the same on every boot. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type CharClass = 0 | 1 | 2 | 3;

function classOf(ch: string): CharClass {
  if (ch >= 'A' && ch <= 'Z') return 0;
  if (ch >= 'a' && ch <= 'z') return 1;
  if (ch >= '0' && ch <= '9') return 2;
  return 3;
}

/** Share of adjacent character pairs whose classes differ. */
export function classChangeRate(s: string): number {
  let changes = 0;
  for (let i = 1; i < s.length; i++) if (classOf(s[i - 1]!) !== classOf(s[i]!)) changes += 1;
  return changes / (s.length - 1);
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ALPHABETS = { 62: BASE64.slice(0, 62), 64: BASE64 } as const;

interface NullFloors {
  entropy: number;
  classChange: number;
}
const floors = new Map<string, NullFloors>();

/**
 * The α/2-quantiles of entropy and class-change rate over uniformly random
 * strings of `length` from the `size`-symbol alphabet, by a seeded Monte
 * Carlo, memoised per (size, length) — a handful of lengths ever occur.
 */
export function randomStringFloors(size: 62 | 64, length: number): NullFloors {
  const key = `${size}:${length}`;
  const known = floors.get(key);
  if (known !== undefined) return known;
  const alphabet = ALPHABETS[size];
  const next = seeded(size * 100_003 + length);
  const entropies: number[] = [];
  const changes: number[] = [];
  for (let i = 0; i < NULL_SAMPLES; i++) {
    let s = '';
    for (let j = 0; j < length; j++) s += alphabet[Math.floor(next() * size)];
    entropies.push(shannonEntropy(s));
    changes.push(classChangeRate(s));
  }
  const at = Math.floor((RANDOM_TOKEN_MISS_RATE / 2) * NULL_SAMPLES);
  const q = (xs: number[]) => xs.sort((x, y) => x - y)[at]!;
  const result = { entropy: q(entropies), classChange: q(changes) };
  floors.set(key, result);
  return result;
}

/** The alphabet a run is drawn from: base64 / base64url or base62. */
function alphabetSize(run: string): 62 | 64 {
  return /[+/=_-]/.test(run) ? 64 : 62;
}

function looksLikeCredential(run: string): boolean {
  if (!/[A-Z]/.test(run) || !/[a-z]/.test(run)) return false;
  const floor = randomStringFloors(alphabetSize(run), Math.min(run.length, NULL_MAX_LENGTH));
  return shannonEntropy(run) >= floor.entropy && classChangeRate(run) >= floor.classChange;
}

/** Where a PEM line opened at `at` (after `-----BEGIN ` / `-----END `) ends, when it names a private key. */
function privateKeyLabelEnd(text: string, at: number): number {
  const close = text.indexOf(PEM_LABEL_TAIL, at);
  if (close < 0 || close - at > PEM_LABEL_MAX) return -1;
  return /^[A-Z0-9 ]*$/.test(text.slice(at, close)) ? close + PEM_LABEL_TAIL.length : -1;
}

/**
 * Private-key blocks masked by a single forward scan. A backtracking
 * pattern (`BEGIN …[\s\S]*?…END`) rescans the rest of the text from every
 * unterminated BEGIN — quadratic on crafted input — while here each BEGIN
 * costs one search for its END and the scan never moves backwards.
 */
function maskPrivateKeys(text: string, mask: () => string): string {
  let out = '';
  let from = 0;
  for (let begin = text.indexOf(PEM_BEGIN); begin >= 0; begin = text.indexOf(PEM_BEGIN, from)) {
    const headerEnd = privateKeyLabelEnd(text, begin + PEM_BEGIN.length);
    const end = headerEnd < 0 ? -1 : text.indexOf(PEM_END, headerEnd);
    const footerEnd = end < 0 ? -1 : privateKeyLabelEnd(text, end + PEM_END.length);
    if (footerEnd < 0) {
      out += text.slice(from, begin + PEM_BEGIN.length);
      from = begin + PEM_BEGIN.length;
      continue;
    }
    out += text.slice(from, begin) + mask();
    from = footerEnd;
  }
  return out + text.slice(from);
}

/**
 * JWTs masked inside each dotted chain: three consecutive segments, the
 * first two JSON objects in base64url (`eyJ`). A single backtracking
 * pattern for the same shape rescans the rest of a hyphenated run from
 * every `eyJ` — quadratic on crafted input — while splitting the chain and
 * sliding a three-segment window touches each segment a constant number
 * of times.
 */
function maskJwts(text: string, mask: () => string): string {
  return text.replace(DOTTED_CHAIN, (chain) => {
    const parts = chain.split('.');
    if (parts.length < 3) return chain;
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const [a, b, c] = [parts[i]!, parts[i + 1], parts[i + 2]];
      const isJwt =
        b !== undefined &&
        c !== undefined &&
        a.startsWith('eyJ') &&
        b.startsWith('eyJ') &&
        a.length >= JWT_SEGMENT_MIN &&
        b.length >= JWT_SEGMENT_MIN &&
        c.length >= JWT_SEGMENT_MIN;
      if (isJwt) {
        out.push(mask());
        i += 2;
      } else {
        out.push(a);
      }
    }
    return out.join('.');
  });
}

/** `text` with every credential masked, and whether any was found. */
export function redactSecrets(text: string): { text: string; found: boolean } {
  let found = false;
  const mask = () => {
    found = true;
    return SECRET_MASK;
  };
  const out = maskJwts(maskPrivateKeys(text, mask), mask)
    .replace(BEARER, (_m, scheme: string) => {
      found = true;
      return `${scheme}${SECRET_MASK}`;
    })
    .replace(TOKEN_RUN, (run) => (looksLikeCredential(run) ? mask() : run));
  return { text: out, found };
}
