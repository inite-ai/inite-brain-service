import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { PredicateIdentityJudgeService } from '../ai/predicate-identity-judge.service';
import { sharesContentToken } from '../common/attribute-names';

/**
 * PredicateConsolidationService — one global pass that folds a tenant's
 * accumulated predicate vocabulary onto its canonical names.
 *
 * WHY IT IS A PASS AND NOT A WRITE-PATH DECISION. Canonicalization used
 * to happen only at coinage: a novel predicate was compared against a
 * shortlist and aliased or proposed, once, forever. Three properties
 * follow from that shape, and all three are wrong:
 *
 *  - ORDER-DEPENDENT. Whichever variant the extractor happened to coin
 *    first became the canon, and a predicate coined BEFORE its sibling
 *    could never merge with it — nothing ever reconsiders a decision.
 *  - RETROACTIVELY BLIND. A tenant that already holds 133 coined
 *    predicates keeps them. Measured on a battery tenant, the write-path
 *    judge merged 24 of them and left the rest untouched, because only
 *    predicates coined DURING that run were ever examined.
 *  - LOCAL. Each decision saw three candidates, never the vocabulary, so
 *    nothing guaranteed that variants of one attribute converged on one
 *    name rather than on two.
 *
 * The literature is unanimous on the shape this wants instead: CESI
 * (WWW'18) canonicalizes Open KB relation phrases by CLUSTERING over the
 * whole vocabulary; EDC (arXiv:2404.03868), the framework our coinage
 * path is modelled on, calls its third stage POST-HOC canonicalization;
 * DIAL-KG's evolution-intent assessment has three outcomes, and the one
 * a write-path decision structurally cannot express is "merge with
 * variant relations ALREADY PRESENT".
 *
 * THE ALGORITHM is leader (canopy) clustering, chosen over the
 * agglomerative clustering CESI uses for one reason: HAC merges CLUSTERS,
 * so a chain of locally-plausible links (A~B, B~C) silently equates A and
 * C, which for predicates means quietly destroying an attribute. Here
 * every candidate is judged against a LEADER and never transitively, so
 * a merge is always a claim someone made about that exact pair.
 *
 *   1. Order the vocabulary deterministically: curated `active` seeds
 *      first, then `proposed` by fact count descending, id ascending.
 *      The most-used name leads, so the canon is the name the data
 *      actually speaks.
 *   2. For each candidate, BLOCK against the leaders chosen so far
 *      (sharesContentToken — token blocking with a prefix predicate;
 *      PC 1.000 / RR 0.9905 on a live registry, see its spec). An empty
 *      block costs nothing and makes the candidate a leader.
 *   3. Otherwise ONE judge call over the blocked leaders. A match joins
 *      that cluster; no match makes it a leader.
 *   4. Apply through `registry.alias()`, which marks the row AND carries
 *      the alias onto the facts already written under it — slot identity
 *      is `(predicateAlias ?? predicate)`, so an alias that stops at the
 *      registry row leaves every stored fact where the canon cannot
 *      reach it.
 *
 * IDEMPOTENT AND CONVERGENT. Aliased rows are excluded from both the
 * candidate and the leader sets, so a second run over an unchanged
 * vocabulary examines the same leaders, finds no new candidates and
 * writes nothing. A re-coined variant simply joins its cluster on the
 * next pass — one-way, never flip-flop.
 *
 * SEEDS ARE NEVER ALIASED AWAY. An `active` predicate is curated
 * ontology; it can only ever be a leader.
 */
@Injectable()
export class PredicateConsolidationService {
  private readonly logger = new Logger(PredicateConsolidationService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly registry: PredicateRegistryService,
    private readonly judge: PredicateIdentityJudgeService,
  ) {}

