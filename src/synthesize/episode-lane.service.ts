import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';

/**
 * Episodic retrieval lane (SEARCH_EPISODIC_LANE_ENABLED — P2 of
 * docs/roadmap/memory-substrate-redesign-2026-07.md).
 *
 * BM25 top-k over the L0 episode substrate, rendered as dated transcript
 * quotes in their own typed section of the generator prompt. This is the
 * lossless fallback lane: facts the extractor missed or fragmented are
 * still findable in the verbatim turn. v1 is BM25-only — episode
 * embeddings are derived state and not yet backfilled.
 *
 * Scope gate: callers without brain:read_pii only see episodes whose
 * piiClass is empty — the episode lane must not become a read surface
 * that bypasses the predicate-keyed PII fence.
 */
@Injectable()
export class EpisodeLaneService {
  private readonly logger = new Logger(EpisodeLaneService.name);

  constructor(private readonly surreal: SurrealService) {}

  isEnabled(): boolean {
    return envFlagEnabled(process.env.SEARCH_EPISODIC_LANE_ENABLED);
  }

  /**
   * Fetch top-k episodes for the query and render them as one prompt
   * section: chronologically ordered, speaker-attributed, dated. Returns
   * [] when disabled, on any failure, or when nothing matches — the lane
   * degrades to absent, never breaks synthesis.
   */
  async transcriptLines(opts: {
    companyId: string;
    query: string;
    callerScopes: string[];
  }): Promise<string[]> {
    if (!this.isEnabled()) return [];
    const k = this.topK();
    const piiGate = opts.callerScopes.includes('brain:read_pii')
      ? ''
      : 'AND piiClass IS NONE';
    try {
      const rows = await this.surreal.withCompany(
        opts.companyId,
        async (db) => {
          const [r] = await db.query<
            [
              Array<{
                speaker?: string;
                text: string;
                occurredAt: Date | string;
              }>,
            ]
          >(
            `SELECT speaker, text, occurredAt, search::score(1) AS score
               FROM episode
              WHERE text @1@ $q ${piiGate}
              ORDER BY score DESC
              LIMIT $k`,
            { q: opts.query, k },
          );
          return r ?? [];
        },
      );
      return rows
        .slice()
        .sort(
          (a, b) =>
            new Date(a.occurredAt as string).getTime() -
            new Date(b.occurredAt as string).getTime(),
        )
        .map((r) => {
          const day = String(
            r.occurredAt instanceof Date
              ? r.occurredAt.toISOString()
              : r.occurredAt,
          ).slice(0, 10);
          const who = r.speaker ? `${r.speaker}` : 'unknown';
          return `[${day}] ${who}: ${r.text}`;
        });
    } catch (e) {
      this.logger.warn(
        `episodic lane failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }

  /** Quotes per prompt; verbatim turns are token-heavy, keep the cap low. */
  private topK(): number {
    const v = parseInt(process.env.SEARCH_EPISODIC_LANE_TOPK ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : 8;
  }
}
