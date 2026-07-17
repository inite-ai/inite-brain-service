/**
 * Unit coverage for the hallucination-resistance (false-premise) metric
 * and the aggregator partition. The load-bearing invariant: refusal-
 * expected outcomes must NOT dilute the faithfulness / abstain / verifier
 * rows (they're supposed to abstain — folding them in would invert those
 * gates), and must feed the refusal-rate / confabulation-count rows.
 */
import {
  refusalRate,
  confabulationCount,
} from './eval/metrics/hallucination-resistance';
import { Aggregator } from './eval/runner/aggregator';
import type { ScenarioOutcome, SynthesizeOutcome } from '../src/eval/types';

function mkOutcome(partial: Partial<SynthesizeOutcome> = {}): SynthesizeOutcome {
  return {
    scenarioId: 's',
    query: 'q',
    answer: 'some answer',
    faithfulness: 0.9,
    totalClaims: 1,
    passed: true,
    faithfulnessFloor: 0.85,
    ...partial,
  };
}

const refusal = (refused: boolean): SynthesizeOutcome =>
  mkOutcome({
    answer: refused ? null : 'a confident fabricated answer',
    faithfulness: null,
    expectedRefusal: true,
    refused,
    passed: refused,
  });

function mkScenarioOutcome(syn: SynthesizeOutcome[]): ScenarioOutcome {
  return {
    scenarioId: 's',
    vertical: 'rent' as never,
    queryResults: [],
    extractionResults: [],
    memoryAssertionResults: [],
    miaTestResults: [],
    synthesizeOutcomes: syn,
  };
}

describe('hallucination-resistance metric', () => {
  it('refusalRate = correctly-refused / false-premise total', () => {
    expect(refusalRate([refusal(true), refusal(true), refusal(false)])).toBeCloseTo(
      2 / 3,
      10,
    );
  });

  it('refusalRate is null when there are no false-premise outcomes', () => {
    expect(refusalRate([mkOutcome({}), mkOutcome({})])).toBeNull();
  });

  it('confabulationCount counts answered false-premise queries', () => {
    expect(confabulationCount([refusal(true), refusal(false), refusal(false)])).toBe(
      2,
    );
    // Normal outcomes never count as confabulations.
    expect(confabulationCount([mkOutcome({}), refusal(true)])).toBe(0);
  });
});

describe('Aggregator — hallucination-resistance partition', () => {
  it('surfaces refusal-rate + confabulation-count over false-premise outcomes', () => {
    const report = new Aggregator().build([
      mkScenarioOutcome([refusal(true), refusal(true), refusal(false)]),
    ]);
    const rate = report.overall.find(
      (m) => m.name === 'hallucination-resistance:refusal-rate',
    );
    const confab = report.overall.find(
      (m) => m.name === 'hallucination-resistance:confabulation-count',
    );
    expect(rate!.value).toBeCloseTo(2 / 3, 10);
    expect(rate!.threshold).toBe(0.8);
    expect(rate!.n).toBe(3);
    expect(confab!.value).toBe(1);
  });

  it('EXCLUDES refusal outcomes from the abstain-rate gate', () => {
    // Two normal answered outcomes + two refusals. If refusals leaked in,
    // the abstain-rate (expressed as 1 - abstain) would drop to 0.5 and
    // trip the 0.7 gate. They must be partitioned out → stays 1.0.
    const report = new Aggregator().build([
      mkScenarioOutcome([
        mkOutcome({}),
        mkOutcome({}),
        refusal(true),
        refusal(true),
      ]),
    ]);
    const abstain = report.overall.find(
      (m) => m.name === 'synthesize-abstain-rate',
    );
    expect(abstain!.value).toBe(1); // 1 - 0/2 over the NORMAL outcomes only
    expect(abstain!.n).toBe(2);
  });

  it('EXCLUDES refusal outcomes from faithfulness:pass-rate', () => {
    const report = new Aggregator().build([
      mkScenarioOutcome([
        mkOutcome({ passed: true }),
        refusal(false), // a confabulation — would drag pass-rate down if counted
      ]),
    ]);
    const passRate = report.overall.find(
      (m) => m.name === 'faithfulness:pass-rate',
    );
    expect(passRate!.value).toBe(1); // only the one normal, passing outcome
    expect(passRate!.n).toBe(1);
  });

  it('refusal-rate is null when a slice has no false-premise queries', () => {
    const report = new Aggregator().build([
      mkScenarioOutcome([mkOutcome({}), mkOutcome({})]),
    ]);
    const rate = report.overall.find(
      (m) => m.name === 'hallucination-resistance:refusal-rate',
    );
    expect(rate!.value).toBeNull();
    expect(rate!.threshold).toBeUndefined();
  });
});
