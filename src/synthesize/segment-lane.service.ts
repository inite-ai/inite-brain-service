import { Injectable, Logger, Optional } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { RerankerService } from '../ai/reranker.service';
import { segmentUserGate } from '../auth/segment-scope';

interface SegmentRow {
  id: unknown;
  text: string;
  occurredAt: Date | string;
  score?: number;
}

/** Anchor-shaped segment row (no text — session attribution only). */
interface SegmentAnchorRow {
  id: unknown;
  conversationId: string;
  occurredAt: Date | string;
  score?: number;
}

/**
 * L0 segment lane (memory-rebuild R1,
 * docs/roadmap/memory-rebuild-2026-07.md §2).
 *
 * Retrieves verbatim multi-turn segments as retrieval units in their own
 * right — dense KNN and BM25 in parallel, fused by reciprocal rank
 * (RRF), optionally precision-trimmed by the listwise reranker — and
 * renders them as transcript excerpts for the generator. This is the
 * union-retrieval design the evidence demands: raw text competes for the
 * prompt on its own retrieval merit instead of riding along as
 * provenance of already-selected facts (measured null, E6/E8).
 *
 * Differences from the episode BM25 lane (measured null twice, E1/E5):
 * segment unit instead of single turns (SeCom: segment ≫ turn ≫ session
 * ≫ summary), dense+BM25 fusion instead of BM25-only, and rerank.
 *
 * Same contracts as the sibling lanes: PII gate for callers without
 * brain:read_pii, degrade to [] on any failure. Activation and the
 * per-prompt caps come from the resolved RetrievalProfile via the
 * caller — this service reads no env.
 */
@Injectable()
export class SegmentLaneService {
  private readonly logger = new Logger(SegmentLaneService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    @Optional() private readonly reranker?: RerankerService,
  ) {}

