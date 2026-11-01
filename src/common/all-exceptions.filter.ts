import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { Request, Response } from 'express';
import { getCorrelationId } from './request-context';

/**
 * RFC 9457 problem details. `type` stays `about:blank` (the status says it
 * all, so `title` is the status phrase), `detail` is the human message,
 * `instance` the path that failed. The body Brain answered before —
 * `statusCode`, `message`, `error`, `requestId` — rides along as extension
 * members, so a client that read those keeps working; validation messages
 * are also listed under `errors`.
 */
export function problemDetails(
  status: number,
  payload: Record<string, unknown>,
  ctx: { instance: string; requestId: string },
): Record<string, unknown> {
  const message = payload.message;
  const detail =
    typeof payload.detail === 'string'
      ? payload.detail
      : Array.isArray(message)
        ? message.map(String).join('; ')
        : typeof message === 'string'
          ? message
          : undefined;
  return {
    ...payload,
    // The standard members win over a payload's own keys of the same name:
    // `status` is the HTTP code here, never a state string.
    type: 'about:blank',
    title: STATUS_CODES[status] ?? 'Error',
    status,
    ...(detail ? { detail } : {}),
    instance: ctx.instance,
    ...(Array.isArray(message) ? { errors: message.map(String) } : {}),
    requestId: ctx.requestId,
  };
}

const PROBLEM_JSON = 'application/problem+json';

/**
 * Global exception filter — the catch-all the service was missing.
 *
 * Two jobs:
 *   1. Stitch every error response back to its request: attach the
 *      correlation id (same one on the `x-request-id` header and the
 *      gen_ai.* spans) to the body so a caller can quote it on a 500.
 *   2. Don't leak internals. HttpExceptions (incl. class-validator 400s
 *      and explicit 404/403) keep their status + their already-safe
 *      message. Everything else collapses to a generic 500 — the real
 *      error (message + stack) goes to the structured log, NOT the wire.
 *
 * Registered globally in main.ts. Without it, unhandled errors fell
 * through to Nest's default filter, which emitted no request id and
 * gave no guarantee about what detail reached the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // Prefer the ALS id; fall back to the response header the
    // correlation-id middleware already set.
    const requestId =
      getCorrelationId() ?? (res.getHeader('x-request-id') as string | undefined) ?? 'unknown';

    // Streaming routes (MCP uses @Res() + transport.handleRequest, SSE)
    // may have already committed the response when a late error reaches
    // us. Writing again throws ERR_HTTP_HEADERS_SENT → uncaughtException.
    // Log and bail.
    if (res.headersSent) {
      this.logger.error(
        `[${requestId}] ${req.method} ${req.url} → error after headers sent: ${
          (exception as Error)?.message ?? exception
        }`,
        (exception as Error)?.stack,
      );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // class-validator / Nest put { statusCode, message, error } here;
      // a string response is wrapped. Both are operator-authored and
      // safe to return verbatim.
      const payload =
        typeof body === 'string'
          ? { statusCode: status, message: body }
          : { ...(body as Record<string, unknown>) };
      // Log 5xx HttpExceptions (rare) at error; 4xx at debug. A 503 is
      // the one 5xx a handler THROWS ON PURPOSE — readiness while a model
      // warms, the embedder space guard, a fail-closed admin path — and
      // the caller polls it. Its stack trace points at the `throw` and
      // nothing else; logged at error it filled a third of the boot log
      // (the edge probes /ready every 3 s through a 20 s warmup). Warn,
      // message only.
      if (status === HttpStatus.SERVICE_UNAVAILABLE) {
        this.logger.warn(
          `[${requestId}] ${req.method} ${req.url} → ${status}: ${exception.message}`,
        );
      } else if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        this.logger.error(
          `[${requestId}] ${req.method} ${req.url} → ${status}: ${exception.message}`,
          exception.stack,
        );
      }
      res
        .status(status)
        .type(PROBLEM_JSON)
        .send(JSON.stringify(problemDetails(status, payload, { instance: req.path, requestId })));
      return;
    }

    // Unknown / non-HTTP error: never leak the message or stack.
    const err = exception as Error;
    this.logger.error(
      `[${requestId}] ${req.method} ${req.url} → 500: ${err?.message ?? exception}`,
      err?.stack,
    );
    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    res
      .status(status)
      .type(PROBLEM_JSON)
      .send(
        JSON.stringify(
          problemDetails(
            status,
            { statusCode: status, message: 'Internal server error' },
            { instance: req.path, requestId },
          ),
        ),
      );
  }
}
