/**
 * Mechanical scorers of the domain-pack battery. Pure functions over
 * plain JSON — no HTTP, no LLM judge — unit-tested on fixtures in
 * test/domain-pack-scorers.unit-spec.ts, so every verdict is
 * reproducible from the report file.
 *
 * Generic primitives are REUSED from the sibling harnesses — one
 * implementation, one unit-tested truth: containsAnyOf / isAbstention /
 * missingKeyPhrases / walkProvenance come from
 * test/eval/memory-fitness/scorers.ts; checkHistorySequence and
 * scoreServe from test/eval/state-transitions/scorers.ts. This file
 * adds only what the domain-pack claims need: the install matcher, the
 * exact-predicate vocabulary matcher, the cross-domain entity/timeline
 * classifiers, the all-groups serve verdict, and the rogue-tool scan.
 */
import { containsAnyOf, isAbstention, missingKeyPhrases } from '../memory-fitness/scorers';
import type { HistoryEvent } from '../state-transitions/scorers';
import type { CrossEntityCheck, DomainSpec } from './types';

export interface Verdict {
  pass: boolean;
  detail: string;
}

// ── install matcher ─────────────────────────────────────────────────

/** The installed-pack fields the matcher consumes (subset of
 *  InstalledPackSchema — src/contracts/admin/packs.schema.ts). */
export interface InstalledPackLike {
  packId: string;
  version: string;
}

/** Every wanted pack is present in the installed list at the wanted
 *  version (a different installed version is named in the fail). */
export function checkPacksInstalled(
  installed: readonly InstalledPackLike[],
  wanted: ReadonlyArray<{ packId: string; version: string }>,
): Verdict {
  const missing: string[] = [];
  const found: string[] = [];
  for (const want of wanted) {
    const hit = installed.find((p) => p.packId === want.packId);
    if (hit === undefined) {
      missing.push(`${want.packId}@${want.version} (absent)`);
    } else if (hit.version !== want.version) {
      missing.push(`${want.packId}@${want.version} (installed at v${hit.version})`);
    } else {
      found.push(`${want.packId}@${want.version}`);
    }
  }
  if (missing.length > 0) {
    return {
      pass: false,
      detail: `not installed as expected: ${missing.join(', ')} (installed list has ${installed.length})`,
    };
  }
  return { pass: true, detail: `installed: ${found.join(', ')}` };
}

// ── pack-vocabulary matcher ─────────────────────────────────────────

/** One search-hit fact as the vocabulary matcher consumes it. */
export interface FactLike {
  factId: string;
  predicate: string;
  object: string;
}

/** One search hit as the cross-domain scorers consume it. */
export interface HitLike {
  entityId: string;
  canonicalName?: string;
  facts?: FactLike[];
}

/**
 * Exact-predicate vocabulary check: some fact across the hits carries
 * EXACTLY the namespaced pack predicate with a matching value. A fail
 * names the predicates extraction coined instead for the same values —
 * the diagnosable half of the honest baseline: the report shows WHAT
 * open vocabulary swallowed the domain phrasing.
 */
export function findExactPredicateFact(
  hits: readonly HitLike[],
  predicate: string,
  valueMarkers: readonly string[],
): Verdict {
  const coined = new Set<string>();
  for (const hit of hits) {
    for (const fact of hit.facts ?? []) {
      if (!containsAnyOf(fact.object, valueMarkers)) continue;
      if (fact.predicate === predicate) {
        return {
          pass: true,
          detail:
            `fact ${fact.factId} on ${hit.canonicalName ?? hit.entityId} carries ` +
            `${predicate}="${fact.object}"`,
        };
      }
      coined.add(fact.predicate);
    }
  }
  const coinedList = [...coined];
  return {
    pass: false,
    detail:
      coinedList.length > 0
        ? `no fact carries ${predicate}; the value landed on coined predicate(s): ` +
          coinedList.join(', ')
        : `no fact carries ${predicate} and no fact matches [${valueMarkers.join('|')}] at all`,
  };
}

// ── cross-domain classifiers ────────────────────────────────────────

/** A fact (or timeline event) belongs to a domain when its predicate
 *  carries the pack namespace prefix OR its combined text matches a
 *  corpus value marker — namespace-first, so the check gets STRONGER
 *  as pack vocabulary adoption grows, but stays meaningful before it. */
export function inDomain(predicate: string, object: string, spec: DomainSpec): boolean {
  if (predicate.startsWith(`${spec.namespace}__`)) return true;
  return containsAnyOf(`${predicate} ${object}`, spec.markers);
}

/**
 * Cross-domain entity check:
 *  1. exactly ONE hit's canonicalName contains the entity token
 *     (2+ = per-domain entity duplication, the failure being measured);
 *  2. that hit carries ≥1 fact of EACH domain and ≥1 generic fact.
 * The detail always carries the per-bucket counts, so a fail is
 * diagnosable from the report alone.
 */
