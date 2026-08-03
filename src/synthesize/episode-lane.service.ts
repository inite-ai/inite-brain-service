import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';
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

  constructor(
    private readonly surreal: SurrealService,
    private readonly episodes: EpisodeReadStoreService,
  ) {}

  isEnabled(): boolean {
    return envFlagEnabled(process.env.SEARCH_EPISODIC_LANE_ENABLED);
  }

  /**
   * Fetch top-k episodes for the query and render them as one prompt
   * section: chronologically ordered, speaker-attributed, dated. Returns
   * [] when disabled, on any failure, or when nothing matches — the lane
   * degrades to absent, never breaks synthesis. `force` bypasses the
   * global flag for router-conditioned callers (verbatim-recall shape):
   * the genre law says quotes help exactly when the question asks for
   * conversational content, so the shape — not a deployment-wide flag —
   * is the right gate.
   */
  async transcriptLines(opts: {
    companyId: string;
    query: string;
    callerScopes: string[];
    force?: boolean;
  }): Promise<string[]> {
    if (!opts.force && !this.isEnabled()) return [];
    try {
      const rows = await this.episodes.searchText({
        companyId: opts.companyId,
        query: opts.query,
        limit: this.topK(),
        includePii: opts.callerScopes.includes('brain:read_pii'),
      });
      return renderQuoteLines(rows);
    } catch (e) {
      this.logger.warn(
        `episodic lane failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }

  isSourceExcerptsEnabled(): boolean {
    return envFlagEnabled(process.env.SYNTHESIZE_SOURCE_EXCERPTS);
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
    force?: boolean;
  }): Promise<string[]> {
    if (
      (!opts.force && !this.isSourceExcerptsEnabled()) ||
      opts.factIds.length === 0
    ) {
      return [];
    }
    const cap = this.sourceExcerptsCap();
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

  /**
   * T2b first-mention enumerator: earliest grounding-episode date per
   * fact. BEAM-style ordering questions ask the order topics were
   * MENTIONED, while validFrom on derived facts carries occurred_on —
   * the EVENT date — so sorting by validFrom lies whenever events are
   * narrated out of order. The mention signal is the timestamp of the
   * earliest episode the fact is grounded in. Dates only (no episode
   * text), so no PII gate. Degrades to {} on any failure.
   */
  async mentionDates(opts: {
    companyId: string;
    factIds: string[];
  }): Promise<Record<string, string>> {
    if (opts.factIds.length === 0) return {};
    try {
      return await this.surreal.withCompany(opts.companyId, async (db) => {
        const [facts] = await db.query<
          [Array<{ id: unknown; eps?: unknown }>]
        >(
          `SELECT id, source.episodeIds AS eps FROM knowledge_fact
            WHERE id INSIDE $ids AND source.episodeIds IS NOT NONE`,
          { ids: opts.factIds.map((id) => new StringRecordId(id)) },
        );
        const epIds = new Set<string>();
        for (const f of facts ?? []) {
          if (!Array.isArray(f.eps)) continue;
          for (const e of f.eps) {
            const id = String(e);
            if (id.startsWith('episode:')) epIds.add(id);
          }
        }
        if (epIds.size === 0) return {};
        const epDate = await this.episodes.occurredAtByIds({
          companyId: opts.companyId,
          ids: [...epIds],
          db,
        });
        const out: Record<string, string> = {};
        for (const f of facts ?? []) {
          if (!Array.isArray(f.eps)) continue;
          let min = Number.POSITIVE_INFINITY;
          for (const e of f.eps) {
            const t = epDate.get(String(e));
            if (t !== undefined && t < min) min = t;
          }
          if (Number.isFinite(min)) {
            out[String(f.id)] = new Date(min).toISOString();
          }
        }
        return out;
      });
    } catch (e) {
      this.logger.warn(
        `mention-date lookup failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return {};
    }
  }

  /** Episode quotes per prompt from the provenance lane. */
  private sourceExcerptsCap(): number {
    const v = parseInt(process.env.SYNTHESIZE_SOURCE_EXCERPTS_CAP ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : 16;
  }

  /** Quotes per prompt; verbatim turns are token-heavy, keep the cap low. */
  private topK(): number {
    const v = parseInt(process.env.SEARCH_EPISODIC_LANE_TOPK ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : 8;
  }
}
