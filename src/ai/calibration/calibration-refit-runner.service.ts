import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { ApiKeyService } from '../../auth/api-key.service';
import { SurrealService } from '../../db/surreal.service';
import {
  fitIsotonic,
  type CalibrationPair,
  type CalibrationMap,
} from './isotonic';
import { CalibrationService, BOOTSTRAP_PROMPT_HASH, BOOTSTRAP_PROMPT_KEY } from './calibration.service';

/** Per-tenant progress callback so the caller can track a job_run row. */
export type RefitProgress = (detail: Record<string, unknown>) => void;

export interface RefitOutcome {
  /** The headline count returned to the caller (upserted / sampleCount). */
  count: number;
  /** The rich payload persisted on the job_run row's success result. */
  result: Record<string, unknown>;
}

/**
 * CalibrationRefitRunnerService — the nightly refit engine.
 *
 * Owns the actual work, free of cron/queue/job-tracking concerns:
 *   - source-trust refit: walk every tenant, group facts by source key,
 *     UPSERT learned agreement rates into source_trust.
 *   - calibration refit: build a (rawConfidence, correctness) gold set
 *     across tenants, PAV-fit a new map, persist + hot-reload it.
 *
 * Both methods take an optional per-tenant progress callback so the
 * orchestrator can mirror progress onto a job_run row. extractorModel is
 * read from the environment so the runner carries no ConfigService dep,
 * keeping it at ≤3 (surreal, calibration, apiKeys).
 */
@Injectable()
export class CalibrationRefitRunnerService {
  private readonly logger = new Logger(CalibrationRefitRunnerService.name);
  private readonly extractorModel =
    process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini';
  private readonly bootstrapPromptKey = BOOTSTRAP_PROMPT_HASH;

  constructor(
    private readonly surreal: SurrealService,
    private readonly calibration: CalibrationService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async refitSourceTrust(onProgress?: RefitProgress): Promise<RefitOutcome> {
    const tenants = this.apiKeys.knownCompanyIds();
    let upserted = 0;
    for (const companyId of tenants) {
      try {
        upserted += await this.refitSourceTrustForTenant(companyId);
        onProgress?.({ currentTenant: companyId, upserted });
      } catch (e) {
        this.logger.warn(
          `source-trust refit failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }
    this.logger.log(
      `source-trust refit done — ${upserted} row(s) upserted across ${tenants.length} tenant(s)`,
    );
    return { count: upserted, result: { upserted, tenants: tenants.length } };
  }

  async refitCalibration(onProgress?: RefitProgress): Promise<RefitOutcome> {
    const tenants = this.apiKeys.knownCompanyIds();
    const allPairs: CalibrationPair[] = [];
    for (const companyId of tenants) {
      try {
        const pairs = await this.collectCalibrationPairsForTenant(companyId);
        allPairs.push(...pairs);
        onProgress?.({ currentTenant: companyId, pairsCollected: allPairs.length });
      } catch (e) {
        this.logger.warn(
          `calibration pair collection failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }
    if (allPairs.length < 40) {
      const msg = `calibration refit skipped — only ${allPairs.length} pair(s) (need 40+)`;
      this.logger.log(msg);
      return {
        count: 0,
        result: {
          skipped: true,
          skipReason: msg,
          pairsCollected: allPairs.length,
          floor: 40,
        },
      };
    }
    const map = fitIsotonic(allPairs);
    await this.persistCalibrationMap(map);
    // loadMap re-hashes its promptText arg internally (cacheKey →
    // promptHashOf), and calibrate() reads with promptHashOf('bootstrap').
    // So pass the RAW literal here, NOT bootstrapPromptKey (which is the
    // already-hashed DB key) — otherwise the map lands under
    // promptHashOf(HASH) and the in-process hot-reload never hits.
    this.calibration.loadMap(this.extractorModel, BOOTSTRAP_PROMPT_KEY, map);
    this.logger.log(
      `calibration refit complete — samples=${map.sampleCount} bins=${map.thresholds.length}`,
    );
    return {
      count: map.sampleCount,
      result: { sampleCount: map.sampleCount, bins: map.thresholds.length },
    };
  }

  /**
   * Read persisted calibration_table versions for the active extractor
   * model. Operator-facing — surfaces the "what got persisted by the
   * nightly job" trail.
   */
  async listVersions(): Promise<
    Array<{
      version: number;
      sampleCount: number;
      bins: number;
      createdAt?: string;
    }>
  > {
    const tenants = this.apiKeys.knownCompanyIds();
    const host = tenants[0];
    if (!host) return [];
    return this.surreal.withCompany(host, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            version: number;
            sampleCount: number;
            thresholds: number[];
            createdAt?: string;
          }>,
        ]
      >(
        `SELECT version, sampleCount, thresholds, createdAt
            FROM calibration_table
            WHERE extractorModel = $m AND promptHash = $p
            ORDER BY version DESC LIMIT 50`,
        { m: this.extractorModel, p: this.bootstrapPromptKey },
      );
      return (rows ?? []).map((r) => ({
        version: r.version,
        sampleCount: r.sampleCount,
        bins: r.thresholds?.length ?? 0,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      }));
    });
  }

