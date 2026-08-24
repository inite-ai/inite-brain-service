/**
 * Renders a MultilingualMatrixReport as a machine-readable object
 * (serialize) and a human markdown table (render). Mirrors
 * test/eval/runner/reporter.ts — pure formatting, no IO.
 */

import type { MultilingualMatrixReport, MultilingualMetricCell } from '../../../src/eval/types';

export interface SerializedMultilingualReport {
  schemaVersion: 1;
  generatedAt: string;
  modelKind: 'stub' | 'real';
  slices: Array<{
    language: string;
    direction: string;
    cases: number;
    metrics: MultilingualMetricCell[];
  }>;
  overall: MultilingualMetricCell[];
  telemetry: MultilingualMatrixReport['telemetry'];
}

export class MultilingualReporter {
  /** Stable object for baseline-diff / downstream tooling. */
  serialize(report: MultilingualMatrixReport): SerializedMultilingualReport {
    return {
      schemaVersion: 1,
      generatedAt: report.generatedAt,
      modelKind: report.modelKind,
      slices: report.slices.map((s) => ({
        language: s.language,
        direction: s.direction,
        cases: s.cases,
        metrics: s.metrics,
      })),
      overall: report.overall,
      telemetry: report.telemetry,
    };
  }

  render(report: MultilingualMatrixReport): string {
    const lines: string[] = [];
    lines.push(`## Multilingual Eval Matrix (${report.modelKind})`, '');

    const metricNames = report.overall.map((m) => m.metric);
    lines.push('| language | dir | n | ' + metricNames.join(' | ') + ' |');
    lines.push('|' + '---|'.repeat(metricNames.length + 3));
    for (const s of report.slices) {
      lines.push(`| ${s.language} | ${s.direction} | ${s.cases} | ${this.cells(s.metrics)} |`);
    }
    lines.push(`| **all** | — | — | ${this.cells(report.overall)} |`);

    // Language-attribution telemetry distribution.
    const t = report.telemetry;
    lines.push('', '### Language-attribution telemetry', '');
    lines.push(
      `total=${t.total} meanConfidence=${t.meanConfidence === null ? '—' : t.meanConfidence.toFixed(2)} ` +
        `lowConfidenceRate=${t.lowConfidenceRate === null ? '—' : t.lowConfidenceRate.toFixed(2)} ` +
        `(threshold ${t.lowConfidenceThreshold.toFixed(2)})`,
    );
    lines.push('', '| lang | count | meanConfidence |', '|---|---|---|');
    for (const l of t.byLanguage) {
      lines.push(`| ${l.lang} | ${l.count} | ${l.meanConfidence.toFixed(2)} |`);
    }
    lines.push('', '| source | count |', '|---|---|');
    for (const s of t.bySource) lines.push(`| ${s.source} | ${s.count} |`);
    lines.push('', '| detectorVersion | count |', '|---|---|');
    for (const d of t.byDetectorVersion) lines.push(`| ${d.detectorVersion} | ${d.count} |`);

    return lines.join('\n');
  }

  private cells(metrics: MultilingualMetricCell[]): string {
    return metrics
      .map((m) => {
        if (m.value === null) return '—';
        const v = m.value.toFixed(2);
        const nTag = m.n > 0 ? ` n=${m.n}` : '';
        if (m.threshold === undefined) return `${v}${nTag}`;
        const ok = m.value >= m.threshold ? '✓' : '✗';
        return `${v} ${ok}${nTag}`;
      })
      .join(' | ');
  }
}
