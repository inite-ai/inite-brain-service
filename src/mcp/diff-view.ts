import type { FactRef, MemoryDiffResult } from '../diff/memory-diff.service';
import type { BrainScope } from '../auth/api-key.types';
import { countTokens } from '../common/token-counter';
import { QUOTE_MAX_CHARS, type FocusSourceTurn } from './compact-read';
import type { ReadToolDeps } from './read-tools';

/**
 * memory_diff as a changelog: what changed, per entity, one line per
 * change. The JSON carried every fact's ids, confidence and four
 * timestamps; over the memory-fitness stand's whole history it came to
 * 17 637 tokens where the 68 turns it was read from were 1 986
 * (2026-10-31) — the "what changed since we last spoke" answer cost
 * nine conversations' worth of context.
 *
 * CHANGED: one line per attribute that took more than one value in the
 * window, oldest first, `old → new` where one replaced the other — the
 * answer to "what changed".
 *
 * LEARNED: everything else, spent the way search_knowledge's focus view
 * spends evidence (compact-read.ts): facts grouped by the turn they were
 * read from, each group shown as its facts or as that turn quoted,
 * whichever costs fewer tokens — a quote only where the turn entails its
 * facts. So the diff of a whole history costs about the history, not
 * nine times it.
 *
 * Restatements of a value already held add nothing. A retraction carries
 * its day. `detail: "full"` returns the JSON.
 */

const day = (v: string | undefined): string => (v ? v.slice(0, 10) : '?');

const nameOf = (f: FactRef): string => f.entityName ?? f.entityId;

/**
 * A paraphrase of a value already held adds no knowledge of its own.
 * (A `compacted` row does: compaction folds a replaced value's history,
 * which is exactly the change a diff is asked for.)
 */
const RESTATED = new Set(['corroborating']);

/** A compaction summary retells the replaced values the chain already shows. */
const RETOLD = new Set(['compaction-summary']);

interface Value {
  object: string;
  from: string;
  until?: string | undefined;
  /** Replaced by the next value (a supersede), whatever its validity says. */
  replaced?: boolean;
}

/**
 * One attribute's values in the window, oldest first: `a → b` when one
 * value ended where the next began (or was replaced by it), `a; b` when
 * they hold together (a multi-valued attribute). An ended last value
 * shows its end.
 */
function slotLine(predicate: string, values: Value[]): string {
  const sorted = [...values].sort((a, b) => a.from.localeCompare(b.from));
  const kept = sorted.filter((v, k) => k === 0 || v.object !== sorted[k - 1]!.object);
  let line = '';
  kept.forEach((v, k) => {
    if (k > 0) {
      const prev = kept[k - 1]!;
      const ended = prev.replaced || (prev.until !== undefined && prev.until <= v.from);
      line += ended ? ' → ' : '; ';
    }
    line += `${v.object} (${day(v.from)})`;
  });
  const last = kept[kept.length - 1];
  if (last?.until && !last.replaced) line += ` until ${day(last.until)}`;
  return `  ${predicate}: ${line}`;
}

/** The turns behind the diff's facts, and the facts each turn entails. */
export interface DiffSources {
  sources: Map<string, FocusSourceTurn[]>;
  entailed: Set<string>;
  tokens: (s: string) => number;
}

const NO_SOURCES: DiffSources = {
  sources: new Map(),
  entailed: new Set(),
  tokens: (s) => s.length,
};

/** The attributes the window changed, and the facts it only added. */
function partition(out: MemoryDiffResult): {
  slots: Map<string, Map<string, Value[]>>;
  added: FactRef[];
  shown: FactRef[];
} {
  const all = new Map<string, Map<string, Array<{ f: FactRef; v: Value }>>>();
  const put = (f: FactRef, v: Value) => {
    const entity = all.get(nameOf(f)) ?? new Map<string, Array<{ f: FactRef; v: Value }>>();
    entity.set(f.predicate, [...(entity.get(f.predicate) ?? []), { f, v }]);
    all.set(nameOf(f), entity);
  };
  const valueOf = (f: FactRef): Value => ({
    object: f.object,
    from: f.validFrom,
    until: f.validUntil,
  });
  const replacements = new Set<string>();
  for (const c of out.changedFacts) {
    put(c.before, { ...valueOf(c.before), replaced: true });
    if (c.after) {
      replacements.add(c.after.factId);
      put(c.after, valueOf(c.after));
    }
  }
  for (const f of out.createdFacts) {
    if (replacements.has(f.factId) || RESTATED.has(f.status ?? '')) continue;
    if (RETOLD.has(f.sourceKind ?? '')) continue;
    put(f, valueOf(f));
  }
  const slots = new Map<string, Map<string, Value[]>>();
  const added: FactRef[] = [];
  for (const [entity, predicates] of all) {
    for (const [predicate, entries] of predicates) {
      const distinct = new Set(entries.map((e) => e.v.object));
      const ended = entries.some((e) => e.v.replaced || e.v.until !== undefined);
      if (distinct.size > 1 && ended) {
        const bucket = slots.get(entity) ?? new Map<string, Value[]>();
        bucket.set(
          predicate,
          entries.map((e) => e.v),
        );
        slots.set(entity, bucket);
      } else {
        const seen = new Set<string>();
        for (const e of entries) {
          if (seen.has(e.v.object)) continue;
          seen.add(e.v.object);
          added.push(e.f);
        }
      }
    }
  }
  const shown = [...all.values()].flatMap((p) => [...p.values()].flat().map((e) => e.f));
  return { slots, added, shown };
}

