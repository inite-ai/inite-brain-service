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
  /** Present on byIds/windowAround reads (dedupe key); absent on BM25. */
  id?: unknown;
  /** Present on byIds/windowAround reads (window-expansion anchor). */
  conversationId?: string;
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

  /**
   * The one user-scope fence for episode reads (audit W1, finding #14).
   * Mirrors the fact read path (search/internals/where-builder.ts) and is
   * FAIL-CLOSED for exactly the same reason: no userId on the request →
   * tenant-global turns only; with one → global + that user's, never
   * anyone else's. Migration 0055's scope was previously bypassed by
   * every L0 surface, so personal verbatim leaked to any brain:read key.
   */
  private userGate(userId: string | undefined): string {
    return userId
      ? 'AND (userId IS NONE OR userId = $scopeUserId)'
      : 'AND userId IS NONE';
  }

  /** Param bag companion to userGate (empty when unscoped). */
  private userParams(userId: string | undefined): Record<string, unknown> {
    return userId ? { scopeUserId: userId } : {};
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
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string;
    db?: EpisodeDb;
  }): Promise<Array<EpisodeQuoteRow & { score?: number }>> {
    return this.run(opts.companyId, opts.db, async (db) => {
      const [rows] = await db.query<
        [Array<EpisodeQuoteRow & { score?: number }>]
      >(
        `SELECT speaker, text, occurredAt, search::score(1) AS score
           FROM episode
          WHERE text @1@ $q ${this.piiGate(opts.includePii)} ${this.userGate(opts.userId)}
          ORDER BY score DESC
          LIMIT $k`,
        { q: opts.query, k: opts.limit, ...this.userParams(opts.userId) },
      );
      return rows ?? [];
    });
  }

  /** Quote rows for specific episode ids, PII-fenced, order unspecified. */
  async byIds(opts: {
    companyId: string;
    ids: string[];
    includePii: boolean;
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string;
    db?: EpisodeDb;
  }): Promise<EpisodeQuoteRow[]> {
    if (opts.ids.length === 0) return [];
    return this.run(opts.companyId, opts.db, async (db) => {
      const [rows] = await db.query<[EpisodeQuoteRow[]]>(
        `SELECT id, conversationId, speaker, text, occurredAt FROM episode
          WHERE id INSIDE $ids ${this.piiGate(opts.includePii)} ${this.userGate(opts.userId)}`,
        {
          ids: opts.ids.map((id) => new StringRecordId(id)),
          ...this.userParams(opts.userId),
        },
      );
      return rows ?? [];
    });
  }

  /**
   * V13 raw-turn window (RETRIEVAL_RAW_WINDOW): the turns immediately
   * around an anchor moment of one conversation — `span` before the
   * anchor (inclusive) and `span` after, chronological. Two bounded
   * ORDER BY occurredAt queries, both PII- and user-fenced; an anchor
   * the fences hide returns only what the caller may see.
   */
  async windowAround(opts: {
    companyId: string;
    conversationId: string;
    centerIso: string;
    span: number;
    includePii: boolean;
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string;
    db?: EpisodeDb;
  }): Promise<EpisodeQuoteRow[]> {
    return this.run(opts.companyId, opts.db, async (db) => {
      const gates = `${this.piiGate(opts.includePii)} ${this.userGate(opts.userId)}`;
      const params = {
        conv: opts.conversationId,
        c: new Date(opts.centerIso),
        ...this.userParams(opts.userId),
      };
      const [before, after] = await Promise.all([
        db
          .query<[EpisodeQuoteRow[]]>(
            `SELECT id, conversationId, speaker, text, occurredAt FROM episode
              WHERE conversationId = $conv AND occurredAt <= $c ${gates}
              ORDER BY occurredAt DESC LIMIT ${Math.max(1, opts.span + 1)}`,
            params,
          )
          .then(([rows]) => rows ?? []),
        db
          .query<[EpisodeQuoteRow[]]>(
            `SELECT id, conversationId, speaker, text, occurredAt FROM episode
              WHERE conversationId = $conv AND occurredAt > $c ${gates}
              ORDER BY occurredAt ASC LIMIT ${Math.max(1, opts.span)}`,
            params,
          )
          .then(([rows]) => rows ?? []),
      ]);
      return [...before.reverse(), ...after];
    });
  }

  /**
   * Metadata rows newer than a watermark, for the subscription
   * dispatcher (surface 4). NO text and NO pii filtering — the payload
   * carries only ids/attribution/timestamps, so every row is safe to
   * announce and subscribers never silently miss PII-classed episodes.
   * Ordered by recordedAt (ingest time, monotone) — occurredAt can be
   * backdated and would leak rows past the watermark.
   */
  async metaSince(opts: {
    companyId: string;
    sinceIso: string;
    limit: number;
  }): Promise<
    Array<{
      id: unknown;
      conversationId?: string;
      messageId: string;
      speaker?: string;
      occurredAt: Date | string;
      recordedAt: Date | string;
    }>
  > {
    return this.run(opts.companyId, undefined, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            id: unknown;
            conversationId?: string;
            messageId: string;
            speaker?: string;
            occurredAt: Date | string;
            recordedAt: Date | string;
          }>,
        ]
      >(
        `SELECT id, conversationId, messageId, speaker, occurredAt, recordedAt
           FROM episode
          WHERE recordedAt > <datetime> $since
          ORDER BY recordedAt ASC
          LIMIT $k`,
        { since: opts.sinceIso, k: opts.limit },
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
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string;
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
      // Fail-closed user scope (0055) — see userGate.
      if (opts.userId) {
        where.push('(userId IS NONE OR userId = $scopeUserId)');
        params.scopeUserId = opts.userId;
      } else {
        where.push('userId IS NONE');
      }
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
}
