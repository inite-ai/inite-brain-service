import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HTTP_CODE_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { Observable, from, lastValueFrom } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { pinUserScope } from '../auth/user-scope';
import { IdempotencyStoreService } from './idempotency-store.service';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Printable ASCII, 1–255 chars: the draft's key is an opaque string. */
const KEY_RE = /^[\x21-\x7e]{1,255}$/;
/** Seconds a client is asked to wait on a key whose first request still runs. */
export const IN_FLIGHT_RETRY_AFTER_S = 1;

/**
 * Idempotency-Key on every authenticated write (0179,
 * draft-ietf-httpapi-idempotency-key-header). Without the header nothing
 * changes. With it:
 *  - the first request runs and its response (2xx or 4xx) is stored for
 *    24 h under (credential, key);
 *  - a retry with the same key and the same request (method, route,
 *    query, body) gets that response back, marked `Idempotent-Replayed:
 *    true`, and runs nothing;
 *  - the same key with a different request is 422; a retry while the
 *    first still runs is 409 with a Retry-After;
 *  - a 5xx is not stored, so the client can retry it.
 * Routes that write the response themselves (`@Res()`: MCP, streams) are
 * left alone; MCP retries carry their own JSON-RPC ids.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly store: IdempotencyStoreService,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request & Partial<AuthenticatedRequest>>();
    const header = req.headers['idempotency-key'];
    if (header === undefined || !UNSAFE.has(req.method) || !req.brainAuth) return next.handle();
    if (writesOwnResponse(ctx)) return next.handle();
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || !KEY_RE.test(key)) {
      throw new BadRequestException('Idempotency-Key must be 1–255 printable ASCII characters');
    }
    return from(this.run(ctx, { req, key }, next));
  }

  private async run(
    ctx: ExecutionContext,
    { req, key }: { req: Request & Partial<AuthenticatedRequest>; key: string },
    next: CallHandler,
  ): Promise<unknown> {
    const res = ctx.switchToHttp().getResponse<Response>();
    const auth = req.brainAuth!;
    const route = routeTemplate(req);
    const decision = await this.store.begin(auth.companyId, {
      scopeKey: auth.keyHash,
      key,
      method: req.method,
      route,
      fingerprint: fingerprintOf(req, route),
      userId: auth.userId ?? pinUserScope(bodyUserId(req)),
    });
    if (decision.kind === 'mismatch') {
      throw new UnprocessableEntityException(
        'This Idempotency-Key was used for a different request',
      );
    }
    if (decision.kind === 'in_flight') {
      // Retry-After is what tells a client this 409 will resolve: once the
      // first request finishes, the same retry gets its stored answer. A
      // conflict that will be the same answer next time carries none.
      res.setHeader('Retry-After', String(IN_FLIGHT_RETRY_AFTER_S));
      throw new ConflictException('A request with this Idempotency-Key is still being processed');
    }
    if (decision.kind === 'replay') {
      res.setHeader('Idempotent-Replayed', 'true');
      if (decision.status >= 400) {
        throw new HttpException(decision.body as Record<string, unknown>, decision.status);
      }
      res.status(decision.status);
      return decision.body;
    }
    try {
      const body = await lastValueFrom(next.handle(), { defaultValue: undefined });
      await this.store.complete(auth.companyId, decision.id, {
        status: this.successStatus(ctx, req),
        body,
      });
      return body;
    } catch (e) {
      const status = e instanceof HttpException ? e.getStatus() : 500;
      if (status < 500 && e instanceof HttpException) {
        await this.store.complete(auth.companyId, decision.id, { status, body: e.getResponse() });
      } else {
        await this.store.release(auth.companyId, decision.id);
      }
      throw e;
    }
  }

  /** The status Nest will answer with: the handler's @HttpCode, else 201 for POST, else 200. */
  private successStatus(ctx: ExecutionContext, req: Request): number {
    const code = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, ctx.getHandler());
    return code ?? (req.method === 'POST' ? 201 : 200);
  }
}

function writesOwnResponse(ctx: ExecutionContext): boolean {
  const args =
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctx.getClass(), ctx.getHandler().name) as
      Record<string, unknown> | undefined) ?? {};
  const own = [`${RouteParamtypes.RESPONSE}:`, `${RouteParamtypes.NEXT}:`];
  return Object.keys(args).some((k) => own.some((p) => k.startsWith(p)));
}

function routeTemplate(req: Request): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? `${req.baseUrl ?? ''}${path}` : req.path;
}

/** What makes two requests "the same": method, route, path params, query and body. */
export function fingerprintOf(
  req: Pick<Request, 'method' | 'params' | 'query' | 'body'>,
  route: string,
): string {
  return createHash('sha256')
    .update(
      canonical({
        method: req.method,
        route,
        params: req.params ?? {},
        query: req.query ?? {},
        body: req.body ?? null,
      }),
    )
    .digest('hex');
}

/** JSON with object keys sorted, so key order never makes two requests differ. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function bodyUserId(req: Request): string | undefined {
  const u = (req.body as { userId?: unknown } | undefined)?.userId;
  return typeof u === 'string' && u.length > 0 ? u : undefined;
}
