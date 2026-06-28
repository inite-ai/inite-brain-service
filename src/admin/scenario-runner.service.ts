import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { allScenarios } from '../eval/scenarios';
import type { Scenario, SetupStep } from '../eval/types';
import { ScenarioWriteService } from './scenario-write.service';
import { ScenarioLifecycleService } from './scenario-lifecycle.service';
import { ScenarioEvalService } from './scenario-eval.service';
import { slugify } from './scenario-runner-utils';
import type {
  ScenarioListItem,
  ScenarioRunOutcome,
  ScenarioRunOptions,
  MemoryAssertionResult,
  ScenarioQueryResult,
} from './scenario-runner.types';

// Re-exported for callers (baseline.service, admin controllers) that import the
// scenario result types from this module.
export type {
  ScenarioListItem,
  ScenarioQueryResult,
  MemoryAssertionResult,
  IdentityMergeOutcomeShape,
  ScenarioRunOutcome,
  ScenarioRunOptions,
} from './scenario-runner.types';

/**
 * Orchestrates a single scenario run across three phase services:
 *  - {@link ScenarioWriteService}     — additive ingest steps (fact/mention/link)
 *  - {@link ScenarioLifecycleService} — destructive steps + tenant teardown
 *  - {@link ScenarioEvalService}      — query / assertion / identity-merge reads
 *
 * This class holds the run lifecycle (ephemeral tenant, setup loop dispatch,
 * metric aggregation) and the static scenario catalogue (list / getById).
 */
@Injectable()
export class ScenarioRunnerService {
  private readonly logger = new Logger(ScenarioRunnerService.name);

  constructor(
    private readonly write: ScenarioWriteService,
    private readonly lifecycle: ScenarioLifecycleService,
    private readonly evaluator: ScenarioEvalService,
  ) {}

  list(): ScenarioListItem[] {
    return allScenarios.map((s) => ({
      id: s.id,
      vertical: s.vertical,
      description: s.description,
      setupSteps: s.setup.length,
      queries: s.queries.length,
      hasMemoryAssertions: !!s.memoryAssertions?.length,
      hasIdentityMerge: !!s.identityMerge,
      hasSynthesize: !!s.synthesizeQueries?.length,
    }));
  }

  getById(id: string): Scenario {
    const s = allScenarios.find((x) => x.id === id);
    if (!s) throw new NotFoundException(`Scenario ${id} not found`);
    return s;
  }

