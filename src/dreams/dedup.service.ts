import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import { EntityJudgeService } from '../ai/entity-judge.service';
import { withSpan } from '../common/tracing';
import { envFlagEnabled } from '../common/env-validation';
import { sameWidthGate } from '../db/vector-width';

/** The index the entity-dedup seed KNN rides — for the diagnostic. */

/**
 * DreamsDedupService — find near-duplicate ENTITIES inside a tenant
 * and emit identity_of links so survivor + loser collapse into one
 * search-side record.
 *
 * Two-stage filter:
 *   1. CHEAP: vector similarity over the entity's OWN name embedding
 *      (knowledge_entity.embedding — a column the 0001 baseline defined and nothing ever wrote). For each seed entity,
 *      fetch the K nearest same-type neighbours by cosine; consider any
 *      pair with cos ≥ threshold a SUSPECT.
 *   2. EXPENSIVE: LLM judge with both entities' top-3 facts as context.
 *      Verdict ∈ {same, different, unsure}. Only `same` triggers a
 *      RELATE knowledge_edge (kind='identity_of'); `unsure` is logged
 *      for operator review.
 *
 * Bounded per run by DREAMS_DEDUP_MAX_PAIRS so a single tenant can't
 * monopolise the off-hours budget. Skip pairs that already have an
 * identity_of edge (idempotent re-runs).
 *
 * Failure modes are explicit. LLM outage → mark suspect, log,
 * continue. Surreal outage → bubble up to the orchestrator which
 * tags the run outcome=hop_error and stops the chain.
 */
export interface DedupCandidate {
  aId: string;
  bId: string;
  cosine: number;
}

export interface DedupIdentityLink {
  survivorId: string;
  loserId: string;
  cosine: number;
}

export interface DedupResult {
  suspectsEvaluated: number;
  llmJudgements: number;
  identityLinksCreated: number;
  unsurePairs: number;
  /** Per-link detail for the admin UI drill-down. Empty when dedup didn't run. */
  identityLinks: DedupIdentityLink[];
}

