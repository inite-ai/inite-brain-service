import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  adaptiveAbstainEnabled,
  adaptiveAbstainThreshold,
  adaptiveL3Enabled,
  adaptiveL3EscalateThreshold,
  focusCaptureEnabled,
} from '../common/fovea-flags';
import { SurrealService } from '../db/surreal.service';
import type { SearchHit } from '../search/search.types';
import type { LaneId } from './answer-router';
import {
  buildFocusSignal,
  calibratedConfidence as calibratedConfidenceOf,
  computeReliability,
  fitPerClass,
  queryClassOf,
  rawFocusConfidence,
  type FocusOutcomeSample,
  type FocusSignal,
  type FocusStage,
  type FocusVerdict,
  type PerClassCalibration,
  type ReliabilityReport,
} from './focus-signal';

/** The two capture/calibration populations, in fit order (see FocusStage). */
const FOCUS_STAGES: readonly FocusStage[] = ['verdict', 'preanswer'];

/**
 * SurrealQL predicate selecting a stage's rows. The verdict stage folds in
 * NONE-stage rows (the pre-migration-0095 population, read as 'verdict');
 * the preanswer stage is an exact match. `stage` is a typed union, never
 * user input, so the literal is safe to inline.
 */
function stagePredicate(stage: FocusStage): string {
  return stage === 'verdict' ? "(stage = 'verdict' OR stage IS NONE)" : "stage = 'preanswer'";
}

/**
 * FocusSignalService — capture + fit + measure for the fovea focus signal
 * (Optics-1). Companion to docs/roadmap/fovea-optics-2026-08.md.
 *
 * SERVING-NEUTRAL: `maybeCapture` is a no-op unless FOVEA_FOCUS_CAPTURE is
 * on, and NOTHING on the serving path reads the persisted calibration. The
 * fit + reliability surface (admin-only) is the §3 measurement that runs
 * once labeled samples exist. Persistence follows the calibration_table
 * idiom (versioned rows, thresholds/values arrays, withCompany scope) —
 * this is not a parallel calibration mechanism, it is the per-class focus
 * analogue keyed by queryClass.
 */
@Injectable()
export class FocusSignalService {
  private readonly logger = new Logger(FocusSignalService.name);

  constructor(private readonly surreal: SurrealService) {}

  /** Master flag — delegates to the common-layer reader (engine dirs take
   *  no direct env reads; see fovea-flags.ts / engine-gates S5.2). Read at
   *  call time so the knob is runtime-mutable (config-catalog runtimeMutable). */
  static captureEnabled(): boolean {
    return focusCaptureEnabled();
  }

  /** Optics-2 (§4.1) master flag — delegates to the common-layer reader
   *  (engine dirs take no direct env reads). Read at call time so the knob
   *  is runtime-mutable. Off ⇒ the L3 lane runs its static coverage path. */
  static adaptiveL3Enabled(): boolean {
    return adaptiveL3Enabled();
  }

  /** Optics-2 (§4.1) escalate threshold on calibrated confidence — the
   *  common-layer reader (default 0.5). */
  static adaptiveL3EscalateThreshold(): number {
    return adaptiveL3EscalateThreshold();
  }

  /** Optics §4.2 master flag — delegates to the common-layer reader (engine
   *  dirs take no direct env reads). Read at call time so the knob is
   *  runtime-mutable. Off ⇒ the abstention gate runs its static coverage path. */
  static adaptiveAbstainEnabled(): boolean {
    return adaptiveAbstainEnabled();
  }

  /** Optics §4.2 abstain threshold on calibrated pre-answer confidence — the
   *  common-layer reader (default 0.5). */
  static adaptiveAbstainThreshold(): number {
    return adaptiveAbstainThreshold();
  }

  /**
   * Record one (signal, outcome=unlabeled) sample at a synthesize decision
   * point. `stage` selects the population (default 'verdict' — Optics-1's
   * existing verdict-point call is unchanged); the Optics §4.2 pre-answer
   * capture passes 'preanswer' with verifierVerdict='none'. Guarded FIRST by
   * the master flag: when off this returns before touching `results` or the
   * DB — zero hot-path cost, byte-identical serving. Never throws into the
   * caller: a capture failure is logged and swallowed so the synthesize
   * response is unaffected.
   */
  async maybeCapture(
    companyId: string,
    args: { results: readonly SearchHit[]; verdict: FocusVerdict; lane: LaneId | null },
    stage: FocusStage = 'verdict',
  ): Promise<void> {
    if (!FocusSignalService.captureEnabled()) return;
    try {
      const factScores: number[] = [];
      for (const hit of args.results) {
        for (const f of hit.facts) factScores.push(f.score);
      }
      const signal = buildFocusSignal({
        queryClass: queryClassOf(args.lane),
        factScores,
        verifierVerdict: args.verdict,
      });
      await this.insertSample(companyId, signal, stage);
    } catch (e) {
      this.logger.warn(`focus-signal capture failed (${(e as Error).message}); ignored`);
    }
  }

