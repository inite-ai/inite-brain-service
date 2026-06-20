import type { HttpBrainClient as BrainClient } from '../http-brain-client';
import type { Scenario, SynthesizeOutcome } from '../../../src/eval/types';
import {
  computeFaithfulness,
  type FaithfulnessSourceFact,
  type OpenAiLike,
} from '../metrics/faithfulness';
import { detectLanguage } from '../../../src/ai/locale/language-detector';

/**
 * Helper — extract diagnostic side-channels from the live brain
 * response. These are best-effort: missing fields silently produce
 * undefined / null, which the aggregator handles.
 */
function extractDiagnostics(
  answer: string | null,
  res: { citations: ReadonlyArray<unknown>; results?: ReadonlyArray<unknown> },
  expectedLang: string | undefined,
): {
  answerLangDetected: string | null;
  answerLangCorrect: boolean | undefined;
  decisionLogCitationCount: number;
  avgExtractionEntropy: number | null;
} {
  let answerLangDetected: string | null = null;
  let answerLangCorrect: boolean | undefined;
  if (answer && answer.trim()) {
    const det = detectLanguage(answer);
    answerLangDetected = det.language === 'und' ? null : det.language;
    if (expectedLang) {
      answerLangCorrect = answerLangDetected === expectedLang;
    }
  } else if (expectedLang) {
    answerLangCorrect = false;
  }

  const decisionLogCitationCount = res.citations.length;

  // SearchHit.facts.breakdown.extractionEntropy is opt-in (only
  // populated when EXTRACTOR_SC_PASSES > 1). We tolerate absence.
  let entropySum = 0;
  let entropyCount = 0;
  for (const hit of (res.results ?? []) as Array<{
    facts?: ReadonlyArray<{
      breakdown?: { extractionEntropy?: number };
    }>;
  }>) {
    for (const fact of hit.facts ?? []) {
      const h = fact.breakdown?.extractionEntropy;
      if (typeof h === 'number' && Number.isFinite(h)) {
        entropySum += h;
        entropyCount += 1;
      }
    }
  }
  const avgExtractionEntropy =
    entropyCount === 0 ? null : entropySum / entropyCount;

  return {
    answerLangDetected,
    answerLangCorrect,
    decisionLogCitationCount,
    avgExtractionEntropy,
  };
}

/**
 * Runs each scenario's synthesizeQueries via brain's /v1/synthesize
 * endpoint and pipes (answer, citations) through the RAGAS-style
 * faithfulness verifier. Returns a SynthesizeOutcome per query, with
 * pass/fail computed against the per-query faithfulnessFloor.
 *
 * Single responsibility: turn declarative synthesize expectations
 * into measured outcomes. Aggregation is in Aggregator.
 */
export class FaithfulnessChecker {
  constructor(
    private readonly brain: BrainClient,
    private readonly openai: OpenAiLike,
    private readonly model?: string,
  ) {}

  async check(scenario: Scenario): Promise<SynthesizeOutcome[]> {
    const expectations = scenario.synthesizeQueries ?? [];
    if (expectations.length === 0) return [];
    const outcomes: SynthesizeOutcome[] = [];

    for (const e of expectations) {
      const floor = e.faithfulnessFloor ?? 0.85;
      try {
        const res = await this.brain.synthesize({
          query: e.query,
          limit: 5,
          synthesisGuardrails: 'lenient',
          asOf: e.asOf,
        });

        const answer = res.answer;
        const diag = extractDiagnostics(answer, res, e.expectedAnswerLang);
        if (!answer || !answer.trim()) {
          // Synthesizer rejected — guardrail engaged. Pass when the
          // scenario explicitly tolerates this (allowEmptyAnswer); fail
          // otherwise so silent regressions don't sneak past the gate.
          outcomes.push({
            scenarioId: scenario.id,
            query: e.query,
            answer: null,
            reason: res.reason,
            faithfulness: null,
            totalClaims: 0,
            passed: !!e.allowEmptyAnswer,
            faithfulnessFloor: floor,
            answerLangDetected: diag.answerLangDetected,
            answerLangCorrect: diag.answerLangCorrect,
            decisionLogCitationCount: diag.decisionLogCitationCount,
            avgExtractionEntropy: diag.avgExtractionEntropy,
          });
          continue;
        }

        // RAGAS faithfulness is measured against the retrieved CONTEXT
        // available to the generator, not against the citations the
        // generator chose to emit. gpt-4o-mini occasionally inlines
        // [fact_xxx] tags in the answer but leaves citedFactIds=[],
        // which would starve the verifier and produce a false-zero
        // score (every claim "not_supported" despite being grounded).
        // Pull the full result.facts as fallback when citations are
        // thin — this matches the verifier's actual semantics.
        const fromCitations: FaithfulnessSourceFact[] = res.citations.map((c) => ({
          factId: c.factId,
          predicate: c.predicate,
          object: c.object,
        }));
        const fromResults: FaithfulnessSourceFact[] = (res.results ?? []).flatMap(
          (r) =>
            (r.facts ?? []).map((f) => ({
              factId: f.factId,
              predicate: f.predicate,
              object: f.object,
            })),
        );
        // Merge: citations first (explicit), then any result-fact not
        // already in citations. Dedup by factId.
        const seen = new Set<string>();
        const sourceFacts: FaithfulnessSourceFact[] = [];
        for (const f of [...fromCitations, ...fromResults]) {
          if (seen.has(f.factId)) continue;
          seen.add(f.factId);
          sourceFacts.push(f);
        }

        const score = await computeFaithfulness(this.openai, {
          answer,
          sourceFacts,
          model: this.model,
        });

        const passed =
          score.faithfulness !== null &&
          score.faithfulness >= floor &&
          !score.verifierFailure;

        // Diagnostic dump on failure — answer + citations + per-claim
        // verdicts. Default-on (LLM-driven verifier is hard to debug
        // without it); silenceable via FAITHFULNESS_DEBUG=0.
        if (
          !passed &&
          score.faithfulness !== null &&
          process.env.FAITHFULNESS_DEBUG !== '0'
        ) {
           
          console.log(
            `[faithfulness-debug] ${scenario.id} q="${e.query}" score=${score.faithfulness.toFixed(2)} ` +
              `claims=${score.totalClaims} answer="${answer.slice(0, 200)}"`,
          );
           
          console.log(
            `[faithfulness-debug] sourceFacts: ${sourceFacts.map((f) => `[${f.factId.slice(-8)}] ${f.predicate}=${f.object.slice(0, 60)}`).join(' | ')}`,
          );
          for (const c of score.claims) {
             
            console.log(`[faithfulness-debug]   ${c.verdict.padEnd(14)} :: ${c.claim}`);
          }
        }

        outcomes.push({
          scenarioId: scenario.id,
          query: e.query,
          answer,
          faithfulness: score.faithfulness,
          totalClaims: score.totalClaims,
          ...(score.verifierFailure
            ? { verifierFailureKind: score.verifierFailure.kind }
            : {}),
          passed,
          faithfulnessFloor: floor,
          answerLangDetected: diag.answerLangDetected,
          answerLangCorrect: diag.answerLangCorrect,
          decisionLogCitationCount: diag.decisionLogCitationCount,
          avgExtractionEntropy: diag.avgExtractionEntropy,
        });
      } catch {
        outcomes.push({
          scenarioId: scenario.id,
          query: e.query,
          answer: null,
          reason: 'exception',
          faithfulness: null,
          totalClaims: 0,
          verifierFailureKind: 'exception',
          passed: false,
          faithfulnessFloor: floor,
        });
      }
    }
    return outcomes;
  }
}
