import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EpisodeReadStoreService } from '../episodes/episode-read-store.service';

interface EpisodeQuoteRow {
  speaker?: string;
  text: string;
  occurredAt: Date | string;
}

/** Chronological `[YYYY-MM-DD] Speaker: text` rendering shared by both lanes. */
function renderQuoteLines(rows: EpisodeQuoteRow[]): string[] {
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
}

/**
 * Episodic retrieval lane (P2 of
 * docs/roadmap/memory-substrate-redesign-2026-07.md).
 *
 * BM25 top-k over the L0 episode substrate, rendered as dated transcript
 * quotes in their own typed section of the generator prompt. This is the
 * lossless fallback lane: facts the extractor missed or fragmented are
 * still findable in the verbatim turn. v1 is BM25-only — episode
 * embeddings are derived state and not yet backfilled.
 *
 * Activation is the caller's job: SynthesizeService gates all three
 * verbatim lanes on the resolved profile's verbatimEvidence mode and
 * passes the per-lane cap explicitly — this service reads no env.
 *
 * Scope gate: callers without brain:read_pii only see episodes whose
 * piiClass is empty — the episode lane must not become a read surface
 * that bypasses the predicate-keyed PII fence.
 */
@Injectable()
export class EpisodeLaneService {
  private readonly logger = new Logger(EpisodeLaneService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly episodes: EpisodeReadStoreService,
  ) {}

  /**
   * Fetch top-k episodes for the query and render them as one prompt
   * section: chronologically ordered, speaker-attributed, dated. Returns
   * [] on any failure or when nothing matches — the lane degrades to
   * absent, never breaks synthesis.
   */
  async transcriptLines(opts: {
    companyId: string;
    query: string;
    callerScopes: string[];
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string;
    /** Quotes per prompt (profile.quotesPerPrompt). */
    limit: number;
  }): Promise<string[]> {
    try {
      const rows = await this.episodes.searchText({
        companyId: opts.companyId,
        query: opts.query,
        limit: opts.limit,
        includePii: opts.callerScopes.includes('brain:read_pii'),
        userId: opts.userId,
      });
      return renderQuoteLines(rows);
    } catch (e) {
      this.logger.warn(
        `episodic lane failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Provenance lane (A1 of the road-to-90 program): verbatim source turns
   * of the facts ALREADY selected as evidence. Unlike `transcriptLines`
   * (which searches episodes by the question and can miss), this follows
   * `knowledge_fact.source.episodeIds` — the derivation stamped exactly
   * which turns ground each proposition, so the quote containing the
   * concrete detail the derivation summarized away ("a cup with a dog
   * face") rides along with the fact. Same PII gate, same degradation
   * contract: [] when disabled, on failure, or when nothing resolves.
   */
  async sourceExcerpts(opts: {
    companyId: string;
    factIds: string[];
    callerScopes: string[];
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string;
    /** Excerpts per prompt (profile.sourceExcerptsCap). */
    cap: number;
  }): Promise<string[]> {
    if (opts.factIds.length === 0) return [];
    const cap = opts.cap;
    try {
      return await this.surreal.withCompany(opts.companyId, async (db) => {
        const [facts] = await db.query<
          [Array<{ eps?: unknown }>]
        >(
          `SELECT source.episodeIds AS eps FROM knowledge_fact
            WHERE id INSIDE $ids AND source.episodeIds IS NOT NONE`,
          { ids: opts.factIds.map((id) => new StringRecordId(id)) },
        );
        // Evidence order ≈ relevance order, so first-seen wins the cap.
        const episodeIds: string[] = [];
        const seen = new Set<string>();
        for (const f of facts ?? []) {
          if (!Array.isArray(f.eps)) continue;
          for (const e of f.eps) {
            const id = String(e);
            if (!id.startsWith('episode:') || seen.has(id)) continue;
            seen.add(id);
            if (episodeIds.length < cap) episodeIds.push(id);
          }
        }
        const rows = await this.episodes.byIds({
          companyId: opts.companyId,
          ids: episodeIds,
          includePii: opts.callerScopes.includes('brain:read_pii'),
          userId: opts.userId,
          db,
        });
        return renderQuoteLines(rows);
      });
    } catch (e) {
      this.logger.warn(
        `source-excerpt lane failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }
}
