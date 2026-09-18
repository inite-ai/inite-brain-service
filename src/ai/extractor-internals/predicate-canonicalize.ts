import type { Logger } from '@nestjs/common';
import type { LocalPredicateSelectorService } from '../local-predicate-selector.service';
import type { PredicateRegistryService, PredicateSnapshot } from '../predicate-registry.service';
import type { ExtractedFact } from './types';

/**
 * Local predicate selection — embed each clause and pick the canonical
 * predicate with highest cosine similarity vs the registry's per-
 * predicate description embeddings. Overrides the LLM-coined predicate
 * ONLY when local top-1 is above `threshold`.
 *
 * Mutates facts in place — predicate field is overwritten on hit.
 * Returns the override-decision list for trace emission.
 */
export interface ApplyLocalPredicateOverridesOptions {
  facts: ExtractedFact[];
  snapshot: PredicateSnapshot | null;
  selector: LocalPredicateSelectorService;
  threshold: number;
}

export async function applyLocalPredicateOverrides({
  facts,
  snapshot,
  selector,
  threshold,
}: ApplyLocalPredicateOverridesOptions): Promise<
  Array<{ original: string; override: string; similarity: number }>
> {
  const overrides: Array<{
    original: string;
    override: string;
    similarity: number;
  }> = [];
  for (const f of facts) {
    if (!f.clause) continue;
    const ranked = await selector.rank(f.clause, snapshot, 3);
    if (ranked.length === 0) continue;
    const top = ranked[0]!; // non-empty guaranteed by the guard above
    if (top.similarity < threshold) continue;
    if (top.predicateId === f.predicate) continue;
    overrides.push({
      original: f.predicate,
      override: top.predicateId,
      similarity: top.similarity,
    });
    f.predicate = top.predicateId;
  }
  return overrides;
}

/**
 * One registry decision per DISTINCT predicate in the batch, resolved
 * concurrently — the shape both canonicalization passes share.
 *
 * WHY GROUPED. `registry.canonicalize` is a per-predicate question — a
 * novel coinage is compared against the curated seed embeddings and,
 * below the alias threshold, classified by the semantics judge (an LLM
 * call, ~1 s). The passes used to ask it once PER FACT, in sequence:
 * a turn with five novel predicates spent ~4 s of its ingest waiting on
 * five serial judge calls, and a repeat coinage inside the same turn
 * only "matched" because the first fact's insert had landed by then.
 * Grouping makes that ordering explicit — the first fact's context
 * text carries the predicate, as it always effectively did — and lets
 * distinct predicates resolve in parallel (the judge's own semaphore
 * bounds the fan-out). Decisions between coinages of one batch are not
 * lost: coinage-vs-coinage aliasing is the consolidation pass's job,
 * not this one's (see registry.canonicalize).
 *
 * Defensive: a per-predicate error is logged and its facts are left
 * untouched; the pass never throws.
 */
async function decidePerPredicate({
  facts,
  registry,
  companyId,
  logger,
  pass,
}: ApplyCanonicalizePassOptions & { pass: string }): Promise<
  Map<string, Awaited<ReturnType<PredicateRegistryService['canonicalize']>>>
> {
  const firstByPredicate = new Map<string, ExtractedFact>();
  for (const f of facts)
    if (!firstByPredicate.has(f.predicate)) firstByPredicate.set(f.predicate, f);
  const decisions = new Map<
    string,
    Awaited<ReturnType<PredicateRegistryService['canonicalize']>>
  >();
  await Promise.all(
    [...firstByPredicate.entries()].map(async ([predicate, f]) => {
      const contextText = `${f.predicate}: ${f.object}${f.clause ? ` (clause: ${f.clause})` : ''}`;
      try {
        decisions.set(
          predicate,
          await registry.canonicalize(companyId, predicate, {
            text: contextText,
            cardinality: f.cardinality,
          }),
        );
      } catch (e) {
        logger.warn(`${pass} failed for predicate '${predicate}': ${(e as Error).message}`);
      }
    }),
  );
  return decisions;
}

