import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type OpenAI from 'openai';
import {
  chatCallParams,
  createOpenAiClientOrThrow,
} from '../ai/openai-client';
import { ApiKeyService } from '../auth/api-key.service';
import { envFlagEnabled } from '../common/env-validation';
import {
  StrategyMemoryService,
  type ScoredStrategyItem,
  type StrategyEvidence,
  type StrategyItem,
  type StrategyPolarity,
} from './strategy-memory.service';

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
        typeof parsed.strategy === 'string' && parsed.strategy.trim()
          ? parsed.strategy
          : undefined,
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
  const runIds = [
    ...new Set([...(existing.runIds ?? []), ...(incoming.runIds ?? [])]),
  ];
  return {
    ...existing,
    ...incoming,
    ...(runIds.length > 0 ? { runIds } : {}),
    nSupport: (existing.nSupport ?? 0) + (incoming.nSupport ?? 0),
    nContradict: (existing.nContradict ?? 0) + (incoming.nContradict ?? 0),
    lastValidatedAt:
      incoming.lastValidatedAt ?? existing.lastValidatedAt ?? undefined,
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
    this.cronEnabled = envFlagEnabled(
      config.get<string>('STRATEGY_DISTILL_CRON_ENABLED'),
    );
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
      const outcome = await this.dedupMerge(companyId, item, evidence);
      stats[outcome]++;
    }
    this.logger.log(
      `[strategy.distill] companyId=${companyId} postMortems=${stats.postMortems} ` +
        `proposed=${stats.proposed} added=${stats.added} updated=${stats.updated} noop=${stats.noop}`,
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
          this.logger.warn(
            `strategy sweep for ${companyId} failed: ${(e as Error).message}`,
          );
        }
      }
      return stats;
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async proposeItems(
    postMortems: PostMortem[],
  ): Promise<DistilledItemShape[]> {
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
    const res = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: DISTILL_SYSTEM },
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
    return items
      .filter(
        (i) =>
          typeof i.title === 'string' &&
          i.title.trim() &&
          typeof i.situation === 'string' &&
          typeof i.strategy === 'string' &&
          (i.polarity === 'do' || i.polarity === 'avoid'),
      )
      .slice(0, DISTILL_MAX_ITEMS);
  }

  /** One item through the ADD/UPDATE/NOOP gate against its neighbors. */
  private async dedupMerge(
    companyId: string,
    item: DistilledItemShape,
    evidence: StrategyEvidence,
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
        evidence: mergeEvidence(target?.evidence ?? {}, evidence),
      });
      return 'updated';
    }
    if (decision.action === 'ADD') {
      await this.createDeduped(companyId, item, evidence);
      return 'added';
    }
    return 'noop';
  }

  /** ADD arm; a unique-title collision degrades to NOOP (exact twin). */
  private async createDeduped(
    companyId: string,
    item: DistilledItemShape,
    evidence: StrategyEvidence,
  ): Promise<StrategyItem | null> {
    try {
      return await this.strategies.create(companyId, {
        ...item,
        status: 'candidate',
        evidence,
      });
    } catch (e) {
      this.logger.warn(
        `strategy ADD skipped (title '${item.title}'): ${(e as Error).message}`,
      );
      return null;
    }
  }

  private async decideMerge(
    item: DistilledItemShape,
    neighbors: ScoredStrategyItem[],
  ): Promise<MergeDecision> {
    const user =
      `NEW item:\n${renderMergeItem(item)}\n\nEXISTING items:\n` +
      neighbors
        .map((n) => `id: ${n.strategyId}\n${renderMergeItem(n)}`)
        .join('\n---\n');
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
