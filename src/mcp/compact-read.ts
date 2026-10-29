import type { SearchHit } from '../search/search.types';
import type { TimelineEvent } from '../entities/entities.service';
import { isoString } from '../common/surreal-date';

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
}

const FOCUS_LAMBDA = 0.4;
const FOCUS_MAX_FACTS = 8;
const NEAR_TOP = 0.9;
const QUOTE_MAX_CHARS = 400;

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
  return { kept, omitted: all.length - kept.length };
}

/** The focus view as the model reads it (see above). `tokens` counts a string. */
export function renderFocus(p: {
  out: SearchOut;
  sources: Map<string, FocusSourceTurn[]>;
  tokens: (s: string) => number;
  opts?: FocusOptions;
}): string {
  const { kept, omitted } = focusSelect(p.out, p.opts);
  // A degraded search (the embedder still warming, a leg down) says so —
  // an empty answer from half a search is not "nothing in memory".
  const degraded =
    Array.isArray(p.out.degraded) && p.out.degraded.length > 0
      ? `(search degraded: ${p.out.degraded.map((d) => (typeof d === 'string' ? d : ((d as { reason?: string }).reason ?? 'partial'))).join(', ')} — retry for a full answer)`
      : undefined;
  if (kept.length === 0) {
    return degraded ?? 'No facts in memory match this question.';
  }
  // Group by the turn each fact was read from; a fact with no readable
  // source is its own group and always shown as a fact.
  const groups = new Map<string, { turn?: FocusSourceTurn; items: Kept[] }>();
  for (const k of kept) {
    const turn = p.sources.get(k.fact.factId)?.[0];
    const key = turn && turn.text.length <= QUOTE_MAX_CHARS ? turn.episodeId : k.fact.factId;
    const g = groups.get(key) ?? { ...(turn && key === turn.episodeId ? { turn } : {}), items: [] };
    g.items.push(k);
    groups.set(key, g);
  }
  const asFacts: Kept[] = [];
  const quotes: string[] = [];
  for (const g of groups.values()) {
    if (!g.turn) {
      asFacts.push(...g.items);
      continue;
    }
    const quote = quoteLine(g.turn);
    const facts = g.items.map((k) => `${k.hit.canonicalName}: ${factSegment(k.fact)}`).join('\n');
    if (p.tokens(quote) < p.tokens(facts)) quotes.push(quote);
    else asFacts.push(...g.items);
  }
  const lines: string[] = [];
  const byEntity = new Map<string, Kept[]>();
  for (const k of asFacts)
    byEntity.set(k.hit.entityId, [...(byEntity.get(k.hit.entityId) ?? []), k]);
  for (const items of byEntity.values()) {
    lines.push(
      `${items[0]!.hit.canonicalName}: ${items.map((k) => factSegment(k.fact)).join('; ')}`,
    );
  }
  lines.push(...quotes);
  const links = connectingLinks(kept);
  if (links.length > 0) lines.push(`links: ${links.join('; ')}`);
  if (omitted > 0) lines.push(`(+${omitted} more: detail "compact")`);
  if (degraded) lines.push(degraded);
  return lines.join('\n');
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
function connectingLinks(kept: Kept[]): string[] {
  const hits = new Map(kept.map((k) => [k.hit.entityId, k.hit]));
  if (hits.size < 2) return [];
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
      if (!names.has(peer) && (peerCount.get(peer) ?? 0) < 2) continue;
      out.add(
        r.direction === 'in'
          ? `${r.peer} ${r.kind} ${h.canonicalName}`
          : `${h.canonicalName} ${r.kind} ${r.peer}`,
      );
    }
  }
  return [...out];
}
