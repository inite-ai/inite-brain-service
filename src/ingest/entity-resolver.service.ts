import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal } from 'surrealdb';
import { EmbedderService } from '../ai/embedder.service';
import { EntityJudgeService, EntityVerdict } from '../ai/entity-judge.service';
import { envFlagEnabled } from '../common/env-validation';
import { dbCreate } from '../db/surreal.service';

/** One auditable reuse/candidate decision (migration 0102 entity_merge_log). */
export interface MergeLogEntry {
  mention: string;
  type: string;
  targetEntity: string;
  verdict: EntityVerdict;
  cosine: number;
  matchKind: 'exact' | 'externalRef' | 'translit' | 'embedding';
  decision: 'reused' | 'candidate';
}

/**
 * EntityResolverService — inline entity resolution at ingest time
 * (graphiti-style). Before the mention pipeline mints a NEW entity for an
 * extracted name that missed the exact canonicalName match, we look for a
 * near-duplicate that already exists and, when the shared EntityJudge
 * confirms it's the same real-world thing, reuse it — so the duplicate is
 * never created.
 *
 * Why a judge and not bare cosine: two different "John Smith"s have
 * near-identical name embeddings and the same type; merging on cosine
 * alone would wrongly fuse them. The judge looks at the FACTS (dob /
 * email / employer) — the existing entity's stored facts vs the incoming
 * mention's freshly-extracted facts (already in memory, not yet written).
 *
 * Scope: the free-text mention path only. Structured `POST /v1/ingest/fact`
 * with an explicit `vertical:id` stays authoritative (externalRef).
 *
 * Gated by INGEST_INLINE_RESOLUTION_ENABLED (default off). Any failure
 * falls back to "create new" — inline resolution must never block ingest.
 *
 * Provenance (deliberate, graphiti-parity): a confirmed match REUSES the
 * existing entity rather than creating a duplicate + an `identity_of` edge
 * the way the off-hours dreams dedup does. So there is no reversible merge
 * edge to unlink — the trade-off for never materialising the duplicate.
 * Mitigations: the judge prefers "different" when unsure; each ingested
 * fact still carries its own `source`; the decision is logged; and the
 * flag is off by default (operators wanting reversible merges keep it off
 * and rely on dreams).
 */
export interface ResolveByNameOptions {
  db: Surreal;
  name: string;
  type: string;
  incomingFacts: string[];
}

@Injectable()
export class EntityResolverService {
  private readonly logger = new Logger(EntityResolverService.name);
  private readonly enabled: boolean;
  private readonly cosineFloor: number;
  private readonly candidateK: number;
  private readonly hnswEnabled: boolean;
  private readonly hnswEf: number;
  private readonly hnswOverfetch: number;

  constructor(
    private readonly config: ConfigService,
    private readonly embedder: EmbedderService,
    private readonly judge: EntityJudgeService,
  ) {
    this.enabled = envFlagEnabled(this.config.get<string>('INGEST_INLINE_RESOLUTION_ENABLED'));
    this.cosineFloor = parseFloat(
      this.config.get<string>('INGEST_INLINE_RESOLUTION_COSINE_FLOOR', '0.85'),
    );
    this.candidateK = parseInt(
      this.config.get<string>('INGEST_INLINE_RESOLUTION_CANDIDATES', '5'),
      10,
    );
    // HNSW approximate KNN for the name-candidate scan (default off). The
    // KNN operator picks the nearest embeddings BEFORE the WHERE narrows to
    // name facts, so we over-fetch (candidateK × overfetch, capped 1000) to
    // keep filtered recall up. A name query embeds like other name facts,
    // so the nearest neighbours are predominantly name facts — but that's
    // an empirical property, so this is gated and eval-verified before
    // enable (a missed candidate here creates a DUPLICATE entity).
    this.hnswEnabled = envFlagEnabled(this.config.get<string>('INGEST_INLINE_RESOLUTION_HNSW'));
    this.hnswEf = positiveIntCfg(this.config.get<string>('INGEST_INLINE_RESOLUTION_HNSW_EF'), 100);
    this.hnswOverfetch = positiveIntCfg(
      this.config.get<string>('INGEST_INLINE_RESOLUTION_HNSW_OVERFETCH'),
      8,
    );
  }

