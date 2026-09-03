import type { ExtractedEntity, ExtractedFact } from './types';
import { normalizeForGrounding } from './grounding';

/**
 * Deterministic literal-harvest lane (EXTRACTOR_LITERAL_HARVEST,
 * memory-fitness lever #1 — Design A of the diagnosed literal-drop).
 *
 * The closed-vocab extraction prompt drops technical literals: the
 * 22-term CRM seed vocabulary has no slot for limits / ports /
 * identifiers / conventions, the zero-fact rule plus "a dropped fact is
 * worse than a missing fact" make omission the model's safe exit, and
 * when a literal DOES squeeze through it lands in the wrong slot
 * (a port under `address`, which is sensitive PII + requiresScope).
 *
 * This module is the deterministic complement: a fixed set of regex
 * rules over the trimmed input, each producing span-grounded facts
 * whose valueSpan is an exact substring of the input BY CONSTRUCTION —
 * so the grounding invariant holds without a second gate pass. Pure
 * code, no LLM call, no prompt change (the rollback precedent for
 * prompt nudging: agent-qa 47.4→42.1).
 */

/** Confidence stamped on every harvested fact — deterministic match. */
export const LITERAL_HARVEST_CONFIDENCE = 0.95;

/** Max harvested facts per turn — bounds pathological inputs. */
export const LITERAL_HARVEST_CAP = 6;

/** `port 8443` — a single port assignment statement. */
const PORT_STATEMENT = /\bport\s+(\d{2,5})\b/gi;

/**
 * `8443 for the HTTP service, 9464 for metrics, 8081 for the admin
 * console` — the enumerated-ports form, one fact per listed port. The
 * filler between `for` and the keyword is `{0,30}?` (not `{2,30}?`): a
 * mandatory filler would eat into a keyword that directly follows
 * (`9464 for metrics` has nothing between them) and the item would
 * silently never match.
 */
const PORT_LIST_ITEM =
  /\b(\d{2,5})\s+for\s+(?:the\s+)?[\w\s-]{0,30}?(?:service|metrics|console|admin)/gi;

/** `50 requests per minute` — number + request unit + time unit. */
const RATE_LIMIT =
  /\b(\d[\d.,]*)\s*(?:requests?|calls?|req|rps)\s*(?:per|\/)\s*(?:second|minute|hour|sec|min|hr)\b/gi;

/** `HTTP 429` — an explicit protocol status code. */
const HTTP_STATUS = /\bHTTP\s+([1-5]\d{2})\b/g;

/** `LSYNC_` — an ALL_CAPS token ending in `_` (a convention prefix). */
const NAMING_PREFIX_TOKEN = /\b([A-Z][A-Z0-9]{1,15}_)\b/g;

/**
 * The naming-prefix rule only fires when its sentence carries an
 * explicit convention cue — a bare trailing-underscore token elsewhere
 * is not evidence of a naming convention.
 */
const NAMING_PREFIX_CUE = /\b(?:prefix(?:ed)?|convention|naming|named)\b/i;

/** `LSYNC_REPLAY_ENABLED` — an ALL_CAPS underscore identifier. */
const ALL_CAPS_IDENTIFIER = /\b([A-Z][A-Z0-9]{2,}_[A-Z0-9_]{2,})\b/g;

/**
 * `LSYNC.payouts.*` — a dotted subject / glob. The terminator is a
 * negative lookahead instead of `\b`: a `\b` after a trailing `*`
 * never holds (both sides non-word), so the glob tail would silently
 * backtrack away and ground only `LSYNC.payouts`.
 */
const DOTTED_IDENTIFIER = /\b([A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9*]+)+)(?![\w*])/g;

/** `idempotencyKey` — camelCase; only admitted with an assignment/idiom cue. */
const CAMEL_TOKEN = /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g;

/** camelCase cue A: the token is immediately followed by `=`. */
const CAMEL_ASSIGN_AFTER = /^\s*=/;

/** camelCase cue B: the immediately preceding word is an idiom verb/noun. */
const CAMEL_CUE_BEFORE = /\b(?:carries|uses|set|key)\s*[:=]?\s*$/i;

