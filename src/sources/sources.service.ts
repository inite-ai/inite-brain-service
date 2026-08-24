import { BadRequestException, Injectable } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService, queryRows, queryFirst } from '../db/surreal.service';
import {
  SOURCE_TYPES,
  type DeclaredSource,
  type DeclareSourceRequest,
  type SourceDetailResponse,
  type SourceSummary,
  type SourceType,
  type TrustScopeRow,
} from '../contracts/sources/sources.schema';

/**
 * source_registry row (columns the mappers read). Date columns are
 * `string | Date` because the SDK hands datetimes back as Date; the scalar
 * columns funnel through Number()/String().
 */
interface DeclaredRow {
  sourceKey: unknown;
  type: SourceType;
  authLevel: unknown;
  owner?: string | null;
  note?: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** source_trust row (one learned reputation scope). */
interface TrustRow {
  domain?: string | null;
  agreementRate: unknown;
  sampleCount: unknown;
  winCount?: unknown;
  lossCount?: unknown;
  lastSeenAt?: string | Date | null;
}

/** source_trust_history row (reputation-over-time trail). */
interface HistoryRow {
  domain?: string | null;
  agreementRate: unknown;
  sampleCount: unknown;
  recordedAt: string | Date;
}

/**
 * Per-tenant source identity + reputation reads (source-reputation track,
 * Phase 3). Joins the two disconnected representations a source has had
 * until now — the operator-declared `source_registry` row and the
 * refit-computed `source_trust` rows — under one sourceKey, and lets an
 * operator declare type/authLevel (the latter activates the resolver's
 * authority slot for that source, see migration 0046).
 *
 * Deliberately NOT an entity surface: sources never appear in search,
 * merge-identity, or the forget cascade.
 */
@Injectable()
export class SourcesService {
  constructor(private readonly surreal: SurrealService) {}

