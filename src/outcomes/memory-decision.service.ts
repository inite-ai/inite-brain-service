import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { outcomeDecisionCaptureEnabled } from '../common/outcome-flags';
import {
  getCorrelationId,
  getRequestContext,
  type RequestContext,
} from '../common/request-context';

/**
 * MemoryDecisionService — the ONE write seam for memory_decision rows
 * (migration 0119): decision-context telemetry for the serving path's
 * policy decisions (the abstain gate, the L3 escalation trigger, and —
 * MM-zoom PR3 — the fragment-zoom step; 'lane_route' reserves the
 * audit's remaining seam).
 *
 * Discipline (the ToolObservationService/MemoryOutcomeService idiom):
 *   * master-flag guard INSIDE the service (OUTCOME_DECISION_CAPTURE,
 *     an independent master — deliberately NOT coupled to
 *     OUTCOME_TELEMETRY_ENABLED, the TOOL_OBSERVATIONS_ENABLED
 *     precedent) — callers may cheaply check too via the static;
 *   * fire-and-forget on a fresh ROOT-pool connection; a failure warns,
 *     NEVER errors or slows the decision it records;
 *   * deterministic record id + INSERT IGNORE (the #92 idiom): an
 *     upstream replay recomputes the same id, collides on the primary
 *     key, and no-ops — replay-safe with NO retry machinery;
 *   * every stored field is whitelisted/capped by the pure shaper.
 *
 * Rows are CONTENT-FREE by contract: ids / enums / numbers only — never
 * query text, never fact text, never answer text. That keeps the table
 * outside the PII reconstruction surface; GDPR purges it via the
 * memory_outcome.decisionId join (decisions carry no subject linkage by
 * design — see the forget services).
 */

/** The decision seams 0119 reserves. 'l3_escalation'/'abstain' got their
 *  writers with 0119, 'zoom' with MM-zoom PR3 (decision-emit.ts
 *  captureZoomDecision); 'lane_route' still reserves its seam. */
export type DecisionKind = 'l3_escalation' | 'abstain' | 'lane_route' | 'zoom';

/** Cap on the alternatives array (contract-bounded row size). */
export const DECISION_ALTERNATIVES_CAP = 8;

/** Cap on observedState.queryClass (a LaneId/'default' in practice). */
export const DECISION_QUERY_CLASS_CAP = 64;

/** Cap on opaque id / enum-ish string fields (requestId, chosenAction,
 *  policyVersion, alternatives[*].action). */
export const DECISION_STRING_CAP = 128;

export interface DecisionInput {
  decisionKind: DecisionKind;
  /** Which policy produced the decision, e.g. 'static' or
   *  'adaptive@thr=0.5' — an id-like tag, never free text. */
  policyVersion: string;
  /** e.g. 'escalate' / 'skip:<reason>' (l3), 'abstain' / 'proceed'. */
  chosenAction: string;
  /** Correlation id override; defaults to the ALS correlation id. */
  requestId?: string | undefined;
  /** Signal numbers at decision time — WHITELISTED by the shaper: only
   *  {topScore, coverageScore, retrievalGap, rawConfidence,
   *  candidateCount: finite numbers; queryClass: string ≤64} survive. */
  observedState?: Record<string, unknown> | undefined;
  /** Calibrated confidence of the chosen action, when one exists. */
  actionScore?: number | undefined;
  /** Considered actions with their scores; capped at 8. */
  alternatives?: ReadonlyArray<{ action: string; score: number }> | undefined;
  /** Decision-time costs; ints only, absent fields stay NONE. */
  costs?:
    | {
        latencyMs?: number | undefined;
        promptTokens?: number | undefined;
        completionTokens?: number | undefined;
        toolCalls?: number | undefined;
      }
    | undefined;
}

/** Row shape handed to INSERT — exported for the unit spec. */
export interface DecisionRow {
  decisionId: string;
  companyId: string;
  decisionKind: DecisionKind;
  policyVersion: string;
  chosenAction: string;
  requestId?: string;
  observedState?: Record<string, number | string>;
  actionScore?: number;
  alternatives?: Array<{ action: string; score: number }>;
  costs?: Record<string, number>;
}

/**
 * Per-request, per-kind decision counter (the D5 kindSeq): the id input
 * is `requestScope|decisionKind|kindSeq`, so a second decision of the
 * same kind in one request (should not occur at today's seams, but the
 * contract tolerates it) stays a distinct row while an upstream replay
 * of the whole request recomputes identical ids. WeakMap keyed on the
 * ALS context; no context → seq 0 (the randomUUID scope fallback
 * already makes the call unique).
 */
const kindSeqByContext = new WeakMap<RequestContext, Partial<Record<DecisionKind, number>>>();

function nextKindSeq(kind: DecisionKind): number {
  const ctx = getRequestContext();
  if (!ctx) return 0;
  const seqs = kindSeqByContext.get(ctx) ?? {};
  const seq = seqs[kind] ?? 0;
  seqs[kind] = seq + 1;
  kindSeqByContext.set(ctx, seqs);
  return seq;
}

