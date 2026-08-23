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
  /**
   * AbortSignal that fires when the underlying HTTP request closes
   * (client disconnect, request timeout). Long-running pipelines
   * (extractor, synthesize, multi-hop, search) thread this into
   * their OpenAI / fetch calls so a cancelled request stops burning
   * tokens. Undefined for background contexts (cron, startup).
   */
  abortSignal?: AbortSignal | undefined;
  /**
   * ABAC policy context for the authenticated key, stamped by
   * ApiKeyGuard after credential + action gating. Read surfaces pick
   * it up via getPolicyContext() so row-level filtering needs no
   * signature threading. Undefined = no policies attached (or the
   * request never passed the guard) → pre-ABAC behavior.
   */
  policy?: import('../policy/policy.types').PolicyContext;
  /**
   * Recorder for aggregated row-decision summaries, bound by the guard
   * to PolicyGateService (which owns the decision sink + metrics).
   * Kept as a closure so pure modules (policy/row-filter) never touch
   * DI. Set iff `policy` is set.
   */
  recordPolicyRows?: (summary: import('../policy/row-filter').RowDecisionSummary) => void;
  /**
   * End-user identity of a user-bound access token (auth-service `sub`
   * when the token carries an `org` claim), stamped by ApiKeyGuard.
   * Per-user memory surfaces pin caller-asserted userId to this value
   * via pinUserScope() — no signature threading. Undefined for M2M
   * credentials (tenant-wide authority, caller may assert any userId).
   */
  authUserId?: string;
  /**
   * Acting client (agent) identity from the token (`act`/`client_id`),
   * stamped by ApiKeyGuard. Fact ingest attributes writes to it via
   * source.meta.actor — provenance without signature threading.
   */
  authActorId?: string;
  /**
   * Per-tenant retrieval profile, resolved once by ApiKeyGuard next to
   * brainAuth. Entry points hand it down by argument; the ALS slot
   * exists so old no-argument call sites resolve the same object
   * instead of re-reading env. Undefined outside a guarded request.
   */
  retrievalProfile?: import('../search/retrieval-profile').RetrievalProfile;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
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

/**
 * Current request's abort signal, or undefined when outside a
 * request. Service-level code uses this to pass through to OpenAI /
 * fetch / Surreal — no signature changes needed.
 */
export function getAbortSignal(): AbortSignal | undefined {
  return storage.getStore()?.abortSignal;
}

/** Active ABAC policy context, or undefined outside a policied request. */
export function getPolicyContext(): import('../policy/policy.types').PolicyContext | undefined {
  return storage.getStore()?.policy;
}

/** Row-decision recorder bound by the guard; undefined without a policy. */
export function getPolicyRowRecorder():
  ((summary: import('../policy/row-filter').RowDecisionSummary) => void) | undefined {
  return storage.getStore()?.recordPolicyRows;
}
