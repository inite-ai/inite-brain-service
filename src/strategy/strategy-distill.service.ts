import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type OpenAI from 'openai';
import { chatCallParams, createOpenAiClientOrThrow } from '../ai/openai-client';
import { ApiKeyService } from '../auth/api-key.service';
import { envFlagEnabled } from '../common/env-validation';
import {
  StrategyMemoryService,
  type ScoredStrategyItem,
  type StrategyEvidence,
  type StrategyItem,
  type StrategyPolarity,
} from './strategy-memory.service';
import {
  toTrajectory,
  type RawToolStep,
  type ToolStep,
  type TrajectoryBundle,
  type VerifiedOutcome,
} from './trajectory-digest';

/**
 * StrategyDistillService — G4's distiller plus the G7 sleep-time
 * sweep host (docs/roadmap/sota-gap-build-2026-08.md), built on the
 * PromotionRunnerService template: env-gated cron, constructor-
 * captured knobs, bounded per run, stats return.
 *
 * v1 distillation source = structured post-mortems from the eval
 * harness (ground truth with a diagnosis — no LLM judge noise, the
 * weakest ReasoningBank component deleted). One LLM call turns a
 * post-mortem batch into ≤3 strategy items (strategy-level, never
 * procedure-level; failures become preventative lessons), then each
 * item goes through a Mem0-style dedup-merge: retrieve the top-3
 * similar existing items and let the LLM decide ADD / UPDATE / NOOP —
 * UPDATE merges the evidence counters instead of growing the table.
 *
 * The nightly cron (STRATEGY_DISTILL_CRON_ENABLED, requires the
 * STRATEGY_MEMORY_ENABLED master) runs the G4 lifecycle sweep:
 * auto-deprecate on nContradict ≥ 2 or 90 days unvalidated. It is
 * the G7 host slot — later consolidation ops (contradiction sweep,
 * digest refresh) mount alongside the same sweep loop.
 */

export interface PostMortem {
  question: string;
  goldAnswer: string;
  ourAnswer: string;
  diagnosis: string;
}

export interface DistillStats {
  companyId: string;
  postMortems: number;
  proposed: number;
  added: number;
  updated: number;
  noop: number;
}

/**
 * A completed tool run reported by a consumer for capture (bet #3,
 * Part 3): the task it was solving, the ordered tool steps it took, and
 * the VERIFIED outcome. `steps` carry raw args/results — they are digested
 * (never stored verbatim) by toTrajectory before anything is persisted.
 */
export interface TrajectoryRun {
  task: string;
  outcome: VerifiedOutcome;
  outcomeEvidenceRef?: string | undefined;
  steps: RawToolStep[];
}

export interface TrajectoryCaptureStats {
  companyId: string;
  steps: number;
  proposed: number;
  added: number;
  updated: number;
  noop: number;
}

export interface SweepRunStats {
  tenants: number;
  scanned: number;
  deprecated: number;
  failed: number;
}

/** Hard bound per distill call (ReasoningBank: ≤3 items per batch). */
export const DISTILL_MAX_ITEMS = 3;

/** Dedup-merge neighbor count (Mem0 idiom, G4 v1: top-3). */
const MERGE_NEIGHBORS = 3;

const DISTILL_SYSTEM = `You are a strategy distiller for an answer-synthesis memory system.

You receive post-mortems of judged answers: the question, the gold answer, our answer, and a diagnosis of what went wrong (or right). Distill AT MOST ${DISTILL_MAX_ITEMS} reusable strategy items.

Rules:
- STRATEGY-LEVEL, never procedure-level: each item says WHY and WHEN an approach helps, in 2-5 sentences. Never step-by-step scripts, never verbatim answers, never question-specific facts.
- Failures become PREVENTATIVE lessons ("avoid X because Y"), not replayable procedures.
- "situation" states the preconditions: the question class, genre, or temporal shape where the item applies.
- "polarity" is "do" for a transferable strategy, "avoid" for a preventative lesson.
- Prefer fewer, more transferable items. Output zero items when the post-mortems teach nothing reusable.

Output strictly the JSON shape requested by the schema.`;

