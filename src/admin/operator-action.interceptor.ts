import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
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
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const isAdminRoute = path.startsWith('/v1/admin/');
    const isSelf =
      path.startsWith('/v1/admin/operator-actions') ||
      // SSE streams emit thousands of events per session — recording
      // each one would drown the table; we log only the initial GET.
      path.endsWith('/stream');
    const startedAt = Date.now();
    return next.handle().pipe(
      tap({
        next: () =>
          this.maybeRecord({ req, res, path, isAdminRoute, isSelf, startedAt }),
        error: () =>
          this.maybeRecord({ req, res, path, isAdminRoute, isSelf, startedAt }),
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

function summariseQuery(
  q: Record<string, unknown> | undefined,
): Record<string, string> | null {
  if (!q || Object.keys(q).length === 0) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    out[k] = truncate(String(v));
  }
  return out;
}

function summariseBody(
  body: unknown,
): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === null || v === undefined) {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] = truncate(v);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = `[array len=${v.length}]`;
    } else if (typeof v === 'object') {
      out[k] = `[object keys=${Object.keys(v as Record<string, unknown>).length}]`;
    } else {
      out[k] = truncate(String(v));
    }
  }
  return out;
}

function truncate(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
