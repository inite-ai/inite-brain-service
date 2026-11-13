import type { Registry } from 'prom-client';
import { llmUsageGauge } from './llm-usage-gauge';
import { migrationDriftGauge } from './migration-drift-gauge';
import { migrationFailedTenantsGauge, migrationFailuresCounter } from './migration-failure-metrics';

/**
 * Gauges over process-level ledgers, read at scrape time: every SDK call's
 * tokens (llm-usage-gauge.ts), the tenants whose applied migrations differ
 * from the shipped files (migration-drift-gauge.ts), and failed schema
 * applies with the databases still backing off after one
 * (migration-failure-metrics.ts).
 */
export function processGauges(registry: Registry) {
  return {
    llmTokens: llmUsageGauge(registry),
    migrationDrift: migrationDriftGauge(registry),
    migrationFailures: migrationFailuresCounter(registry),
    migrationFailedTenants: migrationFailedTenantsGauge(registry),
  };
}