const MERGE_SYSTEM = `You are the dedup-merge arbiter for a strategy memory (Mem0-style ADD/UPDATE/NOOP).

You receive one NEW strategy item and up to ${MERGE_NEIGHBORS} EXISTING items (each with an id). Decide:
- "ADD" when the new item teaches something none of the existing items covers.
- "UPDATE" when an existing item covers the same lesson and should absorb the new one — return that item's id in "targetId", plus the merged "strategy" and "situation" texts (keep them strategy-level, 2-5 sentences).
- "NOOP" when the new item adds nothing over the existing ones.

Output strictly the JSON shape requested by the schema.`;

/**
 * Trajectory distiller (bet #3, Part 3): turn ONE completed tool run +
 * its verified outcome into a single reusable strategy item. The output
 * item is stored ALONGSIDE the concrete trajectory (advice + experience).
 *
 * Trap discipline (MemTrap): a concrete past path is MORE prone to
 * misfire on a surface-similar new task than a generic advice string, so
 * the lesson itself must stay strategy-level and transferable — the
 * trajectory is provenance, not a script to replay.
 */
const TRAJECTORY_DISTILL_SYSTEM = `You are a strategy distiller for an answer-synthesis memory system that also records the agent's tool experience.

You receive ONE completed tool run: the task, the ordered tools that were used (each marked ok/failed), and the VERIFIED outcome (success / failure / unknown). Distill AT MOST ONE reusable strategy item.

Rules:
- STRATEGY-LEVEL and TRANSFERABLE: state WHY and WHEN this kind of approach helps (or, on failure, what to avoid and why), in 2-5 sentences. NEVER a step-by-step replay of these exact tool calls, never task-specific facts, never verbatim arguments.
- A concrete past path can misfire on a surface-similar but different task — write the lesson so it only fires when its stated situation genuinely applies.
- "situation" states the preconditions (task class / shape) where the item applies.
- "polarity" is "do" for a transferable strategy (typically from a success) or "avoid" for a preventative lesson (typically from a failure).
- Output zero items when the run teaches nothing reusable.

Output strictly the JSON shape requested by the schema.`;

interface DistilledItemShape {
  title: string;
  situation: string;
  strategy: string;
  polarity: StrategyPolarity;
}

export interface MergeDecision {
  action: 'ADD' | 'UPDATE' | 'NOOP';
  targetId?: string;
  strategy?: string | undefined;
  situation?: string | undefined;
}

/**
 * Parse the merge-arbiter output. Conservative on garbage: anything
 * unparseable or with an unknown action is NOOP (no silent growth
 * from a malformed decision; the batch can be re-run). UPDATE without
 * a usable targetId also degrades to NOOP.
 */
export function parseMergeDecision(
  raw: string | null | undefined,
  knownIds: string[],
): MergeDecision {
  if (!raw) return { action: 'NOOP' };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { action: 'NOOP' };
  }
  const action = String(parsed.action ?? '').toUpperCase();
  if (action === 'ADD') return { action: 'ADD' };
  if (action === 'UPDATE') {
    const targetId = String(parsed.targetId ?? '');
    if (!knownIds.includes(targetId)) return { action: 'NOOP' };
    return {
      action: 'UPDATE',
      targetId,
      strategy:
        typeof parsed.strategy === 'string' && parsed.strategy.trim() ? parsed.strategy : undefined,
      situation:
        typeof parsed.situation === 'string' && parsed.situation.trim()
          ? parsed.situation
          : undefined,
    };
  }
  return { action: 'NOOP' };
}

/** Evidence merge for the UPDATE arm: counters add, provenance unions. */
export function mergeEvidence(
  existing: StrategyEvidence,
  incoming: StrategyEvidence,
): StrategyEvidence {
  const runIds = [...new Set([...(existing.runIds ?? []), ...(incoming.runIds ?? [])])];
  return {
    ...existing,
    ...incoming,
    ...(runIds.length > 0 ? { runIds } : {}),
    nSupport: (existing.nSupport ?? 0) + (incoming.nSupport ?? 0),
    nContradict: (existing.nContradict ?? 0) + (incoming.nContradict ?? 0),
    lastValidatedAt: incoming.lastValidatedAt ?? existing.lastValidatedAt ?? undefined,
  };
}

