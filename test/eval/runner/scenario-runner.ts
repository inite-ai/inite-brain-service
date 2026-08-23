import type { Scenario, ScenarioOutcome } from '../../../src/eval/types';
import { SetupApplier } from './setup-applier';
import { QueryExecutor } from './query-executor';
import { MemoryAssertionsChecker } from './memory-assertions';
import { MiaChecker } from './mia-checker';
import { FaithfulnessChecker } from './faithfulness-checker';

/**
 * Runs ONE scenario end-to-end:
 *   setup → memory-assertions → mia-tests → queries → outcome.
 *
 * Pure orchestration over the single-purpose collaborators.
 *
 * Stage ordering:
 *   - memoryAssertions BEFORE queries: forget-then-search scenarios
 *     can assert the entity's full disappearance independently of
 *     the query slice.
 *   - miaTests AFTER assertions, BEFORE queries: the MIA probe is
 *     itself a search-side check, so it sees the same post-forget
 *     state assertions saw — but its result feeds a different
 *     metric (privacy leakage AUC, not assertion pass-rate).
 */
export class ScenarioRunner {
  constructor(
    private readonly setupApplier: SetupApplier,
    private readonly queryExecutor: QueryExecutor,
    private readonly memoryChecker?: MemoryAssertionsChecker,
    private readonly miaChecker?: MiaChecker,
    private readonly faithfulnessChecker?: FaithfulnessChecker,
  ) {}

  async run(scenario: Scenario): Promise<ScenarioOutcome> {
    const { extractions, identityMerge } = await this.setupApplier.apply(scenario);

    const memoryAssertionResults = this.memoryChecker
      ? await this.memoryChecker.check(scenario)
      : [];

    const miaTestResults = this.miaChecker ? await this.miaChecker.check(scenario) : [];

    const queryResults = [];
    for (const q of scenario.queries) {
      queryResults.push(await this.queryExecutor.execute(q));
    }

    // Synthesize / faithfulness runs LAST: it depends on the same
    // search retrieval the queryExecutor exercised, but adds the
    // generator + verifier LLM round-trips on top. Putting it after
    // queries means a search regression surfaces in queryResults
    // before the more expensive faithfulness leg burns tokens.
    const synthesizeOutcomes = this.faithfulnessChecker
      ? await this.faithfulnessChecker.check(scenario)
      : [];

    return {
      scenarioId: scenario.id,
      vertical: scenario.vertical,
      queryResults,
      extractionResults: extractions,
      ...(identityMerge !== undefined ? { identityMergeResult: identityMerge } : {}),
      memoryAssertionResults,
      miaTestResults,
      synthesizeOutcomes,
    };
  }
}
