import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import { EntityJudgeService } from '../ai/entity-judge.service';
import { withSpan } from '../common/tracing';

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

  constructor(
    private readonly configService: ConfigService,
    private readonly judge: EntityJudgeService,
  ) {
    this.enabled =
      this.configService.get<string>('DREAMS_DEDUP_ENABLED', '0') === '1';
    this.cosineThreshold = parseFloat(
      this.configService.get<string>('DREAMS_DEDUP_COSINE_THRESHOLD', '0.92'),
    );
    this.maxPairs = parseInt(
      this.configService.get<string>('DREAMS_DEDUP_MAX_PAIRS', '50'),
      10,
    );
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
  async run(db: Surreal): Promise<DedupResult> {
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
      () => this.findCandidates(db),
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
  private async findCandidates(db: Surreal): Promise<DedupCandidate[]> {
    type NameRow = { entityId: unknown; embedding: number[] };
    const [seedRows] = await db.query<[NameRow[]]>(
      `SELECT entityId, embedding FROM knowledge_fact
       WHERE predicate = 'name'
         AND status = 'active'
         AND retractedAt IS NONE
         AND embedding != NONE
         AND entityId.mergedInto IS NONE`,
    );
    const seeds = (seedRows as NameRow[]) ?? [];
    if (seeds.length < 2) return [];

    const out: DedupCandidate[] = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      const aId = String(seed.entityId);
      // K-NN over name facts. We ask for K=5 to surface the closest
      // candidates without flooding the LLM stage; the threshold
      // then filters most away.
      const sql = `
        SELECT entityId, vector::similarity::cosine(embedding, $q) AS sim
        FROM knowledge_fact
        WHERE predicate = 'name'
          AND status = 'active'
          AND retractedAt IS NONE
          AND embedding != NONE
          AND entityId.mergedInto IS NONE
        ORDER BY sim DESC
        LIMIT 5
      `;
      const [neighbourRows] = await db.query<
        [Array<{ entityId: unknown; sim: number }>]
      >(sql, { q: seed.embedding });
      for (const n of (neighbourRows as Array<{ entityId: unknown; sim: number }>) ?? []) {
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

  private async identityEdgeExists(
    db: Surreal,
    aId: string,
    bId: string,
  ): Promise<boolean> {
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

  private async linkIdentity(
    db: Surreal,
    aId: string,
    bId: string,
  ): Promise<void> {
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
