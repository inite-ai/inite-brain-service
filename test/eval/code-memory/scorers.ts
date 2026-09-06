/**
 * Mechanical scorers of the code-memory battery. Pure functions over
 * plain JSON — no HTTP, no LLM judge — unit-tested on fixtures in
 * test/code-memory-scorers.unit-spec.ts, so every verdict is
 * reproducible from the report file.
 *
 * Generic primitives are REUSED from the sibling harnesses — one
 * implementation, one unit-tested truth: containsAnyOf / isAbstention /
 * walkProvenance from test/eval/memory-fitness/scorers.ts;
 * checkHistorySequence and scoreServe from
 * test/eval/state-transitions/scorers.ts; findExactPredicateFact and
 * findNamespacedTools from test/eval/domain-packs/scorers.ts. This
 * file adds only what the code-memory claims need: the builtin-seed
 * matcher, the forbidden-transition scan (intention guard), the
 * path-vs-symbol entity dedup, and the `why` roundtrip/supersession
 * verdicts.
 */
import { containsAnyOf } from '../memory-fitness/scorers';
import type { HitLike } from '../domain-packs/scorers';

export interface Verdict {
  pass: boolean;
  detail: string;
}

// ── builtin-seed matcher ────────────────────────────────────────────

/** The predicate fields the matcher consumes (subset of the
 *  GET /v1/admin/predicates row — src/contracts/admin/predicates.schema.ts). */
export interface PredicateLike {
  predicateId: string;
  status: string;
}

/**
 * Every required namespaced predicate is present AND active in the
 * tenant's registry — with the builtin pack this must hold WITHOUT
 * any install (bootstrap seeding is the surface under test).
 */
export function checkBuiltinPredicates(
  predicates: readonly PredicateLike[],
  required: readonly string[],
): Verdict {
  const byId = new Map(predicates.map((p) => [p.predicateId, p.status]));
  const missing: string[] = [];
  const inactive: string[] = [];
  for (const id of required) {
    const status = byId.get(id);
    if (status === undefined) missing.push(id);
    else if (status !== 'active') inactive.push(`${id} (${status})`);
  }
  if (missing.length > 0 || inactive.length > 0) {
    return {
      pass: false,
      detail:
        `builtin seeding incomplete — missing: [${missing.join(', ')}], ` +
        `non-active: [${inactive.join(', ')}] of ${predicates.length} registry rows`,
    };
  }
  return {
    pass: true,
    detail: `all ${required.length} builtin predicates active without install`,
  };
}

// ── forbidden-transition scan (intention guard) ─────────────────────

/**
 * Intention-guard verdict: NO fact across the hits may carry the
 * forbidden predicate with an object matching a marker — a voiced
 * plan ("we should probably enable X") that produced a completed
 * `state_change` is the exact failure the pre-verb guards exist to
 * prevent. Pass is the ABSENCE; a fail names the offending fact.
 */
export function checkNoForbiddenFact(
  hits: readonly HitLike[],
  predicate: string,
  objectMarkers: readonly string[],
): Verdict {
  let scanned = 0;
  for (const hit of hits) {
    for (const fact of hit.facts ?? []) {
      scanned += 1;
      if (fact.predicate !== predicate) continue;
      if (!containsAnyOf(fact.object, objectMarkers)) continue;
      return {
        pass: false,
        detail:
          `voiced plan flipped state: fact ${fact.factId} on ` +
          `"${hit.canonicalName ?? hit.entityId}" carries ${predicate}="${fact.object}"`,
      };
    }
  }
  return {
    pass: true,
    detail: `no ${predicate} fact matches [${objectMarkers.join('|')}] across ${scanned} facts scanned`,
  };
}

// ── path-vs-symbol entity dedup ─────────────────────────────────────

/**
 * Cross-phrasing entity check:
 *  1. exactly ONE hit's canonicalName matches a module name token
 *     (2+ = the path phrasing and the symbol phrasing split into
 *     separate entities — the failure being measured);
 *  2. that one hit carries ≥1 fact per marker group, each group
 *     seeded by a DIFFERENT phrasing's turn.
 * The detail always carries per-group counts, so a fail is
 * diagnosable from the report alone.
 */