/**
 * EDC alias pass — the OPEN-vocabulary variant of canonicalization
 * (0082, audit 2026-08 finding #2). The dialogue profile's point is to
 * KEEP the specific coined predicate, so this pass never touches
 * `f.predicate`; it runs the same registry.canonicalize and stamps the
 * canonical id into `f.predicateAlias` instead. Downstream, resolution
 * and the read-side predicate consumers key on
 * `predicateAlias ?? predicate` — coinages of one canon meet, the raw
 * coinage survives for display and embedding.
 *
 * A predicate that is its own canon (registry hit on itself, or a
 * novel coinage inserted as proposed) gets NO alias — the ?? fallback
 * already lands on the right key.
 *
 * Returns the non-trivial decisions, one per distinct predicate, for
 * trace emission.
 */
export async function applyAliasPass(opts: ApplyCanonicalizePassOptions): Promise<
  Array<{
    original: string;
    canonical: string;
    kind: 'matched' | 'aliased' | 'proposed';
    similarity?: number;
  }>
> {
  const decided = await decidePerPredicate({ ...opts, pass: 'alias pass' });
  const decisions: Array<{
    original: string;
    canonical: string;
    kind: 'matched' | 'aliased' | 'proposed';
    similarity?: number;
  }> = [];
  for (const [predicate, decision] of decided) {
    if (decision.canonicalId === predicate) continue;
    for (const f of opts.facts)
      if (f.predicate === predicate) f.predicateAlias = decision.canonicalId;
    decisions.push({
      original: predicate,
      canonical: decision.canonicalId,
      kind: decision.kind,
      ...(decision.kind === 'aliased' ? { similarity: decision.similarity } : {}),
    });
  }
  return decisions;
}

/**
 * EDC canonicalization pass. For each distinct predicate, ask the
 * registry to resolve the (possibly-novel) predicate to its canonical
 * id — matching an existing predicate, auto-aliasing a similar novel
 * one, or inserting it as proposed — and rewrite every fact that
 * carries it. Mutates facts in place.
 *
 * Returns the non-trivial decisions, one per distinct predicate, for
 * trace emission.
 */
export interface ApplyCanonicalizePassOptions {
  facts: ExtractedFact[];
  registry: PredicateRegistryService;
  companyId: string;
  logger: Logger;
}

export async function applyCanonicalizePass(opts: ApplyCanonicalizePassOptions): Promise<
  Array<{
    original: string;
    canonical: string;
    kind: 'matched' | 'aliased' | 'proposed';
    similarity?: number;
    bestMatchId?: string;
  }>
> {
  const decided = await decidePerPredicate({ ...opts, pass: 'canonicalize' });
  const decisions: Array<{
    original: string;
    canonical: string;
    kind: 'matched' | 'aliased' | 'proposed';
    similarity?: number;
    bestMatchId?: string;
  }> = [];
  for (const [predicate, decision] of decided) {
    if (decision.canonicalId !== predicate) {
      decisions.push({
        original: predicate,
        canonical: decision.canonicalId,
        kind: decision.kind,
        ...(decision.kind === 'aliased' ? { similarity: decision.similarity } : {}),
        ...(decision.kind === 'proposed' && decision.bestMatch
          ? {
              similarity: decision.bestMatch.similarity,
              bestMatchId: decision.bestMatch.predicateId,
            }
          : {}),
      });
      for (const f of opts.facts) if (f.predicate === predicate) f.predicate = decision.canonicalId;
    } else if (decision.kind !== 'matched') {
      decisions.push({
        original: predicate,
        canonical: decision.canonicalId,
        kind: decision.kind,
        ...(decision.kind === 'aliased' ? { similarity: decision.similarity } : {}),
      });
    }
  }
  return decisions;
}
