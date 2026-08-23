import { Injectable } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { scopeFenceSql } from '../auth/scope-visibility';

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

  /**
   * G6 scope-tag fence (SCOPE_TAGS_ENABLED, default off). An ADDED
   * AND-condition mirroring userGate against the `scope` column, or an
   * empty fragment when the flag is off (userGate stays the sole
   * enforcement). Defense-in-depth — composed with AND, never replacing
   * userGate, so it can only narrow, never open. See scope-visibility.ts.
   */
  private scopeGate(userId: string | undefined): {
    clause: string;
    params: Record<string, unknown>;
  } {
    return scopeFenceSql(userId);
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

  /**
   * All turns of one conversation, chronological, bounded. UNFENCED —
   * the internal derivation reads (window deriver / segment composer)
   * run tenant-wide over the full substrate and MUST see user-scoped
   * and PII turns to derive facts for every user; applying the read
   * fences here would silently drop those turns from derivation. The
   * PII/user-fenced whole-session read for the synthesis read path is
   * `conversationTurns()` below (G2 L3 escalation lane).
   */
  async conversationTurnsRaw(
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

  /**
   * G2 L3 escalation: ALL turns of ONE conversation, chronological,
   * PII- and user-fenced with the SAME gates `windowAround` uses, and
   * bounded by a turn cap. Where `windowAround` reads a bounded span
   * around an anchor moment, this is the whole-session variant the
   * full-raw-context escalation lifts when the extracted facts failed
   * to ground an answer. A conversation the fences hide returns only
   * the turns the caller may see (fail-closed, exactly like the fact
   * read path).
   */
  async conversationTurns(opts: {
    companyId: string;
    conversationId: string;
    includePii: boolean;
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string;
    db?: EpisodeDb;
    /** Turn cap for this read; clamped to the hard CONVERSATION_TURNS_CAP. */
    cap?: number;
  }): Promise<EpisodeTurnRow[]> {
    const cap =
      opts.cap && opts.cap > 0
        ? Math.min(Math.floor(opts.cap), CONVERSATION_TURNS_CAP)
        : CONVERSATION_TURNS_CAP;
    return this.run(opts.companyId, opts.db, async (db) => {
      const scope = this.scopeGate(opts.userId);
      const gates = `${this.piiGate(opts.includePii)} ${this.userGate(opts.userId)} ${scope.clause}`;
      const [rows] = await db.query<[EpisodeTurnRow[]]>(
        `SELECT id, speaker, text, occurredAt, piiClass, userId FROM episode
          WHERE conversationId = $conv ${gates}
          ORDER BY occurredAt ASC, id ASC LIMIT ${cap}`,
        {
          conv: opts.conversationId,
          ...this.userParams(opts.userId),
          ...scope.params,
        },
      );
      return rows ?? [];
    });
  }

  /** BM25 top-k over verbatim turns, best-score first, PII-fenced. */
  async searchText(opts: {
    companyId: string;
    query: string;
    limit: number;
    includePii: boolean;
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string;
    /**
     * Multiworld §10 role filter (assistant verbatim lane): keep only
     * turns whose speaker ENDS WITH this suffix, case-insensitive.
     * Suffix, not equality — eval harness speakers are
     * `<convSlug>__<role>` while production tenants stamp bare roles.
     */
    speakerSuffix?: string;
    db?: EpisodeDb;
  }): Promise<Array<EpisodeQuoteRow & { score?: number }>> {
    const speakerGate = opts.speakerSuffix
      ? 'AND string::ends_with(string::lowercase(speaker), $speakerSuffix)'
      : '';
    const speakerParams = opts.speakerSuffix
      ? { speakerSuffix: opts.speakerSuffix.toLowerCase() }
      : {};
    return this.run(opts.companyId, opts.db, async (db) => {
      const scope = this.scopeGate(opts.userId);
      const [rows] = await db.query<
        [Array<EpisodeQuoteRow & { score?: number }>]
      >(
        `SELECT id, conversationId, speaker, text, occurredAt, search::score(1) AS score
           FROM episode
          WHERE text @1@ $q ${this.piiGate(opts.includePii)} ${this.userGate(opts.userId)} ${scope.clause} ${speakerGate}
          ORDER BY score DESC
          LIMIT $k`,
        {
          q: opts.query,
          k: opts.limit,
          ...this.userParams(opts.userId),
          ...scope.params,
          ...speakerParams,
        },
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
      const scope = this.scopeGate(opts.userId);
      const [rows] = await db.query<[EpisodeQuoteRow[]]>(
        `SELECT id, conversationId, speaker, text, occurredAt FROM episode
          WHERE id INSIDE $ids ${this.piiGate(opts.includePii)} ${this.userGate(opts.userId)} ${scope.clause}`,
        {
          ids: opts.ids.map((id) => new StringRecordId(id)),
          ...this.userParams(opts.userId),
          ...scope.params,
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
      const scope = this.scopeGate(opts.userId);
      const gates = `${this.piiGate(opts.includePii)} ${this.userGate(opts.userId)} ${scope.clause}`;
      const params = {
        conv: opts.conversationId,
        c: new Date(opts.centerIso),
        ...this.userParams(opts.userId),
        ...scope.params,
      };
      const [before, after] = await Promise.all([
        db
          .query<[EpisodeQuoteRow[]]>(
            `SELECT id, conversationId, speaker, text, occurredAt FROM episode
              WHERE conversationId = $conv AND occurredAt <= $c ${gates}
              ORDER BY occurredAt DESC, id DESC LIMIT ${Math.max(1, opts.span + 1)}`,
            params,
          )
          .then(([rows]) => rows ?? []),
        db
          .query<[EpisodeQuoteRow[]]>(
            `SELECT id, conversationId, speaker, text, occurredAt FROM episode
              WHERE conversationId = $conv AND occurredAt > $c ${gates}
              ORDER BY occurredAt ASC, id ASC LIMIT ${Math.max(1, opts.span)}`,
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
      // G6 scope-tag fence (SCOPE_TAGS_ENABLED) — ADDED alongside the
      // userId fence, inert when off. The scopeFenceSql clause carries a
      // leading `AND `; strip it since this builder joins with ` AND `.
      const scope = scopeFenceSql(opts.userId);
      if (scope.clause) {
        where.push(scope.clause.replace(/^AND\s+/, ''));
        Object.assign(params, scope.params);
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