  isEnabled(): boolean {
    return this.enabled && this.judge.isAvailable();
  }

  /**
   * Tier 3 reversible-resolution switch (MULTILINGUAL_ENTITY_REVERSIBLE,
   * default off). Read per-call so a live flip lands without restart — the
   * config catalogue advertises it runtimeMutable, so it must never be
   * constructor-captured. Off ⇒ resolveByName is byte-identical (immediate
   * reuse, no merge log).
   */
  isReversible(): boolean {
    return envFlagEnabled(process.env.MULTILINGUAL_ENTITY_REVERSIBLE);
  }

  /**
   * Append one auditable row to entity_merge_log (migration 0102) so a reuse
   * is reversible / splittable. NEVER throws — an audit-log failure must not
   * block ingest (same posture as resolveByName). Callers gate on
   * isReversible() before invoking.
   */
  async recordMerge(db: Surreal, entry: MergeLogEntry): Promise<void> {
    try {
      await dbCreate(db, 'entity_merge_log', {
        mention: entry.mention,
        mentionType: entry.type,
        targetEntity: entry.targetEntity,
        verdict: entry.verdict,
        cosine: entry.cosine,
        matchKind: entry.matchKind,
        decision: entry.decision,
        // A weak candidate enters the review queue; a deterministic reused
        // row needs no review, so reviewState stays NONE (omitted).
        ...(entry.decision === 'candidate' ? { reviewState: 'pending' } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `[ingest.merge_log] failed to record ${entry.decision} for ` +
          `"${entry.mention}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Resolve an extracted entity to an EXISTING entity id when a confident
   * same-as match is found, otherwise null (caller creates a new entity).
   *
   * @param name   the extracted entity name (also its `name` fact object)
   * @param type   the normalized entity type (must match the candidate's)
   * @param incomingFacts  the mention's freshly-extracted facts for THIS
   *   entity, as `"predicate: object"` lines — the judge's "new" side.
   */
  async resolveByName({
    db,
    name,
    type,
    incomingFacts,
  }: ResolveByNameOptions): Promise<string | null> {
    if (!this.isEnabled()) return null;
    try {
      const candidate = await this.findBestNameCandidate(db, name, type);
      if (!candidate) return null;

      const existingFacts = await this.judge.fetchTopFacts(db, candidate.entityId);
      const incoming =
        incomingFacts.length > 0 ? incomingFacts.map((f) => `- ${f}`).join('\n') : '(no facts)';
      const verdict = await this.judge.judge(existingFacts, incoming, {
        cosine: candidate.cosine,
      });
      if (verdict === 'same') {
        if (this.isReversible()) {
          // Tier 3 (MULTILINGUAL_ENTITY_REVERSIBLE): an embedding-only match
          // is LOW-CONFIDENCE by construction — an exact-canonical /
          // externalRef signal would have reused UPSTREAM before we ran. Do
          // NOT auto-adopt the id: that fuse is unreversible once the caller
          // writes facts under it. Record a reviewable candidate and fall
          // through to "create new", deferring the merge to an explicit,
          // reversible review.
          await this.recordMerge(db, {
            mention: name,
            type,
            targetEntity: candidate.entityId,
            verdict,
            cosine: candidate.cosine,
            matchKind: 'embedding',
            decision: 'candidate',
          });
          this.logger.log(
            `[ingest.inline_resolution] candidate (not auto-merged) ` +
              `${candidate.entityId} for "${name}" (cos=${candidate.cosine.toFixed(3)})`,
          );
          return null;
        }
        this.logger.log(
          `[ingest.inline_resolution] reused ${candidate.entityId} for "${name}" ` +
            `(cos=${candidate.cosine.toFixed(3)})`,
        );
        return candidate.entityId;
      }
      return null;
    } catch (err) {
      // Never block ingest — fall back to "create new".
      this.logger.warn(
        `[ingest.inline_resolution] failed for "${name}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Cosine k-NN over existing `name` fact embeddings; returns the closest
   * candidate of the SAME type at or above the floor, else null. Mirrors
   * the dreams dedup candidate scan, scoped to one query.
   *
   * When INGEST_INLINE_RESOLUTION_HNSW is on, candidates come from the
   * native HNSW index (`<|k,ef|>`); any failure — most commonly "no index
   * on this tenant yet" — falls back to the exact full scan, so the flag
   * can be flipped globally while tenants are indexed one by one.
   */
  private async findBestNameCandidate(
    db: Surreal,
    name: string,
    type: string,
  ): Promise<{ entityId: string; cosine: number } | null> {
    const q = await this.embedder.embed(`name: ${name}`);
    let rows: Array<{ entityId: unknown; etype: string; sim: number }> | null = null;
    if (this.hnswEnabled) {
      try {
        rows = await this.queryNameCandidatesKnn(db, q);
      } catch (err) {
        this.logger.warn(
          `[ingest.inline_resolution] hnsw name-candidate scan fell back ` +
            `to full scan: ${(err as Error).message}`,
        );
        rows = null;
      }
    }
    if (rows === null) rows = await this.queryNameCandidatesFullScan(db, q);
    for (const r of rows) {
      if (r.sim < this.cosineFloor) break; // rows are sorted DESC
      if (r.etype !== type) continue;
      return { entityId: String(r.entityId), cosine: r.sim };
    }
    return null;
  }

  /** Exact full-scan cosine over every active `name` fact. */
  private async queryNameCandidatesFullScan(
    db: Surreal,
    q: number[],
  ): Promise<Array<{ entityId: unknown; etype: string; sim: number }>> {
    const [rows] = await db.query<[Array<{ entityId: unknown; etype: string; sim: number }>]>(
      `SELECT entityId, entityId.type AS etype,
              vector::similarity::cosine(embedding, $q) AS sim
         FROM knowledge_fact
         WHERE predicate = 'name'
           AND status = 'active'
           AND retractedAt IS NONE
           AND embedding != NONE
           AND userId IS NONE
           AND entityId.mergedInto IS NONE
         ORDER BY sim DESC
         LIMIT $k`,
      { q, k: this.candidateK },
    );
    return (rows as Array<{ entityId: unknown; etype: string; sim: number }>) ?? [];
  }

  /**
   * Approximate KNN variant over the per-tenant `fact_embedding_hnsw` index.
   * The `<|kOver,ef|>` operator picks candidates before the WHERE filters,
   * so we over-fetch (kOver = candidateK × overfetch, capped 1000) and let
   * the same predicate/status/type fences narrow the result, then LIMIT to
   * candidateK. Throws when the tenant has no HNSW index — the caller falls
   * back to the exact scan.
   */
  private async queryNameCandidatesKnn(
    db: Surreal,
    q: number[],
  ): Promise<Array<{ entityId: unknown; etype: string; sim: number }>> {
    const kOver = Math.min(this.candidateK * this.hnswOverfetch, 1000);
    // `<|K,EF|>` takes literals, not params — kOver/ef are validated ints.
    // vector::distance::knn() reuses the walk's distance — projecting a
    // fresh cosine next to the KNN operator drops the planner off the
    // KnnScan (V11 audit A4). sim = 1 − cosine distance, so the caller's
    // cosineFloor comparison keeps exact sim semantics.
    const [rows] = await db.query<[Array<{ entityId: unknown; etype: string; dist: number }>]>(
      `SELECT entityId, entityId.type AS etype,
              vector::distance::knn() AS dist
         FROM knowledge_fact
         WHERE embedding <|${kOver},${this.hnswEf}|> $q
           AND predicate = 'name'
           AND status = 'active'
           AND retractedAt IS NONE
           AND userId IS NONE
           AND entityId.mergedInto IS NONE
         ORDER BY dist ASC
         LIMIT $k`,
      { q, k: this.candidateK },
    );
    return ((rows as Array<{ entityId: unknown; etype: string; dist: number }>) ?? []).map(
      ({ dist, ...rest }) => ({
        ...rest,
        sim: typeof dist === 'number' ? 1 - dist : 0,
      }),
    );
  }
}

/** Parse a positive-int config value, falling back on absent/invalid input. */
function positiveIntCfg(raw: string | undefined, fallback: number): number {
  const v = parseInt(raw ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
