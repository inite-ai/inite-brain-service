import type { SearchHit } from '../search/search.types';
import type { EntityProfile, TimelineEvent } from '../entities/entities.service';
import { isoString } from '../common/surreal-date';
import type { LinkedSourceResult } from '../contracts/search/search.schema';

/** What SearchService.search returns, as compact reads it. */
interface SearchOut {
  results: SearchHit[];
  degraded?: unknown;
  linked?: unknown;
}

/**
 * What search_knowledge hands a model by default: the evidence, not the
 * engine's bookkeeping. The full response is built for the REST surface
 * and for debugging — per-fact score breakdowns, every record id, trust
 * keys, both date fields — and measured on a key-less stand (2026-10-29)
 * one answer cost 3545 tokens where all ten raw turns it was distilled
 * from cost 138: the memory spent 27× the context it should save. 44% of
 * it was the score breakdown, a quarter record ids, ~7% the facts.
 *
 * Compact keeps exactly what an answer is made of: the entity's name and
 * id (get_entity_timeline / get_entity_profile take it), each fact's
 * predicate, value and the day it holds from, its status only when it is
 * not the current value, and the 1-hop relations as one line each —
 * minus those that restate a fact already listed. `detail: "full"`
 * returns the old shape. Key names are unchanged, so a reader of
 * `results[].canonicalName` / `facts[].predicate` / `facts[].object`
 * (the plugin's recall hook) reads both.
 */
export interface CompactSearchHit {
  canonicalName: string;
  entityId: string;
  facts: Array<{
    predicate: string;
    object: string;
    since?: string;
    until?: string;
    status?: string;
  }>;
  relations?: string[];
}

export interface CompactSearchResponse {
  results: CompactSearchHit[];
  /** Passed through: what the search could not do this time, and connector hits (content). */
  degraded?: unknown;
  linked?: unknown;
}

export function compactSearch(out: SearchOut): CompactSearchResponse {
  return {
    ...(out.degraded !== undefined ? { degraded: out.degraded } : {}),
    ...(out.linked !== undefined ? { linked: out.linked } : {}),
    results: out.results.map((hit) => {
      const facts = hit.facts.map((f) => {
        const since = day(f.validFrom);
        const until = day(f.validUntil);
        return {
          predicate: f.predicate,
          object: f.object,
          ...(since ? { since } : {}),
          ...(until ? { until } : {}),
          ...(f.status && f.status !== 'active' ? { status: f.status } : {}),
        };
      });
      const stated = new Set(facts.map((f) => `${f.predicate}\u0000${norm(f.object)}`));
      const relations = (hit.relations ?? [])
        .filter((r) => !stated.has(`${r.kind}\u0000${norm(r.peer)}`))
        .map((r) => (r.direction === 'in' ? `← ${r.kind} ${r.peer}` : `→ ${r.kind} ${r.peer}`));
      return {
        canonicalName: hit.canonicalName,
        entityId: hit.entityId,
        facts,
        ...(relations.length > 0 ? { relations } : {}),
      };
    }),
  };
}

