import { Injectable } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';

/**
 * Read port over the L0 episode substrate (raw-substrate driver v1,
 * docs/roadmap/raw-substrate-driver-2026-08.md, surface 2).
 *
 * Every internal reader goes through this service instead of issuing
 * its own `FROM episode` — the episode schema stops being load-bearing
 * across five files, the PII fence has ONE implementation, and the
 * storage engine becomes swappable in principle. The write side stays
 * in ingest's EpisodeStoreService (capture policy — redaction,
 * language detection — is ingest's concern, not storage's).
 *
 * Connection semantics: methods accept an optional `db` handle so
 * callers already inside a withCompany closure keep their connection
 * (the deriver/composer loops, multi-query lane reads); without one,
 * the method opens its own scoped connection.
 */

/** Minimal query surface of a scoped Surreal connection. */
export interface EpisodeDb {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
}

export interface EpisodeTurnRow {
  id: unknown;
  speaker?: string;
  text: string;
  occurredAt: Date | string;
  piiClass?: string[];
  userId?: string;
}

export interface EpisodeQuoteRow {
  speaker?: string;
  text: string;
  occurredAt: Date | string;
}

/** Full row shape served by the public episodes API. */
export interface EpisodePageRow {
  id: unknown;
  kind: string;
  conversationId?: string;
  messageId: string;
  speaker?: string;
  addressee?: string;
  text: string;
  piiClass?: string[];
  occurredAt: Date | string;
  recordedAt: Date | string;
  lang?: string;
  source: Record<string, unknown>;
}

/** Hard bound on a single conversation read (mirrors the historical cap). */
const CONVERSATION_TURNS_CAP = 5000;

@Injectable()
export class EpisodeReadStoreService {
  constructor(private readonly surreal: SurrealService) {}

  /** The one PII-fence implementation for episode reads. */
  private piiGate(includePii: boolean): string {
    return includePii ? '' : 'AND piiClass IS NONE';
  }

  private async run<T>(
    companyId: string,
    db: EpisodeDb | undefined,
    fn: (db: EpisodeDb) => Promise<T>,
  ): Promise<T> {
    if (db) return fn(db);
    return this.surreal.withCompany(companyId, (scoped) =>
      fn(scoped as unknown as EpisodeDb),
    );
  }

  /** Conversations present in the substrate, with turn counts. */
  async conversationCounts(
    db: EpisodeDb,
  ): Promise<Array<{ conversationId: string; n: number }>> {
    const [rows] = await db.query<
      [Array<{ conversationId?: string; n: number }>]
    >(
      `SELECT conversationId, count() AS n FROM episode
        WHERE conversationId IS NOT NONE
        GROUP BY conversationId`,
    );
    return (rows ?? [])
      .filter((r) => r.conversationId !== undefined)
      .map((r) => ({ conversationId: String(r.conversationId), n: r.n }));
  }

  /** All turns of one conversation, chronological, bounded. */
  async conversationTurns(
    db: EpisodeDb,
    conversationId: string,
  ): Promise<EpisodeTurnRow[]> {
    const [rows] = await db.query<[EpisodeTurnRow[]]>(
      `SELECT id, speaker, text, occurredAt, piiClass, userId FROM episode
        WHERE conversationId = $conv ORDER BY occurredAt ASC LIMIT ${CONVERSATION_TURNS_CAP}`,
      { conv: conversationId },
    );
    return rows ?? [];
  }

  /** BM25 top-k over verbatim turns, best-score first, PII-fenced. */
  async searchText(opts: {
    companyId: string;
    query: string;
    limit: number;
    includePii: boolean;
    db?: EpisodeDb;
  }): Promise<Array<EpisodeQuoteRow & { score?: number }>> {
    return this.run(opts.companyId, opts.db, async (db) => {
      const [rows] = await db.query<
        [Array<EpisodeQuoteRow & { score?: number }>]
      >(
        `SELECT speaker, text, occurredAt, search::score(1) AS score
           FROM episode
          WHERE text @1@ $q ${this.piiGate(opts.includePii)}
          ORDER BY score DESC
          LIMIT $k`,
        { q: opts.query, k: opts.limit },
      );
      return rows ?? [];
    });
  }

