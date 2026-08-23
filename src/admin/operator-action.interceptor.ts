import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { OperatorActionService } from './operator-action.service';
import type { AuthenticatedRequest } from '../auth/api-key.types';

/**
 * Records every admin HTTP call to `operator_action` (migration 0027).
 *
 * Scope: only routes whose path starts with `/v1/admin/`. The GET
 * /v1/admin/operator-actions endpoint is itself excluded — otherwise
 * each refresh would multiply the log.
 *
 * Writes are async + best-effort; the interceptor doesn't await the
 * persist promise. Body is summarised (top-level scalars only, capped
 * at 200 chars) so an oversized DTO can't grow the row past a sane
 * cap.
 */
@Injectable()
export class OperatorActionInterceptor implements NestInterceptor {
  constructor(private readonly actions: OperatorActionService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request & Partial<AuthenticatedRequest>>();
    const res = http.getResponse<Response>();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
    const isAdminRoute = path.startsWith('/v1/admin/');
    const isSelf =
      path.startsWith('/v1/admin/operator-actions') ||
      // SSE streams emit thousands of events per session — recording
      // each one would drown the table; we log only the initial GET.
      path.endsWith('/stream');
    const startedAt = Date.now();
    return next.handle().pipe(
      tap({
        next: () => this.maybeRecord({ req, res, path, isAdminRoute, isSelf, startedAt }),
        error: () => this.maybeRecord({ req, res, path, isAdminRoute, isSelf, startedAt }),
      }),
    );
  }

  private maybeRecord({
    req,
    res,
    path,
    isAdminRoute,
    isSelf,
    startedAt,
  }: {
    req: Request & Partial<AuthenticatedRequest>;
    res: Response;
    path: string;
    isAdminRoute: boolean;
    isSelf: boolean;
    startedAt: number;
  }): void {
    if (!isAdminRoute || isSelf) return;
    const brainAuth = req.brainAuth;
    if (!brainAuth?.companyId) return;
    const summary = summariseBody(req.body);
    const query = summariseQuery(req.query as Record<string, unknown>);
    this.actions.record({
      ts: new Date().toISOString(),
      actor: brainAuth.companyId,
      scopes: brainAuth.scopes ?? [],
      method: (req.method ?? 'GET').toUpperCase(),
      path,
      status: res.statusCode ?? 0,
      durationMs: Date.now() - startedAt,
      query,
      bodySummary: summary,
      companyId: brainAuth.companyId,
    });
  }
}

// Prototype-pollution guard: request keys are attacker-controlled, so they
// must never be allowed to address __proto__/constructor/prototype on the
// plain summary object literals below.
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isUnsafeKey(k: string): boolean {
  return PROTO_KEYS.has(k);
}

// Both summaries collect [key, value] pairs and materialise the object in
// one Object.fromEntries call: request-controlled keys become own data
// properties only — never a dynamic write that could reach a setter or an
// inherited Object member.
function summariseQuery(q: Record<string, unknown> | undefined): Record<string, string> | null {
  if (!q || Object.keys(q).length === 0) return null;
  const entries: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(q)) {
    if (isUnsafeKey(k)) continue;
    entries.push([k, truncate(String(v))]);
  }
  return Object.fromEntries(entries);
}

function summariseValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return truncate(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return `[array len=${v.length}]`;
  if (typeof v === 'object') {
    return `[object keys=${Object.keys(v as Record<string, unknown>).length}]`;
  }
  return truncate(String(v));
}

function summariseBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const entries: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (isUnsafeKey(k)) continue;
    entries.push([k, summariseValue(v)]);
  }
  return Object.fromEntries(entries);
}

function truncate(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
