import type { ExtractedEntity, ExtractedFact } from './types';
import { normalizeForGrounding } from './grounding';
import { CODE_MEMORY_DEFAULT_VALUE_PREDICATE } from '../domain-packs/code-memory.pack';

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

/**
 * The cue-gated rate forms the main rule cannot see (k07 code-memory
 * battery finding — additions only, the main rule is untouched): a
 * number joined straight to a TIME unit with no request noun between
 * (`at 120 per minute`, `to 300/min`) or a compact rate token
 * (`850 rps`, `120 qps`). These fire ONLY when the sentence carries
 * explicit rate-limit vocabulary (RATE_LIMIT_CUE) — "the line moved at
 * 120 per minute" is casual prose, not a limit. `rpm` is deliberately
 * absent: outside software prose it reads as revolutions per minute.
 */
const RATE_LIMIT_CUED =
  /\b(\d[\d.,]*)\s*(?:(?:per|\/)\s*(?:second|minute|hour|sec|min|hr)|rps|qps)\b/gi;

/** Explicit rate-limit vocabulary that admits a RATE_LIMIT_CUED match. */
const RATE_LIMIT_CUE = /\b(?:rate[\s-]?limit(?:s|ed|ing)?|throttl(?:e|es|ed|ing)|quota)\b/i;

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

/** `LSYNC_REPLAY_ENABLED` — an ALL_CAPS underscore identifier. One
 *  source, two compilations: the global rule scan below and the
 *  per-sentence subject probe of the flag-default rule (a fresh
 *  non-global instance so the probe can never perturb the global
 *  regex's lastIndex mid-scan). */
const ALL_CAPS_IDENTIFIER_SOURCE = String.raw`\b([A-Z][A-Z0-9]{2,}_[A-Z0-9_]{2,})\b`;
const ALL_CAPS_IDENTIFIER = new RegExp(ALL_CAPS_IDENTIFIER_SOURCE, 'g');
const ALL_CAPS_SUBJECT_PROBE = new RegExp(ALL_CAPS_IDENTIFIER_SOURCE);

/**
 * `LSYNC.payouts.*` — a dotted subject / glob. The terminator is a
 * negative lookahead instead of `\b`: a `\b` after a trailing `*`
 * never holds (both sides non-word), so the glob tail would silently
 * backtrack away and ground only `LSYNC.payouts`.
 */
const DOTTED_IDENTIFIER = /\b([A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9*]+)+)(?![\w*])/g;

/** `idempotencyKey` — camelCase; only admitted with an assignment/idiom cue. */
const CAMEL_TOKEN = /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g;

/**
 * Identifier-shaped SUBJECT tokens for the fallback minting path
 * (no-entity turns only — see HarvestLiteralsArgs.mintSubjects). The
 * shapes mirror the code-memory extractionProfile's subject doctrine
 * ("identifier-shaped subjects become their OWN entities — an ALL_CAPS
 * flag or env var, a file or module path, a dotted symbol or package
 * name"): ALL_CAPS and dotted reuse the harvest rules above; the two
 * additions are the slash path (leading slash allowed, first segment
 * must carry a letter so `300/min` and `2026/03/08` never read as
 * paths) and the hyphenated package/service slug (`acme-api`,
 * `ledger-sync`). The FIRST shape by sentence position wins — English
 * subjects lead their sentence, so position is the deterministic
 * stand-in for a parse.
 */
const SUBJECT_PATH = /(?<![\w.])\/?[\w.-]*[A-Za-z][\w.-]*(?:\/[\w.*-]+)+/g;
const SUBJECT_SLUG = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g;
const SUBJECT_SHAPES = [ALL_CAPS_IDENTIFIER, DOTTED_IDENTIFIER, SUBJECT_PATH, SUBJECT_SLUG];

/** camelCase cue A: the token is immediately followed by `=`. */
const CAMEL_ASSIGN_AFTER = /^\s*=/;

/** camelCase cue B: the immediately preceding word is an idiom verb/noun. */
const CAMEL_CUE_BEFORE = /\b(?:carries|uses|set|key)\s*[:=]?\s*$/i;

