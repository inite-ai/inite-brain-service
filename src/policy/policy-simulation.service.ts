import { BadRequestException, Injectable } from '@nestjs/common';
import { SearchService } from '../search/search.service';
import { policyFor } from '../ingest/conflict-resolver';
import { getAbortSignal, getCorrelationId, runWithRequestContext } from '../common/request-context';
import { ACTIONS } from './action-registry';
import { compilePolicySet } from './policy-compile';
import { evaluateAction, evaluateRow, sourceRuleMatches, toRowView } from './policy-engine';
import { PolicyStoreService } from './policy-store.service';
import {
  CompiledPolicySet,
  PolicyContext,
  PolicyDecision,
  PolicyDocument,
  PolicyDocumentSchema,
  PolicyRule,
  SetVerdict,
} from './policy.types';

/** Normalized simulation subject (the controller resolves keyId → names). */
export interface SimulationSubject {
  policyNames?: string[];
  /** Unsaved draft document from the editor — validated here. */
  inline?: unknown;
  /** Treat every resolved set as enforce ("what if I promoted it"). */
  modeOverride?: 'enforce';
}

export interface SimulationReason {
  policySet: string;
  ruleId: string | null;
  effect: 'allow' | 'deny';
  kind: 'action' | 'source' | 'posture';
  detail: string;
}

export interface SimulateSearchResult {
  summary: { total: number; visible: number; denied: number; wouldDeny: number };
  rows: Array<{
    factId: string;
    entityId: string;
    entityType: string;
    canonicalName: string;
    predicate: string;
    object: string;
    confidence: number;
    score: number;
    source: { vertical?: string; recorder?: string; meta?: Record<string, unknown> };
    decision: PolicyDecision;
    reasons: SimulationReason[];
  }>;
}

export interface SimulateActionsResult {
  actions: Array<{
    name: string;
    family: string;
    kind: string;
    decision: PolicyDecision;
    reasons: SimulationReason[];
  }>;
}

const PREVIEW_SAMPLE_LIMIT = 5_000;

/**
 * The Key Lens backend: run a REAL search over the tenant's data and
 * annotate every row with the subject's would-be verdict — including
 * the denied rows (that diff is the whole point; the endpoint is
 * brain:admin-gated). Zep's explain covers one action at a time; this
 * simulates the full retrieval surface against live data.
 *
 * The internal search runs under the CALLER's scopes with the caller's
 * own ABAC context suppressed (a fresh request context), so the base
 * view is the admin's full view, and the subject's policy is evaluated
 * on top without ever being enforced.
 */
@Injectable()
export class PolicySimulationService {
  constructor(
    private readonly search: SearchService,
    private readonly store: PolicyStoreService,
  ) {}

