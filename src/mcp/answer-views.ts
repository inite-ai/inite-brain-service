import type { SynthesizeResult } from '../synthesize/synthesize.types';
import type { MultiHopResult } from '../multi-hop/multi-hop.types';
import { z } from 'zod';
import type { BrainScope } from '../auth/api-key.types';
import { countTokens } from '../common/token-counter';
import { focusSelect, renderFocus } from './compact-read';
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
  ctx: { deps: ReadToolDeps; companyId: string; scopes: BrainScope[]; userId?: string | undefined },
  found: Parameters<typeof renderFocus>[0]['out'],
): Promise<string> {
  const factIds = focusSelect(found).kept.map((k) => k.fact.factId);
  const sources = ctx.deps.sourceTurns
    ? await ctx.deps.sourceTurns.turnsOf({
        companyId: ctx.companyId,
        factIds,
        scopes: ctx.scopes,
        userId: ctx.userId,
      })
    : new Map();
  return renderFocus({ out: found, sources, tokens: countTokens });
}

export const answerDetailArg = z
  .enum(['answer', 'full'])
  .optional()
  .describe(
    'answer (default): the answer and its citations, or the focus view of the evidence when there is none. full: adds every retrieved hit with scores and ids',
  );
