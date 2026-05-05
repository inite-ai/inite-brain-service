import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { SearchDto, SearchMode } from './dto/search.dto';
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

interface FactRow {
  id: unknown;
  entityId: unknown;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  validUntil?: string;
  recordedAt: string;
  retractedAt?: string;
  status: string;
  source: any;
  // Hydrated via FETCH — entity record inlined.
  entity?: {
    id: unknown;
    type: string;
    canonicalName: string;
    externalRefs?: Record<string, string>;
  };
  // One of these is set per row depending on which leg surfaced it;
  // hybrid mode merges both and lets RRF fuse.
  vec?: number;
  lex?: number;
}

// Reciprocal-rank fusion constant. 60 is the canonical default from the
// RRF paper (Cormack et al. 2009) — small enough that top-1 from each
// list dominates, large enough that the long tail still contributes.
const RRF_K = 60;

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
    const mode: SearchMode = dto.searchMode ?? 'hybrid';

    // Pull more candidates than `limit` so RRF / decay weighting can
    // re-rank without starving the top-K. 5× is empirically a good
    // trade-off — enough headroom for fusion to matter, not so many
    // that we shovel embeddings across the wire for nothing.
    const candidateK = Math.min(limit * 5, 200);

    return this.surreal.withCompany(companyId, async (db) => {
      // Bitemporal predicates pushed into WHERE — no JS post-filter.
      // The composite (entityId, status, recordedAt) index covers
      // entity scope; full-table scans here only run when there's no
      // entity filter, which is the common case for free-text search.
      const baseWhere = this.buildBaseWhere(dto, asOf, includeRetracted, includeContested);

      const [vectorRows, lexicalRows] = await Promise.all([
        mode === 'lexical' ? Promise.resolve([] as FactRow[]) : this.vectorLeg(db, dto.query, candidateK, baseWhere),
        mode === 'vector' ? Promise.resolve([] as FactRow[]) : this.lexicalLeg(db, dto.query, candidateK, baseWhere),
      ]);

      // Fuse — vector and lexical lists are joined by fact id; the
      // resulting per-fact score is RRF(vector_rank, lexical_rank)
      // when both legs contributed, or the single-leg score otherwise.
      const fused = this.fuse(vectorRows, lexicalRows, mode);

      // Apply policy gates AFTER fusion: predicate filter, scope gate,
      // confidence floor. Doing this post-fusion preserves recall —
      // a query that semantically matches but is filtered by scope
      // returns zero rather than silently demoting.
      const filtered = fused.filter((row) => this.passesPolicy(row, dto, callerScopes));

      // Decay-weighted final score uses predicate half-life. Vector
      // and lexical fusion give us a normalized retrieval score in
      // [0, 1); we multiply by decay × confidence as the final
      // ranking signal, same shape as before.
      const now = Date.now();
      const scored = filtered.map((row) => {
        const policy = policyFor(row.predicate);
        const ageDays = (now - new Date(row.recordedAt).getTime()) / 86_400_000;
        const decay = policy.decayHalfLifeDays === null
          ? 1
          : Math.exp((-Math.LN2 * ageDays) / policy.decayHalfLifeDays);
        const finalScore = row.fusedScore * decay * row.confidence;
        return { row, score: finalScore };
      });

      // Group by entity, keep best fact per entity for ranking.
      const byEntity = new Map<string, { entityId: string; bestScore: number; facts: typeof scored }>();
      for (const sf of scored) {
        const eid = String(sf.row.entityId);
        const bucket = byEntity.get(eid) ?? { entityId: eid, bestScore: 0, facts: [] };
        bucket.facts.push(sf);
        if (sf.score > bucket.bestScore) bucket.bestScore = sf.score;
        byEntity.set(eid, bucket);
      }

      const topEntities = [...byEntity.values()]
        .sort((a, b) => b.bestScore - a.bestScore)
        .slice(0, limit);

      const results: SearchHit[] = topEntities
        .filter((e) => {
          if (!dto.entityTypes) return true;
          const ent = e.facts[0]?.row.entity;
          return ent ? dto.entityTypes.includes(ent.type) : false;
        })
        .map((e) => {
          const ent = e.facts[0]?.row.entity ?? {
            id: e.entityId,
            type: 'other',
            canonicalName: e.entityId,
            externalRefs: {},
          };
          return {
            entityId: e.entityId,
            entityType: ent.type,
            canonicalName: ent.canonicalName,
            externalRefs: ent.externalRefs ?? {},
            facts: e.facts
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)
              .map(({ row, score }) => ({
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

  // ── Retrieval legs ───────────────────────────────────────────────

  /**
   * Vector leg — cosine similarity over `embedding`. Uses FETCH on
   * entityId so the response carries the entity record inline,
   * avoiding the separate hydration query the prior implementation
   * needed. We do an explicit full-scan here (no HNSW yet — see
   * schema comment); the LIMIT bound caps work to candidateK.
   */
  private async vectorLeg(
    db: Surreal,
    query: string,
    k: number,
    baseWhere: { sql: string; params: Record<string, unknown> },
  ): Promise<FactRow[]> {
    const queryEmbedding = await this.embedder.embed(query);
    const sql = `
      SELECT
        id, entityId, predicate, object, confidence,
        validFrom, validUntil, recordedAt, retractedAt, status, source,
        entityId.{id, type, canonicalName, externalRefs} AS entity,
        vector::similarity::cosine(embedding, $q) AS vec
      FROM knowledge_fact
      WHERE embedding != NONE
        ${baseWhere.sql}
      ORDER BY vec DESC
      LIMIT $k
      FETCH entityId
    `;
    const [rows] = await db.query<[FactRow[]]>(sql, {
      ...baseWhere.params,
      q: queryEmbedding,
      k,
    });
    return (rows as FactRow[]) ?? [];
  }

  /**
   * Lexical leg — BM25 over the `object` field, surfaced via the
   * `fact_object_search_idx` SEARCH index. The `@1@` operator binds
   * to `search::score(1)` so callers get the index's BM25 score,
   * not a flat boolean match. This catches exact-token queries
   * (transaction ids, structured strings) that vector search
   * routinely misses.
   */
  private async lexicalLeg(
    db: Surreal,
    query: string,
    k: number,
    baseWhere: { sql: string; params: Record<string, unknown> },
  ): Promise<FactRow[]> {
    const sql = `
      SELECT
        id, entityId, predicate, object, confidence,
        validFrom, validUntil, recordedAt, retractedAt, status, source,
        entityId.{id, type, canonicalName, externalRefs} AS entity,
        search::score(1) AS lex
      FROM knowledge_fact
      WHERE object @1@ $query
        ${baseWhere.sql}
      ORDER BY lex DESC
      LIMIT $k
      FETCH entityId
    `;
    try {
      const [rows] = await db.query<[FactRow[]]>(sql, {
        ...baseWhere.params,
        query,
        k,
      });
      return (rows as FactRow[]) ?? [];
    } catch (err) {
      // Fresh tenants without the SEARCH index (e.g. test fixtures
      // pre-dating this migration) shouldn't break free-text search.
      // Fail soft to vector-only by returning [].
      this.logger.warn(`Lexical leg fell back to empty: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Reciprocal-rank fusion. Each leg contributes a rank-position; the
   * fused score is Σ 1/(K + rank). Documents that appear in both
   * lists naturally rank highest — matching both surface tokens AND
   * semantic neighbourhood is the strongest signal.
   *
   * For single-mode searches we skip fusion and just normalize the
   * raw score into a comparable shape, so downstream decay/confidence
   * weighting works the same regardless of mode.
   */
  private fuse(
    vectorRows: FactRow[],
    lexicalRows: FactRow[],
    mode: SearchMode,
  ): Array<FactRow & { fusedScore: number }> {
    const merged = new Map<string, FactRow & { fusedScore: number }>();

    if (mode === 'vector') {
      vectorRows.forEach((r) => {
        merged.set(String(r.id), { ...r, fusedScore: r.vec ?? 0 });
      });
      return [...merged.values()];
    }

    if (mode === 'lexical') {
      lexicalRows.forEach((r) => {
        merged.set(String(r.id), { ...r, fusedScore: this.normalizeLex(r.lex ?? 0) });
      });
      return [...merged.values()];
    }

    // Hybrid — RRF on rank positions.
    vectorRows.forEach((r, idx) => {
      const id = String(r.id);
      const score = 1 / (RRF_K + idx + 1);
      merged.set(id, { ...r, fusedScore: score });
    });
    lexicalRows.forEach((r, idx) => {
      const id = String(r.id);
      const score = 1 / (RRF_K + idx + 1);
      const existing = merged.get(id);
      if (existing) {
        existing.fusedScore += score;
        // Carry lex score forward for diagnostics.
        existing.lex = r.lex;
      } else {
        merged.set(id, { ...r, fusedScore: score });
      }
    });
    return [...merged.values()];
  }

  /**
   * Squash BM25 scores into [0, 1] via a saturation curve. BM25 is
   * unbounded (a 5-term match on a short doc can score 10+), so we
   * pass it through x/(1+x) to keep the lexical-only mode's final
   * score on the same scale as vector cosine.
   */
  private normalizeLex(s: number): number {
    return s <= 0 ? 0 : s / (1 + s);
  }

  private buildBaseWhere(
    dto: SearchDto,
    asOf: Date | null,
    includeRetracted: boolean,
    includeContested: boolean,
  ): { sql: string; params: Record<string, unknown> } {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (!includeRetracted) clauses.push(`AND retractedAt IS NONE`);
    if (!includeContested) clauses.push(`AND status != 'competing'`);
    if (dto.minConfidence !== undefined) {
      clauses.push(`AND confidence >= $minConfidence`);
      params.minConfidence = dto.minConfidence;
    }
    if (dto.predicates && dto.predicates.length > 0) {
      clauses.push(`AND predicate INSIDE $predicates`);
      params.predicates = dto.predicates;
    }
    if (asOf) {
      // recordedAt <= asOf  AND  (retractedAt IS NONE OR retractedAt > asOf)
      // AND validFrom <= asOf  AND  (validUntil IS NONE OR validUntil > asOf)
      clauses.push(
        `AND recordedAt <= $asOf
         AND (retractedAt IS NONE OR retractedAt > $asOf)
         AND validFrom <= $asOf
         AND (validUntil IS NONE OR validUntil > $asOf)`,
      );
      params.asOf = asOf;
    }

    return { sql: clauses.join('\n        '), params };
  }

  private passesPolicy(row: FactRow, dto: SearchDto, callerScopes: string[]): boolean {
    const policy = policyFor(row.predicate);
    if (policy.requiresScope && !callerScopes.includes(policy.requiresScope)) {
      return false;
    }
    return true;
  }
}