export function checkCrossDomainEntity(
  hits: readonly HitLike[],
  spec: Pick<CrossEntityCheck, 'entityNameToken' | 'domains' | 'genericMarkers'>,
): Verdict {
  const named = hits.filter((h) => containsAnyOf(h.canonicalName ?? '', [spec.entityNameToken]));
  if (named.length === 0) {
    return {
      pass: false,
      detail: `no hit named ~"${spec.entityNameToken}" among ${hits.length} results`,
    };
  }
  if (named.length > 1) {
    const names = named.map((h) => `"${h.canonicalName ?? h.entityId}"`).join(', ');
    return {
      pass: false,
      detail: `entity duplicated across ${named.length} hits: ${names}`,
    };
  }
  const top = named[0];
  if (top === undefined) return { pass: false, detail: 'unreachable: no named hit' };
  const [a, b] = spec.domains;
  let inA = 0;
  let inB = 0;
  let generic = 0;
  for (const fact of top.facts ?? []) {
    const isA = inDomain(fact.predicate, fact.object, a);
    const isB = inDomain(fact.predicate, fact.object, b);
    if (isA) inA += 1;
    if (isB) inB += 1;
    if (!isA && !isB && containsAnyOf(`${fact.predicate} ${fact.object}`, spec.genericMarkers)) {
      generic += 1;
    }
  }
  const counts =
    `${a.namespace}=${inA}, ${b.namespace}=${inB}, generic=${generic} ` +
    `of ${(top.facts ?? []).length} facts on "${top.canonicalName ?? top.entityId}"`;
  if (inA > 0 && inB > 0 && generic > 0) {
    return { pass: true, detail: `one entity carries both domains: ${counts}` };
  }
  return { pass: false, detail: `domain coverage incomplete: ${counts}` };
}

/**
 * Timeline interleave check: fact.recorded events of BOTH domains are
 * present, and neither domain sits entirely before the other in time —
 * i.e. each domain's LAST event is later than the other domain's
 * FIRST event. The corpus seeds late events of both domains in the
 * mixed conversation, so a correctly-anchored timeline interleaves.
 */
export function checkInterleavedDomains(
  events: readonly HistoryEvent[],
  a: DomainSpec,
  b: DomainSpec,
): Verdict {
  const inA = events.filter((e) => inDomain(e.predicate, e.object, a));
  const inB = events.filter((e) => inDomain(e.predicate, e.object, b));
  if (inA.length === 0 || inB.length === 0) {
    return {
      pass: false,
      detail:
        `timeline lacks a domain: ${a.namespace}=${inA.length}, ` +
        `${b.namespace}=${inB.length} of ${events.length} recorded events`,
    };
  }
  const at = (list: readonly HistoryEvent[]): number[] =>
    list.map((e) => Date.parse(e.at)).filter((n) => !Number.isNaN(n));
  const timesA = at(inA);
  const timesB = at(inB);
  if (timesA.length === 0 || timesB.length === 0) {
    return { pass: false, detail: 'domain events carry unparseable timestamps' };
  }
  const lastAAfterFirstB = Math.max(...timesA) > Math.min(...timesB);
  const lastBAfterFirstA = Math.max(...timesB) > Math.min(...timesA);
  if (lastAAfterFirstB && lastBAfterFirstA) {
    return {
      pass: true,
      detail:
        `${inA.length} ${a.namespace} + ${inB.length} ${b.namespace} events ` +
        'genuinely interleave in time',
    };
  }
  const blockFirst = lastAAfterFirstB ? b.namespace : a.namespace;
  return {
    pass: false,
    detail:
      `domains do not interleave: every ${blockFirst} event precedes the ` +
      `other domain (${a.namespace}=${inA.length}, ${b.namespace}=${inB.length})`,
  };
}

// ── serve verdicts ──────────────────────────────────────────────────

export interface ServeVerdict {
  status: 'pass' | 'fail';
  detail: string;
}

/**
 * Cross-domain serve verdict: the answer must satisfy EVERY marker
 * group (each group anyOf — the sibling's missingKeyPhrases). An
 * abstention fails: the entity is richly known, so declining to serve
 * it is the cross-domain failure being measured, not honesty.
 */
export function scoreServeCross(
  answer: string | null | undefined,
  reason: string | undefined,
  requireGroups: ReadonlyArray<string[]>,
): ServeVerdict {
  if (isAbstention(answer, reason)) {
    return { status: 'fail', detail: 'abstained on a richly-known entity' };
  }
  const missing = missingKeyPhrases(answer ?? '', requireGroups);
  if (missing.length === 0) {
    return {
      status: 'pass',
      detail: `answer serves ≥1 marker of all ${requireGroups.length} domains`,
    };
  }
  return {
    status: 'fail',
    detail: `answer misses ${missing.length}/${requireGroups.length} domain group(s): ${missing.join('; ')}`,
  };
}

// ── rogue-surface scan ──────────────────────────────────────────────

/**
 * Pack-namespaced tool detector: pack mcpTools surface as
 * `<packId>__<tool>` (the code_memory__decided naming law), while
 * every builtin tool uses single underscores. Returns the offenders —
 * an empty list is the asserted no-op.
 */
export function findNamespacedTools(toolNames: readonly string[]): string[] {
  return toolNames.filter((name) => name.includes('__'));
}
