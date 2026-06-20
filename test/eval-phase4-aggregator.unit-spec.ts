/**
 * Unit-test for the Phase 4 / 2 / 3.B aggregator gates introduced
 * alongside the SynthesizeOutcome diagnostic fields:
 *   - answer-language-correctness
 *   - decision-log-citation-rate
 *   - mean-extraction-entropy (diagnostic, no threshold)
 */
import { Aggregator } from './eval/runner/aggregator';
import type {
  ScenarioOutcome,
  SynthesizeOutcome,
} from '../src/eval/types';

function mkOutcome(
  partial: Partial<SynthesizeOutcome> = {},
): SynthesizeOutcome {
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

function mkScenarioOutcome(syn: SynthesizeOutcome[]): ScenarioOutcome {
  return {
    scenarioId: 's',
    vertical: 'rent' as any,
    queryResults: [],
    extractionResults: [],
    memoryAssertionResults: [],
    miaTestResults: [],
    synthesizeOutcomes: syn,
  };
}

describe('Aggregator — Phase 4 gates', () => {
  it('answer-language-correctness: ignores outcomes without an expectation', async () => {
    const agg = new Aggregator();
    const report = agg.build([
      mkScenarioOutcome([
        // No answerLangCorrect → dropped from gate
        mkOutcome({}),
        // expectedAnswerLang='ru', detected='ru' → correct
        mkOutcome({ answerLangCorrect: true, answerLangDetected: 'ru' }),
        // expected='ru', detected='en' → incorrect
        mkOutcome({ answerLangCorrect: false, answerLangDetected: 'en' }),
      ]),
    ]);
    const metric = report.overall.find(
      (m) => m.name === 'answer-language-correctness',
    );
    expect(metric).toBeDefined();
    // 1/2 = 0.5 (only the two gated outcomes count)
    expect(metric!.value).toBe(0.5);
    expect(metric!.n).toBe(2);
    expect(metric!.threshold).toBe(0.95);
  });

  it('answer-language-correctness: null when no expectations declared', async () => {
    const agg = new Aggregator();
    const report = agg.build([
      mkScenarioOutcome([mkOutcome({}), mkOutcome({})]),
    ]);
    const metric = report.overall.find(
      (m) => m.name === 'answer-language-correctness',
    );
    expect(metric!.value).toBeNull();
    expect(metric!.threshold).toBeUndefined();
  });

  it('decision-log-citation-rate: counts only outcomes WITH answer', async () => {
    const agg = new Aggregator();
    const report = agg.build([
      mkScenarioOutcome([
        // answer + citations > 0 → counted as cited
        mkOutcome({ decisionLogCitationCount: 3 }),
        // answer + 0 citations → counted as un-cited
        mkOutcome({ decisionLogCitationCount: 0 }),
        // null answer → excluded
        mkOutcome({ answer: null, decisionLogCitationCount: 0 }),
      ]),
    ]);
    const metric = report.overall.find(
      (m) => m.name === 'decision-log-citation-rate',
    );
    expect(metric!.value).toBe(0.5);
    expect(metric!.n).toBe(2);
    expect(metric!.threshold).toBe(0.8);
  });

  it('mean-extraction-entropy: averages the populated entropies', async () => {
    const agg = new Aggregator();
    const report = agg.build([
      mkScenarioOutcome([
        mkOutcome({ avgExtractionEntropy: 0.2 }),
        mkOutcome({ avgExtractionEntropy: 0.8 }),
        // null entropy excluded
        mkOutcome({ avgExtractionEntropy: null }),
      ]),
    ]);
    const metric = report.overall.find(
      (m) => m.name === 'mean-extraction-entropy',
    );
    expect(metric!.value).toBe(0.5);
    expect(metric!.threshold).toBeUndefined();
    expect(metric!.n).toBe(2);
  });

  it('mean-extraction-entropy: null when no entropy data', async () => {
    const agg = new Aggregator();
    const report = agg.build([mkScenarioOutcome([mkOutcome({})])]);
    const metric = report.overall.find(
      (m) => m.name === 'mean-extraction-entropy',
    );
    expect(metric!.value).toBeNull();
  });
});
