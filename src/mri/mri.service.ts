import { Injectable, Logger } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MetricsService } from '../metrics/metrics.service';
import { plausibilityCheckEnabled } from '../common/fovea-flags';
import { readerFromPromJson, type PromMetricJson } from './metrics-reader';
import { buildMriReport, type BuildMriReportOptions } from './mri-collectors';
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

  constructor(private readonly metrics: MetricsService) {}

  /** Build a fresh report from live telemetry + the ledger, persist, and return.
   *  Resolves the premise-awareness DEFENSE state (FOVEA_PLAUSIBILITY_CHECK) via
   *  the common-layer flag reader — a read-only config read, no serving-path
   *  touch — unless the caller pinned it explicitly (tests). */
  async generate(options: BuildMriReportOptions = {}): Promise<MriReport> {
    const json = (await this.metrics.registry.getMetricsAsJSON()) as unknown as PromMetricJson[];
    const reader = readerFromPromJson(json);
    const ledger = loadSuiteLedger(this.ledgerPath);
    const report = buildMriReport(reader, ledger, {
      ...options,
      plausibilityCheckEnabled: options.plausibilityCheckEnabled ?? plausibilityCheckEnabled(),
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