/** YYYY-MM-DD of an instant, or undefined; the sentinel "unknown start" is dropped. */
function day(v: unknown): string | undefined {
  // The driver hands datetimes as its own DateTime objects, not strings
  // (the #814 trap) — one reader for every shape.
  const d = (v === null || v === undefined ? '' : isoString(v)).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !d.startsWith('1970-') ? d : undefined;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * get_entity_timeline, compact: the same events without the provenance
 * blob each one carried (document, episodes, evidence, indexer
 * candidates, origin key — get_fact_provenance serves that for one fact),
 * which was most of the 2784 tokens one user's eleven-fact timeline cost.
 * A recorded event keeps its value and the day it held from; a retraction
 * keeps the day and the fact it retracted. `id` is the fact's record id,
 * the handle get_fact_provenance takes and a retraction points at.
 */
export type CompactTimelineEvent =
  | { type: 'recorded'; id: string; predicate: string; object: string; since?: string }
  | { type: 'retracted'; id: string; on?: string; supersededBy?: string; reason?: string };

export function compactTimeline(out: { entityId: string; events: TimelineEvent[] }): {
  entityId: string;
  events: CompactTimelineEvent[];
} {
  return {
    entityId: out.entityId,
    events: out.events.map((e): CompactTimelineEvent => {
      if (e.type === 'fact.recorded') {
        const since = day(e.validFrom);
        return {
          type: 'recorded',
          id: e.factId,
          predicate: e.predicate,
          object: e.object,
          ...(since ? { since } : {}),
        };
      }
      const on = day(e.at);
      return {
        type: 'retracted',
        id: e.factId,
        ...(on ? { on } : {}),
        ...(e.supersededBy ? { supersededBy: e.supersededBy } : {}),
        ...(typeof e.reason === 'string' && e.reason ? { reason: e.reason } : {}),
      };
    }),
  };
}

/**
 * search_knowledge's default view — the fovea. The compact view hands
 * every fact of every matched entity whatever was asked (on a ten-turn
 * memory the same 442 tokens for each question, three times the 138 the
 * raw turns cost). The focus view keeps what the question is about and
 * spends on it the cheapest faithful form:
 *
 *  - SELECT: facts scoring within `lambda` of the spread between the
 *    top score and the median (the noise floor of this answer), at least
 *    one, at most `maxFacts`. Scale-free — the fused scores move with
 *    the corpus, their spread above the median does not. Measured on the
 *    stand: the answer-bearing facts sat at 0.21–0.27 against a 0.13
 *    median, and were exactly the ones kept.
 *  - SPEND: facts grouped by the turn they were read from; a group is
 *    shown as its facts or as that turn quoted, whichever costs fewer
 *    tokens. So the evidence never costs more than the raw it came from,
 *    and the memory's own value — choosing the turns that matter among
 *    all of them, and only current values — is what the reader pays for.
 *  - LINKS: a relation is shown only when it connects the entities kept
 *    (a peer that is itself kept, or shared by two kept entities — the
 *    hop a "where do my sister's colleagues live" answer needs).
 *  - MORE: one line saying how much was left out and how to get it
 *    (detail "compact": every fact, with entity ids for the timeline and
 *    profile tools; "full": everything).
 */
export interface FocusSourceTurn {
  episodeId: string;
  text: string;
  at: string;
  speaker?: string | undefined;
}

export interface FocusOptions {
  lambda?: number;
  maxFacts?: number;
  topRelations?: boolean;
}

const FOCUS_LAMBDA = 0.4;
const FOCUS_MAX_FACTS = 8;
const NEAR_TOP = 0.9;
const QUOTE_MAX_CHARS = 400;
/** Share of a value's words its turn must contain to stand in for the fact. */
const QUOTE_MIN_VALUE_COVERAGE = 0.6;
/** Linked-source answers (W7) shown per source, and the excerpt kept of each. */
const LINKED_HITS = 3;
const LINKED_SNIPPET_CHARS = 200;

type Kept = { hit: SearchHit; fact: SearchHit['facts'][number] };

/** The facts the question is about (SELECT above), best first, and how many were left. */
export function focusSelect(
  out: SearchOut,
  opts: FocusOptions = {},
): { kept: Kept[]; omitted: number } {
  const all: Kept[] = out.results.flatMap((hit) => hit.facts.map((fact) => ({ hit, fact })));
  if (all.length === 0) return { kept: [], omitted: 0 };
  const ranked = [...all].sort((a, b) => (b.fact.score ?? 0) - (a.fact.score ?? 0));
  const scores = ranked.map((k) => k.fact.score ?? 0).sort((a, b) => a - b);
  const top = scores[scores.length - 1] ?? 0;
  // Lower median: with two facts the upper one IS the top, and the cut
  // would drop a near-equal second. A fact within 10% of the top always
  // stays — two answers to one question score alike.
  const median = scores[Math.floor((scores.length - 1) / 2)] ?? 0;
  const cut = Math.min(top - (opts.lambda ?? FOCUS_LAMBDA) * (top - median), NEAR_TOP * top);
  const max = opts.maxFacts ?? FOCUS_MAX_FACTS;
  const kept = ranked.filter((k, i) => i === 0 || (k.fact.score ?? 0) >= cut).slice(0, max);
  // A dispute is shown whole: the other side of a kept competing value
  // stays whatever it scored, or the cut would settle the conflict the
  // memory deliberately left open.
  const disputed = new Set(kept.filter((k) => k.fact.status === 'competing').map((k) => slotOf(k)));
  for (const k of ranked) {
    if (k.fact.status === 'competing' && disputed.has(slotOf(k)) && !kept.includes(k)) kept.push(k);
  }
  return { kept, omitted: all.length - kept.length };
}

function slotOf(k: Kept): string {
  return `${k.hit.entityId}\u0000${k.fact.predicate}`;
}

/** The focus view as the model reads it (see above). `tokens` counts a string. */
export function renderFocus(p: {
  out: SearchOut;
  sources: Map<string, FocusSourceTurn[]>;
  tokens: (s: string) => number;
  opts?: FocusOptions;
}): string {
  const { kept, omitted } = focusSelect(p.out, p.opts);
  const degraded = degradedNote(p.out.degraded);
  const linked = linkedLines(p.out.linked);
  if (kept.length === 0) {
    if (linked.length > 0) return [...linked, ...(degraded ? [degraded] : [])].join('\n');
    return degraded ?? 'No facts in memory match this question.';
  }
  const lines = evidenceLines(kept, p.sources, p.tokens);
  const links = connectingLinks(kept, p.opts?.topRelations ?? true);
  if (links.length > 0) lines.push(`links: ${links.join('; ')}`);
  lines.push(...linked);
  if (omitted > 0) lines.push(`(+${omitted} more: detail "compact")`);
  if (degraded) lines.push(degraded);
  return lines.join('\n');
}

/**
 * A degraded search (the embedder still warming, a leg down) says so —
 * an empty answer from half a search is not "nothing in memory".
 */
function degradedNote(degraded: unknown): string | undefined {
  if (!Array.isArray(degraded) || degraded.length === 0) return undefined;
  const why = degraded.map((d) =>
    typeof d === 'string' ? d : ((d as { reason?: string }).reason ?? 'partial'),
  );
  return `(search degraded: ${why.join(', ')} — retry for a full answer)`;
}

/**
 * The kept facts as lines, in rank order: a group of facts read from one
 * turn becomes that turn quoted when the quote is shorter, an entity's
 * remaining facts one line where its best fact ranked. A fact with no
 * readable source is its own group. A fact the turn alone would misstate
 * — competing, or ended since — is never quoted: the quote cannot carry
 * its status or its end.
 */
function evidenceLines(
  kept: Kept[],
  sources: Map<string, FocusSourceTurn[]>,
  tokens: (s: string) => number,
): string[] {
  const keyOf = new Map<Kept, string>();
  const groups = new Map<string, { turn?: FocusSourceTurn; items: Kept[] }>();
  for (const k of kept) {
    const turn = sources.get(k.fact.factId)?.[0];
    const quotable =
      turn !== undefined &&
      turn.text.length <= QUOTE_MAX_CHARS &&
      (!k.fact.status || k.fact.status === 'active') &&
      !day(k.fact.validUntil) &&
      statedIn(k.fact.object, turn.text);
    const key = quotable ? turn.episodeId : k.fact.factId;
    const g = groups.get(key) ?? { ...(quotable ? { turn } : {}), items: [] };
    g.items.push(k);
    groups.set(key, g);
    keyOf.set(k, key);
  }
  const quoted = new Map<string, string>();
  for (const [key, g] of groups) {
    if (!g.turn) continue;
    const quote = quoteLine(g.turn);
    const facts = g.items.map((k) => `${k.hit.canonicalName}: ${factSegment(k.fact)}`).join('\n');
    if (tokens(quote) < tokens(facts)) quoted.set(key, quote);
  }
  const lines: string[] = [];
  const done = new Set<string>();
  for (const k of kept) {
    const quote = quoted.get(keyOf.get(k) as string);
    const slot = quote !== undefined ? (keyOf.get(k) as string) : k.hit.entityId;
    if (done.has(slot)) continue;
    done.add(slot);
    if (quote !== undefined) {
      lines.push(quote);
      continue;
    }
    const facts = kept.filter(
      (x) => x.hit.entityId === k.hit.entityId && !quoted.has(keyOf.get(x) as string),
    );
    lines.push(`${k.hit.canonicalName}: ${facts.map((x) => factSegment(x.fact)).join('; ')}`);
  }
  return lines;
}

/**
 * Whether a turn states a value itself. The extractor reads a turn WITH
 * its conversation, so a fact can carry a value the turn only refers to
 * ("update the runbooks for the new retry policy" → retry_policy =
 * exponential backoff, said three turns earlier) — quoting that turn
 * would drop the value. Most of the value's words must be in the turn.
 */
function statedIn(value: string, text: string): boolean {
  const words = value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._:-]*/gu) ?? [];
  const significant = words.filter((w) => w.length >= 3 || /\d/.test(w));
  if (significant.length === 0) return false;
  const turn = text.toLowerCase();
  const found = significant.filter((w) => turn.includes(w)).length;
  return found / significant.length >= QUOTE_MIN_VALUE_COVERAGE;
}

