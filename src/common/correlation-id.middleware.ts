/**
 * Mint a correlation id per request and bind it to the AsyncLocal
 * context for the lifetime of the request handler.
 *
 * Source precedence:
 *   1. `x-request-id`     — common upstream convention (NGINX, Heroku)
 *   2. `x-correlation-id` — also common (Spring, .NET)
 *   3. randomUUID()       — first hop, mint our own
 *
 * The id is also written back to the response header (`x-request-id`)
 * so the caller can quote it when filing a bug. Pure middleware, no
 * NestJS DI; mounted from main.ts before the request-logger so the
 * id is available to both the request-line and every inner Logger.
 */
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithRequestContext } from './request-context';

export function correlationIdMiddleware() {
  return function (req: Request, res: Response, next: NextFunction) {
    const headers = req.headers ?? {};
    const headerVal =
      (headers['x-request-id'] as string | undefined) ??
      (headers['x-correlation-id'] as string | undefined);
    // Cap at 128 chars — defensive against a malicious upstream sending
    // a 1 MB header and letting it ride in every downstream log line.
    const correlationId = (headerVal ? String(headerVal) : randomUUID()).slice(
      0,
      128,
    );
    res.setHeader('x-request-id', correlationId);
    // Bind an AbortController to the underlying socket. The controller
    // fires when the request closes BEFORE the response finishes —
    // covers browser-tab-close / curl-Ctrl-C / proxy timeout. Long
    // pipelines (extractor, synthesize) consume getAbortSignal() and
    // forward into OpenAI / fetch so cancelled requests stop burning
    // tokens. The listener self-removes on response 'finish' (normal
    // path) to avoid leaking when the response completes normally.
    const controller = new AbortController();
    // Defensive: unit tests mock req/res as plain objects without
    // EventEmitter wiring. Skip the listener install when on() is
    // missing — production Express requests always have it.
    if (typeof (req as { on?: unknown }).on === 'function') {
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.on('close', onClose);
      if (typeof (res as { on?: unknown }).on === 'function') {
        res.on('finish', () => req.removeListener('close', onClose));
      }
    }
    runWithRequestContext(
      { correlationId, abortSignal: controller.signal },
      () => next(),
    );
  };
}