  /** Catalogue: union of declared and learned sources, one line each.
   *  opts.domain additionally captures that domain's learned rate onto
   *  each summary (public /v1/sources?domain= projection). */
  async list(companyId: string, opts?: { domain?: string | undefined }): Promise<SourceSummary[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const declaredRows = await queryRows<DeclaredRow>(
        db,
        `SELECT * FROM source_registry ORDER BY sourceKey`,
      );
      const trustRows = await queryRows<TrustRow & { sourceKey: unknown }>(
        db,
        `SELECT sourceKey, domain, agreementRate, sampleCount, winCount,
                lossCount, lastSeenAt
           FROM source_trust ORDER BY sourceKey`,
      );

      const summaries = new Map<string, SourceSummary>();
      const summaryOf = (sourceKey: string): SourceSummary => {
        const existing = summaries.get(sourceKey);
        if (existing) return existing;
        const fresh: SourceSummary = {
          sourceKey,
          declared: null,
          globalTrust: null,
          scopedDomains: 0,
        };
        summaries.set(sourceKey, fresh);
        return fresh;
      };

      for (const r of declaredRows) {
        summaryOf(String(r.sourceKey)).declared = mapDeclared(r);
      }
      for (const r of trustRows) {
        const summary = summaryOf(String(r.sourceKey));
        if (r.domain === undefined || r.domain === null) {
          summary.globalTrust = mapTrustScope(r);
        } else {
          summary.scopedDomains += 1;
          if (opts?.domain === r.domain) summary.domainTrust = mapTrustScope(r);
        }
      }
      return [...summaries.values()];
    });
  }

  /** Declared row + every learned scope + the reputation-over-time trail. */
  async detail(companyId: string, sourceKey: string): Promise<SourceDetailResponse> {
    return this.surreal.withCompany(companyId, async (db) => {
      const declared = await this.declaredOf(db, sourceKey);
      const trustRows = await queryRows<TrustRow>(
        db,
        `SELECT domain, agreementRate, sampleCount, winCount, lossCount, lastSeenAt
           FROM source_trust WHERE sourceKey = $k`,
        { k: sourceKey },
      );
      const historyRows = await queryRows<HistoryRow>(
        db,
        `SELECT domain, agreementRate, sampleCount, recordedAt
           FROM source_trust_history WHERE sourceKey = $k
           ORDER BY recordedAt DESC LIMIT 100`,
        { k: sourceKey },
      );
      const trust = trustRows.map(mapTrustScope).sort(byGlobalFirstThenDomain);
      return {
        sourceKey,
        declared,
        trust,
        history: historyRows.map((r) => ({
          domain: r.domain ?? null,
          agreementRate: Number(r.agreementRate),
          sampleCount: Number(r.sampleCount),
          recordedAt: new Date(r.recordedAt).toISOString(),
        })),
      };
    });
  }

  /** Upsert the declared identity. authLevel > 0 activates the resolver's
   *  authority component for this source (fn::source_authority_of). */
  async declare(
    companyId: string,
    sourceKey: string,
    body: DeclareSourceRequest,
  ): Promise<DeclaredSource> {
    if (!sourceKey.trim()) {
      throw new BadRequestException('sourceKey is required');
    }
    if (!SOURCE_TYPES.includes(body?.type as (typeof SOURCE_TYPES)[number])) {
      throw new BadRequestException(`type must be one of ${SOURCE_TYPES.join('|')}`);
    }
    const authLevel = body.authLevel ?? 0;
    if (
      typeof authLevel !== 'number' ||
      !Number.isFinite(authLevel) ||
      authLevel < 0 ||
      authLevel > 1
    ) {
      throw new BadRequestException('authLevel must be a number in [0, 1]');
    }
    return this.surreal.withCompany(companyId, async (db) => {
      // option<> fields reject JS null — omit absent owner/note on CREATE
      // and write literal NONE on UPDATE so a re-declare can clear them.
      const params: Record<string, unknown> = {
        k: sourceKey,
        t: body.type,
        a: authLevel,
        ...(body.owner !== undefined ? { o: body.owner } : {}),
        ...(body.note !== undefined ? { n: body.note } : {}),
      };
      await db.query(
        `LET $existing = (SELECT id FROM source_registry
            WHERE sourceKey = $k LIMIT 1)[0];
         IF $existing IS NONE THEN
           CREATE source_registry CONTENT {
             sourceKey: $k,
             type: $t,
             authLevel: $a
             ${body.owner !== undefined ? ', owner: $o' : ''}
             ${body.note !== undefined ? ', note: $n' : ''}
           }
         ELSE
           UPDATE $existing.id SET
             type = $t,
             authLevel = $a,
             owner = ${body.owner !== undefined ? '$o' : 'NONE'},
             note = ${body.note !== undefined ? '$n' : 'NONE'},
             updatedAt = time::now()
         END;`,
        params,
      );
      const declared = await this.declaredOf(db, sourceKey);
      // The row was just upserted; absence means the write failed loudly.
      if (!declared) {
        throw new Error(`source_registry upsert for ${sourceKey} vanished`);
      }
      return declared;
    });
  }

  private async declaredOf(db: Surreal, sourceKey: string): Promise<DeclaredSource | null> {
    const row = await queryFirst<DeclaredRow>(
      db,
      `SELECT * FROM source_registry WHERE sourceKey = $k LIMIT 1`,
      { k: sourceKey },
    );
    return row ? mapDeclared(row) : null;
  }
}

function mapDeclared(r: DeclaredRow): DeclaredSource {
  return {
    sourceKey: String(r.sourceKey),
    type: r.type,
    authLevel: Number(r.authLevel),
    owner: r.owner ?? null,
    note: r.note ?? null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function mapTrustScope(r: TrustRow): TrustScopeRow {
  return {
    domain: r.domain ?? null,
    agreementRate: Number(r.agreementRate),
    sampleCount: Number(r.sampleCount),
    winCount: Number(r.winCount ?? 0),
    lossCount: Number(r.lossCount ?? 0),
    lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : null,
  };
}

function byGlobalFirstThenDomain(a: TrustScopeRow, b: TrustScopeRow): number {
  if (a.domain === null && b.domain !== null) return -1;
  if (a.domain !== null && b.domain === null) return 1;
  return (a.domain ?? '').localeCompare(b.domain ?? '');
}
