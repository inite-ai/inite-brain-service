/**
 * Truth discovery: which of the values claimed for one slot is probably
 * true, and how reliable each source is, estimated together (#847).
 *
 * The model is Dawid & Skene (1979) with one accuracy per source: a source
 * names the true value with probability a, and otherwise one of the other
 * values claimed for the slot. EM alternates between the two unknowns:
 * claim posteriors given accuracies (E), accuracies given claim posteriors
 * (M). Sources that copy each other are not independent evidence (Dong et
 * al., VLDB 2009), so every vote is one ORIGIN: facts that share an
 * `originKey` (0050) collapse into one vote.
 *
 * What competes. Only facts on the same single-valued slot whose valid-time
 * intervals overlap and whose values differ. A value that succeeded another
 * in valid time is not its rival, so reporting a change never costs a
 * source accuracy (the win/loss refit counted every `superseded` fact as a
 * loss). An uncontested value with at least two independent origins is
 * kept as a one-claim contest: agreement across origins is evidence the
 * sources were right. A value from one origin with no rival says nothing
 * about anyone and is left out.
 *
 * Priors. Accuracy has a Beta prior of strength `priorStrength`
 * pseudo-votes. Per (source, domain) it shrinks towards the source's own
 * accuracy across domains, and that in turn towards the declared
 * `authLevel` (source_registry, 0046), or 0.5 where nothing is declared.
 * A sparse source therefore stays near what is known about it instead of
 * jumping on its first few votes.
 *
 * Anchors. A claim a user confirmed is clamped true, one a user rejected
 * or a source retracted is clamped false. This is the only place human
 * judgement enters, and it makes the fit semi-supervised.
 *
 * Pure: no I/O, deterministic for a given input.
 */

export interface TruthFact {
  factId: string;
  /** The slot: entity, canonical predicate, scope and derived world. */
  slot: string;
  /** The value, normalised so a restatement is the same claim. */
  claim: string;
  sourceKey: string;
  /** The slot's predicate: the grain of a domain-specific accuracy. */
  domain: string;
  /** `source.originKey`, else the sourceKey: one vote per origin. */
  origin: string;
  /** Valid time, ms since epoch. */
  validFrom: number;
  /** Exclusive end of valid time; null while the value still holds. */
  validUntil: number | null;
  /** The value was retracted: its claim is clamped false. */
  retracted?: boolean;
}

export interface TruthAnchor {
  factId: string;
  /** true: a user confirmed it; false: a user rejected it. */
  correct: boolean;
}

export interface TruthOptions {
  /** Pseudo-votes of the Beta prior on every accuracy. */
  priorStrength: number;
  /** Declared prior mean per sourceKey (source_registry.authLevel); default 0.5. */
  declared?: ReadonlyMap<string, number>;
  maxIterations?: number;
  tolerance?: number;
}

export interface SourceAccuracy {
  sourceKey: string;
  /** null: the source's accuracy across every domain. */
  domain: string | null;
  accuracy: number;
  /** Votes the estimate rests on. */
  votes: number;
  /** Expected number of those votes that named the true value. */
  correct: number;
}

export interface FactTruth {
  factId: string;
  /** Posterior that this fact's value is the true one for its contest. */
  posterior: number;
  /** Distinct values in the contest (1 = corroborated, uncontested). */
  claims: number;
}

export interface TruthResult {
  facts: FactTruth[];
  sources: SourceAccuracy[];
  iterations: number;
}

/** The estimate never reaches 0 or 1, so one vote cannot veto a claim forever. */
const ACCURACY_FLOOR = 0.01;
const ACCURACY_CEIL = 0.99;

interface Vote {
  source: string;
  domain: string;
  claim: number;
}

interface Contest {
  claims: string[];
  votes: Vote[];
  /** Per claim: 1 clamped true, 0 clamped false, undefined free. */
  clamp: Array<0 | 1 | undefined>;
  /** factId → claim index, for the output. */
  members: Array<{ factId: string; claim: number }>;
  posterior: number[];
}