/** Deterministic decision id: sha256(requestScope|kind|kindSeq), first
 *  32 hex chars — hex tail ⇒ unquoted-safe record id (the #92 idiom).
 *  Pure and exported for the unit spec. */
export function decisionEventId(requestScope: string, kind: DecisionKind, kindSeq: number): string {
  return createHash('sha256')
    .update(`${requestScope}|${kind}|${kindSeq}`)
    .digest('hex')
    .slice(0, 32);
}

@Injectable()
export class MemoryDecisionService {
  private readonly logger = new Logger(MemoryDecisionService.name);

  constructor(private readonly surreal: SurrealService) {}

  /**
   * Master-flag check, exposed as a static so the engine dirs (S5.2 —
   * no process.env below the profile boundary) can gate cheaply via the
   * service class, the MemoryOutcomeService.enabled() idiom.
   */
  static enabled(): boolean {
    return outcomeDecisionCaptureEnabled();
  }

  /**
   * Record one decision row — fire-and-forget, replay-safe via the
   * deterministic id + INSERT IGNORE (no retry by design). Returns the
   * decisionId (the join key the caller threads onto outcome rows and
   * focus samples), or undefined when capture is off.
   */
  record(companyId: string, input: DecisionInput): string | undefined {
    if (!outcomeDecisionCaptureEnabled()) return undefined;
    // Captured SYNCHRONOUSLY — ALS is dead inside the detached promise.
    const correlated = input.requestId ?? getCorrelationId();
    const decisionId = decisionEventId(
      correlated ?? randomUUID(),
      input.decisionKind,
      nextKindSeq(input.decisionKind),
    );
    const row = shapeDecisionRow(input, { decisionId, companyId, requestId: correlated });
    void this.surreal
      .withCompany(companyId, async (db) => {
        await db.query('INSERT IGNORE INTO memory_decision $row', {
          row: { id: new StringRecordId(`memory_decision:${decisionId}`), ...row },
        });
      })
      .catch((e: Error) => {
        this.logger.warn(
          `decision insert failed (kind=${input.decisionKind}, companyId=${companyId}): ${e.message}`,
        );
      });
    return decisionId;
  }
}

const OBSERVED_NUMBER_KEYS = [
  'topScore',
  'coverageScore',
  'retrievalGap',
  'rawConfidence',
  'candidateCount',
] as const;

/** The observedState whitelist: ONLY the contracted signal numbers +
 *  a capped queryClass survive; everything else is DROPPED (that is what
 *  keeps the FLEXIBLE column content-free). */
function whitelistObservedState(
  state: Record<string, unknown>,
): Record<string, number | string> | undefined {
  const out: Record<string, number | string> = {};
  for (const key of OBSERVED_NUMBER_KEYS) {
    const v = state[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  const qc = state['queryClass'];
  if (typeof qc === 'string' && qc.length > 0) {
    out['queryClass'] = qc.slice(0, DECISION_QUERY_CLASS_CAP);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const COST_KEYS = ['latencyMs', 'promptTokens', 'completionTokens', 'toolCalls'] as const;

/** costs.* are int columns — keep only finite non-negative integers. */
function shapeCosts(
  costs: NonNullable<DecisionInput['costs']>,
): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const key of COST_KEYS) {
    const v = costs[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = Math.round(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Pure row shaper — exported for the content-free unit spec. Whitelists
 * observedState, caps alternatives at 8 (action/score pairs ONLY — any
 * extra fields are dropped), bounds every string, and keeps only finite
 * numbers. `propensity` is deliberately never stamped in this PR: no
 * stochastic policy exists; the 0119 column is the contract for future
 * bandit work.
 */
export function shapeDecisionRow(
  input: DecisionInput,
  ctx: { decisionId: string; companyId: string; requestId?: string | undefined },
): DecisionRow {
  const row: DecisionRow = {
    decisionId: ctx.decisionId,
    companyId: ctx.companyId,
    decisionKind: input.decisionKind,
    policyVersion: input.policyVersion.slice(0, DECISION_STRING_CAP),
    chosenAction: input.chosenAction.slice(0, DECISION_STRING_CAP),
  };
  if (ctx.requestId !== undefined) {
    row.requestId = ctx.requestId.slice(0, DECISION_STRING_CAP);
  }
  if (input.observedState !== undefined) {
    const state = whitelistObservedState(input.observedState);
    if (state) row.observedState = state;
  }
  if (typeof input.actionScore === 'number' && Number.isFinite(input.actionScore)) {
    row.actionScore = input.actionScore;
  }
  if (input.alternatives !== undefined) {
    const alts = input.alternatives
      .filter((a) => typeof a.action === 'string' && Number.isFinite(a.score))
      .slice(0, DECISION_ALTERNATIVES_CAP)
      .map((a) => ({ action: a.action.slice(0, DECISION_STRING_CAP), score: a.score }));
    if (alts.length > 0) row.alternatives = alts;
  }
  if (input.costs !== undefined) {
    const costs = shapeCosts(input.costs);
    if (costs) row.costs = costs;
  }
  return row;
}