  async run(companyId: string, opts: { dryRun?: boolean } = {}): Promise<ConsolidationResult> {
    const dryRun = opts.dryRun === true;
    const result: ConsolidationResult = {
      examined: 0,
      leaders: 0,
      merged: 0,
      factsRepointed: 0,
      blocked: 0,
      judged: 0,
      dryRun,
      merges: [],
    };
    if (!this.judge.isAvailable()) {
      this.logger.warn(
        `predicate consolidation skipped for ${companyId}: no identity judge configured`,
      );
      return result;
    }

    const rows = await this.loadVocabulary(companyId);
    // Curated seeds lead; then the most-used coinage. Ties break on the
    // id so a re-run over unchanged data takes the same path.
    const seeds = rows.filter((r) => r.status === 'active');
    const coined = rows
      .filter((r) => r.status === 'proposed')
      .sort((a, b) => b.factCount - a.factCount || a.predicateId.localeCompare(b.predicateId));

    const leaders: string[] = seeds.map((r) => r.predicateId);
    for (const cand of coined) {
      result.examined += 1;
      const block = leaders.filter((l) => sharesContentToken(cand.predicateId, l));
      if (block.length === 0) {
        leaders.push(cand.predicateId);
        continue;
      }
      result.blocked += 1;
      result.judged += 1;
      const picked = await this.judge.sameAttributeAs(
        cand.predicateId,
        cand.sampleContext ?? cand.predicateId.replace(/_/g, ' '),
        block,
      );
      if (picked === null) {
        leaders.push(cand.predicateId);
        continue;
      }
      result.merged += 1;
      result.merges.push({ from: cand.predicateId, to: picked, facts: cand.factCount });
      if (dryRun) continue;
      const { factsRepointed } = await this.registry.alias(companyId, cand.predicateId, picked);
      result.factsRepointed += factsRepointed;
    }
    result.leaders = leaders.length;

    this.logger.log(
      `predicate consolidation${dryRun ? ' (dry run)' : ''} for ${companyId}: ` +
        `${result.examined} coined predicate(s) examined, ${result.blocked} blocked into a ` +
        `candidate set, ${result.merged} merged onto ${result.leaders} leader(s), ` +
        `${result.factsRepointed} fact(s) re-pointed`,
    );
    return result;
  }

  /**
   * The vocabulary with each predicate's fact count and one sample
   * object — the "example use" the judge reads, taken from the data
   * rather than re-derived, and the fact count that decides who leads.
   *
   * Deliberately does NOT select embeddings: the coined set's vectors
   * are the O(registry) MB that `OMIT embedding` exists to keep out of
   * this process (0082). Blocking here is lexical, so none are needed.
   */
  private async loadVocabulary(companyId: string): Promise<VocabularyRow[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [preds] = await db.query<[Array<{ predicateId?: unknown; status?: unknown }>]>(
        `SELECT predicateId, status FROM knowledge_predicate
          WHERE status = 'active' OR status = 'proposed'`,
      );
      const [counts] = await db.query<
        [Array<{ predicate?: unknown; n?: unknown; sample?: unknown }>]
      >(
        `SELECT predicate, count() AS n, array::first(array::group(object)) AS sample
           FROM knowledge_fact GROUP BY predicate`,
      );
      const byPredicate = new Map<string, { n: number; sample?: string }>();
      for (const c of (counts as Array<Record<string, unknown>>) ?? []) {
        if (typeof c.predicate !== 'string') continue;
        byPredicate.set(c.predicate, {
          n: typeof c.n === 'number' ? c.n : 0,
          ...(typeof c.sample === 'string' ? { sample: c.sample } : {}),
        });
      }
      const out: VocabularyRow[] = [];
      for (const p of (preds as Array<Record<string, unknown>>) ?? []) {
        if (typeof p.predicateId !== 'string' || typeof p.status !== 'string') continue;
        const hit = byPredicate.get(p.predicateId);
        out.push({
          predicateId: p.predicateId,
          status: p.status as 'active' | 'proposed',
          factCount: hit?.n ?? 0,
          ...(hit?.sample !== undefined
            ? { sampleContext: `${p.predicateId}: ${hit.sample}` }
            : {}),
        });
      }
      return out;
    });
  }
}

interface VocabularyRow {
  predicateId: string;
  status: 'active' | 'proposed';
  factCount: number;
  sampleContext?: string;
}

export interface ConsolidationResult {
  /** Coined predicates considered (seeds are leaders, never candidates). */
  examined: number;
  /** Distinct canonical names the vocabulary ended on. */
  leaders: number;
  merged: number;
  /** Facts whose `predicateAlias` was carried to a canon. */
  factsRepointed: number;
  /** Candidates whose block was non-empty — the judge's input count. */
  blocked: number;
  judged: number;
  dryRun: boolean;
  merges: Array<{ from: string; to: string; facts: number }>;
}