  /**
   * Recompute learned source trust for one tenant at BOTH grains: the
   * global per-source rate (domain NONE — what existed pre-0045) and the
   * domain-scoped rate ((sourceKey, domain), domain = predicate for now).
   * fn::source_trust_scoped resolves scoped → global → 0.5, so scoped rows
   * simply sharpen the picture where a source has enough same-predicate
   * history. Rate movements (or first sightings) append to
   * source_trust_history — the reputation-over-time trail; the hot
   * source_trust row stays an in-place UPSERT cache.
   */
  private async refitSourceTrustForTenant(companyId: string): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            vertical: string | null;
            recorder: string | null;
            predicate: string;
            status: string;
            recordedAt: string | Date;
            originKey: string | null;
            corroborates: unknown;
          }>,
        ]
      >(
        `SELECT
            source.vertical AS vertical,
            source.recorder AS recorder,
            source.originKey AS originKey,
            corroborates,
            predicate,
            status,
            recordedAt
          FROM knowledge_fact
          WHERE source.vertical IS NOT NONE
          ORDER BY recordedAt DESC
          LIMIT 50000;`,
      );
      // Retrieval feedback (migration 0054) joins the same win/loss
      // currency: 'helpful' confirms the source, 'incorrect' counts
      // against it. One standing vote per (fact, caller key) is enforced
      // at write time (UNIQUE index), so a single consumer can't farm
      // its own source's rate. 'not_helpful' is a relevance signal, not
      // a reliability one — excluded here by the WHERE.
      const [feedbackRows] = await db.query<
        [
          Array<{
            vertical: string | null;
            recorder: string | null;
            predicate: string;
            verdict: string;
            createdAt: string | Date;
          }>,
        ]
      >(
        `SELECT
            factId.source.vertical AS vertical,
            factId.source.recorder AS recorder,
            factId.predicate AS predicate,
            verdict,
            createdAt
          FROM retrieval_feedback
          WHERE verdict != 'not_helpful'
            AND factId.source.vertical IS NOT NONE
          ORDER BY createdAt DESC
          LIMIT 50000;`,
      );
      const summary = aggregateByScope([
        ...buildTrustEvents(rows ?? []),
        ...buildFeedbackTrustEvents(feedbackRows ?? []),
      ]);

      // Prior rates in one read — the |Δ| > 0.01 history gate needs them,
      // and per-scope SELECTs would be N extra round-trips.
      const [existingRows] = await db.query<
        [Array<{ sourceKey: string; domain: string | null; agreementRate: number }>]
      >(`SELECT sourceKey, domain, agreementRate FROM source_trust;`);
      const prior = new Map<string, number>();
      for (const r of existingRows ?? []) {
        prior.set(scopeKeyOf(r.sourceKey, r.domain ?? null), r.agreementRate);
      }

      let upsertedHere = 0;
      for (const scope of summary) {
        if (scope.wins + scope.losses === 0) continue;
        await this.upsertTrustScope(db, {
          ...scope,
          prevRate: prior.get(scopeKeyOf(scope.sourceKey, scope.domain)) ?? null,
        });
        upsertedHere++;
      }
      return upsertedHere;
    });
  }

  /** UPSERT one (sourceKey, domain) trust row + append history when the
   *  rate moved (or the scope is first seen). `domain: null` = the global
   *  row; SurrealDB option<> rejects JS null, so the global variant omits
   *  the field entirely and matches with `domain IS NONE`. */
  private async upsertTrustScope(
    db: Surreal,
    scope: TrustScope & { prevRate: number | null },
  ): Promise<void> {
    const sampleCount = scope.wins + scope.losses;
    const rate = scope.wins / sampleCount;
    const isGlobal = scope.domain === null;
    const params: Record<string, unknown> = {
      k: scope.sourceKey,
      r: rate,
      sc: sampleCount,
      w: scope.wins,
      l: scope.losses,
      ls: scope.lastSeenAt,
      ...(isGlobal ? {} : { d: scope.domain }),
    };
    const domainWhere = isGlobal ? 'domain IS NONE' : 'domain = $d';
    await db.query(
      `LET $existing = (SELECT id FROM source_trust
          WHERE sourceKey = $k AND ${domainWhere} LIMIT 1)[0];
       IF $existing IS NONE THEN
         CREATE source_trust CONTENT {
           sourceKey: $k,
           ${isGlobal ? '' : 'domain: $d,'}
           agreementRate: $r,
           sampleCount: $sc,
           winCount: $w,
           lossCount: $l,
           lastSeenAt: $ls,
           lastUpdated: time::now()
         }
       ELSE
         UPDATE $existing.id SET
           agreementRate = $r,
           sampleCount = $sc,
           winCount = $w,
           lossCount = $l,
           lastSeenAt = $ls,
           lastUpdated = time::now()
       END;`,
      params,
    );
    if (scope.prevRate === null || Math.abs(scope.prevRate - rate) > 0.01) {
      await db.query(
        `CREATE source_trust_history CONTENT {
            sourceKey: $k,
            ${isGlobal ? '' : 'domain: $d,'}
            agreementRate: $r,
            sampleCount: $sc
         };`,
        params,
      );
    }
  }

  private async collectCalibrationPairsForTenant(
    companyId: string,
  ): Promise<CalibrationPair[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            confidence: number;
            status: string;
            retractedAt: string | null;
            retractionReason: string | null;
          }>,
        ]
      >(
        `SELECT confidence, status, retractedAt, retractionReason, recordedAt
            FROM knowledge_fact
            WHERE confidence IS NOT NONE
              AND time::now() - recordedAt > 30d
            ORDER BY recordedAt DESC
            LIMIT 5000;`,
      );
      const pairs: CalibrationPair[] = [];
      for (const r of rows ?? []) {
        const conf = clamp01(Number(r.confidence));
        if (!Number.isFinite(conf)) continue;
        const correctness = isCorrect(r) ? 1 : 0;
        pairs.push({ rawConfidence: conf, correctness });
      }
      return pairs;
    });
  }

  private async persistCalibrationMap(map: CalibrationMap): Promise<void> {
    const tenants = this.apiKeys.knownCompanyIds();
    const host = tenants[0];
    if (!host) {
      this.logger.warn(
        'calibration persist skipped — no known tenants to host the row',
      );
      return;
    }
    await this.surreal.withCompany(host, async (db) => {
      const [latest] = await db.query<[Array<{ version: number }>]>(
        `SELECT version FROM calibration_table
            WHERE extractorModel = $m AND promptHash = $p
            ORDER BY version DESC LIMIT 1`,
        { m: this.extractorModel, p: this.bootstrapPromptKey },
      );
      const next =
        Array.isArray(latest) && latest[0]?.version ? latest[0].version + 1 : 2;
      await db.query(
        `CREATE calibration_table CONTENT {
            extractorModel: $m,
            promptHash: $p,
            thresholds: $t,
            values: $v,
            sampleCount: $sc,
            version: $version
         }`,
        {
          m: this.extractorModel,
          p: this.bootstrapPromptKey,
          t: map.thresholds,
          v: map.values,
          sc: map.sampleCount,
          version: next,
        },
      );
    });
  }
}

