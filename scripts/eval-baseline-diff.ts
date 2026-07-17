#!/usr/bin/env -S npx tsx
/**
 * eval-baseline-diff — compare two SerializedReport JSONs (a baseline
 * from the last green main, and a current run) and exit non-zero on
 * regression beyond per-metric tolerances.
 *
 * Usage:
 *   tsx scripts/eval-baseline-diff.ts <baseline.json> <current.json>
 *
 * Tolerance rules (all "delta" = current - baseline):
 *   - recall@k, MRR, NDCG, F1, precision, recall (any name): block on
 *     drop > 0.03 (3 percentage points). Improvement is fine.
 *   - extraction-predicate-recall, entity-extraction-rate: drop > 0.05.
 *   - identity-resolution-* / pii-gating-correctness: ANY drop > 0.01
 *     (these were either passing or not — large tolerance hides bugs).
 *   - memory-lifecycle-correctness: must equal 1.0 in current; ANY
 *     drop is a hard fail (matches the existing absolute-threshold
 *     gate in test/quality.real-e2e-spec.ts).
 *   - privacy-leakage-mia-auc: lower is better — block on RISE > 0.05.
 *   - other / unrecognized metrics: drop > 0.05 (conservative default).
 *
 * CI-aware widening: when the BASELINE row carries a bootstrap CI
 * (ciLower/ciUpper — written by the eval harness alongside n), the
 * allowed drop widens by the baseline's own downward CI half-width:
 *   allowedDrop = flatTolerance + (baseline.value - baseline.ciLower)
 * i.e. "regression = below the baseline's own noise band by more than
 * the flat tolerance". Rationale: a flat 0.03 on a 10-sample vertical
 * is below ONE flipped case (0.10) — the 2026-07 estate false alarm was
 * a knife-edge ranking pair wobbling inside the baseline's own
 * [0.70–1.00] bootstrap band. A value the baseline itself could have
 * produced is not a regression. Small-n verticals (wide CI) get slack
 * proportional to their noise; big-n metrics stay tight (overall n=262:
 * 0.03 + 0.031). Hard correctness gates (tolerance < 0.03) never widen.
 * For lower-is-better metrics the mirror applies with ciUpper. Rows
 * without CI data keep the flat tolerance.
 *
 * Missing-in-current is treated as a regression (metric disappeared).
 * New-in-current is reported as "added" but never blocks.
 *
 * Skipped silently when baseline is `--no-baseline` — first runs after
 * the gate is introduced have no prior data; the upload-as-new-baseline
 * step still records this run for next time.
 */
import { readFileSync, existsSync } from 'node:fs';

interface MetricRow {
  name: string;
  value: number | null;
  threshold?: number;
  /** Bootstrap CI bounds + sample size, when the harness computed them. */
  ciLower?: number;
  ciUpper?: number;
  n?: number;
}
interface VerticalBlock {
  vertical: string;
  scenarios: number;
  metrics: MetricRow[];
}
interface SerializedReport {
  schemaVersion: 1;
  generatedAt: string;
  perVertical: VerticalBlock[];
  overall: MetricRow[];
}

interface Finding {
  scope: string;
  metric: string;
  baseline: number | null;
  current: number | null;
  delta: number | null;
  tolerance: number;
  direction: 'higher_is_better' | 'lower_is_better';
  kind: 'regression' | 'missing' | 'added';
}

function parseReport(path: string, label: string): SerializedReport {
  if (!existsSync(path)) {
    throw new Error(`[eval-baseline-diff] ${label} not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[eval-baseline-diff] ${label} is not JSON: ${(err as Error).message}`,
    );
  }
  const obj = parsed as SerializedReport;
  if (obj.schemaVersion !== 1) {
    throw new Error(
      `[eval-baseline-diff] ${label} schemaVersion=${(obj as { schemaVersion?: unknown }).schemaVersion} unsupported (expected 1)`,
    );
  }
  return obj;
}

function tolerance(name: string): { drop: number; lowerIsBetter: boolean } {
  if (name === 'memory-lifecycle-correctness') return { drop: 0.0, lowerIsBetter: false };
  if (name === 'privacy-leakage-mia-auc') return { drop: 0.05, lowerIsBetter: true };
  // Hallucination resistance is a safety gate — hold it to the tight 0.03
  // recall-class tolerance rather than the loose 0.05 default.
  if (name === 'hallucination-resistance:refusal-rate') {
    return { drop: 0.03, lowerIsBetter: false };
  }
  if (name === 'pii-gating-correctness' || name.startsWith('identity-resolution')) {
    return { drop: 0.01, lowerIsBetter: false };
  }
  if (name.startsWith('extraction-') || name.startsWith('entity-')) {
    return { drop: 0.05, lowerIsBetter: false };
  }
  if (
    name.startsWith('recall@') ||
    name.startsWith('MRR') ||
    name.startsWith('NDCG') ||
    name.endsWith('-f1') ||
    name.endsWith('-precision') ||
    name.endsWith('-recall')
  ) {
    return { drop: 0.03, lowerIsBetter: false };
  }
  return { drop: 0.05, lowerIsBetter: false };
}