function factSegment(f: SearchHit['facts'][number]): string {
  const since = day(f.validFrom);
  const until = day(f.validUntil);
  const when = since && until ? ` (${since}…${until})` : since ? ` (${since})` : '';
  const status = f.status && f.status !== 'active' ? ` [${f.status}]` : '';
  return `${f.predicate} = ${f.object}${when}${status}`;
}

function quoteLine(t: FocusSourceTurn): string {
  const on = day(t.at);
  return `${on ? `[${on}] ` : ''}${t.speaker ? `${t.speaker}: ` : ''}"${t.text}"`;
}

/** Relations between the kept entities, or through a peer two of them share. */
function connectingLinks(kept: Kept[], withTop: boolean): string[] {
  const hits = new Map(kept.map((k) => [k.hit.entityId, k.hit]));
  const top = kept[0]?.hit.entityId;
  const names = new Set([...hits.values()].map((h) => norm(h.canonicalName)));
  const peerCount = new Map<string, number>();
  for (const h of hits.values()) {
    for (const peer of new Set((h.relations ?? []).map((r) => norm(r.peer)))) {
      peerCount.set(peer, (peerCount.get(peer) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  for (const h of hits.values()) {
    for (const r of h.relations ?? []) {
      const peer = norm(r.peer);
      const connects = names.has(peer) || (peerCount.get(peer) ?? 0) >= 2;
      if (!connects && !(withTop && h.entityId === top)) continue;
      out.add(
        r.direction === 'in'
          ? `${r.peer} ${r.kind} ${h.canonicalName}`
          : `${h.canonicalName} ${r.kind} ${r.peer}`,
      );
    }
  }
  return [...out];
}

/**
 * What linked sources answered at query time (W7). Not memory — nothing
 * was stored — so each line says where it came from, and the observation
 * ref ingest_document takes to keep the chain if the answer is kept.
 */
function linkedLines(linked: unknown): string[] {
  if (!Array.isArray(linked)) return [];
  const lines: string[] = [];
  for (const src of linked as LinkedSourceResult[]) {
    for (const h of (src.hits ?? []).slice(0, LINKED_HITS)) {
      const snippet = h.snippet ? ` — ${h.snippet.slice(0, LINKED_SNIPPET_CHARS)}` : '';
      const where = h.originUri ? ` <${h.originUri}>` : '';
      lines.push(
        `[${src.connector}, not in memory, ${src.observationRef}] ${h.title}${where}${snippet}`,
      );
    }
  }
  return lines;
}

/**
 * get_entity_profile, as the model reads it: the entity's name and type
 * and one line per attribute — every current value of it, with the day
 * it holds from. The JSON profile carried a record id, a confidence and
 * two full timestamps on each of 74 facts: 5197 tokens for the entity
 * of a memory whose whole raw history is 1986. `detail: "full"` keeps
 * the ids (get_fact_provenance and retract_fact take them).
 */
export function renderProfile(p: EntityProfile): string {
  const head = `${p.canonicalName} (${p.type})${p.mergedInto ? ` — merged into ${p.mergedInto}` : ''}`;
  const byPredicate = new Map<string, string[]>();
  for (const f of p.facts) {
    const since = day(f.validFrom);
    const until = day(f.validUntil);
    const when = since && until ? ` (${since}…${until})` : since ? ` (${since})` : '';
    const status = f.status && f.status !== 'active' ? ` [${f.status}]` : '';
    byPredicate.set(f.predicate, [
      ...(byPredicate.get(f.predicate) ?? []),
      `${f.object}${when}${status}`,
    ]);
  }
  const lines = [...byPredicate].map(
    ([predicate, values]) => `${predicate}: ${values.join(' | ')}`,
  );
  return [head, ...(lines.length > 0 ? lines : ['(no facts)'])].join('\n');
}

/**
 * get_entity_timeline, as the model reads it: one line per event, oldest
 * first as the service orders them — `+` a value recorded on the day it
 * holds from, `−` a value retracted (with what replaced it). A
 * retraction names the value it ended, read from the recording it
 * points at; the JSON views made the reader join the two by id.
 */
export function renderTimeline(out: { entityId: string; events: TimelineEvent[] }): string {
  const valueOf = new Map<string, string>();
  for (const e of out.events) {
    if (e.type === 'fact.recorded') valueOf.set(e.factId, `${e.predicate} = ${e.object}`);
  }
  const lines = out.events.map((e) => {
    if (e.type === 'fact.recorded') {
      return `${day(e.validFrom) ?? day(e.at) ?? '?'} + ${e.predicate} = ${e.object}`;
    }
    const replaced = e.supersededBy ? valueOf.get(e.supersededBy) : undefined;
    const why = replaced
      ? ` → ${replaced}`
      : typeof e.reason === 'string' && e.reason
        ? ` (${e.reason})`
        : '';
    return `${day(e.at) ?? '?'} − ${valueOf.get(e.factId) ?? e.factId}${why}`;
  });
  return lines.length > 0 ? lines.join('\n') : 'No events.';
}