export function discoverTruth(
  facts: readonly TruthFact[],
  anchors: readonly TruthAnchor[],
  options: TruthOptions,
): TruthResult {
  const contests = buildContests(facts, anchors);
  const maxIterations = options.maxIterations ?? 100;
  const tolerance = options.tolerance ?? 1e-6;

  // Start from the (clamped) vote share, the usual Dawid–Skene start: the
  // all-0.5 accuracies a symmetric start would give are a fixed point.
  for (const c of contests) c.posterior = clampPosterior(c, voteShare(c));

  let accuracy = fitAccuracies(contests, options);
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    let moved = 0;
    for (const c of contests) {
      const next = clampPosterior(c, likelihood(c, accuracy.of));
      for (let i = 0; i < next.length; i++)
        moved = Math.max(moved, Math.abs(next[i]! - c.posterior[i]!));
      c.posterior = next;
    }
    accuracy = fitAccuracies(contests, options);
    if (moved < tolerance) break;
  }

  const out: FactTruth[] = [];
  for (const c of contests) {
    for (const m of c.members) {
      out.push({ factId: m.factId, posterior: c.posterior[m.claim]!, claims: c.claims.length });
    }
  }
  return { facts: out, sources: accuracy.rows, iterations };
}

/**
 * Group facts into contests: per slot, the connected components of the
 * "valid times overlap" relation. A component with two or more values is
 * a disagreement; one with a single value counts only when two or more
 * origins vouch for it.
 */
function buildContests(facts: readonly TruthFact[], anchors: readonly TruthAnchor[]): Contest[] {
  const anchorOf = new Map<string, boolean[]>();
  for (const a of anchors) {
    const list = anchorOf.get(a.factId) ?? [];
    list.push(a.correct);
    anchorOf.set(a.factId, list);
  }
  const bySlot = new Map<string, TruthFact[]>();
  for (const f of facts) {
    const list = bySlot.get(f.slot) ?? [];
    list.push(f);
    bySlot.set(f.slot, list);
  }
  const contests: Contest[] = [];
  for (const slotFacts of [...bySlot.values()]) {
    for (const group of overlapComponents(slotFacts)) {
      const contest = toContest(group, anchorOf);
      if (contest) contests.push(contest);
    }
  }
  return contests;
}

/**
 * Sweep by validFrom: a fact joins the running component while it starts
 * before that component ends. A value closed the instant it began (a
 * `single_active` slot closes the value a same-time write replaces) still
 * claimed that instant, so its interval is the instant itself, not empty:
 * two sources naming different values for one moment disagree, whichever
 * was written last.
 */