  async runOne(id: string, opts: ScenarioRunOptions = {}): Promise<ScenarioRunOutcome> {
    const scenario = this.getById(id);
    const startedAt = Date.now();
    // Ephemeral tenant id — randomUUID slice so two concurrent runs of the
    // same scenario don't collide on a ms timestamp and drop each other's DB.
    const companyId = `eval_${slugify(id)}_${randomUUID().slice(0, 8)}`;

    const setupSummary: ScenarioRunOutcome['setupSummary'] = {
      facts: 0,
      mentions: 0,
      links: 0,
      retracts: 0,
      forgets: 0,
      errors: [],
    };
    const factIdsByTag = new Map<string, string>();

    try {
      for (let i = 0; i < scenario.setup.length; i++) {
        const step = scenario.setup[i];
        try {
          await this.applyStep({
            companyId,
            step,
            summary: setupSummary,
            factIdsByTag,
          });
        } catch (e) {
          setupSummary.errors.push({
            step: i,
            kind: step.kind,
            error: (e as Error).message,
          });
        }
      }

      // identityMerge runs after setup (link is itself a setup step,
      // but the assertion side — resolving survivor / loser / distractor
      // entityIds and checking same-vs-distinct — only makes sense once
      // every fact has been ingested).
      const identityMergeResult = scenario.identityMerge
        ? await this.evaluator.runIdentityMerge(companyId, scenario.identityMerge)
        : undefined;

      const memoryAssertionResults: MemoryAssertionResult[] = [];
      for (const a of scenario.memoryAssertions ?? []) {
        memoryAssertionResults.push(
          await this.evaluator.runMemoryAssertion(companyId, a),
        );
      }

      const queryResults: ScenarioQueryResult[] = [];
      for (const q of scenario.queries) {
        queryResults.push(await this.evaluator.runQuery(companyId, q));
      }

      const passes = queryResults.filter((q) => q.passed).length;
      const memPassed = memoryAssertionResults.filter((r) => r.passed).length;
      const piiResults = queryResults.filter(
        (q) => q.piiGatedCorrectly !== null,
      );
      const piiPassed = piiResults.filter((q) => q.piiGatedCorrectly).length;

      const identityOk = identityMergeResult
        ? identityMergeResult.merged &&
          identityMergeResult.falseMerges.length === 0 &&
          identityMergeResult.unresolvedDistractors.length === 0
        : true;

      const passedAll =
        setupSummary.errors.length === 0 &&
        passes === queryResults.length &&
        memPassed === memoryAssertionResults.length &&
        identityOk;

      return {
        scenarioId: scenario.id,
        vertical: scenario.vertical,
        companyId,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        passed: passedAll,
        setupSummary,
        queryResults,
        memoryAssertionResults,
        identityMergeResult,
        ...(scenario.synthesizeQueries?.length
          ? {
              synthesizeSkipped: {
                count: scenario.synthesizeQueries.length,
                reason:
                  'RAGAS-style faithfulness verifier not ported to admin runner — synthesizeQueries cannot be auto-validated here yet.',
              },
            }
          : {}),
        metrics: {
          recallAt1: queryResults.length
            ? queryResults.filter((q) => q.rankOfExpected === 1).length /
              queryResults.length
            : 0,
          recallAt5: queryResults.length
            ? queryResults.filter(
                (q) => q.rankOfExpected > 0 && q.rankOfExpected <= 5,
              ).length / queryResults.length
            : 0,
          queries: queryResults.length,
          passes,
          memoryAssertionsPassed: memPassed,
          memoryAssertionsTotal: memoryAssertionResults.length,
          piiGatingPassed: piiPassed,
          piiGatingTotal: piiResults.length,
        },
      };
    } finally {
      // Always drop the ephemeral DB unless the operator explicitly asked
      // to keep it for post-mortem. A run that throws mid-flight would
      // otherwise leak its `co_eval_*` database forever.
      if (!opts.keepTenant) {
        await this.lifecycle.dropTenant(companyId);
      }
    }
  }

  async cleanupEphemeralTenants(): Promise<string[]> {
    // Best-effort: list known evals databases via the surreal admin pool.
    // No central registry exists, so we leave deletion to dropCompanyDatabase
    // calls for explicitly-known ids. This method is a stub for the v2
    // cleanup UI; for now it just reports an empty list.
    return [];
  }

  private async applyStep({
    companyId,
    step,
    summary,
    factIdsByTag,
  }: {
    companyId: string;
    step: SetupStep;
    summary: ScenarioRunOutcome['setupSummary'];
    factIdsByTag: Map<string, string>;
  }): Promise<void> {
    switch (step.kind) {
      case 'fact': {
        const factId = await this.write.applyFact(companyId, step);
        if (step.tag && factId) factIdsByTag.set(step.tag, factId);
        summary.facts += 1;
        break;
      }
      case 'mention': {
        await this.write.applyMention(companyId, step);
        summary.mentions += 1;
        break;
      }
      case 'link': {
        await this.write.applyLink(companyId, step);
        summary.links += 1;
        break;
      }
      case 'retract': {
        await this.lifecycle.applyRetract(companyId, {
          step,
          factId: factIdsByTag.get(step.tag),
        });
        summary.retracts += 1;
        break;
      }
      case 'forget': {
        await this.lifecycle.applyForget(companyId, step);
        summary.forgets += 1;
        break;
      }
    }
  }
}
