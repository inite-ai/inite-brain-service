import { Injectable, Logger, Optional } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { RerankerService } from '../ai/reranker.service';
import { envFlagEnabled } from '../common/env-validation';

interface SegmentRow {
  id: unknown;
  text: string;
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
 * brain:read_pii, degrade to [] on any failure.
 */
@Injectable()
export class SegmentLaneService {
  private readonly logger = new Logger(SegmentLaneService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    @Optional() private readonly reranker?: RerankerService,
  ) {}

  isEnabled(): boolean {
    return envFlagEnabled(process.env.SEARCH_SEGMENT_LANE_ENABLED);
  }

  async transcriptLines(opts: {
    companyId: string;
    query: string;
    callerScopes: string[];
  }): Promise<string[]> {
    if (!this.isEnabled()) return [];
    const topK = this.topK();
    const fetchK = Math.max(topK * 3, 12);
    const piiGate = opts.callerScopes.includes('brain:read_pii')
      ? ''
      : 'AND piiClass IS NONE';
    try {
      const queryVector = await this.embedder.embed(opts.query);
      const fused = await this.surreal.withCompany(
        opts.companyId,
        async (db) => {
          const [dense] = await db.query<[SegmentRow[]]>(
            `SELECT id, text, occurredAt,
                    vector::similarity::cosine(embedding, $q) AS score
               FROM episode_segment
              WHERE embedding != NONE ${piiGate}
              ORDER BY score DESC
              LIMIT $k`,
            { q: queryVector, k: fetchK },
          );
          const [bm25] = await db.query<[SegmentRow[]]>(
            `SELECT id, text, occurredAt, search::score(1) AS score
               FROM episode_segment
              WHERE text @1@ $q ${piiGate}
              ORDER BY score DESC
              LIMIT $k`,
            { q: opts.query, k: fetchK },
          );
          return rrfFuse([dense ?? [], bm25 ?? []]);
        },
      );
      if (fused.length === 0) return [];
      const kept = await this.maybeRerank(opts.query, fused, topK);
      return kept
        .slice()
        .sort(
          (a, b) =>
            new Date(a.occurredAt as string).getTime() -
            new Date(b.occurredAt as string).getTime(),
        )
        .map((s) => s.text);
    } catch (e) {
      this.logger.warn(
        `segment lane failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }

  /** Listwise-rerank the fused pool when the reranker is on; else head. */
  private async maybeRerank(
    query: string,
    fused: SegmentRow[],
    topK: number,
  ): Promise<SegmentRow[]> {
    if (
      !envFlagEnabled(process.env.SEARCH_SEGMENT_LANE_RERANK) ||
      !this.reranker?.isEnabled() ||
      fused.length <= topK
    ) {
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
      return order.slice(0, topK).map((i) => fused[i]);
    } catch (e) {
      this.logger.warn(`segment rerank failed: ${(e as Error).message}`);
      return fused.slice(0, topK);
    }
  }

  private topK(): number {
    const v = parseInt(process.env.SEARCH_SEGMENT_LANE_TOPK ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : 5;
  }
}

/** Reciprocal-rank fusion over ranked lists, dedup by record id. */
export function rrfFuse(lists: SegmentRow[][], k = 60): SegmentRow[] {
  const scores = new Map<string, { row: SegmentRow; score: number }>();
  for (const list of lists) {
    list.forEach((row, rank) => {
      const id = String(row.id);
      const prev = scores.get(id);
      const add = 1 / (k + rank + 1);
      if (prev) prev.score += add;
      else scores.set(id, { row, score: add });
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((x) => x.row);
}
