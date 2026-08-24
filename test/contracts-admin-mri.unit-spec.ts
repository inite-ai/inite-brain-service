/**
 * Wire-contract drift guard for GET /v1/admin/mri.
 *
 * Two-path coverage: a busy window (live cells are numbers, structural cells
 * carry ledger status) and a cold/empty window (live cells pending, ledger
 * empty). Both must parse against MriReportSchema — the same drift-gate idiom
 * as the calibration cockpit.
 */
import { MriReportSchema } from '../src/contracts/admin/mri.schema';
import { buildMriReport } from '../src/mri/mri-collectors';
import type { CounterSeries, HistogramData, MetricsReader } from '../src/mri/metrics-reader';
import type { SuiteLedger } from '../src/mri/suite-status';

function stubReader(
  counters: Record<string, CounterSeries[]>,
  hist?: HistogramData,
): MetricsReader {
  return {
    counter: (name) => counters[name] ?? [],
    histogram: (name) => (name === 'brain_search_duration_seconds' ? (hist ?? null) : null),
  };
}

const LEDGER: SuiteLedger = {
  'memtrap-shakedown': { status: 'pass', recordedAt: '2026-08-20T00:00:00.000Z' },
  'minja-redteam': { status: 'pass', gapCount: 0, recordedAt: '2026-08-20T00:00:00.000Z' },
  'tenant-user-isolation': { status: 'pass', recordedAt: '2026-08-20T00:00:00.000Z' },
};

describe('GET /v1/admin/mri — wire contract', () => {
  it('matches MriReportSchema for a busy window', () => {
    const reader = stubReader(
      {
        brain_synthesize_total: [{ labels: { outcome: 'ok' }, value: 10 }],
        brain_openai_tokens_total: [{ labels: { kind: 'chat', type: 'prompt' }, value: 1000 }],
      },
      {
        buckets: [
          { le: 0.1, cumulativeCount: 5 },
          { le: Number.POSITIVE_INFINITY, cumulativeCount: 10 },
        ],
        sum: 1,
        count: 10,
      },
    );
    const parsed = MriReportSchema.safeParse(buildMriReport(reader, LEDGER, {}));
    if (!parsed.success) {
      throw new Error(`MRI (busy) drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.data.operatingPoint.sampleCount).toBe(10);
  });

  it('matches MriReportSchema for a cold/empty window', () => {
    const parsed = MriReportSchema.safeParse(buildMriReport(stubReader({}), {}, {}));
    if (!parsed.success) {
      throw new Error(`MRI (cold) drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.data.operatingPoint.accuracyProxy).toBeNull();
  });
});
