import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, catchError, map, throwError } from 'rxjs';
import {
  getDebugContext,
  type DebugTraceSnapshot,
} from './debug-trace-core';
import { TraceBufferService } from './trace-buffer.service';

/**
 * Nest interceptor that finalises the request-scoped DebugContext into a
 * snapshot and pushes it onto the TraceBufferService ring buffer.
 *
 * Split out of `debug-trace.ts` to satisfy one-class-per-file and to keep
 * the HTTP-coupled side (Request/Response, NestInterceptor wiring) away
 * from the ALS / runtime API that pure server code uses.
 *
 * Snapshots are admin-only: a non-admin caller can still trigger ALS
 * recording via `X-Brain-Debug: 1` (the trace payload comes back inline)
 * but the snapshot is not persisted to the shared ring buffer, so an
 * audit-mode admin cannot see other tenants' traces through
 * /admin/traces.
 */
@Injectable()
export class DebugTraceInterceptor implements NestInterceptor {
  constructor(private readonly traceBuffer: TraceBufferService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = getDebugContext();
    if (!ctx) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const captureSnapshot = (errored?: {
      message: string;
      name?: string;
    }): DebugTraceSnapshot | null => {
      const auth = (req as unknown as {
        brainAuth?: { companyId: string; scopes: string[] };
      }).brainAuth;
      // Cross-tenant leakage guard: only admins get snapshots in the
      // shared ring buffer. Non-admin callers can still emit X-Brain-Debug
      // (and pay the in-flight ALS cost), but their artifacts evaporate
      // when the request ends — no GET /admin/traces access exists for them.
      const isAdmin = !!auth?.scopes?.includes('brain:admin');
      if (!isAdmin) return null;
      return {
        requestId: ctx.requestId,
        ts: new Date(ctx.startedAt).toISOString(),
        method: req.method,
        path: req.originalUrl ?? req.url,
        status: res.statusCode,
        durationMs: Date.now() - ctx.startedAt,
        companyId: auth?.companyId,
        spans: ctx.spans,
        artifacts: ctx.artifacts,
        ...(errored ? { errored } : {}),
      };
    };

    const isAdmin = !!(
      req as unknown as { brainAuth?: { scopes: string[] } }
    ).brainAuth?.scopes?.includes('brain:admin');

    return next.handle().pipe(
      catchError((err) => {
        // Write the trace BEFORE the error propagates — otherwise the
        // most diagnostically valuable traces (the failing ones) are
        // silently dropped.
        const snap = captureSnapshot({
          message: (err as Error)?.message ?? String(err),
          name: (err as Error)?.name,
        });
        if (snap) this.traceBuffer.add(snap);
        return throwError(() => err);
      }),
      map((body) => {
        const snap = captureSnapshot();
        if (snap) this.traceBuffer.add(snap);

        if (!isAdmin) return body;

        const tracePayload = {
          requestId: ctx.requestId,
          totalMs: Date.now() - ctx.startedAt,
          spans: ctx.spans,
          artifacts: ctx.artifacts,
          artifactsDropped: ctx.artifactsDropped,
        };

        // Only merge __trace into plain JSON objects. Arrays / primitives /
        // class instances pass through untouched — they're rare on
        // brain:admin endpoints (all current admin returns are objects),
        // and the requestId is also surfaced on /admin/traces so the
        // waterfall is fetchable separately.
        if (
          body &&
          typeof body === 'object' &&
          !Array.isArray(body) &&
          Object.getPrototypeOf(body) === Object.prototype
        ) {
          return { ...body, __trace: tracePayload };
        }
        return body;
      }),
    );
  }
}
