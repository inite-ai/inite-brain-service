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
