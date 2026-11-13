import type { Registry } from 'prom-client';
import { dataMigrationRemainingGauge } from './data-migration-remaining-gauge';
import { llmUsageGauge } from './llm-usage-gauge';
import { migrationBlockedGauge } from './migration-blocked-gauge';
import { migrationDriftGauge } from './migration-drift-gauge';
import { migrationFailuresCounter } from './migration-failure-metrics';

/**
 * Gauges over process-level ledgers, read at scrape time: every SDK call's
 * tokens (llm-usage-gauge.ts), the tenants whose applied migrations differ
 * from the shipped files (migration-drift-gauge.ts), the tenants whose
 * next migration fails to apply (migration-blocked-gauge.ts), failed
 * schema applies (migration-failure-metrics.ts), and the rows each data
 * migration still has to fix (data-migration-remaining-gauge.ts).
 */
export function processGauges(registry: Registry) {
  return {
    llmTokens: llmUsageGauge(registry),
    migrationDrift: migrationDriftGauge(registry),
    migrationFailures: migrationFailuresCounter(registry),
    migrationBlocked: migrationBlockedGauge(registry),
    dataMigrationRemaining: dataMigrationRemainingGauge(registry),
  };
}
