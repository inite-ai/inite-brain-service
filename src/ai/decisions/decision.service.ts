import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JevClient } from './jev.client';
import { MetricsService } from '../../metrics/metrics.service';
import {
  certaintyOf,
  type DecisionAnswer,
  type DecisionRequest,
  type DecisionResponse,
} from './decision.types';

/**
 * The lanes that ask for a decision rather than a generation. Each one names a
 * judgement the service used to put to a chat model as "answer in JSON, one
 * token please" — the call sites that already ask for `reasoning_effort: none`
 * because there is nothing to think about in prose.
 */
export type DecisionLane =
  | 'entity_judge'
  | 'verifier'
  | 'predicate_identity'
  | 'predicate_semantics'
  | 'reranker'
  | 'chat_router'
  | 'dream_resolver'
  | 'dream_corroborate';

/**
 * Routes a lane's decision to the System One plane, and tells the caller when
 * the answer is too uncertain to act on.
 *
 * The contract every lane follows:
 *
 *   * `decide()` returns null when the lane is not on the decision plane, the
 *     plane has no key, or the call failed. Null means "use the path you had",
 *     never "the answer is no" — a decision plane that degrades into a default
 *     verdict is a silent quality regression.
 *   * `confident()` is the gate. A calibrated probability is only worth having
 *     if something reads it: below the lane's floor the caller escalates to the
 *     reasoning model it used before. That is the whole bargain — a decision at
 *     a tenth of the latency and a fifth of the price for the many easy cases,
 *     the expensive model for the few genuinely hard ones.
 *
 * Lanes are opted in one at a time through `DECISIONS_LANES`, because "is this
 * lane better on the decision plane" is a measurement per lane (and per
 * language — the model's own documentation says non-English is weaker), not a
 * global switch.
 */
@Injectable()
export class DecisionService {
  private readonly logger = new Logger(DecisionService.name);
  private readonly lanes: Set<string>;
  private readonly floor: number;
  private readonly perLaneFloor = new Map<DecisionLane, number>();

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly jev?: JevClient,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.lanes = new Set(
      (config.get<string>('DECISIONS_LANES', '') || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    );
    this.floor = Number.parseFloat(config.get<string>('DECISIONS_CONFIDENCE_FLOOR', '0.7'));
  }

  /** Is this lane served by the decision plane at all? */
  enabled(lane: DecisionLane): boolean {
    if (!this.jev?.available()) return false;
    return this.lanes.has(lane) || this.lanes.has('all');
  }

  /** The certainty a lane's answer must reach before the caller may act on it. */
  floorFor(lane: DecisionLane): number {
    const cached = this.perLaneFloor.get(lane);
    if (cached !== undefined) return cached;
    const raw = this.config.get<string>(
      `DECISIONS_CONFIDENCE_FLOOR_${lane.toUpperCase()}`,
      String(this.floor),
    );
    const parsed = Number.parseFloat(raw);
    const value = Number.isFinite(parsed) ? parsed : this.floor;
    this.perLaneFloor.set(lane, value);
    return value;
  }

  /**
   * True when this answer is certain enough for the lane to act on — and the
   * one place the outcome is counted, so `brain_decisions_total` tells acted
   * from escalated without every lane remembering to say so.
   */
  confident(lane: DecisionLane, answer: DecisionAnswer): boolean {
    const ok = certaintyOf(answer) >= this.floorFor(lane);
    this.metrics?.countDecision(lane, ok ? 'acted' : 'escalated');
    return ok;
  }

  async decide(lane: DecisionLane, req: DecisionRequest): Promise<DecisionResponse | null> {
    if (!this.enabled(lane)) return null;
    const res = await this.jev!.decide(req, lane);
    if (res === null) {
      this.logger.debug(`[${lane}] decision plane returned nothing — falling back`);
      this.metrics?.countDecision(lane, 'unanswered');
    }
    return res;
  }
}
