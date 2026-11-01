import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId, Surreal } from 'surrealdb';
import { ApiKeyService } from '../../auth/api-key.service';
import { SurrealService } from '../../db/surreal.service';
import { fitIsotonic, type CalibrationPair, type CalibrationMap } from './isotonic';
import {
  CalibrationService,
  BOOTSTRAP_PROMPT_HASH,
  BOOTSTRAP_PROMPT_KEY,
} from './calibration.service';
import { DEFAULT_CHAT_MODEL } from '../openai-client';
import { CORE_PREDICATES } from '../predicate-registry-internals/core-seed';
import { discoverTruth, type FactTruth } from './truth-discovery';
import {
  TRUTH_METHOD,
  TRUTH_MODEL,
  TRUTH_PRIOR_STRENGTH,
  sourceKeyOf,
  toTruthAnchors,
  toTruthFacts,
  type TruthFactRow,
  type TruthFeedbackRow,
} from './truth-discovery-input';

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
  private readonly extractorModel = process.env.OPENAI_CHAT_MODEL ?? DEFAULT_CHAT_MODEL;
  private readonly bootstrapPromptKey = BOOTSTRAP_PROMPT_HASH;

  constructor(
    private readonly surreal: SurrealService,
    private readonly calibration: CalibrationService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async refitSourceTrust(onProgress?: RefitProgress): Promise<RefitOutcome> {
    const tenants = this.apiKeys.fanOutRoster();
    let upserted = 0;
    for (const companyId of tenants) {
      try {
        upserted += await this.refitSourceTrustForTenant(companyId);
        onProgress?.({ currentTenant: companyId, upserted });
      } catch (e) {
        this.logger.warn(`source-trust refit failed for ${companyId}: ${(e as Error).message}`);
      }
    }
    this.logger.log(
      `source-trust refit done — ${upserted} row(s) upserted across ${tenants.length} tenant(s)`,
    );
    return { count: upserted, result: { upserted, tenants: tenants.length } };
  }

  async refitCalibration(onProgress?: RefitProgress): Promise<RefitOutcome> {
    const tenants = this.apiKeys.fanOutRoster();
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
      createdAt?: string | undefined;
    }>
  > {
    const host = this.apiKeys.hostTenant();
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
   * Fit truth discovery for one tenant (#847) and write what it learned:
   * per-source accuracy at both grains ((sourceKey, domain) and the
   * source across domains) into source_trust, and the posterior of each
   * contested fact's value onto the fact. Replaces the win/loss tally,
   * which scored every valid-time succession as a loss. Rows of sources
   * that took part in no contest this run are removed: there is no
   * evidence for them, and fn::source_trust_scoped then falls back to 0.5.
   * Rate movements (or first sightings) still append to
   * source_trust_history.
   */
  private async refitSourceTrustForTenant(companyId: string): Promise<number> {
    // Opt-in recency window (CALIBRATION_REFIT_WINDOW_DAYS): bounds the
    // scans by recordedAt/createdAt instead of relying on the fixed
    // LIMIT 50000, which already acts as a silent sliding window on
    // tenants past 50k rows. Unset = no window.
    const windowDays = parseInt(process.env.CALIBRATION_REFIT_WINDOW_DAYS ?? '0', 10);
    const since = windowDays > 0 ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000) : null;
    return this.surreal.withCompany(companyId, async (db) => {
      const [[runStart], [rows], [feedbackRows], [predicates], [declaredRows]] = await Promise.all([
        db.query<[unknown]>('RETURN time::now();'),
        db.query<[Array<TruthFactRow & { recordedAt: string | Date }>]>(
          `SELECT id, entityId, predicate, predicateAlias, object, validFrom, validUntil, status,
                  userId, scope, derivedVersion, recordedAt,
                  corroborates.validUntil AS corroboratedUntil,
                  source.vertical AS vertical,
                  source.recorder AS recorder,
                  source.originKey AS originKey
             FROM knowledge_fact
            WHERE source.vertical IS NOT NONE
              ${since ? 'AND recordedAt > $since' : ''}
            ORDER BY recordedAt DESC
            LIMIT 50000;`,
          since ? { since } : undefined,
        ),
        db.query<[TruthFeedbackRow[]]>(
          `SELECT factId, actor, verdict, createdAt
             FROM retrieval_feedback
            WHERE verdict != 'not_helpful'
              ${since ? 'AND createdAt > $since' : ''}
            ORDER BY createdAt DESC
            LIMIT 50000;`,
          since ? { since } : undefined,
        ),
        db.query<[Array<{ predicateId: string; semantics: string }>]>(
          `SELECT predicateId, semantics FROM knowledge_predicate;`,
        ),
        db.query<[Array<{ sourceKey: string; authLevel: number }>]>(
          `SELECT sourceKey, authLevel FROM source_registry WHERE authLevel > 0;`,
        ),
      ]);
      const singleValued = singleValuedPredicates(predicates ?? []);
      const facts = toTruthFacts(rows ?? [], singleValued);
      const anchors = toTruthAnchors(feedbackRows ?? [], facts);
      const declared = new Map((declaredRows ?? []).map((r) => [r.sourceKey, r.authLevel]));
      const fit = discoverTruth(facts, anchors, {
        priorStrength: TRUTH_PRIOR_STRENGTH,
        declared,
      });

      const lastSeen = new Map<string, Date>();
      for (const r of rows ?? []) {
        const key = sourceKeyOf(r);
        const at = new Date(r.recordedAt);
        const seen = lastSeen.get(key);
        if (!seen || seen.getTime() < at.getTime()) lastSeen.set(key, at);
      }

      const [existingRows] = await db.query<
        [Array<{ sourceKey: string; domain: string | null; agreementRate: number }>]
      >(`SELECT sourceKey, domain, agreementRate FROM source_trust;`);
      const prior = new Map<string, number>();
      for (const r of existingRows ?? []) {
        prior.set(scopeKeyOf(r.sourceKey, r.domain ?? null), r.agreementRate);
      }
      const scopes = fit.sources.map((s) => {
        const prevRate = prior.get(scopeKeyOf(s.sourceKey, s.domain)) ?? null;
        return {
          k: s.sourceKey,
          // JS null coalesces to NONE inside the FOR body (`?? NONE`).
          d: s.domain,
          r: s.accuracy,
          sc: s.votes,
          w: Math.round(s.correct),
          l: s.votes - Math.round(s.correct),
          ls: lastSeen.get(s.sourceKey) ?? null,
          hist: prevRate === null || Math.abs(prevRate - s.accuracy) > 0.01,
        };
      });
      await this.upsertTrustScopes(db, scopes);
      await db.query(
        `LET $stale = (SELECT VALUE id FROM source_trust WHERE lastUpdated < $start);
         DELETE $stale;`,
        { start: runStart },
      );
      await this.writeFactTruth(db, fit.facts);
      return scopes.length;
    });
  }

  /**
   * Stamp `truth` on every fact whose value is contested (two or more
   * claims), and clear it from facts no longer contested. A one-claim
   * contest (an uncontested value several origins agree on) informs the
   * source accuracies but has nothing to weigh, so it gets no stamp.
   */
  private async writeFactTruth(db: Surreal, facts: FactTruth[]): Promise<void> {
    const contested = facts
      .filter((f) => f.claims > 1)
      .map((f) => ({ id: new StringRecordId(f.factId), p: f.posterior, c: f.claims }));
    const CHUNK = 500;
    for (let i = 0; i < contested.length; i += CHUNK) {
      await db.query(
        `FOR $t IN $rows {
           UPDATE $t.id SET truth = {
             posterior: $t.p, claims: $t.c, model: $model, computedAt: time::now()
           };
         };`,
        { rows: contested.slice(i, i + CHUNK), model: TRUTH_MODEL },
      );
    }
    // Compared as strings: a record id and a bound StringRecordId do not
    // compare equal under NOT IN, which would clear every stamp.
    const keep = new Set(contested.map((t) => String(t.id)));
    const [stamped] = await db.query<[unknown[]]>(
      'SELECT VALUE id FROM knowledge_fact WHERE truth IS NOT NONE;',
    );
    const gone = (stamped ?? []).filter((id) => !keep.has(String(id)));
    for (let i = 0; i < gone.length; i += CHUNK) {
      await db.query('UPDATE $ids SET truth = NONE;', { ids: gone.slice(i, i + CHUNK) });
    }
  }

  /**
   * UPSERT the (sourceKey, domain) trust rows + append history where the
   * rate moved (or the scope is first seen), batched into one FOR-loop
   * statement per chunk. The per-scope form issued 1-2 serial round
   * trips × (sources × predicates × 2 grains) — ~10k RTTs per tenant per
   * night on a busy corpus. Side-effect-only FOR body (no cross-iteration
   * accumulation — the SurrealQL limitation doesn't apply).
   */
  private async upsertTrustScopes(
    db: Surreal,
    scopes: Array<{
      k: string;
      d: string | null;
      r: number;
      sc: number;
      w: number;
      l: number;
      ls: Date | null;
      hist: boolean;
    }>,
  ): Promise<void> {
    const CHUNK = 500;
    for (let i = 0; i < scopes.length; i += CHUNK) {
      const chunk = scopes.slice(i, i + CHUNK);
      await db.query(
        `FOR $s IN $scopes {
           LET $d = $s.d ?? NONE;
           LET $existing = (SELECT id FROM source_trust
              WHERE sourceKey = $s.k
                AND ((domain IS NONE AND $d IS NONE) OR domain = $d)
              LIMIT 1)[0];
           IF $existing IS NONE THEN
             CREATE source_trust CONTENT {
               sourceKey: $s.k,
               domain: $d,
               agreementRate: $s.r,
               sampleCount: $s.sc,
               winCount: $s.w,
               lossCount: $s.l,
               lastSeenAt: $s.ls,
               method: $method,
               lastUpdated: time::now()
             }
           ELSE
             UPDATE $existing.id SET
               agreementRate = $s.r,
               sampleCount = $s.sc,
               winCount = $s.w,
               lossCount = $s.l,
               lastSeenAt = $s.ls,
               method = $method,
               lastUpdated = time::now()
           END;
           IF $s.hist THEN
             CREATE source_trust_history CONTENT {
               sourceKey: $s.k,
               domain: $d,
               agreementRate: $s.r,
               sampleCount: $s.sc
             }
           END;
         };`,
        { scopes: chunk, method: TRUTH_METHOD },
      );
    }
  }

  private async collectCalibrationPairsForTenant(companyId: string): Promise<CalibrationPair[]> {
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
    const host = this.apiKeys.hostTenant();
    if (!host) {
      this.logger.warn('calibration persist skipped — no known tenants to host the row');
      return;
    }
    await this.surreal.withCompany(host, async (db) => {
      const [latest] = await db.query<[Array<{ version: number }>]>(
        `SELECT version FROM calibration_table
            WHERE extractorModel = $m AND promptHash = $p
            ORDER BY version DESC LIMIT 1`,
        { m: this.extractorModel, p: this.bootstrapPromptKey },
      );
      const next = Array.isArray(latest) && latest[0]?.version ? latest[0].version + 1 : 2;
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

/**
 * Predicates whose slot holds one value at a time. The tenant's registry
 * rows decide; a core predicate the registry has not seeded into this
 * tenant yet (it seeds on first read) answers from the code seed.
 */
function singleValuedPredicates(
  rows: ReadonlyArray<{ predicateId: string; semantics: string }>,
): Set<string> {
  const semantics = new Map(CORE_PREDICATES.map((p) => [p.predicateId, p.semantics as string]));
  for (const r of rows) semantics.set(r.predicateId, r.semantics);
  return new Set([...semantics].filter(([, s]) => s !== 'append_only').map(([id]) => id));
}

/** Map key for a (sourceKey, domain) scope — NUL can't appear in either. */
export function scopeKeyOf(sourceKey: string, domain: string | null): string {
  return `${sourceKey}\u0000${domain ?? ''}`;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