  private async insertSample(
    companyId: string,
    sig: FocusSignal,
    stage: FocusStage = 'verdict',
  ): Promise<void> {
    await this.surreal.withCompany(companyId, async (db) => {
      await db.query(
        `CREATE focus_signal_sample CONTENT {
            companyId: $companyId,
            sampleId: $sampleId,
            queryClass: $queryClass,
            stage: $stage,
            topScore: $topScore,
            coverageScore: $coverageScore,
            verifierVerdict: $verifierVerdict,
            retrievalGap: $retrievalGap,
            rawConfidence: $rawConfidence,
            correct: NONE
         }`,
        {
          companyId,
          sampleId: randomUUID(),
          queryClass: sig.queryClass,
          stage,
          topScore: sig.topScore,
          coverageScore: sig.coverageScore,
          verifierVerdict: sig.verifierVerdict,
          retrievalGap: sig.retrievalGap,
          rawConfidence: rawFocusConfidence(sig),
        },
      );
    });
  }

  // ── Admin surface: backfill labels, fit, measure ──────────────────

  /**
   * Backfill outcome labels by sampleId (the eval-harness path — the
   * synthesize DTO carries no expected answer, so correctness is set here
   * after the harness scores the answer). Returns the number of rows
   * updated.
   */
  async labelSamples(
    companyId: string,
    labels: ReadonlyArray<{ sampleId: string; correct: 0 | 1 }>,
  ): Promise<number> {
    if (labels.length === 0) return 0;
    return this.surreal.withCompany(companyId, async (db) => {
      // Two statements: the FOR loop applies each label, the trailing SELECT
      // reports which of the requested ids are now labeled. db.query returns
      // one result per statement — the SELECT's rows are the last element.
      const results = await db.query(
        `FOR $l IN $labels {
            UPDATE focus_signal_sample SET correct = $l.correct
              WHERE sampleId = $l.sampleId;
         };
         SELECT sampleId FROM focus_signal_sample
            WHERE sampleId IN $ids AND correct IS NOT NONE;`,
        { labels, ids: labels.map((l) => l.sampleId) },
      );
      const rows = (results as unknown[])[results.length - 1];
      return Array.isArray(rows) ? rows.length : 0;
    });
  }

