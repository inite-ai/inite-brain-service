/**
 * Run a battery in two halves, so what is written can be kept.
 *
 *   BATTERY_PHASE=ingest — write the corpus, drain extraction, run the
 *                          builds, record what the builds answered, stop.
 *                          Nothing is asked: asking leaves rows behind
 *                          (answer cache, observations) that a snapshot
 *                          must not carry into the next run.
 *   BATTERY_PHASE=ask    — the memory is already there (a restored
 *                          snapshot): skip the writes, read back what the
 *                          builds answered, ask.
 *   unset                — both, as before.
 *
 * The builds record matters: a skipped ingest otherwise reads as "the
 * scene build never ran", and every question that depends on it is
 * skipped instead of asked.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type BatteryPhase = 'all' | 'ingest' | 'ask';

export function batteryPhase(env: NodeJS.ProcessEnv = process.env): BatteryPhase {
  const raw = env.BATTERY_PHASE;
  if (raw === undefined || raw === '' || raw === 'all') return 'all';
  if (raw === 'ingest' || raw === 'ask') return raw;
  throw new Error(`BATTERY_PHASE must be ingest|ask|all, got "${raw}"`);
}

const buildsPath = (reportDir: string, runId: string): string =>
  join(reportDir, `builds-${runId}.json`);

export function saveBuilds(reportDir: string, runId: string, builds: Record<string, string>): void {
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(buildsPath(reportDir, runId), `${JSON.stringify(builds, null, 2)}\n`);
}

/** What the ingest half's builds answered, or null when it left no record. */
export function loadBuilds(reportDir: string, runId: string): Record<string, string> | null {
  const path = buildsPath(reportDir, runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}
