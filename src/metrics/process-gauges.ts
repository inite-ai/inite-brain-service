import type { Registry } from 'prom-client';
import { llmUsageGauge } from './llm-usage-gauge';
import { migrationBlockedGauge } from './migration-blocked-gauge';
import { migrationDriftGauge } from './migration-drift-gauge';

/**
 * Gauges over process-level ledgers, read at scrape time: every SDK call's
 * tokens (llm-usage-gauge.ts) and the tenants whose applied migrations differ
 * from the shipped files (migration-drift-gauge.ts), and the tenants whose
 * next migration fails to apply (migration-blocked-gauge.ts).
 */
export function processGauges(registry: Registry) {
  return {
    llmTokens: llmUsageGauge(registry),
    migrationDrift: migrationDriftGauge(registry),
    migrationBlocked: migrationBlockedGauge(registry),
  };
}
