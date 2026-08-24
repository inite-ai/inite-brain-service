import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import { EntityJudgeService } from '../ai/entity-judge.service';
import { withSpan } from '../common/tracing';
import { envFlagEnabled } from '../common/env-validation';
import { derivedVersionFence } from '../episodes/read-pin.service';

/**
 * DreamsDedupService — find near-duplicate ENTITIES inside a tenant
 * and emit identity_of links so survivor + loser collapse into one
 * search-side record.
 *
 * Two-stage filter:
 *   1. CHEAP: vector similarity over the entity's `name` fact embedding.
 *      For each candidate entity, fetch the K nearest neighbours by
 *      name-embedding cosine; consider any pair with cos ≥ threshold
 *      a SUSPECT.
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
   * Find suspect pairs. Strategy:
   *   - Pull every entity that has a `name` fact (the dedup signal).
   *     Limited to entities owning at least ONE fact whose embedding
   *     is non-NONE (post-compaction warm tier is excluded — those
   *     entities can't be embedding-matched cheaply).
   *   - For each, take its newest active `name` fact's embedding.
   *   - Run a Surreal HNSW-cosine k-NN over the name embedding,
   *     keep only pairs with cos ≥ threshold AND aId < bId (canonical
   *     ordering so each pair is counted once).
   *   - Cap at maxPairs to bound the LLM cost.
   */
  private async findCandidates(
    db: Surreal,
    derivedVersion: string | null,
  ): Promise<DedupCandidate[]> {
    // Seed pass: fact id + entity id ONLY. The old shape selected every
    // name embedding into process memory (1536 float64s × N entities —
    // hundreds of MB at scale) and then looped over ALL of them. The
    // embedding never leaves the DB now: each neighbour query resolves
    // its seed vector by fact id, and the seed set is capped
    // newest-first. recordedAt rides in the projection for the 3.x
    // ORDER BY idiom.
    const fence = derivedVersionFence(derivedVersion);
    type SeedRow = { id: unknown; entityId: unknown; recordedAt: unknown };
    const [seedRows] = await db.query<[SeedRow[]]>(
      `SELECT id, entityId, recordedAt FROM knowledge_fact
       WHERE predicate = 'name'
         AND status = 'active'
         AND retractedAt IS NONE
         AND embedding != NONE
         AND userId IS NONE
         AND entityId.mergedInto IS NONE
         ${fence.clause}
       ORDER BY recordedAt DESC
       LIMIT $maxSeeds`,
      { maxSeeds: this.maxSeeds, ...fence.params },
    );
    const seeds = (seedRows as SeedRow[]) ?? [];
    if (seeds.length < 2) return [];

    const out: DedupCandidate[] = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      const aId = String(seed.entityId);
      const neighbours = await this.nearestNames(db, String(seed.id), derivedVersion);
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
   * K nearest name facts to a seed name fact, seed vector resolved
   * DB-side by fact id. With SEARCH_HNSW_ENABLED the KNN operator rides
   * the HNSW index (same literal-K idiom + overfetch as the search
   * vector leg; the operator throws when the tenant has no index, and
   * we fall back to the scan). Without it, a scan ordered by cosine —
   * still zero vectors shipped to JS in both directions.
   */
  private async nearestNames(
    db: Surreal,
    seedFactId: string,
    derivedVersion: string | null,
  ): Promise<Array<{ entityId: unknown; sim: number }>> {
    const fence = derivedVersionFence(derivedVersion);
    const filters = `predicate = 'name'
          AND status = 'active'
          AND retractedAt IS NONE
          AND embedding != NONE
          AND userId IS NONE
          AND entityId.mergedInto IS NONE
          ${fence.clause}`;
    type Row = { entityId: unknown; sim: number };
    if (envFlagEnabled(process.env.SEARCH_HNSW_ENABLED)) {
      const ef = parseInt(process.env.SEARCH_HNSW_EF ?? '100', 10);
      const overfetch = parseInt(process.env.SEARCH_HNSW_OVERFETCH ?? '4', 10);
      const kOver = Math.min(5 * overfetch, 1000);
      try {
        // vector::distance::knn() reuses the walk's distance — a fresh
        // cosine projection next to the KNN operator drops the planner
        // off the KnnScan (V11 audit A4). sim = 1 − cosine distance;
        // works with the LET-var query vector (stand-verified).
        const res = await db.query<[unknown, Array<{ entityId: unknown; dist: number }>]>(
          `LET $q = (SELECT VALUE embedding FROM ONLY type::record($fid));
           SELECT entityId, vector::distance::knn() AS dist
             FROM knowledge_fact
            WHERE embedding <|${kOver},${ef}|> $q
              AND ${filters}
            ORDER BY dist ASC
            LIMIT 5;`,
          { fid: seedFactId, ...fence.params },
        );
        return ((res[1] as Array<{ entityId: unknown; dist: number }>) ?? []).map(
          ({ entityId, dist }) => ({
            entityId,
            sim: typeof dist === 'number' ? 1 - dist : 0,
          }),
        );
      } catch (e) {
        this.logger.warn(
          `[dreams.dedup] KNN leg failed (${(e as Error).message}); falling back to scan`,
        );
      }
    }
    const res = await db.query<[unknown, Row[]]>(
      `LET $q = (SELECT VALUE embedding FROM ONLY type::record($fid));
       SELECT entityId, vector::similarity::cosine(embedding, $q) AS sim
         FROM knowledge_fact
        WHERE ${filters}
        ORDER BY sim DESC
        LIMIT 5;`,
      { fid: seedFactId, ...fence.params },
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