// ── Pure helpers (exported for unit tests) ─────────────────────────

/**
 * A fact's "correctness" for calibration purposes — see the
 * documented survivorship bias: a never-retracted fact counts as
 * correct (FaithfulRAG weak-supervision recipe).
 */
export function isCorrect(row: {
  status: string;
  retractedAt: string | null;
  retractionReason: string | null;
}): boolean {
  if (row.status === 'active' && row.retractedAt === null) return true;
  if (row.retractionReason === 'superseded') return false;
  if (row.status === 'retracted') return false;
  if (row.status === 'superseded') return false;
  return true;
}

export interface TrustEventRow {
  vertical: string | null;
  recorder: string | null;
  predicate: string;
  status: string;
  recordedAt: string | Date;
  originKey: string | null;
  corroborates: unknown;
}

export interface TrustEvent {
  sourceKey: string;
  domain: string;
  win: number;
  loss: number;
  recordedAt: string | Date;
}

/**
 * Turn raw knowledge_fact rows into per-source {win, loss} events for the
 * nightly source-trust refit.
 *
 * A corroborating row (migration 0047) is independent agreement with a
 * standing fact — evidence of reliability, counted as a win for its source.
 * But corroboration wins are deduped to at most ONE per
 * (sourceKey, domain, origin, incumbent): without this, a source could
 * echo-ingest the same standing fact repeatedly and farm unbounded wins
 * (reputation inflation), since each echo is a fresh corroborating row.
 * 0050 keys independence on ORIGIN; genuinely independent origins (distinct
 * documents corroborating the same incumbent) still each count. Exported so
 * the dedup can be unit-tested without a SurrealDB round-trip.
 */