/**
 * Clause boundary shared by the deterministic lanes: comma, semicolon,
 * colon, sentence punctuation, em/en dash, a SPACED ascii dash (an
 * intra-word hyphen as in "ledger-sync" must not split), and the
 * subordinators. Moved here from state-verb-harvest (which imports it
 * back) so the dependency direction stays state-verb → literal; the
 * flag-default guard below clips its pre-window with the SAME boundary
 * the sibling lane's guards use.
 */
export const CLAUSE_BOUNDARY_SOURCE = String.raw`[,;:.!?—–]|\s--?\s|\s(?:because|when|so|but)\s`;
const FLAG_DEFAULT_CLAUSE_BOUNDARY = new RegExp(CLAUSE_BOUNDARY_SOURCE, 'gi');

/**
 * `default stays 0` / `default is now 1` / `defaults to 0` — an
 * explicit flag/config DEFAULT assertion (k08 code-memory battery
 * finding — additions only, every existing rule untouched). The
 * measured lottery: the flag story's two stages had NO deterministic
 * producer — the state-verb lane binds "we enabled FLAG" to a person
 * or the speaker (absent on agent-recorded turns, so the match drops),
 * and the LLM redraw sometimes lands the stage as a `decided`
 * paraphrase and sometimes as the typed default only. This rule makes
 * the TYPED emission deterministic: verb forms are present-state only
 * ("defaulted to" — a historical default — never matches by
 * construction) and the captured value must be value-shaped (a number
 * or an on/off/true/false/enabled/disabled state word), so "the
 * default is the same as prod" harvests nothing.
 */
const FLAG_DEFAULT =
  /\bdefaults?\s+(?:is\s+(?:now\s+)?|stays?\s+(?:at\s+)?|remains?\s+(?:at\s+)?|becomes?\s+|to\s+|at\s+)(\d[\w.-]*|true|false|on|off|enabled|disabled|null|none)\b/gi;

/**
 * Pre-cue guard for the flag-default rule: negation, hypotheticals,
 * futures, intentions and conditionals within the 6 tokens before the
 * match (clipped to the match's own clause) mean the asserted default
 * is NOT the current one — "we should probably default to 1" and
 * "if the default stays 0" must not write the typed slot. Same failure
 * direction as the state lane's guards: over-guarding costs a missing
 * fact, never a wrong one.
 */
const FLAG_DEFAULT_GUARD =
  /\b(?:not|never|no longer|won't|wouldn't|shouldn't|should|will|would|might|may|could|plan to|planning to|considering|thinking about|thinking of|want to|wants to|hoping to|going to|about to|used to|previously|formerly|intend|intends|propose[ds]?|if|unless|whether|assuming|suppose)\b/i;

/** Guard window: tokens inspected before the match (same clause). */
const FLAG_DEFAULT_GUARD_WINDOW_TOKENS = 6;

/**
 * True when the guard window before the flag-default match carries a
 * guard term — the state lane's guardedBefore idiom (clause-clipped
 * window, typographic apostrophes folded) applied to this rule's own
 * term list.
 */
function flagDefaultGuardedBefore(
  input: string,
  sentenceStart: number,
  matchStart: number,
): boolean {
  const pre = input.slice(sentenceStart, matchStart);
  let clauseFrom = 0;
  for (const b of pre.matchAll(FLAG_DEFAULT_CLAUSE_BOUNDARY)) {
    clauseFrom = b.index + b[0].length;
  }
  const window = pre
    .slice(clauseFrom)
    .replace(/’/g, "'")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(-FLAG_DEFAULT_GUARD_WINDOW_TOKENS)
    .join(' ');
  return window.length > 0 && FLAG_DEFAULT_GUARD.test(window);
}

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

export interface SentenceSpan {
  start: number;
  end: number;
  text: string;
}

/**
 * Sentence spans with offsets. The boundary is [.!?] + whitespace +
 * an upper-case letter or digit, so dots INSIDE identifiers
 * (`LSYNC.payouts.*`, `Fly.io`, `v2.3`) never split a sentence.
 * Exported for the sibling deterministic lane (state-verb-harvest) so
 * the two lanes attribute matches identically.
 */
export function sentenceSpans(input: string): SentenceSpan[] {
  const starts = [0];
  for (const m of input.matchAll(/[.!?]+\s+(?=[A-Z0-9])/g)) {
    starts.push(m.index + m[0].length);
  }
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? (starts[i + 1] as number) : input.length;
    return { start, end, text: input.slice(start, end) };
  });
}