  async transcriptLines(opts: {
    companyId: string;
    query: string;
    callerScopes: string[];
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string | undefined;
    /** Segments per prompt (profile.segmentTopK). */
    topK: number;
    /** Listwise-rerank the fused pool (profile.segmentRerank). */
    rerank: boolean;
  }): Promise<string[]> {
    const topK = opts.topK;
    const fetchK = Math.max(topK * 3, 12);
    const piiGate = opts.callerScopes.includes('brain:read_pii') ? '' : 'AND piiClass IS NONE';
    // Fail-closed user scope (0055 + 0117, PRIVACY_SEGMENT_USER_FENCE):
    // an unscoped read stays tenant-global; a scoped read never serves
    // another user's window, and with the fence on a mixed-user window
    // is served only to its own members (segmentUserGate).
    const gate = segmentUserGate(opts.userId);
    try {
      const queryVector = await this.embedder.embed(opts.query);
      const fused = await this.surreal.withCompany(opts.companyId, async (db) => {
        const [dense] = await db.query<[SegmentRow[]]>(
          `SELECT id, text, occurredAt,
                    vector::similarity::cosine(embedding, $q) AS score
               FROM episode_segment
              WHERE embedding != NONE ${piiGate} ${gate.clause}
              ORDER BY score DESC
              LIMIT $k`,
          { q: queryVector, k: fetchK, ...gate.params },
        );
        const [bm25] = await db.query<[SegmentRow[]]>(
          `SELECT id, text, occurredAt, search::score(1) AS score
               FROM episode_segment
              WHERE text @1@ $q ${piiGate} ${gate.clause}
              ORDER BY score DESC
              LIMIT $k`,
          { q: opts.query, k: fetchK, ...gate.params },
        );
        return rrfFuse([dense ?? [], bm25 ?? []]);
      });
      if (fused.length === 0) return [];
      const kept = await this.maybeRerank(opts.query, fused, {
        topK,
        rerank: opts.rerank,
      });
      return kept
        .slice()
        .sort(
          (a, b) =>
            new Date(a.occurredAt as string).getTime() - new Date(b.occurredAt as string).getTime(),
        )
        .map((s) => s.text);
    } catch (e) {
      this.logger.warn(
        `segment lane failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }

  /**
   * L3 anchor independence (segment aux source): the same dense+BM25
   * RRF retrieval as `transcriptLines`, but selecting the segments'
   * conversationId/occurredAt (both first-class since migration 0075)
   * and returning session anchors instead of rendered text. NO rerank
   * — anchors need recall, not the precision trim. Score is the RRF
   * fusion score (the caller normalizes per-source). Same contracts as
   * the lane read: PII/user gates, degrade to [] on any failure.
   */
  async topSegmentAnchors(opts: {
    companyId: string;
    query: string;
    callerScopes: string[];
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string | undefined;
    limit: number;
  }): Promise<Array<{ conversationId: string; occurredAt: Date | string; score: number }>> {
    const piiGate = opts.callerScopes.includes('brain:read_pii') ? '' : 'AND piiClass IS NONE';
    // Same 0055 + 0117 fence as the lane read (segmentUserGate).
    const gate = segmentUserGate(opts.userId);
    try {
      const queryVector = await this.embedder.embed(opts.query);
      const fused = await this.surreal.withCompany(opts.companyId, async (db) => {
        const [dense] = await db.query<[SegmentAnchorRow[]]>(
          `SELECT id, conversationId, occurredAt,
                    vector::similarity::cosine(embedding, $q) AS score
               FROM episode_segment
              WHERE embedding != NONE ${piiGate} ${gate.clause}
              ORDER BY score DESC
              LIMIT $k`,
          { q: queryVector, k: opts.limit, ...gate.params },
        );
        const [bm25] = await db.query<[SegmentAnchorRow[]]>(
          `SELECT id, conversationId, occurredAt, search::score(1) AS score
               FROM episode_segment
              WHERE text @1@ $q ${piiGate} ${gate.clause}
              ORDER BY score DESC
              LIMIT $k`,
          { q: opts.query, k: opts.limit, ...gate.params },
        );
        return rrfFuseScored([dense ?? [], bm25 ?? []]);
      });
      return fused
        .slice(0, opts.limit)
        .filter((x) => Boolean(x.row.conversationId))
        .map((x) => ({
          conversationId: x.row.conversationId,
          occurredAt: x.row.occurredAt,
          score: x.score,
        }));
    } catch (e) {
      this.logger.warn(
        `segment anchor source failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }

  /** Listwise-rerank the fused pool when the profile asks; else head. */
  private async maybeRerank(
    query: string,
    fused: SegmentRow[],
    opts: { topK: number; rerank: boolean },
  ): Promise<SegmentRow[]> {
    const { topK, rerank } = opts;
    if (!rerank || !this.reranker?.isEnabled() || fused.length <= topK) {
      return fused.slice(0, topK);
    }
    try {
      const order = await this.reranker.rerank(
        query,
        fused.map((s, i) => ({
          label: `segment ${i}`,
          body: s.text.slice(0, 600),
        })),
      );
      return order
        .slice(0, topK)
        .map((i) => fused[i])
        .filter((s): s is SegmentRow => s !== undefined);
    } catch (e) {
      this.logger.warn(`segment rerank failed: ${(e as Error).message}`);
      return fused.slice(0, topK);
    }
  }
}

/** Reciprocal-rank fusion over ranked lists, dedup by record id. */
export function rrfFuse(lists: SegmentRow[][], k = 60): SegmentRow[] {
  return rrfFuseScored(lists, k).map((x) => x.row);
}

/** RRF keeping the fused score (the anchor source scores by it). */
function rrfFuseScored<T extends { id: unknown }>(
  lists: T[][],
  k = 60,
): Array<{ row: T; score: number }> {
  const scores = new Map<string, { row: T; score: number }>();
  for (const list of lists) {
    list.forEach((row, rank) => {
      const id = String(row.id);
      const prev = scores.get(id);
      const add = 1 / (k + rank + 1);
      if (prev) prev.score += add;
      else scores.set(id, { row, score: add });
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score);
}
