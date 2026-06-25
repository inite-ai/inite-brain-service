import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal } from 'surrealdb';
import { EmbedderService } from '../ai/embedder.service';
import { EntityJudgeService } from '../ai/entity-judge.service';

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
@Injectable()
export class EntityResolverService {
  private readonly logger = new Logger(EntityResolverService.name);
  private readonly enabled: boolean;
  private readonly cosineFloor: number;
  private readonly candidateK: number;

  constructor(
    private readonly config: ConfigService,
    private readonly embedder: EmbedderService,
    private readonly judge: EntityJudgeService,
  ) {
    this.enabled =
      this.config.get<string>('INGEST_INLINE_RESOLUTION_ENABLED', '0') === '1';
    this.cosineFloor = parseFloat(
      this.config.get<string>('INGEST_INLINE_RESOLUTION_COSINE_FLOOR', '0.85'),
    );
    this.candidateK = parseInt(
      this.config.get<string>('INGEST_INLINE_RESOLUTION_CANDIDATES', '5'),
      10,
    );
  }

  isEnabled(): boolean {
    return this.enabled && this.judge.isAvailable();
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
  async resolveByName(
    db: Surreal,
    name: string,
    type: string,
    incomingFacts: string[],
  ): Promise<string | null> {
    if (!this.isEnabled()) return null;
    try {
      const candidate = await this.findBestNameCandidate(db, name, type);
      if (!candidate) return null;

      const existingFacts = await this.judge.fetchTopFacts(db, candidate.entityId);
      const incoming =
        incomingFacts.length > 0
          ? incomingFacts.map((f) => `- ${f}`).join('\n')
          : '(no facts)';
      const verdict = await this.judge.judge(existingFacts, incoming, {
        cosine: candidate.cosine,
      });
      if (verdict === 'same') {
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
   */
  private async findBestNameCandidate(
    db: Surreal,
    name: string,
    type: string,
  ): Promise<{ entityId: string; cosine: number } | null> {
    const q = await this.embedder.embed(`name: ${name}`);
    const [rows] = await db.query<
      [Array<{ entityId: unknown; etype: string; sim: number }>]
    >(
      `SELECT entityId, entityId.type AS etype,
              vector::similarity::cosine(embedding, $q) AS sim
         FROM knowledge_fact
         WHERE predicate = 'name'
           AND status = 'active'
           AND retractedAt IS NONE
           AND embedding != NONE
           AND entityId.mergedInto IS NONE
         ORDER BY sim DESC
         LIMIT $k`,
      { q, k: this.candidateK },
    );
    for (const r of (rows as Array<{ entityId: unknown; etype: string; sim: number }>) ?? []) {
      if (r.sim < this.cosineFloor) break; // rows are sorted DESC
      if (r.etype !== type) continue;
      return { entityId: String(r.entityId), cosine: r.sim };
    }
    return null;
  }
}
