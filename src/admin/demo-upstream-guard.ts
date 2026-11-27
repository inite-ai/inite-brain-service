import { HttpException, type Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * The demo chat's upstream guard, shared by the operator demo
 * (/v1/admin/demo/chat) and the public demo workspace
 * (/v1/demo/workspace/chat), so both answer a transient upstream failure
 * the same way (test/demo-chat-upstream-guard.e2e-spec.ts).
 *
 * Typed Nest exceptions (BadRequest, Forbidden, ...) pass through: they
 * mean something and the client routes on them. A transient upstream
 * failure (an OpenAI premature close or connection drop after the SDK's
 * own retries) is not a bug in our pipeline but an outage of a
 * dependency: it becomes a 503 with a retry hint, so the chat UI backs off
 * and replays instead of showing a generic 500. Anything else rethrows.
 */
export function isUpstreamFailure(err: unknown): boolean {
  const e = err as (Error & { code?: string }) | undefined;
  return (
    e?.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    /api\.openai\.com|Premature close|ECONNRESET|ETIMEDOUT|fetch failed/i.test(e?.message ?? '')
  );
}

export function rethrowDemoChatError(err: unknown, logger: Logger, route: string): never {
  if (err instanceof HttpException) throw err;
  if (isUpstreamFailure(err)) {
    const message = (err as Error).message;
    logger.warn(`${route} upstream LLM unavailable: ${message}`);
    throw new ServiceUnavailableException({
      reason: 'upstream_llm_unavailable',
      detail: message,
      retryAfterMs: 2000,
    });
  }
  throw err;
}
