import type { Registry } from 'prom-client';
import { llmUsageGauge } from './llm-usage-gauge';
import { migrationDriftGauge } from './migration-drift-gauge';

/**
 * Gauges over process-level ledgers, read at scrape time: every SDK call's
 * tokens (llm-usage-gauge.ts) and the tenants whose applied migrations differ
 * from the shipped files (migration-drift-gauge.ts).
 */
export function processGauges(registry: Registry) {
  return {
    llmTokens: llmUsageGauge(registry),
    migrationDrift: migrationDriftGauge(registry),
  };
}
