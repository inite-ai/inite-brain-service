import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { Observable, catchError, map, throwError } from 'rxjs';

export interface DebugSpan {
  id: string;
  parentId?: string;
  name: string;
  startedAt: number;
  durationMs?: number;
  attributes?: Record<string, unknown>;
  error?: string;
}

export interface DebugArtifact {
  spanId?: string;
  name: string;
  ts: number;
  value: unknown;
}

export interface DebugContext {
  requestId: string;
  startedAt: number;
  spans: DebugSpan[];
  artifacts: DebugArtifact[];
  /** Bounded counter — drops new artifacts past MAX_ARTIFACTS_PER_REQUEST. */
  artifactsDropped: number;
}

export interface DebugTraceSnapshot {
  requestId: string;
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  companyId?: string;
  spans: DebugSpan[];
  artifacts: DebugArtifact[];
  /** Set when the underlying handler threw. */
  errored?: { message: string; name?: string };
}

const requestAls = new AsyncLocalStorage<DebugContext>();
/** Tracks the currently-active span id (innermost). Per-async-chain, so
 *  concurrent sibling spans (e.g. vector+lexical run via Promise.all)
 *  each see the correct parent without trampling a shared stack. */
const spanAls = new AsyncLocalStorage<{ spanId: string }>();

export function getDebugContext(): DebugContext | undefined {
  return requestAls.getStore();
}

/**
 * Run `fn` inside a fresh DebugContext and return both the result and the
 * captured trace. Used by callers that aren't reached via the HTTP
 * middleware (notably the in-process scenario runner) but still want a
 * per-call waterfall.
 */
export async function runWithDebugTrace<T>(fn: () => Promise<T>): Promise<{
  result: T;
  trace: {
    requestId: string;
    totalMs: number;
    spans: DebugSpan[];
    artifacts: DebugArtifact[];
    artifactsDropped: number;
  };
}> {
  const ctx: DebugContext = {
    requestId: randomUUID(),
    startedAt: Date.now(),
    spans: [],
    artifacts: [],
    artifactsDropped: 0,
  };
  const result = await requestAls.run(ctx, () => fn());
  return {
    result,
    trace: {
      requestId: ctx.requestId,
      totalMs: Date.now() - ctx.startedAt,
      spans: ctx.spans,
      artifacts: ctx.artifacts,
      artifactsDropped: ctx.artifactsDropped,
    },
  };
}

const MAX_ARTIFACT_SIZE = 32 * 1024;
const MAX_ARTIFACTS_PER_REQUEST = 200;

function safeArtifact(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  try {
    if (typeof value === 'string') {
      return value.length <= MAX_ARTIFACT_SIZE
        ? value
        : {
            __truncated: true,
            preview: value.slice(0, MAX_ARTIFACT_SIZE),
            originalSize: value.length,
          };
    }
    const json = JSON.stringify(value);
    if (json.length <= MAX_ARTIFACT_SIZE) {
      // Deep-clone via JSON round-trip so later in-place mutations in
      // the producer code don't rewrite the captured artifact.
      return JSON.parse(json);
    }
    return {
      __truncated: true,
      preview: json.slice(0, MAX_ARTIFACT_SIZE),
      originalSize: json.length,
    };
  } catch {
    return { __unserializable: true, type: typeof value };
  }
}

export async function traceSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, unknown>,
): Promise<T> {
  const ctx = requestAls.getStore();
  if (!ctx) return fn();

  const id = randomUUID();
  const parentId = spanAls.getStore()?.spanId;
  const startedAt = Date.now();
  const span: DebugSpan = { id, parentId, name, startedAt, attributes };
  ctx.spans.push(span);
  try {
    return await spanAls.run({ spanId: id }, async () => {
      try {
        return await fn();
      } finally {
        span.durationMs = Date.now() - startedAt;
      }
    });
  } catch (err) {
    span.durationMs = span.durationMs ?? Date.now() - startedAt;
    span.error = (err as Error)?.message ?? String(err);
    throw err;
  }
}

export function traceArtifact(name: string, value: unknown): void {
  const ctx = requestAls.getStore();
  if (!ctx) return;
  if (ctx.artifacts.length >= MAX_ARTIFACTS_PER_REQUEST) {
    ctx.artifactsDropped += 1;
    return;
  }
  ctx.artifacts.push({
    spanId: spanAls.getStore()?.spanId,
    name,
    ts: Date.now(),
    value: safeArtifact(value),
  });
}

export function debugTraceMiddleware() {
  return function (req: Request, _res: Response, next: NextFunction) {
    if (req.headers['x-brain-debug'] !== '1') return next();
    const ctx: DebugContext = {
      requestId: randomUUID(),
      startedAt: Date.now(),
      spans: [],
      artifacts: [],
      artifactsDropped: 0,
    };
    requestAls.run(ctx, () => next());
  };
}

@Injectable()
export class TraceBufferService {
  private buffer: DebugTraceSnapshot[] = [];
  private readonly capacity = 100;

  add(snapshot: DebugTraceSnapshot): void {
    this.buffer.unshift(snapshot);
    if (this.buffer.length > this.capacity) {
      this.buffer.length = this.capacity;
    }
  }

  /**
   * Operator-facing list — companyId optional so a caller with `brain:admin`
   * on a tenant key only sees their own debug traces. (The interceptor
   * already refuses to record snapshots for non-admin callers, so there is
   * no per-row ACL beyond company scoping.)
   */
  list(
    companyId?: string,
  ): Array<Omit<DebugTraceSnapshot, 'spans' | 'artifacts'>> {
    const rows = companyId
      ? this.buffer.filter((s) => s.companyId === companyId)
      : this.buffer;
    return rows.map(({ spans: _s, artifacts: _a, ...rest }) => rest);
  }

  get(requestId: string, companyId?: string): DebugTraceSnapshot | undefined {
    const hit = this.buffer.find((s) => s.requestId === requestId);
    if (!hit) return undefined;
    if (companyId && hit.companyId && hit.companyId !== companyId) {
      return undefined;
    }
    return hit;
  }
}

@Injectable()
export class DebugTraceInterceptor implements NestInterceptor {
  constructor(private readonly traceBuffer: TraceBufferService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = requestAls.getStore();
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