const segment = (f: FactRef): string =>
  `${f.predicate} = ${f.object}${f.validUntil ? ` (until ${day(f.validUntil)})` : ''}`;

/**
 * LEARNED, under one heading per day (the Keep a Changelog layout — the
 * day once, not on every value): per source turn, its facts or the turn
 * quoted, whichever is cheaper. When the turns behind all of it cost
 * less than the section — a window spanning most of a memory, where the
 * facts restate nearly every sentence — the turns themselves are shown,
 * in order: that IS the raw, complete, and needs no entailment check.
 */
function learnedLines(added: FactRef[], ctx: DiffSources): string[] {
  // A turn stands in for its facts where it entails them and costs less.
  const byTurn = new Map<string, { turn: FocusSourceTurn; facts: FactRef[] }>();
  for (const f of added) {
    const turn = ctx.sources.get(f.factId)?.[0];
    if (!turn || turn.text.length > QUOTE_MAX_CHARS || !ctx.entailed.has(f.factId)) continue;
    const g = byTurn.get(turn.episodeId) ?? { turn, facts: [] };
    g.facts.push(f);
    byTurn.set(turn.episodeId, g);
  }
  const quoted = new Set<string>();
  const entries: Array<{ at: string; line: string }> = [];
  for (const g of byTurn.values()) {
    const quote = `    ${quoteBody(g.turn)}`;
    if (ctx.tokens(quote) >= ctx.tokens(entityLines(g.facts).join('\n'))) continue;
    for (const f of g.facts) quoted.add(f.factId);
    entries.push({ at: g.turn.at, line: quote });
  }
  // The rest: one line per entity per day.
  const rest = new Map<string, FactRef[]>();
  for (const f of added) {
    if (quoted.has(f.factId)) continue;
    const key = `${day(f.validFrom)}\u0000${nameOf(f)}`;
    rest.set(key, [...(rest.get(key) ?? []), f]);
  }
  for (const facts of rest.values()) {
    entries.push({ at: facts[0]!.validFrom, line: entityLines(facts)[0]! });
  }
  const lines: string[] = [];
  let heading = '';
  for (const e of entries.sort((a, b) => a.at.localeCompare(b.at))) {
    if (day(e.at) !== heading) {
      heading = day(e.at);
      lines.push(`  ${heading}`);
    }
    lines.push(e.line);
  }
  return lines;
}

/** The facts as `name: p = v; p2 = v2`, one line per entity. */
function entityLines(facts: FactRef[]): string[] {
  const lines = new Map<string, string[]>();
  for (const f of facts) lines.set(nameOf(f), [...(lines.get(nameOf(f)) ?? []), segment(f)]);
  return [...lines].map(([name, segs]) => `    ${name}: ${segs.join('; ')}`);
}

/** A quoted turn under its day's heading: the speaker and the words. */
function quoteBody(t: FocusSourceTurn): string {
  return `${t.speaker ? `${t.speaker}: ` : ''}"${t.text}"`;
}

/**
 * Every turn behind `added`, oldest first, then the facts no turn holds
 * (direct writes) — the raw the section was distilled from.
 */
function transcriptOf(added: FactRef[], ctx: DiffSources): string[] {
  const turns = new Map<string, FocusSourceTurn>();
  const unsourced: FactRef[] = [];
  for (const f of added) {
    const turn = ctx.sources.get(f.factId)?.[0];
    if (turn) turns.set(turn.episodeId, turn);
    else unsourced.push(f);
  }
  const said: string[] = [];
  let heading = '';
  for (const t of [...turns.values()].sort((a, b) => a.at.localeCompare(b.at))) {
    if (day(t.at) !== heading) {
      heading = day(t.at);
      said.push(`  ${heading}`);
    }
    said.push(`    ${quoteBody(t)}`);
  }
  return unsourced.length > 0
    ? [...said, '  not from a conversation:', ...entityLines(unsourced)]
    : said;
}