function diffMetrics(scope: string, base: MetricRow[], cur: MetricRow[]): Finding[] {
  const findings: Finding[] = [];
  const curByName = new Map(cur.map((m) => [m.name, m]));
  const seen = new Set<string>();

  for (const b of base) {
    seen.add(b.name);
    const c = curByName.get(b.name);
    const tol = tolerance(b.name);
    if (!c) {
      findings.push({
        scope,
        metric: b.name,
        baseline: b.value,
        current: null,
        delta: null,
        tolerance: tol.drop,
        direction: tol.lowerIsBetter ? 'lower_is_better' : 'higher_is_better',
        kind: 'missing',
      });
      continue;
    }
    if (b.value === null || c.value === null) continue; // null = no data, can't compare
    const delta = c.value - b.value;
    // CI-aware widening (see header): the baseline's own bootstrap
    // half-width is the noise floor — a current value inside the band
    // the baseline could have produced is not a regression. Hard-fail
    // metrics (drop 0.0/0.01) stay hard: correctness gates are
    // pass/fail, not sampled rankings.
    const ciSlack =
      tol.drop >= 0.03
        ? tol.lowerIsBetter
          ? b.ciUpper !== undefined
            ? b.ciUpper - b.value
            : 0
          : b.ciLower !== undefined
            ? b.value - b.ciLower
            : 0
        : 0;
    const allowedDrop = tol.drop + ciSlack;
    const regressed = tol.lowerIsBetter ? delta > allowedDrop : delta < -allowedDrop;
    if (regressed) {
      findings.push({
        scope,
        metric: b.name,
        baseline: b.value,
        current: c.value,
        delta,
        tolerance: allowedDrop,
        direction: tol.lowerIsBetter ? 'lower_is_better' : 'higher_is_better',
        kind: 'regression',
      });
    }
  }

  for (const c of cur) {
    if (!seen.has(c.name)) {
      const tol = tolerance(c.name);
      findings.push({
        scope,
        metric: c.name,
        baseline: null,
        current: c.value,
        delta: null,
        tolerance: tol.drop,
        direction: tol.lowerIsBetter ? 'lower_is_better' : 'higher_is_better',
        kind: 'added',
      });
    }
  }

  return findings;
}

function main(): void {
  const [baselinePath, currentPath] = process.argv.slice(2);
  if (!baselinePath || !currentPath) {
    console.error('usage: eval-baseline-diff.ts <baseline.json> <current.json>');
    process.exit(2);
  }
  if (baselinePath === '--no-baseline') {
    console.log('[eval-baseline-diff] no baseline supplied — skipping diff (first run mode)');
    process.exit(0);
  }
  const baseline = parseReport(baselinePath, 'baseline');
  const current = parseReport(currentPath, 'current');

  const findings: Finding[] = [];
  findings.push(...diffMetrics('overall', baseline.overall, current.overall));

  const baseVerticals = new Map(baseline.perVertical.map((v) => [v.vertical, v]));
  const curVerticals = new Map(current.perVertical.map((v) => [v.vertical, v]));
  for (const [vertical, baseV] of baseVerticals) {
    const curV = curVerticals.get(vertical);
    if (!curV) {
      findings.push({
        scope: vertical,
        metric: '<vertical>',
        baseline: null,
        current: null,
        delta: null,
        tolerance: 0,
        direction: 'higher_is_better',
        kind: 'missing',
      });
      continue;
    }
    findings.push(...diffMetrics(vertical, baseV.metrics, curV.metrics));
  }

  const regressions = findings.filter((f) => f.kind === 'regression' || f.kind === 'missing');
  const added = findings.filter((f) => f.kind === 'added');

  const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(3));
  console.log(`# Baseline diff (baseline=${baseline.generatedAt} → current=${current.generatedAt})`);
  console.log('');
  if (added.length > 0) {
    console.log(`## Added (${added.length}) — informational, not blocking`);
    for (const f of added) {
      console.log(`  + ${f.scope}.${f.metric} = ${fmt(f.current)}`);
    }
    console.log('');
  }
  if (regressions.length === 0) {
    console.log('No regressions beyond per-metric tolerance. ✓');
    process.exit(0);
  }
  console.log(`## Regressions (${regressions.length})`);
  for (const f of regressions) {
    if (f.kind === 'missing') {
      console.log(`  ✗ ${f.scope}.${f.metric}: missing in current (was ${fmt(f.baseline)})`);
    } else {
      const arrow = f.direction === 'lower_is_better' ? 'rose' : 'dropped';
      console.log(
        `  ✗ ${f.scope}.${f.metric}: ${fmt(f.baseline)} → ${fmt(f.current)} ` +
          `(${arrow} by ${Math.abs(f.delta!).toFixed(3)}, tolerance ${f.tolerance.toFixed(3)})`,
      );
    }
  }
  process.exit(1);
}

main();
