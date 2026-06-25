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
    // Strip CR/LF/control chars first: this value is interpolated into
    // plain-string log lines (request-logger, exception filter) and
    // reflected into the response body/header, so an un-sanitized
    // `\n[forged log line]` would be log injection.
    const correlationId = (
      headerVal ? String(headerVal).replace(/[\r\n\x00-\x1f\x7f]/g, '') : ''
    ).slice(0, 128) || randomUUID();
    res.setHeader('x-request-id', correlationId);
    // Bind an AbortController to the underlying socket. The controller
    // fires when the request closes BEFORE the response finishes —
    // covers browser-tab-close / curl-Ctrl-C / proxy timeout. Long
    // pipelines (extractor, synthesize) consume getAbortSignal() and
    // forward into OpenAI / fetch so cancelled requests stop burning
    // tokens. The listener self-removes on response 'finish' (normal
    // path) to avoid leaking when the response completes normally.
    const controller = new AbortController();
    // Bind cancellation to the RESPONSE lifecycle, not the request stream.
    // On Express 5 / modern Node the request's 'close' event fires once the
    // request BODY has been fully read — which happens long before a slow
    // async handler (OpenAI embed/extract) finishes — so keying the abort
    // off `req 'close'` cancelled every in-flight request mid-flight
    // (observed: ingest aborting its own embedding call ~25ms in → HTTP 500
    // "Request was aborted"). The response 'close' event fires when the
    // response stream closes; if it closed WITHOUT finishing, the client
    // genuinely went away and we abort to stop burning tokens.
    // Defensive: unit tests mock res as a plain object without EventEmitter
    // wiring — skip the listener when on() is missing.
    if (typeof (res as { on?: unknown }).on === 'function') {
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
    }
    runWithRequestContext(
      { correlationId, abortSignal: controller.signal },
      () => next(),
    );
  };
}
