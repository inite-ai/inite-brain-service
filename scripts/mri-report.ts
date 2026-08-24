#!/usr/bin/env -S npx ts-node -T
/**
 * mri-report — generate a Memory Reliability Index snapshot and write it as
 * markdown + JSON under var/mri/.
 *
 * Two honest modes:
 *   1. LIVE (recommended): set MRI_ENDPOINT_URL + MRI_ADMIN_KEY to point at a
 *      running brain; the script fetches GET /v1/admin/mri (real telemetry).
 *   2. COLD (default): no running server — the script builds the report from an
 *      EMPTY telemetry reader + the committed suite-status ledger. Live cells
 *      then render `pending-eval` with reason "no traffic in window" (honest —
 *      a cold process observed no queries), and structural cells render the
 *      ledger's last-recorded status. It NEVER fabricates a number.
 *
 * Run:
 *   pnpm mri:report
 *   MRI_ENDPOINT_URL=http://localhost:3033 MRI_ADMIN_KEY=key_… pnpm mri:report
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readerFromPromJson } from '../src/mri/metrics-reader';
import { buildMriReport } from '../src/mri/mri-collectors';
import { loadSuiteLedger } from '../src/mri/suite-status';
import { renderMriMarkdown } from '../src/mri/mri-markdown';
import type { MriReport } from '../src/mri/mri.types';

async function fetchLive(url: string, key: string): Promise<MriReport> {
  const res = await fetch(`${url.replace(/\/$/, '')}/v1/admin/mri`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/admin/mri returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as MriReport;
}

function buildCold(): MriReport {
  // Empty reader → no counters/histograms; live dims render pending honestly.
  const reader = readerFromPromJson([]);
  const ledger = loadSuiteLedger();
  return buildMriReport(reader, ledger);
}

async function main(): Promise<void> {
  const url = process.env.MRI_ENDPOINT_URL;
  const key = process.env.MRI_ADMIN_KEY;

  let report: MriReport;
  let mode: string;
  if (url && key) {
    report = await fetchLive(url, key);
    mode = `live (${url})`;
  } else {
    report = buildCold();
    mode = 'cold (no MRI_ENDPOINT_URL/MRI_ADMIN_KEY — live cells pending, structural from ledger)';
  }

  const outDir = join('var', 'mri');
  mkdirSync(outDir, { recursive: true });
  const md = renderMriMarkdown(report);
  writeFileSync(join(outDir, 'latest.md'), md, 'utf8');
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  process.stdout.write(`MRI snapshot written to var/mri/latest.{md,json} — mode: ${mode}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`mri-report failed: ${(err as Error).message}\n`);
  process.exit(1);
});