/**
 * Duration-limit pattern (`30s delay`, `15 minutes`, `30 days`) —
 * SHIPPED DARK, deliberately excluded from the active rule list. It is
 * the over-firing rule of the family: casual prose durations ("three
 * minutes apart", "the extra three weeks") would become facts. The
 * `duration_limit` predicate card still ships (a legitimate LLM slot);
 * this regex waits for a measured activation decision.
 */
export const DURATION_LIMIT_PATTERN =
  /\b(\d[\d.,]*)\s*(?:seconds?|minutes?|hours?|days?|weeks?|ms|secs?|mins?|hrs?)\b/gi;

interface SentenceSpan {
  start: number;
  end: number;
  text: string;
}

/**
 * Sentence spans with offsets. The boundary is [.!?] + whitespace +
 * an upper-case letter or digit, so dots INSIDE identifiers
 * (`LSYNC.payouts.*`, `Fly.io`, `v2.3`) never split a sentence.
 */
function sentenceSpans(input: string): SentenceSpan[] {
  const starts = [0];
  for (const m of input.matchAll(/[.!?]+\s+(?=[A-Z0-9])/g)) {
    starts.push(m.index + m[0].length);
  }
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? (starts[i + 1] as number) : input.length;
    return { start, end, text: input.slice(start, end) };
  });
}

function sentenceAt(sentences: SentenceSpan[], index: number): SentenceSpan {
  for (const s of sentences) {
    if (index >= s.start && index < s.end) return s;
  }
  return sentences[sentences.length - 1] as SentenceSpan;
}

/**
 * Map a resolved speaker name onto the grounded entity list. The
 * speaker entity is allow-listed by groundEntities even when the name
 * is absent from a first-person-only turn, so it is the safe
 * attribution fallback for a harvested literal whose sentence names no
 * entity.
 */
export function resolveSpeakerEntityIndex(
  entities: ExtractedEntity[],
  speakerName: string | undefined,
): number | null {
  if (!speakerName) return null;
  const normalized = normalizeForGrounding(speakerName);
  if (!normalized) return null;
  const idx = entities.findIndex((e) => normalizeForGrounding(e.name) === normalized);
  return idx === -1 ? null : idx;
}

/**
 * Clause-overlap entity binding (the local-synth entityIndexForFact
 * heuristic adapted to ExtractedEntity): the subject is the first
 * entity whose name occurs in the sentence containing the match;
 * fall back to the speaker entity, else the match is dropped —
 * a fact with no grounded actor has nowhere legal to attach.
 */
function bindEntity(
  entities: ExtractedEntity[],
  sentenceText: string,
  speakerEntityIndex: number | null,
): number | null {
  const sentenceLower = sentenceText.toLowerCase();
  for (const [i, e] of entities.entries()) {
    const name = e.name.trim().toLowerCase();
    if (name && sentenceLower.includes(name)) return i;
  }
  return speakerEntityIndex;
}

interface HarvestMatch {
  predicate: string;
  /** Stored value — always an exact substring of the input. */
  object: string;
  /** The exact matched substring the object came from (grounding span). */
  valueSpan: string;
  /** Match start offset — drives sentence/clause attribution. */
  index: number;
}

