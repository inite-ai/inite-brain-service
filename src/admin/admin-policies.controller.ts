import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { PolicyStoreService, StoredPolicySet } from '../policy/policy-store.service';
import { compilePolicySet } from '../policy/policy-compile';
import {
  evaluateAction,
  evaluateRow,
  explainAction,
  explainRow,
  toRowView,
} from '../policy/policy-engine';
import { policyFor } from '../ingest/conflict-resolver';
import { CompiledPolicySet, PolicyContext } from '../policy/policy.types';
import type {
  PolicyBindingsResponse,
  PolicyExplainResponse,
  PolicySetDeleteResponse,
  PolicySetResponse,
  PolicySetsListResponse,
  PolicySetWire,
} from '../contracts/admin/policies.schema';

/**
 * ABAC policy-set CRUD + attachments + decision explain. The rule
 * documents themselves are validated by PolicyDocumentSchema inside
 * PolicyStoreService (zod, strict caps) — this controller owns HTTP
 * shape only. Tenancy comes from the token (`req.brainAuth.companyId`),
 * never a param, per house convention.
 */
@Controller('v1/admin/policy-sets')
@UseGuards(ApiKeyGuard)
export class AdminPoliciesController {
  constructor(private readonly store: PolicyStoreService) {}

  @Get()
  @RequireScopes('brain:admin')
  async list(@Req() req: AuthenticatedRequest): Promise<PolicySetsListResponse> {
    const sets = await this.store.list(req.brainAuth.companyId);
    return { policySets: sets.map(toWire) } satisfies PolicySetsListResponse;
  }

  @Post()
  @RequireScopes('brain:admin')
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<PolicySetResponse> {
    const created = await this.store.create(req.brainAuth.companyId, body, actorOf(req));
    return { policySet: toWire(created) } satisfies PolicySetResponse;
  }

  @Get(':name')
  @RequireScopes('brain:admin')
  async get(
    @Req() req: AuthenticatedRequest,
    @Param('name') name: string,
  ): Promise<PolicySetResponse> {
    const found = await this.store.get(req.brainAuth.companyId, name);
    return { policySet: toWire(found) } satisfies PolicySetResponse;
  }