  async resolveSubject(companyId: string, subject: SimulationSubject): Promise<PolicyContext> {
    const sets: CompiledPolicySet[] = [];
    if (subject.inline !== undefined) {
      const parsed = PolicyDocumentSchema.safeParse(subject.inline);
      if (!parsed.success) {
        throw new BadRequestException({
          error: 'invalid_policy_document',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
      }
      const compiled = this.compile(parsed.data, subject.modeOverride);
      if (compiled) sets.push(compiled);
    }
    for (const name of subject.policyNames ?? []) {
      const stored = await this.store.get(companyId, String(name));
      const compiled = this.compile(stored.document, subject.modeOverride);
      if (compiled) sets.push(compiled);
    }
    if (sets.length === 0) {
      throw new BadRequestException('Simulation subject resolves to zero enabled policy sets');
    }
    return {
      companyId,
      keyHash: 'simulate',
      sets,
      forceReportOnly: false,
      resolutionError: false,
    };
  }

  async simulateSearch(opts: {
    companyId: string;
    ctx: PolicyContext;
    callerScopes: string[];
    query: { query: string; limit?: number; asOf?: string };
  }): Promise<SimulateSearchResult> {
    const { companyId, ctx, callerScopes, query } = opts;
    // Fresh request context: the base search must reflect the ADMIN's
    // full view — the admin's own policy (if any) is suppressed, the
    // subject's policy is evaluated per-row below, never enforced.
    const { results } = await runWithRequestContext(
      {
        correlationId: getCorrelationId() ?? 'policy-simulate',
        abortSignal: getAbortSignal(),
      },
      () =>
        this.search.search(
          companyId,
          {
            query: query.query,
            limit: query.limit ?? 10,
            ...(query.asOf ? { asOf: query.asOf } : {}),
          } as never,
          callerScopes,
        ),
    );

    const flat = results.flatMap((hit) => (hit.facts ?? []).map((fact) => ({ hit, fact })));
    const views = await this.store.loadFactViews(
      companyId,
      flat.map(({ fact }) => fact.factId),
    );

    const rows: SimulateSearchResult['rows'] = flat.map(({ hit, fact }) => {
      const view = views.get(fact.factId);
      const evaluation = view
        ? evaluateRow(
            ctx,
            toRowView(view, (p) => policyFor(p).piiClass),
          )
        : { decision: 'allow' as PolicyDecision, verdicts: [] as SetVerdict[] };
      const src = (view?.source ?? {}) as Record<string, unknown>;
      return {
        factId: fact.factId,
        entityId: hit.entityId,
        entityType: hit.entityType,
        canonicalName: hit.canonicalName,
        predicate: fact.predicate,
        object: fact.object,
        confidence: fact.confidence,
        score: fact.score,
        source: {
          ...(typeof src.vertical === 'string' ? { vertical: src.vertical } : {}),
          ...(typeof src.recorder === 'string' ? { recorder: src.recorder } : {}),
          ...(src.meta && typeof src.meta === 'object'
            ? { meta: src.meta as Record<string, unknown> }
            : {}),
        },
        decision: evaluation.decision,
        reasons: this.reasonsOf(ctx, evaluation.verdicts, 'source'),
      };
    });

    const denied = rows.filter((r) => r.decision === 'deny').length;
    const wouldDeny = rows.filter((r) => r.decision === 'would_deny').length;
    return {
      summary: {
        total: rows.length,
        visible: rows.length - denied,
        denied,
        wouldDeny,
      },
      rows,
    };
  }

  simulateActions(ctx: PolicyContext): SimulateActionsResult {
    return {
      actions: Object.entries(ACTIONS).map(([name, spec]) => {
        const evaluation = evaluateAction(ctx, name);
        return {
          name,
          family: spec.family,
          kind: spec.kind,
          decision: evaluation.decision,
          reasons: this.reasonsOf(ctx, evaluation.verdicts, 'action'),
        };
      }),
    };
  }

  /**
   * Approximate live match count for one rule (the editor's "~1,234
   * facts match" line). Samples up to PREVIEW_SAMPLE_LIMIT recent
   * active facts — documented as approximate; exactness is not worth a
   * full-table policy scan per keystroke.
   */
  async previewRule(
    companyId: string,
    rule: unknown,
  ): Promise<{
    matched: number;
    sampled: number;
    sample: Array<{
      factId: string;
      predicate: string;
      source: { vertical?: string; recorder?: string };
    }>;
  }> {
    const doc = PolicyDocumentSchema.safeParse({
      name: 'preview-probe',
      posture: { actions: 'allow', reads: 'allow' },
      mode: 'enforce',
      rules: [rule],
    });
    if (!doc.success) {
      throw new BadRequestException({
        error: 'invalid_rule',
        issues: doc.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const parsedRule = doc.data.rules[0];
    if (!parsedRule || parsedRule.kind !== 'source') {
      throw new BadRequestException('preview-rule only applies to source rules');
    }
    const compiled = this.compile(doc.data);
    const compiledRule = [...(compiled?.sourceDeny ?? []), ...(compiled?.sourceAllow ?? [])][0];
    if (!compiledRule) {
      throw new BadRequestException('Rule is disabled — nothing to preview');
    }

    const views = await this.store.sampleFactViews(companyId, PREVIEW_SAMPLE_LIMIT);
    let matched = 0;
    const sample: Array<{
      factId: string;
      predicate: string;
      source: { vertical?: string; recorder?: string };
    }> = [];
    for (const view of views) {
      const rowView = toRowView(view, (p) => policyFor(p).piiClass);
      if (!sourceRuleMatches(compiledRule, rowView)) continue;
      matched += 1;
      if (sample.length < 3) {
        const src = (view.source ?? {}) as Record<string, unknown>;
        sample.push({
          factId: String(view.id ?? ''),
          predicate: view.predicate,
          source: {
            ...(typeof src.vertical === 'string' ? { vertical: src.vertical } : {}),
            ...(typeof src.recorder === 'string' ? { recorder: src.recorder } : {}),
          },
        });
      }
    }
    return { matched, sampled: views.length, sample };
  }

  private compile(doc: PolicyDocument, modeOverride?: 'enforce'): CompiledPolicySet | null {
    return compilePolicySet(
      modeOverride && doc.mode !== 'disabled' ? { ...doc, mode: modeOverride } : doc,
    );
  }

  /** Human-readable per-set reasons for a deny/would_deny verdict. */
  private reasonsOf(
    ctx: PolicyContext,
    verdicts: SetVerdict[],
    domain: 'action' | 'source',
  ): SimulationReason[] {
    const reasons: SimulationReason[] = [];
    for (const v of verdicts) {
      if (v.verdict !== 'deny') continue;
      const set = ctx.sets.find((s) => s.name === v.policySet);
      const rule = set?.document.rules.find((r) => r.id === v.ruleId);
      reasons.push({
        policySet: v.policySet,
        ruleId: v.ruleId,
        effect: 'deny',
        kind: v.ruleId ? domain : 'posture',
        detail: rule
          ? describeRule(rule)
          : `default ${domain === 'action' ? 'actions' : 'reads'} posture (deny)`,
      });
    }
    return reasons;
  }
}

function describeRule(rule: PolicyRule): string {
  if (rule.kind === 'action') {
    return `${rule.id}: actions [${(rule.actions ?? []).join(', ')}]`;
  }
  const conds = (rule.match ?? [])
    .map((c) => `${c.attr} ${c.op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ''}`)
    .join(' AND ');
  return `${rule.id}: ${conds}`;
}