function collectMatches(input: string, sentences: SentenceSpan[]): HarvestMatch[] {
  const out: HarvestMatch[] = [];

  for (const m of input.matchAll(RATE_LIMIT)) {
    // The full phrase verbatim WITH units — "50" alone is not a limit.
    out.push({ predicate: 'rate_limit', object: m[0], valueSpan: m[0], index: m.index });
  }
  for (const m of input.matchAll(PORT_STATEMENT)) {
    out.push({
      predicate: 'service_port',
      object: m[1] as string,
      valueSpan: m[0],
      index: m.index,
    });
  }
  for (const m of input.matchAll(PORT_LIST_ITEM)) {
    out.push({
      predicate: 'service_port',
      object: m[1] as string,
      valueSpan: m[0],
      index: m.index,
    });
  }
  for (const m of input.matchAll(HTTP_STATUS)) {
    out.push({
      predicate: 'http_status',
      object: m[1] as string,
      valueSpan: m[0],
      index: m.index,
    });
  }
  for (const m of input.matchAll(NAMING_PREFIX_TOKEN)) {
    if (!NAMING_PREFIX_CUE.test(sentenceAt(sentences, m.index).text)) continue;
    out.push({
      predicate: 'naming_prefix',
      object: m[1] as string,
      valueSpan: m[1] as string,
      index: m.index,
    });
  }
  for (const m of input.matchAll(ALL_CAPS_IDENTIFIER)) {
    out.push({
      predicate: 'identifier',
      object: m[1] as string,
      valueSpan: m[1] as string,
      index: m.index,
    });
  }
  for (const m of input.matchAll(DOTTED_IDENTIFIER)) {
    out.push({
      predicate: 'identifier',
      object: m[1] as string,
      valueSpan: m[1] as string,
      index: m.index,
    });
  }
  for (const m of input.matchAll(CAMEL_TOKEN)) {
    // TIGHT by design (the loose rule of the family): the token must be
    // immediately followed by `=` or immediately preceded by an idiom
    // cue word within its sentence. Sentence-wide cues would drag every
    // camelCase argument of the same clause in with it.
    const sentence = sentenceAt(sentences, m.index);
    const followedByAssign = CAMEL_ASSIGN_AFTER.test(input.slice(m.index + m[0].length));
    const precededByCue = CAMEL_CUE_BEFORE.test(input.slice(sentence.start, m.index));
    if (!followedByAssign && !precededByCue) continue;
    out.push({ predicate: 'identifier', object: m[0], valueSpan: m[0], index: m.index });
  }
  // NOTE: DURATION_LIMIT_PATTERN is deliberately NOT collected — see
  // its doc comment. The rule ships dark until measured.

  return out;
}

export interface HarvestLiteralsArgs {
  /** The clamped input text the extraction ran on. */
  trimmed: string;
  /** The FINAL compacted grounded entity list of the extraction. */
  entities: ExtractedEntity[];
  /** Speaker's index in `entities` (resolveSpeakerEntityIndex), or null. */
  speakerEntityIndex: number | null;
  /** The denoised LLM facts — drives dedup against the harvest. */
  existingFacts?: readonly ExtractedFact[];
}

/**
 * Harvest technical literals from the trimmed input as span-grounded
 * facts. `existingFacts` (the denoised LLM set) drives dedup: a
 * harvested fact whose (entityIndex, predicate, normalized object)
 * triple already exists — from the LLM or an earlier rule — is
 * skipped. Returns ONLY the new facts, capped at LITERAL_HARVEST_CAP,
 * for the caller to union.
 */
export function harvestLiterals(args: HarvestLiteralsArgs): ExtractedFact[] {
  const { trimmed, entities, speakerEntityIndex, existingFacts = [] } = args;
  if (!trimmed || entities.length === 0) return [];
  const sentences = sentenceSpans(trimmed);
  const seen = new Set(
    existingFacts.map(
      (f) => `${f.entityIndex}\u0000${f.predicate}\u0000${normalizeForGrounding(f.object)}`,
    ),
  );
  const harvested: ExtractedFact[] = [];
  for (const m of collectMatches(trimmed, sentences)) {
    if (harvested.length >= LITERAL_HARVEST_CAP) break;
    const sentence = sentenceAt(sentences, m.index);
    const entityIndex = bindEntity(entities, sentence.text, speakerEntityIndex);
    if (entityIndex === null) continue;
    const key = `${entityIndex}\u0000${m.predicate}\u0000${normalizeForGrounding(m.object)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    harvested.push({
      entityIndex,
      predicate: m.predicate,
      object: m.object,
      confidence: LITERAL_HARVEST_CONFIDENCE,
      clause: sentence.text.trim(),
      valueSpan: m.valueSpan,
    });
  }
  return harvested;
}