  /** Quote rows for specific episode ids, PII-fenced, order unspecified. */
  async byIds(opts: {
    companyId: string;
    ids: string[];
    includePii: boolean;
    db?: EpisodeDb;
  }): Promise<EpisodeQuoteRow[]> {
    if (opts.ids.length === 0) return [];
    return this.run(opts.companyId, opts.db, async (db) => {
      const [rows] = await db.query<[EpisodeQuoteRow[]]>(
        `SELECT speaker, text, occurredAt FROM episode
          WHERE id INSIDE $ids ${this.piiGate(opts.includePii)}`,
        { ids: opts.ids.map((id) => new StringRecordId(id)) },
      );
      return rows ?? [];
    });
  }

  /**
   * Keyset page for the public episodes API (surface 1): stable
   * (occurredAt, id) order, filters composed in code, PII fence via
   * the shared gate. `after` resumes past the last row of the previous
   * page — offset-free, so a growing substrate never skips or repeats.
   */
  async page(opts: {
    companyId: string;
    includePii: boolean;
    limit: number;
    conversationId?: string;
    speaker?: string;
    sinceIso?: string;
    untilIso?: string;
    after?: { occurredAtIso: string; id: string };
  }): Promise<EpisodePageRow[]> {
    return this.run(opts.companyId, undefined, async (db) => {
      const where: string[] = [];
      const params: Record<string, unknown> = { k: opts.limit };
      if (opts.conversationId !== undefined) {
        where.push('conversationId = $conv');
        params.conv = opts.conversationId;
      }
      if (opts.speaker !== undefined) {
        where.push('speaker = $speaker');
        params.speaker = opts.speaker;
      }
      if (opts.sinceIso !== undefined) {
        where.push('occurredAt >= $since');
        params.since = new Date(opts.sinceIso);
      }
      if (opts.untilIso !== undefined) {
        where.push('occurredAt <= $until');
        params.until = new Date(opts.untilIso);
      }
      if (opts.after) {
        where.push(
          '(occurredAt > $afterT OR (occurredAt = $afterT AND id > $afterId))',
        );
        params.afterT = new Date(opts.after.occurredAtIso);
        params.afterId = new StringRecordId(opts.after.id);
      }
      if (!opts.includePii) where.push('piiClass IS NONE');
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const [rows] = await db.query<[EpisodePageRow[]]>(
        `SELECT id, kind, conversationId, messageId, speaker, addressee,
                text, piiClass, occurredAt, recordedAt, lang, source
           FROM episode ${whereSql}
          ORDER BY occurredAt ASC, id ASC
          LIMIT $k`,
        params,
      );
      return rows ?? [];
    });
  }

  /**
   * occurredAt (epoch ms) per episode id — dates only, no text, so no
   * PII gate. Unparseable timestamps are dropped.
   */
  async occurredAtByIds(opts: {
    companyId: string;
    ids: string[];
    db?: EpisodeDb;
  }): Promise<Map<string, number>> {
    if (opts.ids.length === 0) return new Map();
    return this.run(opts.companyId, opts.db, async (db) => {
      const [rows] = await db.query<
        [Array<{ id: unknown; occurredAt: Date | string }>]
      >(`SELECT id, occurredAt FROM episode WHERE id INSIDE $ids`, {
        ids: opts.ids.map((id) => new StringRecordId(id)),
      });
      const out = new Map<string, number>();
      for (const r of rows ?? []) {
        const t = new Date(r.occurredAt as string).getTime();
        if (Number.isFinite(t)) out.set(String(r.id), t);
      }
      return out;
    });
  }
}
