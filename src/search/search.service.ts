import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { SearchDto } from './dto/search.dto';
import { policyFor } from '../ingest/conflict-resolver';

export interface SearchHit {
  entityId: string;
  entityType: string;
  canonicalName: string;
  externalRefs: Record<string, string>;
  facts: Array<{
    factId: string;
    predicate: string;
    object: string;
    confidence: number;
    validFrom: string;
    validUntil?: string;
    status: string;
    score: number;
  }>;
  score: number;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  async search(
    companyId: string,
    dto: SearchDto,
    callerScopes: string[],
  ): Promise<{ results: SearchHit[] }> {
    const limit = dto.limit ?? 10;
    const asOf = dto.asOf ? new Date(dto.asOf) : null;
    const includeRetracted = dto.includeRetracted ?? false;
    const includeContested = dto.includeContested ?? true;
    const queryEmbedding = await this.embedder.embed(dto.query);

    return this.surreal.withCompany(companyId, async (db) => {
      // Cosine similarity scan. We deliberately avoid the HNSW <|K|>
      // KNN operator: it shines at tens-of-thousands+ scale but skips
      // results on tiny datasets (e.g. fresh tenant, e2e tests).
      // For per-tenant graphs that rarely exceed millions of facts,
      // a full scan is acceptable; we can switch to HNSW per-tenant
      // once any tenant grows past ~50k active facts.
      const vectorK = Math.min(limit * 5, 200);
      const sql = `
        SELECT
          id, entityId, predicate, object, confidence,
          validFrom, validUntil, recordedAt, retractedAt, status, source,
          vector::similarity::cosine(embedding, $q) AS sim
        FROM knowledge_fact
        WHERE embedding != NONE
        ORDER BY sim DESC
        LIMIT $k
      `;
      const [factRows] = await db.query<[any[]]>(sql, { q: queryEmbedding, k: vectorK });
      const rows: any[] = (factRows as any[]) ?? [];

      const filtered = rows.filter(r => {
        if (!includeRetracted && r.retractedAt) return false;
        if (!includeContested && r.status === 'competing') return false;
        if (dto.minConfidence !== undefined && r.confidence < dto.minConfidence) return false;
        if (dto.predicates && !dto.predicates.includes(r.predicate)) return false;

        // PII gate
        const policy = policyFor(r.predicate);
        if (policy.requiresScope && !callerScopes.includes(policy.requiresScope)) {
          return false;
        }

        // Bitemporal asOf
        if (asOf) {
          if (new Date(r.recordedAt) > asOf) return false;
          if (r.retractedAt && new Date(r.retractedAt) <= asOf) return false;
          if (new Date(r.validFrom) > asOf) return false;
          if (r.validUntil && new Date(r.validUntil) <= asOf) return false;
        }
        return true;
      });

      // Apply per-predicate decay weighting to the cosine similarity.
      const now = Date.now();
      const scored = filtered.map(r => {
        const policy = policyFor(r.predicate);
        const ageDays = (now - new Date(r.recordedAt).getTime()) / 86400000;
        const decay = policy.decayHalfLifeDays === null
          ? 1
          : Math.exp(-Math.LN2 * ageDays / policy.decayHalfLifeDays);
        const score = r.sim * decay * r.confidence;
        return { row: r, score };
      });

      // Group hits by entityId, keep top facts per entity.
      const byEntity = new Map<string, { entityId: string; bestScore: number; facts: any[] }>();
      for (const { row, score } of scored) {
        const eid = String(row.entityId);
        const bucket = byEntity.get(eid) ?? { entityId: eid, bestScore: 0, facts: [] };
        bucket.facts.push({ row, score });
        if (score > bucket.bestScore) bucket.bestScore = score;
        byEntity.set(eid, bucket);
      }

      const topEntities = [...byEntity.values()]
        .sort((a, b) => b.bestScore - a.bestScore)
        .slice(0, limit);

      // Hydrate entity records for top hits. ids are strings like
      // "knowledge_entity:abc"; we must coerce them to record refs for
      // SurrealDB to compare against the typed `id` field.
      const idTails = topEntities.map((e) => {
        const i = e.entityId.indexOf(':');
        return i === -1 ? e.entityId : e.entityId.slice(i + 1);
      });
      const entityRows = idTails.length === 0
        ? []
        : (((await db.query<[any[]]>(
            `SELECT id, type, canonicalName, externalRefs FROM knowledge_entity
             WHERE meta::id(id) INSIDE $tails`,
            { tails: idTails },
          ))[0] ?? []) as any[]);
      const entityMap = new Map(entityRows.map((e) => [String(e.id), e]));

      const results: SearchHit[] = topEntities
        .filter(e => {
          if (!dto.entityTypes) return true;
          const ent = entityMap.get(e.entityId);
          return ent && dto.entityTypes.includes(ent.type);
        })
        .map(e => {
          const ent = entityMap.get(e.entityId) ?? {
            type: 'other', canonicalName: e.entityId, externalRefs: {},
          };
          return {
            entityId: e.entityId,
            entityType: ent.type,
            canonicalName: ent.canonicalName,
            externalRefs: ent.externalRefs ?? {},
            facts: e.facts
              .sort((a: any, b: any) => b.score - a.score)
              .slice(0, 5)
              .map(({ row, score }: any) => ({
                factId: String(row.id),
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                validFrom: row.validFrom,
                validUntil: row.validUntil ?? undefined,
                status: row.status,
                score,
              })),
            score: e.bestScore,
          };
        });

      return { results };
    });
  }
}
