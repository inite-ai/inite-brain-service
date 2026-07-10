import { ForbiddenException, Injectable } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { ApiKeyRecord } from '../auth/api-key.types';
import { getCorrelationId } from '../common/request-context';
import { evaluateAction } from './policy-engine';
import { PolicyDecisionSink } from './policy-decision.sink';
import { PolicyResolverService } from './policy-resolver.service';
import { PolicyContext } from './policy.types';
import { RowDecisionSummary } from './row-filter';

/**
 * Action-level ABAC gate, bundled behind one injectable so ApiKeyGuard
 * keeps its ≤3-dependency shape (same extraction rationale as
 * CredentialResolverService). Resolves the key's PolicyContext, applies
 * the action verdict, and owns decision telemetry (metrics always;
 * decision rows for every deny/would_deny, sampled for allows).
 *
 * Routes that must not be action-gated (the MCP transport — its tools
 * are gated individually inside McpService) mark themselves
 * @PolicyAction(POLICY_ACTION_EXEMPT): the context still resolves and
 * flows downstream, only the action verdict is skipped.
 */
export const POLICY_ACTION_EXEMPT = '@exempt';

@Injectable()
export class PolicyGateService {
  private readonly sampleRate: number;

  constructor(
    private readonly resolver: PolicyResolverService,
    private readonly sink: PolicyDecisionSink,
    private readonly metrics: MetricsService,
  ) {
    // ConfigService is deliberately not injected (4th dep) — the rate
    // is process-static anyway.
    const raw = parseFloat(process.env.POLICY_DECISION_SAMPLE_RATE ?? '0.01');
    this.sampleRate = Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.01;
  }

  /**
   * Resolve the key's policy context and enforce the action verdict.
   * Returns undefined when ABAC is off / no sets attached. Throws 403
   * policy_denied when an enforce-mode set denies the action.
   */
  async gate(
    record: ApiKeyRecord,
    action: string,
    requestId?: string,
  ): Promise<PolicyContext | undefined> {
    const ctx = await this.resolver.contextFor(
      record.companyId,
      record.keyHash,
      record.policyNames,
    );
    if (!ctx) return undefined;
    if (action !== POLICY_ACTION_EXEMPT) {
      this.enforceAction(ctx, action, requestId);
    }
    return ctx;
  }

  /**
   * Shared by the REST gate above and McpService's per-tool wrappers.
   * Emits metrics + decision rows and throws on an enforced deny.
   */
  enforceAction(ctx: PolicyContext, action: string, requestId?: string): void {
    const evaluation = evaluateAction(ctx, action);
    const denies = evaluation.verdicts.filter((v) => v.verdict === 'deny');
    const decided = denies[0];

    for (const v of denies) {
      const enforced =
        v.mode === 'enforce' && !ctx.forceReportOnly && evaluation.decision === 'deny';
      const decision = enforced ? 'deny' : 'would_deny';
      this.metrics.countPolicyDecision(decision, 'action', v.mode);
      this.sink.record(ctx.companyId, {
        keyHash: ctx.keyHash,
        kind: 'action',
        decision,
        mode: v.mode,
        action,
        policySet: v.policySet,
        ruleId: v.ruleId ?? undefined,
        requestId,
      });
    }

    if (denies.length === 0) {
      this.metrics.countPolicyDecision('allow', 'action', 'enforce');
      if (Math.random() < this.sampleRate) {
        this.sink.record(ctx.companyId, {
          keyHash: ctx.keyHash,
          kind: 'action',
          decision: 'allow',
          mode: 'enforce',
          action,
          requestId,
          sampled: true,
        });
      }
    }

    if (evaluation.decision === 'deny') {
      throw new ForbiddenException({
        error: 'policy_denied',
        action,
        policySet: decided?.policySet,
        ruleId: decided?.ruleId ?? null,
      });
    }
  }

  /**
   * Sink + metrics for one read surface's aggregated row decisions
   * (bound into the request context by ApiKeyGuard, consumed by
   * makeRowPolicyFilter.finish()). Row decisions are per-request
   * aggregates — one sink row per (surface × policy set × outcome),
   * never one per fact.
   */
  recordRowSummary(ctx: PolicyContext, summary: RowDecisionSummary): void {
    this.metrics.observePolicyEval(summary.evalSeconds);
    const requestId = getCorrelationId();
    let anyDeny = false;

    for (const s of summary.perSet) {
      for (const [decision, count] of [
        ['deny', s.denied],
        ['would_deny', s.wouldDeny],
      ] as const) {
        if (count === 0) continue;
        anyDeny = true;
        this.metrics.countPolicyDecision(decision, 'row', s.mode);
        this.sink.record(ctx.companyId, {
          keyHash: ctx.keyHash,
          kind: 'row',
          decision,
          mode: s.mode,
          action: summary.surface,
          policySet: s.policySet,
          ruleId: s.ruleIds[0],
          requestId,
          rowCounts: { total: summary.total, denied: count },
          sampleFactIds: s.sampleFactIds,
          samplePredicates: s.samplePredicates,
        });
      }
    }

    if (!anyDeny) {
      this.metrics.countPolicyDecision('allow', 'row', 'enforce');
      if (Math.random() < this.sampleRate) {
        this.sink.record(ctx.companyId, {
          keyHash: ctx.keyHash,
          kind: 'row',
          decision: 'allow',
          mode: 'enforce',
          action: summary.surface,
          requestId,
          rowCounts: { total: summary.total, denied: 0 },
          sampled: true,
        });
      }
    }
  }
}
