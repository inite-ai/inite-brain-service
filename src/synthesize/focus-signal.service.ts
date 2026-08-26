import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  adaptiveAbstainEnabled,
  adaptiveAbstainThreshold,
  adaptiveL3Enabled,
  adaptiveL3EscalateThreshold,
  focusCaptureEnabled,
  multilingualCalibrationEnabled,
} from '../common/fovea-flags';
import { SurrealService } from '../db/surreal.service';
import { detectLanguage } from '../ai/locale/language-detector';
import type { SearchHit } from '../search/search.types';
import type { LaneId } from './answer-router';
import {
  buildFocusSignal,
  calibratedConfidence as calibratedConfidenceOf,
  calibrationKey,
  computeReliability,
  fitPerClass,
  parseCalibrationKey,
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
 * Build the WHERE fragment + params that select EXACTLY one calibration key's
 * (queryClass, language, script) tuple — an absent dimension matches `IS NONE`
 * so a bare per-class row is never confused with a (class × language) row when
 * bumping the version counter (Tier 5). queryClass is a typed LaneId/'default';
 * language/script are ISO codes — all inlined via bound params.
 */
function calibrationKeyPredicate(parts: {
  queryClass: string;
  language?: string | undefined;
  script?: string | undefined;
}): {
  where: string;
  params: Record<string, unknown>;
} {
  const clauses = ['queryClass = $q'];
  const params: Record<string, unknown> = { q: parts.queryClass };
  if (parts.language) {
    clauses.push('language = $language');
    params.language = parts.language;
  } else {
    clauses.push('language IS NONE');
  }
  if (parts.script) {
    clauses.push('script = $script');
    params.script = parts.script;
  } else {
    clauses.push('script IS NONE');
  }
  return { where: clauses.join(' AND '), params };
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
    args: {
      results: readonly SearchHit[];
      verdict: FocusVerdict;
      lane: LaneId | null;
      query?: string;
      /**
       * 0119 join key: the request's primary decision id, threaded by
       * synthesize ONLY under OUTCOME_DECISION_CAPTURE. Absent (the
       * default, and always when that flag is off) ⇒ the CREATE is
       * byte-identical to pre-0119 — 0094's fit/measure surface stays
       * the sole consumer of samples; new rows merely gain the column.
       */
      decisionId?: string | undefined;
    },
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
      // Tier 5 (MULTILINGUAL_CALIBRATION): stamp the detected QUERY language +
      // script so the hierarchical calibrator can key on them. Detected with
      // attribution OFF so the bucket label is deterministic and independent
      // of MULTILINGUAL_LANG_ATTRIBUTION; 'und' leaves the pair unset (the
      // sample stays in the global per-class pool). Off ⇒ never stamped, so
      // every sample is language-NONE and the fit/apply path is byte-identical.
      if (multilingualCalibrationEnabled() && args.query) {
        const det = detectLanguage(args.query, false);
        if (det.language !== 'und') {
          signal.language = det.language;
          signal.script = det.script;
        }
      }
      await this.insertSample(companyId, { sig: signal, stage, decisionId: args.decisionId });
    } catch (e) {
      this.logger.warn(`focus-signal capture failed (${(e as Error).message}); ignored`);
    }
  }

  private async insertSample(
    companyId: string,
    args: { sig: FocusSignal; stage: FocusStage; decisionId?: string | undefined },
  ): Promise<void> {
    const { sig, stage, decisionId } = args;
    await this.surreal.withCompany(companyId, async (db) => {
      // Tier 5 language/script columns are appended to the CONTENT only when
      // detected — an omitted optional field stays NONE (not NULL), so
      // `language IS NONE` still selects the global per-class pool. Off ⇒ the
      // clause is empty and the insert is byte-identical to pre-Tier-5.
      // The 0119 decisionId join key follows the same appended-only idiom.
      const langFields =
        (sig.language ? ', language: $language' : '') + (sig.script ? ', script: $script' : '');
      const decisionField = decisionId ? ', decisionId: $decisionId' : '';
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
            correct: NONE${langFields}${decisionField}
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
          ...(sig.language ? { language: sig.language } : {}),
          ...(sig.script ? { script: sig.script } : {}),
          ...(decisionId ? { decisionId } : {}),
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
            language: string | null;
            script: string | null;
          }>,
        ]
      >(
        `SELECT queryClass, topScore, coverageScore, verifierVerdict,
                retrievalGap, correct, language, script
            FROM focus_signal_sample
            WHERE correct IS NOT NONE AND ${stagePredicate(stage)}
            LIMIT 100000`,
      );
      // language/script are carried through (NONE ⇒ global pool); fitPerClass
      // only groups on them when byLanguage is on (Tier 5), so loading them
      // unconditionally is flag-agnostic and harmless when off.
      return (rows ?? []).map((r) => ({
        queryClass: r.queryClass,
        topScore: r.topScore,
        coverageScore: r.coverageScore,
        verifierVerdict: normalizeVerdict(r.verifierVerdict),
        retrievalGap: r.retrievalGap,
        correct: r.correct === 1 ? 1 : 0,
        ...(r.language ? { language: r.language } : {}),
        ...(r.script ? { script: r.script } : {}),
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
    const byLanguage = multilingualCalibrationEnabled();
    for (const stage of FOCUS_STAGES) {
      const samples = await this.loadLabeledSamples(companyId, stage);
      total += samples.length;
      if (samples.length === 0) continue;
      const cal = fitPerClass(samples, { byLanguage });
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
      for (const [key, map] of Object.entries(cal)) {
        // Decode the calibration key back into its columns (Tier 5): a bare
        // key → { queryClass } (language/script NONE, byte-identical to
        // pre-0103); a hierarchical key → the (class × language|script) tuple.
        const parts = parseCalibrationKey(key);
        // Version counter is per (queryClass, language, script, stage) — a
        // (class × ru), a (class × Cyrl) and the global (class) map each
        // advance independently, as do the verdict/preanswer stages.
        const keyPred = calibrationKeyPredicate(parts);
        const [latest] = await db.query<[Array<{ version: number }>]>(
          `SELECT version FROM focus_calibration
              WHERE ${keyPred.where} AND stage = $stage ORDER BY version DESC LIMIT 1`,
          { ...keyPred.params, stage },
        );
        const next = Array.isArray(latest) && latest[0]?.version ? latest[0].version + 1 : 1;
        // Optional columns appended only when set — an omitted one stays NONE,
        // so a bare per-class row is byte-identical to pre-0103.
        const langFields =
          (parts.language ? ', language: $language' : '') +
          (parts.script ? ', script: $script' : '');
        await db.query(
          `CREATE focus_calibration CONTENT {
              queryClass: $q,
              stage: $stage,
              thresholds: $t,
              values: $v,
              sampleCount: $sc,
              version: $version${langFields}
           }`,
          {
            q: parts.queryClass,
            stage,
            t: map.thresholds,
            v: map.values,
            sc: map.sampleCount,
            version: next,
            ...(parts.language ? { language: parts.language } : {}),
            ...(parts.script ? { script: parts.script } : {}),
          },
        );
        out.push({ queryClass: key, bins: map.thresholds.length, sampleCount: map.sampleCount });
      }
      return out;
    });
  }

  /**
   * Load the latest persisted per-class calibration for one STAGE (max
   * version per key). `stage` defaults to 'verdict' so Optics-2's stage-less
   * `loadCalibration(companyId)` call resolves the verdict calibrator
   * byte-identically; NONE-stage rows (pre-0095) are read as verdict.
   *
   * Tier 5 (MULTILINGUAL_CALIBRATION): when the flag is on, the (class ×
   * language) and (class × script) rows are ALSO loaded and re-keyed with
   * `calibrationKey`, so the hierarchical lookup in `calibratedConfidence`
   * can resolve them. When OFF the query adds `language IS NONE AND script IS
   * NONE`, selecting ONLY the global per-class rows (every pre-0103 row, plus
   * any bare row a later fit wrote) — byte-identical to the pre-Tier-5 load.
   */
  async loadCalibration(
    companyId: string,
    stage: FocusStage = 'verdict',
  ): Promise<PerClassCalibration> {
    const byLanguage = multilingualCalibrationEnabled();
    return this.surreal.withCompany(companyId, async (db) => {
      const langClause = byLanguage ? '' : ' AND language IS NONE AND script IS NONE';
      const [rows] = await db.query<
        [
          Array<{
            queryClass: string;
            thresholds: number[];
            values: number[];
            sampleCount: number;
            version: number;
            language: string | null;
            script: string | null;
          }>,
        ]
      >(
        `SELECT queryClass, thresholds, values, sampleCount, version, language, script
            FROM focus_calibration
            WHERE ${stagePredicate(stage)}${langClause}
            ORDER BY version DESC`,
      );
      const cal: PerClassCalibration = {};
      for (const r of rows ?? []) {
        // Re-key on the full (class, language, script) tuple; a bare row
        // yields the plain queryClass key. First row per key wins (rows are
        // version-desc ordered).
        const key = calibrationKey({
          queryClass: r.queryClass,
          ...(r.language ? { language: r.language } : {}),
          ...(r.script ? { script: r.script } : {}),
        });
        if (cal[key]) continue;
        if (!Array.isArray(r.thresholds) || !Array.isArray(r.values)) continue;
        cal[key] = {
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
   *  Optics-2/3 (NOT called on the serving path in this PR). Threads the Tier 5
   *  hierarchy flag so the (class × language|script) lookup matches the load. */
  async calibrate(companyId: string, sig: FocusSignal): Promise<number> {
    const byLanguage = multilingualCalibrationEnabled();
    const cal = await this.loadCalibration(companyId);
    return calibratedConfidenceOf(cal, sig, { byLanguage });
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
