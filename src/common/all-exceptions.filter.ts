import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getCorrelationId } from './request-context';

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
      getCorrelationId() ??
      (res.getHeader('x-request-id') as string | undefined) ??
      'unknown';

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
      // Log 5xx HttpExceptions (rare) at error; 4xx at debug.
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        this.logger.error(
          `[${requestId}] ${req.method} ${req.url} → ${status}: ${exception.message}`,
          exception.stack,
        );
      }
      res.status(status).json({ ...payload, requestId });
      return;
    }

    // Unknown / non-HTTP error: never leak the message or stack.
    const err = exception as Error;
    this.logger.error(
      `[${requestId}] ${req.method} ${req.url} → 500: ${err?.message ?? exception}`,
      err?.stack,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      requestId,
    });
  }
}
