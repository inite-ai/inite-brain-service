import { Injectable, Logger } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MetricsService } from '../metrics/metrics.service';
import { plausibilityCheckEnabled } from '../common/fovea-flags';
import { type PromMetricJson } from './metrics-reader';
import { buildMriReport, type BuildMriReportOptions } from './mri-collectors';
import { SnapshotWindow, windowedReader, DEFAULT_MRI_WINDOW_MS } from './mri-window';
import { loadSuiteLedger, DEFAULT_LEDGER_PATH } from './suite-status';
import type { MriReport } from './mri.types';

/**
 * MriService — generates the Memory Reliability Index report from LIVE sources
 * and persists the latest snapshot so the admin endpoint can serve it.
 *
 * READ-ONLY with respect to serving: it reads the Prometheus registry (a
 * snapshot of counters/histograms the pipeline already emits) and the committed
 * suite-status ledger. It never touches the answer path — no lane, no verdict,
 * no synthesize hook.
 */
@Injectable()
export class MriService {
  private readonly logger = new Logger(MriService.name);
  private readonly ledgerPath = DEFAULT_LEDGER_PATH;
  private readonly snapshotPath = join('var', 'mri', 'latest.json');
  /** Rolling snapshot ring: deltas process-lifetime counters against a baseline
   *  so the LIVE rate cells cover a bounded recent window, not the whole process
   *  lifetime (R3 P1). Read-only — snapshots the registry the pipeline emits. */
  private readonly window = new SnapshotWindow(DEFAULT_MRI_WINDOW_MS);

  constructor(private readonly metrics: MetricsService) {}

  /** Build a fresh report from live telemetry + the ledger, persist, and return.
   *  Windows the counters against a rolling baseline so "per query" rates are
   *  bounded to a recent window. Resolves the premise-awareness DEFENSE state
   *  (FOVEA_PLAUSIBILITY_CHECK) via the common-layer flag reader — a read-only
   *  config read, no serving-path touch — unless the caller pinned it (tests). */
  async generate(options: BuildMriReportOptions = {}): Promise<MriReport> {
    const now = options.now ?? new Date();
    const json = (await this.metrics.registry.getMetricsAsJSON()) as unknown as PromMetricJson[];
    const win = this.window.observe(json, now);
    const reader = windowedReader(json, win.baseline.metrics);
    const ledger = loadSuiteLedger(this.ledgerPath);
    const report = buildMriReport(reader, ledger, {
      ...options,
      now,
      plausibilityCheckEnabled: options.plausibilityCheckEnabled ?? plausibilityCheckEnabled(),
      window: { startedAt: win.startedAt, endedAt: win.endedAt, windowMs: win.windowMs },
    });
    this.persist(report);
    return report;
  }

  /** Best-effort durable snapshot (var/ is a runtime artifact, like eval reports). */
  private persist(report: MriReport): void {
    try {
      mkdirSync(dirname(this.snapshotPath), { recursive: true });
      writeFileSync(this.snapshotPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    } catch (err) {
      this.logger.warn(`MRI snapshot persist failed: ${(err as Error).message}`);
    }
  }
}