export function sentenceAt(sentences: SentenceSpan[], index: number): SentenceSpan {
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
 * Exported for the sibling state-verb lane (same binding semantics).
 */
export function bindEntity(
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
  /**
   * Subject-directed binding (flag-default rule only): the fact is
   * ABOUT this identifier token, never about whichever entity happens
   * to lead the sentence. Binding resolves the token against the
   * entity list (minting it on the no-entity path) and DROPS the match
   * when it cannot — a flag default bound to the project or the
   * speaker would be a wrong fact, not a weaker one.
   */
  subjectToken?: string;
}

/** The predicates whose match token IS the subject (identifier-class). */
const IDENTIFIER_CLASS = new Set(['identifier', 'naming_prefix']);

/**
 * The first identifier-shaped subject token of a sentence (by position;
 * longest match on a tie), or null when the sentence carries none. Only
 * consulted on the fallback minting path.
 */
export function firstSubjectToken(sentenceText: string): string | null {
  let best: { index: number; token: string } | null = null;
  for (const shape of SUBJECT_SHAPES) {
    shape.lastIndex = 0;
    for (const m of sentenceText.matchAll(shape)) {
      const token = m[1] ?? m[0];
      if (
        !best ||
        m.index < best.index ||
        (m.index === best.index && token.length > best.token.length)
      ) {
        best = { index: m.index, token };
      }
    }
  }
  return best?.token ?? null;
}

/**
 * Resolve a subject token against the working entity list by normalized
 * name (the extractor's existing resolution idiom — the same match
 * resolveSpeakerEntityIndex uses), minting a new `other`-typed entity
 * when absent. APPENDS to the passed array; returns the bound index.
 * Deliberately `other`, never a person type — bindStateHolder must not
 * pick a minted identifier as a state holder. Cross-turn dedup stays
 * where it lives today: the ingest entity-resolution upsert
 * (resolveOrCreateNamedEntity) resolves the minted name exactly like an
 * LLM-emitted one.
 */
function resolveOrMintSubject(entities: ExtractedEntity[], token: string): number {
  const normalized = normalizeForGrounding(token);
  const existing = entities.findIndex((e) => normalizeForGrounding(e.name) === normalized);
  if (existing !== -1) return existing;
  entities.push({ name: token, type: 'other' });
  return entities.length - 1;
}

function collectMatches(input: string, sentences: SentenceSpan[]): HarvestMatch[] {
  const out: HarvestMatch[] = [];

  for (const m of input.matchAll(RATE_LIMIT)) {
    // The full phrase verbatim WITH units — "50" alone is not a limit.
    out.push({ predicate: 'rate_limit', object: m[0], valueSpan: m[0], index: m.index });
  }
  for (const m of input.matchAll(RATE_LIMIT_CUED)) {
    // Unit-noun-less / compact rate forms only count inside a sentence
    // that says it IS a limit (throttle / rate-limit / quota).
    if (!RATE_LIMIT_CUE.test(sentenceAt(sentences, m.index).text)) continue;
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
  for (const m of input.matchAll(FLAG_DEFAULT)) {
    const sentence = sentenceAt(sentences, m.index);
    // Cue: an ALL_CAPS identifier must co-occur in the SAME sentence —
    // a flag default is a fact about the FLAG; a prose default with no
    // identifier subject ("the timeout default is 10000") stays with
    // the LLM path. A fresh non-global probe, so the global identifier
    // rule's iteration state is never perturbed.
    const subject = ALL_CAPS_SUBJECT_PROBE.exec(sentence.text)?.[1];
    if (subject === undefined) continue;
    if (flagDefaultGuardedBefore(input, sentence.start, m.index)) continue;
    // The namespaced pack predicate ON PURPOSE (not a coined bare
    // `default_value`): the builtin code_memory extraction profile
    // already teaches the LLM this exact id, so only the SAME id lets
    // the (entity, predicate, object) dedup collapse the two producers
    // into one fact and keeps the slot's single_active revision
    // history on one predicate.
    out.push({
      predicate: CODE_MEMORY_DEFAULT_VALUE_PREDICATE,
      object: m[1] as string,
      valueSpan: m[0],
      index: m.index,
      subjectToken: subject,
    });
  }
  // NOTE: DURATION_LIMIT_PATTERN is deliberately NOT collected — see
  // its doc comment. The rule ships dark until measured.

  return out;
}

export interface HarvestLiteralsArgs {
  /** The clamped input text the extraction ran on. */
  trimmed: string;
  /**
   * The FINAL compacted grounded entity list of the extraction. With
   * `mintSubjects` on, minted subject entities are APPENDED to this
   * array (pass a copy if the original must stay untouched).
   */
  entities: ExtractedEntity[];
  /** Speaker's index in `entities` (resolveSpeakerEntityIndex), or null. */
  speakerEntityIndex: number | null;
  /** The denoised LLM facts — drives dedup against the harvest. */
  existingFacts?: readonly ExtractedFact[];
  /**
   * Fallback grounding for the no-entity starvation case (the k07
   * code-memory battery finding: an LLM extraction that yields zero
   * entities used to starve this lane entirely, so a turn like
   * "acme-api throttles /v1/webhooks at 120 requests per minute."
   * produced NO rate_limit fact). When set, a match that normal
   * binding cannot ground is bound by minting: an identifier-class
   * match (identifier / naming_prefix) becomes its OWN subject entity
   * — the code-memory extractionProfile's doctrine — and any other
   * match binds to the first identifier-shaped subject token of its
   * sentence, with the speaker kept as the LAST resort (mirroring
   * bindEntity's name-in-sentence-over-speaker priority). A sentence
   * with no subject shape and no speaker still harvests nothing —
   * minting never invents a subject. Default off: absent, the function
   * is byte-identical to the pre-mint behavior.
   */
  mintSubjects?: boolean;
}

/**
 * Harvest technical literals from the trimmed input as span-grounded
 * facts. `existingFacts` (the denoised LLM set) drives dedup: a
 * harvested fact whose (entityIndex, predicate, normalized object)
 * triple already exists — from the LLM or an earlier rule — is
 * skipped. Returns ONLY the new facts, capped at LITERAL_HARVEST_CAP,
 * for the caller to union.
 */
/**
 * Entity binding for one harvest match — pulled out of harvestLiterals
 * verbatim (cognitive-complexity gate). Subject-directed matches
 * (flag-default rule) bind to the match's own identifier token: resolve
 * it against the working list, mint it on the no-entity path, and
 * otherwise drop the match honestly (see HarvestMatch.subjectToken).
 * Undirected matches run bindEntity's priority — a sentence-grounded
 * subject beats the speaker — so the speaker fallback is withheld from
 * the first pass and re-applied only after minting found no subject
 * shape in the sentence.
 */
function bindHarvestSubject(args: {
  m: HarvestMatch;
  sentenceText: string;
  entities: HarvestLiteralsArgs['entities'];
  speakerEntityIndex: number | null;
  mintSubjects: boolean;
}): number | null {
  const { m, sentenceText, entities, speakerEntityIndex, mintSubjects } = args;
  if (m.subjectToken !== undefined) {
    const normalizedSubject = normalizeForGrounding(m.subjectToken);
    const existing = entities.findIndex((e) => normalizeForGrounding(e.name) === normalizedSubject);
    if (existing !== -1) return existing;
    return mintSubjects ? resolveOrMintSubject(entities, m.subjectToken) : null;
  }
  const bound = bindEntity(entities, sentenceText, mintSubjects ? null : speakerEntityIndex);
  if (bound !== null || !mintSubjects) return bound;
  const token = IDENTIFIER_CLASS.has(m.predicate) ? m.object : firstSubjectToken(sentenceText);
  return token !== null ? resolveOrMintSubject(entities, token) : speakerEntityIndex;
}

export function harvestLiterals(args: HarvestLiteralsArgs): ExtractedFact[] {
  const { trimmed, entities, speakerEntityIndex, existingFacts = [], mintSubjects = false } = args;
  if (!trimmed || (entities.length === 0 && !mintSubjects)) return [];
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
    const entityIndex = bindHarvestSubject({
      m,
      sentenceText: sentence.text,
      entities,
      speakerEntityIndex,
      mintSubjects,
    });
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
