/**
 * AsyncLocalStorage-backed request context. The HTTP request handler
 * mints a UUID per inbound request (or reuses an `x-request-id` /
 * `x-correlation-id` header from an upstream proxy), and stores it
 * in the per-request context. Every Logger call inside that request
 * can then look up the current correlationId without threading it
 * through every signature.
 *
 * Why this exists: the audit flagged that service-level log lines
 * (logger.warn / logger.error fired deep in extractor / search /
 * synthesize / dreams) carry no request identifier outside debug-
 * mode. Operators tracking down a specific 500 had no way to stitch
 * a service-level warn back to the request-logger line. With ALS,
 * `getCorrelationId()` returns the active id and a custom logger
 * formatter (or a JSON log shipper enrichment) folds it in.
 *
 * Pure module — no NestJS coupling. Imported from the request
 * middleware AND from common/tracing.ts, which sets the OTel span
 * attribute `request.id` from the same source so the gen_ai.* spans
 * and the structured log lines reconcile.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

/**
 * Active correlation id, or undefined when called outside a request
 * (background cron, boot, etc.). Pure read; never throws.
 */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Same shape as RequestContext for forward compatibility — any fields
 * we add later (companyId, scopes, tenant tier) get a single getter
 * without bumping every call site.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
