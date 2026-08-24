import type { MriDimension, MriReport } from './mri.types';
import type { ParetoReport, PolicyOperatingPoint } from './economics';

/**
 * Render an MRI report (+ optional Pareto frontier) to a human-readable
 * markdown snapshot. Pure string-building — no fs, no telemetry. Used by
 * `pnpm mri:report` to write the committed/human artifact.
 */

function fmtValue(d: MriDimension): string {
  if (typeof d.value === 'number') {
    const n = Number.isInteger(d.value) ? String(d.value) : d.value.toPrecision(4);
    return d.unit ? `${n} ${d.unit}` : n;
  }
  return `\`${d.value}\``;
}

function fmtNum(v: number | null, digits = 4): string {
  if (v === null) return 'pending-eval';
  return Number.isInteger(v) ? String(v) : v.toPrecision(digits);
}

function operatingPointTable(p: PolicyOperatingPoint): string {
  const rows: Array<[string, string]> = [
    ['flags', p.flags.length ? p.flags.join(', ') : '(baseline)'],
    [
      'accuracyProxy (ok ÷ terminal synthesize — PROXY, not true accuracy)',
      fmtNum(p.accuracyProxy),
    ],
    ['ece', p.ece === null ? 'pending-eval (needs labels)' : fmtNum(p.ece)],
    [
      'latencyP50 (s)',
      p.latencyP50 === null ? 'pending (no serving-path histogram)' : fmtNum(p.latencyP50),
    ],
    [
      'latencyP95 (s)',
      p.latencyP95 === null ? 'pending (no serving-path histogram)' : fmtNum(p.latencyP95),
    ],
    [
      'costPerQueryUpperBound (USD, all-AI upper bound — NOT per-answer cost)',
      fmtNum(p.costPerQueryUpperBound),
    ],
    ['sampleCount (terminal synthesize requests in window)', String(p.sampleCount)],
  ];
  return ['| Axis | Value |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join(
    '\n',
  );
}

export function renderMriMarkdown(report: MriReport, pareto?: ParetoReport): string {
  const lines: string[] = [];
  lines.push('# Memory Reliability Index (MRI) snapshot');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(
    '> Honest scaffold (measurable-economics-mri-2026-08.md). Every cell is a real value or the ' +
      '`pending-eval` / `unrecorded` sentinel with a reason — never a fabricated number.',
  );
  lines.push('');

  lines.push('## Part 2 — MRI dimensions');
  lines.push('');
  lines.push('| Dimension | Kind | Value | Eval-gated | Source / reason |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const [name, d] of Object.entries(report.dimensions)) {
    const detail = d.reason ? `${d.source} — ${d.reason}` : d.source;
    lines.push(
      `| ${name} | ${d.kind} | ${fmtValue(d)} | ${d.evalGated ? 'yes' : 'no'} | ${detail.replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('');

  lines.push('## Part 1 — economics operating point (live)');
  lines.push('');
  lines.push(operatingPointTable(report.operatingPoint));
  lines.push('');

  if (pareto) {
    lines.push('## Part 1 — Pareto frontier (advisory)');
    lines.push('');
    lines.push(`Frontier (non-dominated): ${pareto.frontier.length} point(s)`);
    for (const p of pareto.frontier) {
      lines.push(
        `- [${p.flags.join(',') || 'baseline'}] proxy=${fmtNum(p.accuracyProxy)} ` +
          `$${fmtNum(p.costPerQueryUpperBound)}/q (upper bound) p95=${fmtNum(p.latencyP95)}s`,
      );
    }
    if (pareto.dominated.length) {
      lines.push('');
      lines.push('Dominated:');
      for (const d of pareto.dominated) {
        lines.push(
          `- [${d.point.flags.join(',') || 'baseline'}] dominated by ` +
            `[${d.dominatedBy.flags.join(',') || 'baseline'}]`,
        );
      }
    }
    if (pareto.insufficientData.length) {
      lines.push('');
      lines.push(`Insufficient data (missing an axis): ${pareto.insufficientData.length} point(s)`);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}
