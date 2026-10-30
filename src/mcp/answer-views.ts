import type { SynthesizeResult } from '../synthesize/synthesize.types';
import type { MultiHopResult } from '../multi-hop/multi-hop.types';
import { z } from 'zod';
import type { BrainScope } from '../auth/api-key.types';
import { countTokens } from '../common/token-counter';
import {
  focusHypothesis,
  focusSelect,
  renderFocus,
  type FocusBelief,
  type FocusSourceTurn,
  type Kept,
} from './compact-read';
import type { ReadToolDeps } from './read-tools';

/**
 * What synthesize and search_multi_hop hand a model by default.
 *
 * Both used to return the whole retrieval beside the answer — every hit
 * with its score breakdown and record ids. Measured on the memory-fitness
 * memory (68 turns, 1986 tokens raw), one synthesize answer cost 11453
 * tokens and one multi-hop answer 13110: six times the raw history the
 * memory exists to spare the reader. An answer is the answer and the
 * facts it cites; when there is no answer (harness mode leaves the
 * reading to the agent; strict guardrails abstain) the reader gets the
 * evidence as search_knowledge's focus view gives it. `detail: "full"`
 * returns the old shape.
 */
export function synthesizeView(
  out: SynthesizeResult,
  evidence: string | undefined,
): Omit<SynthesizeResult, 'results' | 'decisionLog'> & { evidence?: string } {
  const { results: _results, decisionLog: _log, ...rest } = out;
  return { ...rest, ...(out.answer === null && evidence !== undefined ? { evidence } : {}) };
}

export interface MultiHopView {
  isMultiHop: boolean;
  /** Each hop's sub-query and how many entities it kept. */
  hops: Array<{ query: string; kept: number }>;
  synthesis?: MultiHopResult['synthesis'];
  evidence: string;
}

export function multiHopView(out: MultiHopResult, evidence: string): MultiHopView {
  return {
    isMultiHop: out.isMultiHop,
    hops: out.hops.map((h) => ({ query: h.hop.subQuery, kept: h.runningEntityIds.length })),
    ...(out.synthesis ? { synthesis: out.synthesis } : {}),
    evidence,
  };
}

/**
 * The focus view of a retrieval (compact-read.ts): what the query is
 * about, each piece of evidence as facts or the turn it came from,
 * whichever is shorter. search_knowledge's default, and the evidence
 * synthesize and search_multi_hop hand back beside (or instead of) an
 * answer.
 */
export async function focusOf(
  ctx: {
    deps: ReadToolDeps;
    companyId: string;
    scopes: BrainScope[];
    query: string;
    userId?: string | undefined;
  },
  found: Parameters<typeof renderFocus>[0]['out'],
): Promise<string> {
  const beliefs = await scoredBeliefs(ctx);
  const { kept } = focusSelect(found, {}, beliefs);
  const sources = ctx.deps.sourceTurns
    ? await ctx.deps.sourceTurns.turnsOf({
        companyId: ctx.companyId,
        factIds: kept.map((k) => k.fact.factId),
        scopes: ctx.scopes,
        userId: ctx.userId,
      })
    : new Map<string, FocusSourceTurn[]>();
  const entailed = await entailedBySource(kept, sources, ctx.deps.entails);
  return renderFocus({ out: found, sources, tokens: countTokens, entailed, beliefs });
}

/**
 * The beliefs the query reaches, each with the cross-encoder's relevance
 * of its statement — the coarse level of the focus pool. None without a
 * scoped user (the belief lane's fence) or without relevance scores.
 */
async function scoredBeliefs(ctx: {
  deps: ReadToolDeps;
  companyId: string;
  query: string;
  userId?: string | undefined;
}): Promise<FocusBelief[]> {
  const { beliefs, relevance } = ctx.deps;
  if (!beliefs || !relevance || ctx.userId === undefined) return [];
  const found = await beliefs({ companyId: ctx.companyId, query: ctx.query, userId: ctx.userId });
  if (found.length === 0) return [];
  const scores = await relevance(
    ctx.query,
    found.map((b) => ({ label: `${b.subject} — ${b.field}`, body: b.statement })),
  );
  return found.flatMap((b, i) => {
    const r = scores[i];
    return r === undefined ? [] : [{ ...b, relevance: r }];
  });
}

/**
 * The kept facts their first source turn entails, one NLI call per turn.
 * No NLI available → none: the facts are shown, never a quote unchecked.
 */
async function entailedBySource(
  kept: Kept[],
  sources: Map<string, FocusSourceTurn[]>,
  entails: ReadToolDeps['entails'],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!entails) return out;
  const byTurn = new Map<string, { text: string; facts: Kept[] }>();
  for (const k of kept) {
    const turn = sources.get(k.fact.factId)?.[0];
    if (!turn) continue;
    const g = byTurn.get(turn.episodeId) ?? { text: turn.text, facts: [] };
    g.facts.push(k);
    byTurn.set(turn.episodeId, g);
  }
  for (const { text, facts } of byTurn.values()) {
    const verdicts = await entails(text, facts.map(focusHypothesis));
    facts.forEach((k, i) => {
      if (verdicts[i] === true) out.add(k.fact.factId);
    });
  }
  return out;
}

export const answerDetailArg = z
  .enum(['answer', 'full'])
  .optional()
  .describe(
    'answer (default): the answer and its citations, or the focus view of the evidence when there is none. full: adds every retrieved hit with scores and ids',
  );