  /**
   * Whole-document replace with optimistic concurrency: the body is the
   * policy document plus the `version` the client loaded. A stale
   * version 409s with the current copy so the UI can offer a reload.
   */
  @Put(':name')
  @RequireScopes('brain:admin')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('name') name: string,
    @Body() body: { version?: unknown } & Record<string, unknown>,
  ): Promise<PolicySetResponse> {
    const version = Number(body?.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException('version (int ≥ 1) is required');
    }
    const { version: _v, ...document } = body;
    const updated = await this.store.update(req.brainAuth.companyId, name, {
      body: document,
      expectedVersion: version,
      updatedBy: actorOf(req),
    });
    return { policySet: toWire(updated) } satisfies PolicySetResponse;
  }

  @Delete(':name')
  @RequireScopes('brain:admin')
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('name') name: string,
  ): Promise<PolicySetDeleteResponse> {
    await this.store.remove(req.brainAuth.companyId, name);
    return { deleted: name } satisfies PolicySetDeleteResponse;
  }

  @Get('bindings/all')
  @RequireScopes('brain:admin')
  async bindings(@Req() req: AuthenticatedRequest): Promise<PolicyBindingsResponse> {
    const bindings = await this.store.listBindings(req.brainAuth.companyId);
    return { bindings } satisfies PolicyBindingsResponse;
  }

  @Post(':name/attachments')
  @RequireScopes('brain:admin')
  async attachments(
    @Req() req: AuthenticatedRequest,
    @Param('name') name: string,
    @Body() body: { attach?: string[]; detach?: string[] },
  ): Promise<PolicySetResponse> {
    const attach = body?.attach ?? [];
    const detach = body?.detach ?? [];
    if (!Array.isArray(attach) || !Array.isArray(detach)) {
      throw new BadRequestException('attach/detach must be arrays of subjects');
    }
    if (attach.length === 0 && detach.length === 0) {
      throw new BadRequestException('Nothing to do: attach and detach are empty');
    }
    const updated = await this.store.updateAttachments(req.brainAuth.companyId, name, {
      attach,
      detach,
    });
    return { policySet: toWire(updated) } satisfies PolicySetResponse;
  }

  /**
   * Batched source.meta backfill for facts committed before the
   * metadata projection existed. Idempotent (only facts with no meta
   * are touched) — repeat until `remaining` is 0 and `factsUpdated`
   * stays 0.
   */
  @Post('backfill-meta')
  @RequireScopes('brain:admin')
  async backfillMeta(
    @Req() req: AuthenticatedRequest,
    @Body() body: { maxDocs?: number },
  ): Promise<{ documentsProcessed: number; factsUpdated: number; remaining: number }> {
    const maxDocs =
      Number.isInteger(body?.maxDocs) && (body.maxDocs as number) > 0
        ? Math.min(body.maxDocs as number, 1000)
        : 200;
    return this.store.backfillSourceMeta(req.brainAuth.companyId, maxDocs);
  }

  /**
   * Single-decision explain (Zep's `zepctl api-key explain`, but with
   * per-rule field traces). Evaluates the named sets as one context —
   * `action` explains an action verdict, `factId` explains a row
   * verdict against a real stored fact. Either or both.
   */
  @Post('explain')
  @RequireScopes('brain:admin')
  async explain(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: { policyNames?: string[]; action?: string; factId?: string },
  ): Promise<PolicyExplainResponse> {
    const companyId = req.brainAuth.companyId;
    const names = body?.policyNames ?? [];
    if (!Array.isArray(names) || names.length === 0) {
      throw new BadRequestException('policyNames (non-empty array) is required');
    }
    if (!body.action && !body.factId) {
      throw new BadRequestException('Provide action and/or factId to explain');
    }

    const stored = await this.store.list(companyId);
    const byName = new Map(stored.map((s) => [s.name, s]));
    const sets: CompiledPolicySet[] = [];
    for (const name of names) {
      const s = byName.get(String(name));
      if (!s) throw new NotFoundException(`Policy set '${name}' not found`);
      const compiled = compilePolicySet(s.document);
      if (compiled) sets.push(compiled);
    }
    if (sets.length === 0) {
      throw new BadRequestException('All referenced policy sets are disabled');
    }
    const ctx: PolicyContext = {
      companyId,
      keyHash: 'explain',
      sets,
      forceReportOnly: false,
      resolutionError: false,
    };

    const out: PolicyExplainResponse = {};
    if (body.action) {
      const action = String(body.action);
      out.action = {
        name: action,
        decision: evaluateAction(ctx, action).decision,
        traces: explainAction(ctx, action),
      };
    }
    if (body.factId) {
      const row = await this.store.loadFactForExplain(companyId, String(body.factId));
      const view = toRowView(row, (p) => policyFor(p).piiClass);
      out.row = {
        factId: String(body.factId),
        decision: evaluateRow(ctx, view).decision,
        traces: explainRow(ctx, view),
        view: {
          predicate: view.predicate,
          piiClass: view.piiClass,
          source: (view.source as Record<string, unknown>) ?? null,
          trustSnapshot: (view.trustSnapshot as Record<string, unknown>) ?? null,
          corroboration: (view.corroboration as Record<string, unknown>) ?? null,
          userId: view.userId ?? null,
        },
      };
    }
    return out;
  }
}

function actorOf(req: AuthenticatedRequest): string {
  return req.brainAuth.keyHash.slice(0, 20);
}

function toWire(s: StoredPolicySet): PolicySetWire {
  return {
    name: s.name,
    description: s.document.description ?? '',
    posture: s.document.posture,
    mode: s.mode,
    activeFrom: s.document.activeFrom ?? null,
    activeUntil: s.document.activeUntil ?? null,
    rules: s.document.rules.map((r) => ({
      id: r.id,
      effect: r.effect,
      kind: r.kind,
      enabled: r.enabled,
      ...(r.description !== undefined ? { description: r.description } : {}),
      ...(r.actions !== undefined ? { actions: r.actions } : {}),
      ...(r.match !== undefined ? { match: r.match } : {}),
    })),
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
    attachedSubjects: s.attachedSubjects,
  };
}