@Injectable()
export class StrategyDistillService {
  private readonly logger = new Logger(StrategyDistillService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly cronEnabled: boolean;
  private sweepInFlight = false;

  constructor(
    private readonly strategies: StrategyMemoryService,
    private readonly apiKeys: ApiKeyService,
    config: ConfigService,
  ) {
    this.openai = createOpenAiClientOrThrow(config);
    this.model = config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini');
    this.cronEnabled = envFlagEnabled(config.get<string>('STRATEGY_DISTILL_CRON_ENABLED'));
  }

  /**
   * Distill one post-mortem batch into ≤3 dedup-merged strategy
   * items. Every item lands as status='candidate' — activation is a
   * deliberate operator flip (PATCH), never automatic.
   */
  async distillFromPostMortems(
    companyId: string,
    postMortems: PostMortem[],
    runId?: string,
  ): Promise<DistillStats> {
    const stats: DistillStats = {
      companyId,
      postMortems: postMortems.length,
      proposed: 0,
      added: 0,
      updated: 0,
      noop: 0,
    };
    if (postMortems.length === 0) return stats;
    const items = await this.proposeItems(postMortems);
    stats.proposed = items.length;
    const evidence: StrategyEvidence = {
      source: 'post_mortem',
      ...(runId ? { runIds: [runId] } : {}),
      nSupport: 1,
      nContradict: 0,
      lastValidatedAt: new Date().toISOString(),
    };
    for (const item of items) {
      const outcome = await this.dedupMerge(companyId, item, { evidence });
      stats[outcome]++;
    }
    this.logger.log(
      `[strategy.distill] companyId=${companyId} postMortems=${stats.postMortems} ` +
        `proposed=${stats.proposed} added=${stats.added} updated=${stats.updated} noop=${stats.noop}`,
    );
    return stats;
  }

  /**
   * Capture ONE completed tool run + verified outcome as a
   * trajectory-bearing strategy item (bet #3, Part 3;
   * STRATEGY_TRAJECTORIES_ENABLED). REUSES the same Mem0 ADD/UPDATE/NOOP
   * dedup as the post-mortem path — only the distill prompt and the
   * attached experience bundle differ. The raw args/results are digested
   * (toTrajectory) BEFORE anything is proposed or stored: no secrets/PII
   * are persisted, and the LLM proposer is shown only the tool NAMES +
   * ok/fail + task, never raw payloads.
   *
   * TRAP CAVEAT (MemTrap): the stored trajectory is more prone to
   * Cognitive-Bias / Trauma fixation than a bare advice string — enabling
   * serving must ride the §4.3 lens-suppression governor + the verifier
   * answer-integrity arm. The structural containment is unchanged: the
   * trajectory reaches the GENERATOR advisory only, never the verifier or
   * citations (the G4 verifier-parity exception).
   */
  async distillFromTrajectory(
    companyId: string,
    run: TrajectoryRun,
    runId?: string,
  ): Promise<TrajectoryCaptureStats> {
    const trajectory = toTrajectory(run.steps);
    const stats: TrajectoryCaptureStats = {
      companyId,
      steps: trajectory.length,
      proposed: 0,
      added: 0,
      updated: 0,
      noop: 0,
    };
    // Defensive gate: never write trajectory columns when the flag is off
    // (the controller already 404s the capture route — belt and braces).
    if (!this.strategies.isTrajectoriesEnabled()) return stats;
    const bundle: TrajectoryBundle = {
      trajectory,
      verifiedOutcome: run.outcome,
      ...(run.outcomeEvidenceRef ? { outcomeEvidenceRef: run.outcomeEvidenceRef } : {}),
    };
    const items = await this.proposeTrajectoryItem(run, trajectory);
    stats.proposed = items.length;
    const evidence: StrategyEvidence = {
      source: 'tool_trajectory',
      ...(runId ? { runIds: [runId] } : {}),
      nSupport: 1,
      nContradict: 0,
      lastValidatedAt: new Date().toISOString(),
    };
    for (const item of items) {
      const outcome = await this.dedupMerge(companyId, item, { evidence, bundle });
      stats[outcome]++;
    }
    this.logger.log(
      `[strategy.trajectory] companyId=${companyId} steps=${stats.steps} ` +
        `proposed=${stats.proposed} added=${stats.added} updated=${stats.updated} ` +
        `noop=${stats.noop} outcome=${run.outcome}`,
    );
    return stats;
  }

  /**
   * Nightly lifecycle sweep at 03:52 UTC — after compaction (03:17)
   * and the calibration refits (03:42/03:51), before dreams (04:00).
   * Env-gated and reentrancy-guarded; per-tenant failures are
   * contained (the MemoryQualityService fan-out idiom).
   */
  @Cron('52 3 * * *', { timeZone: 'UTC' })
  async runNightlySweep(): Promise<SweepRunStats> {
    const stats: SweepRunStats = {
      tenants: 0,
      scanned: 0,
      deprecated: 0,
      failed: 0,
    };
    if (!this.cronEnabled || !this.strategies.isEnabled()) return stats;
    if (this.sweepInFlight) {
      this.logger.warn('strategy sweep skipped — previous run still in flight');
      return stats;
    }
    this.sweepInFlight = true;
    try {
      const tenants = this.apiKeys.knownCompanyIds();
      stats.tenants = tenants.length;
      for (const companyId of tenants) {
        try {
          const swept = await this.strategies.deprecateSweep(companyId);
          stats.scanned += swept.scanned;
          stats.deprecated += swept.deprecated;
        } catch (e) {
          stats.failed++;
          this.logger.warn(`strategy sweep for ${companyId} failed: ${(e as Error).message}`);
        }
      }
      return stats;
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async proposeItems(postMortems: PostMortem[]): Promise<DistilledItemShape[]> {
    const user = postMortems
      .map(
        (pm, i) =>
          `Post-mortem ${i + 1}:\n` +
          `Question: ${pm.question}\n` +
          `Gold answer: ${pm.goldAnswer}\n` +
          `Our answer: ${pm.ourAnswer}\n` +
          `Diagnosis: ${pm.diagnosis}`,
      )
      .join('\n\n');
    return (await this.proposeFromMessages(DISTILL_SYSTEM, user)).slice(0, DISTILL_MAX_ITEMS);
  }

  /**
   * Trajectory capture proposer (bet #3): one strategy item from a
   * completed tool run. The user message carries only the task, verified
   * outcome, and the tool NAMES + ok/fail — never raw args/results (those
   * were digested before this point). At most one item.
   */
  private async proposeTrajectoryItem(
    run: TrajectoryRun,
    trajectory: ToolStep[],
  ): Promise<DistilledItemShape[]> {
    const path =
      trajectory.map((s, i) => `${i + 1}. ${s.tool} — ${s.ok ? 'ok' : 'failed'}`).join('\n') ||
      '(no tool steps)';
    const user =
      `Task: ${run.task}\n` + `Verified outcome: ${run.outcome}\n` + `Tool path taken:\n${path}`;
    return (await this.proposeFromMessages(TRAJECTORY_DISTILL_SYSTEM, user)).slice(0, 1);
  }

  /**
   * Shared distill LLM call: one system+user pair through the structured
   * `distilled_strategies` schema, parsed and validated. The post-mortem
   * and trajectory proposers differ only in prompt — the schema, JSON
   * handling, and item validation are identical (and unchanged from the
   * original proposeItems body).
   */
  private async proposeFromMessages(system: string, user: string): Promise<DistilledItemShape[]> {
    const res = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'distilled_strategies',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    situation: { type: 'string' },
                    strategy: { type: 'string' },
                    polarity: { type: 'string', enum: ['do', 'avoid'] },
                  },
                  required: ['title', 'situation', 'strategy', 'polarity'],
                },
              },
            },
            required: ['items'],
          },
        },
      },
      ...chatCallParams(this.model, { temperature: 0, visibleCap: 1200 }),
    });
    const raw = res.choices?.[0]?.message?.content;
    let items: DistilledItemShape[] = [];
    try {
      const parsed = JSON.parse(raw ?? '{}') as { items?: DistilledItemShape[] };
      items = Array.isArray(parsed.items) ? parsed.items : [];
    } catch (e) {
      this.logger.warn(`distill output unparseable: ${(e as Error).message}`);
    }
    return items.filter(
      (i) =>
        typeof i.title === 'string' &&
        i.title.trim() &&
        typeof i.situation === 'string' &&
        typeof i.strategy === 'string' &&
        (i.polarity === 'do' || i.polarity === 'avoid'),
    );
  }

  /**
   * One item through the ADD/UPDATE/NOOP gate against its neighbors.
   * `bundle` (trajectory capture only) attaches the experience to the
   * created row (ADD) or the merged target (UPDATE); the post-mortem path
   * passes none and behaves exactly as before.
   */
  private async dedupMerge(
    companyId: string,
    item: DistilledItemShape,
    ctx: { evidence: StrategyEvidence; bundle?: TrajectoryBundle | undefined },
  ): Promise<'added' | 'updated' | 'noop'> {
    const neighbors = await this.strategies.findSimilar(
      companyId,
      `${item.title}\n${item.situation}`,
      MERGE_NEIGHBORS,
    );
    const decision =
      neighbors.length === 0
        ? ({ action: 'ADD' } as MergeDecision)
        : await this.decideMerge(item, neighbors);
    if (decision.action === 'UPDATE' && decision.targetId) {
      const target = neighbors.find((n) => n.strategyId === decision.targetId);
      await this.strategies.mergeUpdate(companyId, decision.targetId, {
        strategy: decision.strategy,
        situation: decision.situation,
        evidence: mergeEvidence(target?.evidence ?? {}, ctx.evidence),
        ...bundleFields(ctx.bundle),
      });
      return 'updated';
    }
    if (decision.action === 'ADD') {
      await this.createDeduped(companyId, item, ctx);
      return 'added';
    }
    return 'noop';
  }

  /** ADD arm; a unique-title collision degrades to NOOP (exact twin). */
  private async createDeduped(
    companyId: string,
    item: DistilledItemShape,
    ctx: { evidence: StrategyEvidence; bundle?: TrajectoryBundle | undefined },
  ): Promise<StrategyItem | null> {
    try {
      return await this.strategies.create(companyId, {
        ...item,
        status: 'candidate',
        evidence: ctx.evidence,
        ...bundleFields(ctx.bundle),
      });
    } catch (e) {
      this.logger.warn(`strategy ADD skipped (title '${item.title}'): ${(e as Error).message}`);
      return null;
    }
  }

  private async decideMerge(
    item: DistilledItemShape,
    neighbors: ScoredStrategyItem[],
  ): Promise<MergeDecision> {
    const user =
      `NEW item:\n${renderMergeItem(item)}\n\nEXISTING items:\n` +
      neighbors.map((n) => `id: ${n.strategyId}\n${renderMergeItem(n)}`).join('\n---\n');
    const res = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: MERGE_SYSTEM },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'merge_decision',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['ADD', 'UPDATE', 'NOOP'] },
              targetId: { type: ['string', 'null'] },
              strategy: { type: ['string', 'null'] },
              situation: { type: ['string', 'null'] },
            },
            required: ['action', 'targetId', 'strategy', 'situation'],
          },
        },
      },
      ...chatCallParams(this.model, { temperature: 0, visibleCap: 600 }),
    });
    return parseMergeDecision(
      res.choices?.[0]?.message?.content,
      neighbors.map((n) => n.strategyId),
    );
  }
}

function renderMergeItem(i: {
  title: string;
  situation: string;
  strategy: string;
  polarity: string;
}): string {
  return (
    `title: ${i.title}\npolarity: ${i.polarity}\n` +
    `situation: ${i.situation}\nstrategy: ${i.strategy}`
  );
}

/**
 * Spread the experience bundle into a create/mergeUpdate arg — empty when
 * there is no bundle (the post-mortem path), so those writes are
 * unchanged. The actual "write only when the flag is on" gate lives in
 * StrategyMemoryService.trajectoryWriteFragment.
 */
function bundleFields(bundle?: TrajectoryBundle): {
  trajectory?: ToolStep[];
  verifiedOutcome?: VerifiedOutcome;
  outcomeEvidenceRef?: string | undefined;
} {
  if (!bundle) return {};
  return {
    trajectory: bundle.trajectory,
    verifiedOutcome: bundle.verifiedOutcome,
    outcomeEvidenceRef: bundle.outcomeEvidenceRef,
  };
}