/** The facts the view shows (the turns it may quote are theirs) and those it only added. */
export function diffFacts(out: MemoryDiffResult): { added: FactRef[]; shown: FactRef[] } {
  const { added, shown } = partition(out);
  return { added, shown };
}

export function diffText(out: MemoryDiffResult, ctx: DiffSources = NO_SOURCES): string {
  const { slots, added, shown } = partition(out);
  const changed: string[] = [];
  for (const [entity, predicates] of slots) {
    for (const [p, values] of predicates)
      changed.push(`  ${entity} — ${slotLine(p, values).trim()}`);
  }
  const learned = learnedLines(added, ctx);
  const structured = [
    ...(changed.length > 0 ? ['changed:', ...changed] : []),
    ...(learned.length > 0 ? ['learned:', ...learned] : []),
  ];
  // The raw this was distilled from: every turn behind the window's facts.
  // When it is cheaper — a window spanning most of a memory, where the
  // facts restate nearly every sentence — it is the answer.
  const raw = ctx.sources.size > 0 ? transcriptOf(shown, ctx) : [];
  const body =
    raw.length > 0 && ctx.tokens(raw.join('\n')) < ctx.tokens(structured.join('\n'))
      ? ['said (the turns are shorter than their facts):', ...raw]
      : structured;
  const lines = [`changes recorded ${day(out.from)} → ${day(out.to)}:`, ...body];
  if (out.retractedFacts.length > 0) {
    lines.push(
      'retracted:',
      ...out.retractedFacts.map(
        (f) => `  ${nameOf(f)}: ${f.predicate} = ${f.object} (${day(f.retractedAt)})`,
      ),
    );
  }
  if (body.length === 0 && out.retractedFacts.length === 0) {
    lines.push('  (none)');
  }
  if (out.newEntities.length > 0) {
    lines.push(`new: ${out.newEntities.map((e) => e.canonicalName || e.entityId).join(', ')}`);
  }
  if (out.forgottenEntities.length > 0) {
    lines.push(`forgotten: ${out.forgottenEntities.length} entities (erased on request)`);
  }
  if (out.lapsedExpectations.length > 0) {
    lines.push(
      'expected to be over, not confirmed since:',
      ...out.lapsedExpectations.map(
        (f) => `  ${nameOf(f)}: ${f.predicate} = ${f.object} (until ${day(f.expectedUntil)})`,
      ),
    );
  }
  if (out.truncated) lines.push('(truncated: narrow the window to see the rest)');
  return lines.join('\n');
}

/**
 * memory_diff's default answer: the turns behind the learned facts read
 * through the same fence as get_fact_provenance, and one NLI call per
 * turn deciding which facts it may stand in for. No turns or no NLI →
 * facts only, never a quote unchecked.
 */
export async function diffOf(
  ctx: { deps: ReadToolDeps; companyId: string; scopes: BrainScope[]; userId?: string | undefined },
  out: MemoryDiffResult,
): Promise<string> {
  const { sourceTurns, entails } = ctx.deps;
  if (!sourceTurns || !entails) return diffText(out, { ...NO_SOURCES, tokens: countTokens });
  const { added, shown } = diffFacts(out);
  const sources = await sourceTurns.turnsOf({
    companyId: ctx.companyId,
    factIds: shown.map((f) => f.factId),
    scopes: ctx.scopes,
    userId: ctx.userId,
  });
  const byTurn = new Map<string, { text: string; facts: FactRef[] }>();
  for (const f of added) {
    const turn = sources.get(f.factId)?.[0];
    if (!turn) continue;
    const g = byTurn.get(turn.episodeId) ?? { text: turn.text, facts: [] };
    g.facts.push(f);
    byTurn.set(turn.episodeId, g);
  }
  const entailed = new Set<string>();
  for (const { text, facts } of byTurn.values()) {
    const verdicts = await entails(
      text,
      facts.map((f) => `${nameOf(f)} ${f.predicate.replace(/_/g, ' ')}: ${f.object}`),
    );
    facts.forEach((f, i) => {
      if (verdicts[i] === true) entailed.add(f.factId);
    });
  }
  return diffText(out, { sources, entailed, tokens: countTokens });
}
