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
 *
 * THE SECOND HALF IS THE ONE THAT CHANGES ANSWERS. Merging names is
 * bookkeeping: a fact keeps the status it was written with, so a slot
 * can hold several active values whatever its name. The pass therefore
 * ends by RE-RESOLVING contested slots under today's policy — see
 * reresolveSlots. Measured on a battery tenant, 20 slots held more than
 * one active value; the merges above had increased that count, because
 * co-locating facts is not the same as adjudicating them.
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
      slotsContested: 0,
      slotsResolved: 0,
      factsRetired: 0,
      beliefDuplicatesRetired: 0,
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
    if (!dryRun) {
      Object.assign(result, await this.reresolveSlots(companyId, result));
      result.beliefDuplicatesRetired = await this.retireBeliefSlotDuplicates(companyId);
    }

    this.logger.log(
      `predicate consolidation${dryRun ? ' (dry run)' : ''} for ${companyId}: ` +
        `${result.examined} coined predicate(s) examined, ${result.blocked} blocked into a ` +
        `candidate set, ${result.merged} merged onto ${result.leaders} leader(s), ` +
        `${result.factsRepointed} fact(s) re-pointed; ` +
        `${result.slotsResolved}/${result.slotsContested} contested slot(s) re-resolved, ` +
        `${result.factsRetired} stale value(s) retired, ` +
        `${result.beliefDuplicatesRetired} duplicate belief(s) closed`,
    );
    return result;
  }

  /**
   * Apply TODAY's policy to facts that are already co-located in a slot.
   *
   * Merging names is bookkeeping on its own. A fact keeps the status it
   * was given when it was written, and resolution runs at ingest — so a
   * slot can hold several active values for reasons that have nothing to
   * do with naming:
   *
   *  - the INGEST-ORDERING RACE. The policy that applied is the one in
   *    the registry at write time, and a predicate is classified when it
   *    is coined. A fact written before its own predicate was classified
   *    took `append_only`, which means "no conflict possible", and
   *    stayed active beside everything that followed.
   *  - a MISCLASSIFICATION since corrected. Measured on six tenants from
   *    one corpus, the whole deploy family was `append_only`; correcting
   *    the prompt fixes new writes and does nothing for what is stored.
   *  - the merge this pass just made, which co-locates facts that were
   *    never resolved against each other in the first place.
   *
   * Measured on a battery tenant: grouping active facts on the
   * alias-resolved slot found 20 slots holding more than one active
   * value — `service_port` with five, `deployed_to` with two.
   *
   * CONSERVATIVE BY CONSTRUCTION. Only `single_active` slots are
   * touched, because that policy alone settles the outcome without a
   * similarity margin: the latest value wins, the rest become history.
   * `bitemporal` needs the resolver's cosine and margin and is left to
   * it; `append_only` is nothing to resolve. Losers are MARKED, never
   * deleted, with the same stamp `fn::resolve_fact` writes, so a
   * retroactively resolved slot is indistinguishable from one resolved
   * at ingest. Idempotent: a second run finds one active per slot.
   *
   * THE SNAPSHOT MUST BE RE-WARMED FIRST, and that is not a micro-
   * optimisation. `alias()` goes through `update()`, which ends in
   * `invalidate(companyId)` — so by the time the merges are done the
   * tenant's cache entry is GONE, and `policyFor` is a SYNC lookup that
   * silently answers from `SEED_PREDICATES` (core ∪ builtin packs) when
   * the cache is cold. Every `proposed` predicate — which is every
   * predicate the extractor coined — then reads back as the
   * `append_only` DEFAULT_FALLBACK and this loop declines it.
   *
   * Measured: three tenants held 6 / 8 / 4 contested `single_active`
   * slots (`deploy_target`, `retry_policy`, `pilot_launch_date`,
   * `queue_backend`, `payout_cutoff` …) and the pass attempted exactly
   * ONE re-resolve between them — on `code_memory__owns`, the single
   * contested slot whose predicate happens to be a PACK SEED and so
   * survives a cold cache. The other eighteen looked like a policy
   * decision in the counters and were a cache miss.
   */
  private async reresolveSlots(
    companyId: string,
    result: ConsolidationResult,
  ): Promise<Partial<ConsolidationResult>> {
    await this.registry.getSnapshot(companyId);
    const slots = await this.loadContestedSlots(companyId);
    let resolved = 0;
    let retired = 0;
    for (const slot of slots) {
      const policy = this.registry.policyFor(companyId, slot.slot);
      if (policy.semantics !== 'single_active') continue;
      // Latest valid-from wins; the id breaks a tie so a replay over the
      // same data picks the same winner.
      const ordered = [...slot.facts].sort(
        (a, b) => b.validFrom - a.validFrom || b.id.localeCompare(a.id),
      );
      const winner = ordered[0];
      const losers = ordered.slice(1);
      if (winner === undefined || losers.length === 0) continue;
      try {
        await this.surreal.withCompany(companyId, async (db) => {
          await db.query(
            `UPDATE $ids SET
               status = 'superseded',
               retractedAt = time::now(),
               retractionReason = 'superseded',
               retractedBy = 'system',
               supersededBy = type::record('knowledge_fact', $winnerTail),
               validUntil = type::datetime($until)`,
            {
              ids: losers.map((l) => l.raw),
              winnerTail: winner.id.replace(/^knowledge_fact:/, ''),
              until: new Date(winner.validFrom).toISOString(),
            },
          );
        });
        resolved += 1;
        retired += losers.length;
      } catch (e) {
        this.logger.warn(
          `predicate consolidation: re-resolve failed for slot '${slot.slot}': ${(e as Error).message}`,
        );
      }
    }
    if (resolved > 0) {
      this.logger.log(
        `predicate consolidation: re-resolved ${resolved} single_active slot(s) in ${companyId}, ` +
          `retiring ${retired} stale value(s) that ingest-time policy had left active`,
      );
    }
    result.slotsContested = slots.length;
    return { slotsResolved: resolved, factsRetired: retired };
  }

  /**
   * One active belief per slot, after the merges.
   *
   * A belief IS the current state of one attribute, so unlike a fact it
   * needs no semantics lookup: two active rows in one
   * `(userId, subject, predicateAlias ?? predicateId)` are a
   * contradiction by definition, and the higher revision is the one that
   * survives.
   *
   * THIS EXISTS BECAUSE THE ALIAS ALONE IS NOT ENOUGH, which a live run
   * showed: after the merges, one tenant's `ledger-sync` held
   * `job queue backend` = Redis Streams beside `queue backend` = NATS
   * JetStream, and `deployment` = Fly.io beside `deployment target` =
   * AWS ECS Fargate — now correctly in ONE slot each, and both still
   * active. The promoter retires such a duplicate the next time it
   * writes that slot, which may be never, and the serving lane picks per
   * slot by relevance — so the stale value could win the render, in the
   * section whose whole job is to say what is true now.
   *
   * MARK, NEVER DELETE, and the same stamp the promoter uses, so a
   * retroactively retired duplicate is indistinguishable from one
   * retired at write time. Idempotent: a second run finds one row per
   * slot and writes nothing.
   */
  private async retireBeliefSlotDuplicates(companyId: string): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            id?: unknown;
            userId?: unknown;
            subject?: unknown;
            slot?: unknown;
            revision?: unknown;
            validFrom?: unknown;
          }>,
        ]
      >(
        `SELECT id, userId, subject, (predicateAlias ?? predicateId) AS slot, revision, validFrom
           FROM semantic_belief WHERE status = 'active'`,
      );
      const bySlot = new Map<string, Array<Record<string, unknown>>>();
      for (const r of (rows as Array<Record<string, unknown>>) ?? []) {
        // A row with no slot predates 0147 and has no cross-row identity;
        // leaving it alone is the behaviour it already has.
        if (typeof r.slot !== 'string' || r.slot === '' || r.id === undefined) continue;
        const key = `${String(r.userId)}\u0000${String(r.subject)}\u0000${r.slot}`;
        const list = bySlot.get(key);
        if (list === undefined) bySlot.set(key, [r]);
        else list.push(r);
      }
      let retired = 0;
      for (const group of bySlot.values()) {
        if (group.length < 2) continue;
        // Highest revision wins; the id breaks a tie so a replay over the
        // same data picks the same survivor.
        const ordered = [...group].sort(
          (a, b) =>
            (typeof b.revision === 'number' ? b.revision : 0) -
              (typeof a.revision === 'number' ? a.revision : 0) ||
            String(b.id).localeCompare(String(a.id)),
        );
        const winner = ordered[0]!;
        const losers = ordered.slice(1);
        try {
          await db.query(
            `UPDATE $ids SET status = 'superseded', supersededBy = $winner,
                             validUntil = type::datetime($until), updatedAt = time::now()`,
            {
              ids: losers.map((l) => l.id),
              winner: winner.id,
              until: new Date(String(winner.validFrom)).toISOString(),
            },
          );
          retired += losers.length;
        } catch (e) {
          this.logger.warn(
            `predicate consolidation: could not retire belief duplicates in slot ` +
              `'${String(winner.slot)}': ${(e as Error).message}`,
          );
        }
      }
      if (retired > 0) {
        this.logger.log(
          `predicate consolidation: retired ${retired} duplicate belief(s) in ${companyId} — ` +
            `rows the merges just put into one slot and nothing else would have closed`,
        );
      }
      return retired;
    });
  }

  /**
   * Slots — keyed on `(entityId, predicateAlias ?? predicate)`, the same
   * key resolution and retrieval use — holding more than one ACTIVE
   * fact. Grouped in the DB; only the handful that are contested come
   * back with their facts.
   */
  private async loadContestedSlots(companyId: string): Promise<ContestedSlot[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [Array<{ id?: unknown; entityId?: unknown; slot?: unknown; validFrom?: unknown }>]
      >(
        `SELECT id, entityId, (predicateAlias ?? predicate) AS slot, validFrom
           FROM knowledge_fact WHERE status = 'active'`,
      );
      const byKey = new Map<string, ContestedSlot>();
      for (const r of (rows as Array<Record<string, unknown>>) ?? []) {
        if (typeof r.slot !== 'string' || r.id === undefined) continue;
        const key = `${String(r.entityId)}\u0000${r.slot}`;
        let entry = byKey.get(key);
        if (entry === undefined) {
          entry = { slot: r.slot, facts: [] };
          byKey.set(key, entry);
        }
        const ms = Date.parse(String(r.validFrom));
        entry.facts.push({
          id: String(r.id),
          raw: r.id,
          validFrom: Number.isNaN(ms) ? 0 : ms,
        });
      }
      return [...byKey.values()].filter((s) => s.facts.length > 1);
    });
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
  /** Slots holding more than one ACTIVE value before the re-resolve. */
  slotsContested: number;
  /** Of those, the single_active ones this pass settled. */
  slotsResolved: number;
  /** Stale values retired by that — `superseded`, never deleted. */
  factsRetired: number;
  /** Beliefs the merges co-located into one slot, closed to one active. */
  beliefDuplicatesRetired: number;
}

interface ContestedSlot {
  slot: string;
  facts: Array<{ id: string; raw: unknown; validFrom: number }>;
}