export function checkEntityDedup(
  hits: readonly HitLike[],
  nameTokens: readonly string[],
  mustCarryGroups: ReadonlyArray<readonly string[]>,
): Verdict {
  const named = hits.filter((h) => containsAnyOf(h.canonicalName ?? '', nameTokens));
  if (named.length === 0) {
    return {
      pass: false,
      detail: `no hit named ~[${nameTokens.join('|')}] among ${hits.length} results`,
    };
  }
  if (named.length > 1) {
    const names = named.map((h) => `"${h.canonicalName ?? h.entityId}"`).join(', ');
    return {
      pass: false,
      detail: `module split across ${named.length} entities: ${names}`,
    };
  }
  const top = named[0];
  if (top === undefined) return { pass: false, detail: 'unreachable: no named hit' };
  const facts = top.facts ?? [];
  const counts: number[] = mustCarryGroups.map(
    (group) => facts.filter((f) => containsAnyOf(`${f.predicate} ${f.object}`, group)).length,
  );
  const summary = counts.map((n, i) => `[${(mustCarryGroups[i] ?? []).join('|')}]=${n}`).join(', ');
  if (counts.every((n) => n > 0)) {
    return {
      pass: true,
      detail:
        `one entity "${top.canonicalName ?? top.entityId}" carries both phrasings: ` +
        `${summary} of ${facts.length} facts`,
    };
  }
  return {
    pass: false,
    detail:
      `entity "${top.canonicalName ?? top.entityId}" misses a phrasing's facts: ` +
      `${summary} of ${facts.length} facts`,
  };
}

// ── `why` verdicts (roundtrip + supersession) ───────────────────────

/** The `why` tool output fields the verdicts consume. */
export interface WhyLike {
  found: number;
  memory: Array<{ kind: string; text: string }>;
}

/** record_decision → why roundtrip: ≥1 memory entry of the recorded
 *  kind whose text matches a marker. */
export function checkWhyRoundtrip(
  out: WhyLike,
  kind: string,
  textMarkers: readonly string[],
): Verdict {
  if (out.found === 0 || out.memory.length === 0) {
    return { pass: false, detail: 'why returned found:0 — the write did not round-trip' };
  }
  const hit = out.memory.find((m) => m.kind === kind && containsAnyOf(m.text, textMarkers));
  if (hit !== undefined) {
    return { pass: true, detail: `why serves ${kind}="${hit.text}"` };
  }
  const kinds = out.memory.map((m) => `${m.kind}="${m.text}"`).join('; ');
  return {
    pass: false,
    detail: `no ${kind} entry matches [${textMarkers.join('|')}]; memory: ${kinds}`,
  };
}

/**
 * Supersession verdict over two `why` reads of ONE anchor:
 *  - NOW: exactly one entry of the kind is active, it matches the NEW
 *    text and not the old one (two active = single_active broken;
 *    old text active = supersession did not happen);
 *  - asOf (a cursor between the two writes): the OLD text is
 *    recallable and the NEW one is not known yet (bitemporal).
 */
export function checkSupersession(
  now: WhyLike,
  atAsOf: WhyLike,
  kind: string,
  oldMarkers: readonly string[],
  newMarkers: readonly string[],
): Verdict {
  const nowKind = now.memory.filter((m) => m.kind === kind);
  if (nowKind.length !== 1) {
    return {
      pass: false,
      detail:
        `expected exactly 1 active ${kind} now, got ${nowKind.length}: ` +
        nowKind.map((m) => `"${m.text}"`).join('; '),
    };
  }
  const active = nowKind[0];
  if (active === undefined) return { pass: false, detail: 'unreachable: no active entry' };
  if (!containsAnyOf(active.text, newMarkers)) {
    return { pass: false, detail: `active ${kind} is not the new decision: "${active.text}"` };
  }
  if (containsAnyOf(active.text, oldMarkers)) {
    return { pass: false, detail: `active ${kind} still carries the old value: "${active.text}"` };
  }
  const oldAtAsOf = atAsOf.memory.find((m) => m.kind === kind && containsAnyOf(m.text, oldMarkers));
  if (oldAtAsOf === undefined) {
    return {
      pass: false,
      detail: `the superseded ${kind} is unrecoverable at asOf (found ${atAsOf.found})`,
    };
  }
  const newAtAsOf = atAsOf.memory.find((m) => m.kind === kind && containsAnyOf(m.text, newMarkers));
  if (newAtAsOf !== undefined) {
    return {
      pass: false,
      detail: `asOf leaks the FUTURE decision: "${newAtAsOf.text}" was not known at the cursor`,
    };
  }
  return {
    pass: true,
    detail:
      `one active ${kind} ("${active.text}"), old one recallable at asOf ` +
      `("${oldAtAsOf.text}") and the new one unknown there — supersession holds`,
  };
}