function overlapComponents(facts: TruthFact[]): TruthFact[][] {
  const sorted = [...facts].sort(
    (a, b) => a.validFrom - b.validFrom || a.factId.localeCompare(b.factId),
  );
  const groups: TruthFact[][] = [];
  let current: TruthFact[] = [];
  let end = -Infinity;
  for (const f of sorted) {
    if (current.length > 0 && f.validFrom >= end) {
      groups.push(current);
      current = [];
      end = -Infinity;
    }
    current.push(f);
    end = Math.max(end, f.validUntil === null ? Infinity : Math.max(f.validUntil, f.validFrom + 1));
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function toContest(group: TruthFact[], anchorOf: Map<string, boolean[]>): Contest | null {
  const claims = [...new Set(group.map((f) => f.claim))].sort();
  const index = new Map(claims.map((c, i) => [c, i]));
  // One vote per (origin, claim): copies of one origin are one piece of evidence.
  const seen = new Set<string>();
  const votes: Vote[] = [];
  for (const f of group) {
    const key = `${f.origin}\u0000${f.claim}`;
    if (seen.has(key)) continue;
    seen.add(key);
    votes.push({ source: f.sourceKey, domain: f.domain, claim: index.get(f.claim)! });
  }
  const origins = new Set(group.map((f) => f.origin));
  if (claims.length === 1 && origins.size < 2) return null;

  // A claim's verdicts: retraction and rejection say false, confirmation
  // true. Disagreeing humans leave the claim free rather than pick a side.
  const verdicts: boolean[][] = claims.map(() => []);
  for (const f of group) {
    const i = index.get(f.claim)!;
    if (f.retracted) verdicts[i]!.push(false);
    for (const v of anchorOf.get(f.factId) ?? []) verdicts[i]!.push(v);
  }
  const clamp = verdicts.map((v) =>
    v.length === 0 ? undefined : v.every(Boolean) ? 1 : v.every((x) => !x) ? 0 : undefined,
  );
  return {
    claims,
    votes,
    clamp,
    members: group.map((f) => ({ factId: f.factId, claim: index.get(f.claim)! })),
    posterior: claims.map(() => 1 / claims.length),
  };
}

function voteShare(c: Contest): number[] {
  const counts = c.claims.map(() => 0);
  for (const v of c.votes) counts[v.claim]!++;
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map((n) => n / total);
}

/** P(claim i is true | votes, accuracies), in log space. */
function likelihood(c: Contest, accuracyOf: (source: string, domain: string) => number): number[] {
  const k = c.claims.length;
  if (k === 1) return [1];
  const log = c.claims.map(() => 0);
  for (const v of c.votes) {
    const a = accuracyOf(v.source, v.domain);
    const miss = Math.log((1 - a) / (k - 1));
    const hit = Math.log(a);
    for (let i = 0; i < k; i++) log[i]! += i === v.claim ? hit : miss;
  }
  const max = Math.max(...log);
  const exp = log.map((l) => Math.exp(l - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((e) => e / sum);
}

/**
 * Apply the anchors to a posterior: a claim clamped true takes all the
 * mass; claims clamped false take none and the rest renormalise. A contest
 * whose every claim is clamped false keeps its unclamped estimate: the
 * truth is then something nobody claimed, which this model cannot name.
 */
function clampPosterior(c: Contest, p: number[]): number[] {
  const yes = c.clamp.indexOf(1);
  if (yes >= 0) return p.map((_, i) => (i === yes ? 1 : 0));
  const kept = p.map((v, i) => (c.clamp[i] === 0 ? 0 : v));
  const sum = kept.reduce((a, b) => a + b, 0);
  return sum > 0 ? kept.map((v) => v / sum) : p;
}

/**
 * The M step with hierarchical shrinkage: declared prior → the source
 * across domains → the source within one domain, each level a Beta with
 * `priorStrength` pseudo-votes centred on the level above.
 */
function fitAccuracies(
  contests: Contest[],
  options: TruthOptions,
): { of: (source: string, domain: string) => number; rows: SourceAccuracy[] } {
  const global = new Map<string, { correct: number; votes: number }>();
  const scoped = new Map<
    string,
    { source: string; domain: string; correct: number; votes: number }
  >();
  for (const c of contests) {
    for (const v of c.votes) {
      const right = c.posterior[v.claim]!;
      const g = global.get(v.source) ?? { correct: 0, votes: 0 };
      g.correct += right;
      g.votes += 1;
      global.set(v.source, g);
      const key = `${v.source}\u0000${v.domain}`;
      const s = scoped.get(key) ?? { source: v.source, domain: v.domain, correct: 0, votes: 0 };
      s.correct += right;
      s.votes += 1;
      scoped.set(key, s);
    }
  }
  const strength = options.priorStrength;
  const shrink = (correct: number, votes: number, mean: number) =>
    bound((strength * mean + correct) / (strength + votes));
  const globalAccuracy = new Map<string, number>();
  const rows: SourceAccuracy[] = [];
  for (const [source, g] of [...global.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const accuracy = shrink(g.correct, g.votes, options.declared?.get(source) ?? 0.5);
    globalAccuracy.set(source, accuracy);
    rows.push({ sourceKey: source, domain: null, accuracy, votes: g.votes, correct: g.correct });
  }
  const scopedAccuracy = new Map<string, number>();
  for (const [key, s] of [...scoped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const accuracy = shrink(s.correct, s.votes, globalAccuracy.get(s.source)!);
    scopedAccuracy.set(key, accuracy);
    rows.push({
      sourceKey: s.source,
      domain: s.domain,
      accuracy,
      votes: s.votes,
      correct: s.correct,
    });
  }
  return {
    of: (source, domain) =>
      scopedAccuracy.get(`${source}\u0000${domain}`) ??
      globalAccuracy.get(source) ??
      bound(options.declared?.get(source) ?? 0.5),
    rows,
  };
}

function bound(a: number): number {
  return Math.min(ACCURACY_CEIL, Math.max(ACCURACY_FLOOR, a));
}