  /** Load every LABELED sample of one STAGE for a tenant as calibration
   *  input. The two stages are NEVER pooled (fit-shape = apply-shape, §4.2):
   *  the verdict stage folds in NONE-stage rows (pre-0095, read as verdict),
   *  the preanswer stage is exact. */
  private async loadLabeledSamples(
    companyId: string,
    stage: FocusStage,
  ): Promise<FocusOutcomeSample[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            queryClass: string;
            topScore: number;
            coverageScore: number;
            verifierVerdict: string;
            retrievalGap: number;
            correct: number;
          }>,
        ]
      >(
        `SELECT queryClass, topScore, coverageScore, verifierVerdict,
                retrievalGap, correct
            FROM focus_signal_sample
            WHERE correct IS NOT NONE AND ${stagePredicate(stage)}
            LIMIT 100000`,
      );
      return (rows ?? []).map((r) => ({
        queryClass: r.queryClass,
        topScore: r.topScore,
        coverageScore: r.coverageScore,
        verifierVerdict: normalizeVerdict(r.verifierVerdict),
        retrievalGap: r.retrievalGap,
        correct: r.correct === 1 ? 1 : 0,
      }));
    });
  }

  /**
   * Fit per-class isotonic calibration and persist one versioned row per
   * (class, stage) (calibration_table idiom). BOTH stages are fit
   * SEPARATELY — never pooled (§4.2) — so the verdict-stage calibrator
   * (Optics-2 L3) and the pre-answer calibrator (Optics §4.2 abstention) are
   * independent. A stage with no labeled samples is skipped (no bootstrap
   * row). Returns a summary tagged by stage.
   */
  async fitAndPersist(companyId: string): Promise<{
    sampleCount: number;
    classes: Array<{ queryClass: string; bins: number; sampleCount: number; stage: FocusStage }>;
  }> {
    let total = 0;
    const classes: Array<{
      queryClass: string;
      bins: number;
      sampleCount: number;
      stage: FocusStage;
    }> = [];
    for (const stage of FOCUS_STAGES) {
      const samples = await this.loadLabeledSamples(companyId, stage);
      total += samples.length;
      if (samples.length === 0) continue;
      const cal = fitPerClass(samples);
      const persisted = await this.persistCalibration(companyId, cal, stage);
      for (const p of persisted) classes.push({ ...p, stage });
    }
    return { sampleCount: total, classes };
  }

  private async persistCalibration(
    companyId: string,
    cal: PerClassCalibration,
    stage: FocusStage,
  ): Promise<Array<{ queryClass: string; bins: number; sampleCount: number }>> {
    return this.surreal.withCompany(companyId, async (db) => {
      const out: Array<{ queryClass: string; bins: number; sampleCount: number }> = [];
      for (const [queryClass, map] of Object.entries(cal)) {
        // Version counter is per (queryClass, stage) — a verdict 'default'
        // and a preanswer 'default' map advance independently.
        const [latest] = await db.query<[Array<{ version: number }>]>(
          `SELECT version FROM focus_calibration
              WHERE queryClass = $q AND stage = $stage ORDER BY version DESC LIMIT 1`,
          { q: queryClass, stage },
        );
        const next = Array.isArray(latest) && latest[0]?.version ? latest[0].version + 1 : 1;
        await db.query(
          `CREATE focus_calibration CONTENT {
              queryClass: $q,
              stage: $stage,
              thresholds: $t,
              values: $v,
              sampleCount: $sc,
              version: $version
           }`,
          {
            q: queryClass,
            stage,
            t: map.thresholds,
            v: map.values,
            sc: map.sampleCount,
            version: next,
          },
        );
        out.push({ queryClass, bins: map.thresholds.length, sampleCount: map.sampleCount });
      }
      return out;
    });
  }

  /**
   * Load the latest persisted per-class calibration for one STAGE (max
   * version per class). `stage` defaults to 'verdict' so Optics-2's stage-
   * less `loadCalibration(companyId)` call resolves the verdict calibrator
   * byte-identically; NONE-stage rows (pre-0095) are read as verdict.
   */
  async loadCalibration(
    companyId: string,
    stage: FocusStage = 'verdict',
  ): Promise<PerClassCalibration> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            queryClass: string;
            thresholds: number[];
            values: number[];
            sampleCount: number;
            version: number;
          }>,
        ]
      >(
        `SELECT queryClass, thresholds, values, sampleCount, version
            FROM focus_calibration
            WHERE ${stagePredicate(stage)}
            ORDER BY version DESC`,
      );
      const cal: PerClassCalibration = {};
      for (const r of rows ?? []) {
        // First row per class wins (rows are version-desc ordered).
        if (cal[r.queryClass]) continue;
        if (!Array.isArray(r.thresholds) || !Array.isArray(r.values)) continue;
        cal[r.queryClass] = {
          thresholds: r.thresholds,
          values: r.values,
          sampleCount: r.sampleCount,
        };
      }
      return cal;
    });
  }

  /**
   * The §3 reliability report (ECE + diagram, global and per-class) over the
   * labeled samples of one STAGE. This is the honest gate: ship no adaptive
   * optic whose driving signal hasn't passed it. `stage` defaults to
   * 'verdict' so the admin surface is byte-identical; measure the pre-answer
   * signal (Optics §4.2) by passing 'preanswer'.
   */
  async reliability(
    companyId: string,
    bins = 10,
    stage: FocusStage = 'verdict',
  ): Promise<ReliabilityReport & { sampleCount: number }> {
    const samples = await this.loadLabeledSamples(companyId, stage);
    return { ...computeReliability(samples, bins), sampleCount: samples.length };
  }

  /** Apply the latest persisted calibration to a live signal — provided for
   *  Optics-2/3 (NOT called on the serving path in this PR). */
  async calibrate(companyId: string, sig: FocusSignal): Promise<number> {
    const cal = await this.loadCalibration(companyId);
    return calibratedConfidenceOf(cal, sig);
  }

  /** List recent samples (id + class + label state) so the harness can
   *  discover sampleIds to backfill. */
  async listSamples(
    companyId: string,
    opts: { limit?: number; onlyUnlabeled?: boolean } = {},
  ): Promise<
    Array<{
      sampleId: string;
      queryClass: string;
      correct: number | null;
      createdAt: string | null;
    }>
  > {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            sampleId: string;
            queryClass: string;
            correct: number | null;
            createdAt: string | null;
          }>,
        ]
      >(
        `SELECT sampleId, queryClass, correct, createdAt
            FROM focus_signal_sample
            ${opts.onlyUnlabeled ? 'WHERE correct IS NONE' : ''}
            ORDER BY createdAt DESC
            LIMIT ${limit}`,
      );
      return (rows ?? []).map((r) => ({
        sampleId: r.sampleId,
        queryClass: r.queryClass,
        correct: r.correct ?? null,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      }));
    });
  }
}

/** Coerce a stored verdict string back into the FocusVerdict union. */
function normalizeVerdict(v: string): FocusVerdict {
  return v === 'supported' || v === 'partial' || v === 'unsupported' ? v : 'none';
}