export function buildTrustEvents(
  rows: ReadonlyArray<TrustEventRow>,
): TrustEvent[] {
  const seenCorroboration = new Set<string>();
  const events: TrustEvent[] = [];
  for (const r of rows) {
    const sourceKey = `${r.vertical}:${r.recorder ?? '_'}`;
    if (r.status === 'corroborating') {
      const dedupKey = `${sourceKey} ${r.predicate} ${
        r.originKey ?? sourceKey
      } ${r.corroborates == null ? '' : String(r.corroborates)}`;
      if (seenCorroboration.has(dedupKey)) continue;
      seenCorroboration.add(dedupKey);
    }
    events.push({
      sourceKey,
      domain: r.predicate,
      win: r.status === 'active' || r.status === 'corroborating' ? 1 : 0,
      loss: r.status === 'superseded' || r.status === 'retracted' ? 1 : 0,
      recordedAt: r.recordedAt,
    });
  }
  return events;
}

export interface FeedbackEventRow {
  vertical: string | null;
  recorder: string | null;
  predicate: string;
  verdict: string;
  createdAt: string | Date;
}

/**
 * Retrieval-feedback verdicts → the same per-source {win, loss} currency
 * the fact-status events use: 'helpful' = win, 'incorrect' = loss.
 * 'not_helpful' rows never reach here (filtered in the query) — an
 * irrelevant retrieval says nothing about the source's reliability.
 * Exported for unit tests, same as buildTrustEvents.
 */
export function buildFeedbackTrustEvents(
  rows: ReadonlyArray<FeedbackEventRow>,
): TrustEvent[] {
  const events: TrustEvent[] = [];
  for (const r of rows) {
    if (r.verdict !== 'helpful' && r.verdict !== 'incorrect') continue;
    events.push({
      sourceKey: `${r.vertical}:${r.recorder ?? '_'}`,
      domain: r.predicate,
      win: r.verdict === 'helpful' ? 1 : 0,
      loss: r.verdict === 'incorrect' ? 1 : 0,
      recordedAt: r.createdAt,
    });
  }
  return events;
}

export interface TrustScope {
  sourceKey: string;
  /** null = the global per-source rate (domain NONE in the DB). */
  domain: string | null;
  wins: number;
  losses: number;
  lastSeenAt: Date;
}

/** Map key for a (sourceKey, domain) scope — NUL can't appear in either. */
export function scopeKeyOf(sourceKey: string, domain: string | null): string {
  return `${sourceKey}\u0000${domain ?? ''}`;
}

/**
 * Roll up per-row {win, loss} tuples into {wins, losses, lastSeenAt} at
 * BOTH reputation grains: (sourceKey, domain) and the global
 * (sourceKey, null). Every row feeds both — the global rate stays exactly
 * the pre-0045 blended number while scoped rows sharpen it per domain.
 * Exported so the unit test can exercise the math without a SurrealDB
 * round-trip.
 */
export function aggregateByScope(
  rows: ReadonlyArray<{
    sourceKey: string;
    domain: string;
    win: number;
    loss: number;
    recordedAt: string | Date;
  }>,
): TrustScope[] {
  const byScope = new Map<string, TrustScope>();
  for (const r of rows) {
    const seenAt = new Date(r.recordedAt);
    for (const domain of [r.domain, null] as Array<string | null>) {
      const key = scopeKeyOf(r.sourceKey, domain);
      const acc =
        byScope.get(key) ??
        ({
          sourceKey: r.sourceKey,
          domain,
          wins: 0,
          losses: 0,
          lastSeenAt: seenAt,
        } satisfies TrustScope);
      acc.wins += r.win;
      acc.losses += r.loss;
      if (seenAt.getTime() > acc.lastSeenAt.getTime()) acc.lastSeenAt = seenAt;
      byScope.set(key, acc);
    }
  }
  return [...byScope.values()];
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