@Injectable()
export class DreamsDedupService {
  private readonly logger = new Logger(DreamsDedupService.name);
  private readonly enabled: boolean;
  private readonly cosineThreshold: number;
  private readonly maxPairs: number;
  private readonly maxSeeds: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly judge: EntityJudgeService,
  ) {
    this.enabled = envFlagEnabled(this.configService.get<string>('DREAMS_DEDUP_ENABLED'));
    this.cosineThreshold = parseFloat(
      this.configService.get<string>('DREAMS_DEDUP_COSINE_THRESHOLD', '0.92'),
    );
    this.maxPairs = parseInt(this.configService.get<string>('DREAMS_DEDUP_MAX_PAIRS', '50'), 10);
    // Bounds the neighbour-query loop (one query per seed). maxPairs
    // only capped EMITTED pairs — on a corpus where few pairs cleared
    // the threshold, the loop still ran one full scan per entity:
    // O(N²) vector ops per tenant per night. Newest name facts seed
    // first, so recently-touched entities are always covered.
    this.maxSeeds = parseInt(this.configService.get<string>('DREAMS_DEDUP_MAX_SEEDS', '500'), 10);
  }

  isEnabled(): boolean {
    return this.enabled && this.judge.isAvailable();
  }

  /**
   * Run dedup for ONE tenant. The caller (DreamsService) owns the
   * Surreal connection and tenant scoping — we just operate over the
   * passed `db` handle. This keeps the service stateless and
   * compatible with the controller's per-request manual trigger.
   */
  async run(db: Surreal, derivedVersion: string | null = null): Promise<DedupResult> {
    const result: DedupResult = {
      suspectsEvaluated: 0,
      llmJudgements: 0,
      identityLinksCreated: 0,
      unsurePairs: 0,
      identityLinks: [],
    };
    if (!this.isEnabled()) return result;

    const candidates = await withSpan(
      'dreams.dedup.find_candidates',
      () => this.findCandidates(db, derivedVersion),
      { 'dedup.cosine_threshold': this.cosineThreshold },
    );
    result.suspectsEvaluated = candidates.length;
    if (candidates.length === 0) return result;

    for (const cand of candidates) {
      // Skip pairs that already have an identity_of edge — idempotent.
      const exists = await this.identityEdgeExists(db, cand.aId, cand.bId);
      if (exists) continue;

      const verdict = await withSpan('dreams.dedup.judge', async () => {
        const factsA = await this.judge.fetchTopFacts(db, cand.aId);
        const factsB = await this.judge.fetchTopFacts(db, cand.bId);
        return this.judge.judge(factsA, factsB, { cosine: cand.cosine });
      });
      result.llmJudgements++;
      if (verdict === 'same') {
        await this.linkIdentity(db, cand.aId, cand.bId);
        result.identityLinksCreated++;
        result.identityLinks.push({
          survivorId: cand.aId,
          loserId: cand.bId,
          cosine: cand.cosine,
        });
      } else if (verdict === 'unsure') {
        result.unsurePairs++;
        this.logger.warn(
          `[dreams.dedup] unsure pair: ${cand.aId} ⟷ ${cand.bId} (cos=${cand.cosine.toFixed(3)})`,
        );
      }
    }
    return result;
  }

  /**
   * Find suspect pairs: for each entity carrying a name embedding, its
   * nearest same-type neighbours by cosine, kept when cos ≥ threshold and
   * ordered aId < bId so each pair is counted once. Capped at maxPairs to
   * bound the LLM cost.
   *
   * OVER ENTITIES, NOT `name` FACTS. This pass used to
   * seed from `knowledge_fact WHERE predicate = 'name'` and walk that
   * fact's embedding, and measured on a live tenant on 2026-09-16 that
   * predicate had ZERO rows against 33 entities: nothing on the mention
   * path writes a `name` fact. Every off-hours dedup sweep on a
   * mention-ingested corpus had found zero seeds, logged nothing, and
   * merged nothing — not "rarely", structurally.
   *
   * Entities are one to two orders of magnitude fewer than facts, so the
   * seed set and each neighbour query are plain cosine scans; the HNSW
   * leg that rode `fact_embedding_hnsw` went with the fact scan. The
   * embedding still never leaves the DB — each neighbour query reads the
   * seed vector by entity id.
   *
   * `derivedVersion` is accepted for the caller's contract and not used
   * to fence candidates: it is a FACT field (0074), an entity is the same
   * node in every derived world, and the judge's evidence
   * (`fetchTopFacts`) was never world-fenced either.
   */
  private async findCandidates(
    db: Surreal,
    _derivedVersion: string | null,
  ): Promise<DedupCandidate[]> {
    type SeedRow = { id: unknown; type: string; recordedAt: unknown };
    const [seedRows] = await db.query<[SeedRow[]]>(
      `SELECT id, type, recordedAt FROM knowledge_entity
       WHERE embedding != NONE
         AND userId IS NONE
         AND mergedInto IS NONE
       ORDER BY recordedAt DESC
       LIMIT $maxSeeds`,
      { maxSeeds: this.maxSeeds },
    );
    const seeds = (seedRows as SeedRow[]) ?? [];
    if (seeds.length < 2) return [];

    const out: DedupCandidate[] = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      const aId = String(seed.id);
      const neighbours = await this.nearestNames(db, aId, seed.type);
      for (const n of neighbours) {
        const bId = String(n.entityId);
        if (bId === aId) continue;
        if (n.sim < this.cosineThreshold) continue;
        const pairKey = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        out.push({
          aId: aId < bId ? aId : bId,
          bId: aId < bId ? bId : aId,
          cosine: n.sim,
        });
        if (out.length >= this.maxPairs) return out;
      }
    }
    return out;
  }

  /**
   * K nearest entities of the same type to a seed entity, by cosine over
   * their name embeddings; the seed vector is resolved DB-side by id so
   * no vector is shipped to JS in either direction.
   */
  private async nearestNames(
    db: Surreal,
    seedEntityId: string,
    type: string,
  ): Promise<Array<{ entityId: unknown; sim: number }>> {
    type Row = { entityId: unknown; sim: number };
    const res = await db.query<[unknown, Row[]]>(
      `LET $q = (SELECT VALUE embedding FROM ONLY type::record($eid));
       SELECT id AS entityId, vector::similarity::cosine(embedding, $q) AS sim
         FROM knowledge_entity
        WHERE ${sameWidthGate('embedding')}
          AND type = $type
          AND userId IS NONE
          AND mergedInto IS NONE
          AND id != type::record($eid)
        ORDER BY sim DESC
        LIMIT 5;`,
      { eid: seedEntityId, type },
    );
    return (res[1] as Row[]) ?? [];
  }

  private async identityEdgeExists(db: Surreal, aId: string, bId: string): Promise<boolean> {
    const [rows] = await db.query<[Array<{ id: unknown }>]>(
      `SELECT id FROM knowledge_edge
       WHERE kind = 'identity_of'
         AND ((in = $a AND out = $b) OR (in = $b AND out = $a))
       LIMIT 1`,
      {
        a: new StringRecordId(aId),
        b: new StringRecordId(bId),
      },
    );
    return ((rows as Array<{ id: unknown }>) ?? []).length > 0;
  }

  private async linkIdentity(db: Surreal, aId: string, bId: string): Promise<void> {
    // Direction: aId → bId. The conventional survivor/loser policy
    // (older entity wins) is enforced by the existing identity-merge
    // path in the search service via mergedInto reattribution; from
    // dreams we just emit the link with weight 1.0 and source tag.
    await db.query(
      `RELATE $a->knowledge_edge->$b SET kind = 'identity_of', weight = 1.0,
        source = { vertical: 'dreams', kind: 'auto_dedup' },
        createdAt = time::now()`,
      {
        a: new StringRecordId(aId),
        b: new StringRecordId(bId),
      },
    );
  }
}
