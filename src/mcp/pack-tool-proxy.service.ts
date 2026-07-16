import { createHmac, randomUUID } from 'node:crypto';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { envFlagEnabled } from '../common/env-validation';
import { assertPublicHttpUrl, EgressDeniedError } from '../common/egress-guard';
import type { PackExternalToolSpec } from '../ai/domain-packs';
import { sanitizePackText } from './pack-tool-render';
import type { PackToolBinding } from './pack-tools-reader.service';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const BREAKER_THRESHOLD = 3;
const BREAKER_MS = 60_000;

/** Shape handed straight back as the MCP tool result. */
export interface PackToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}

/**
 * Outbound proxy for pack-declared EXTERNAL MCP tools
 * (docs/mcp-pack-tools.md): Brain POSTs the call to the publisher's
 * endpoint, HMAC-signed with the pack's per-install webhook secret
 * (indexer-webhook mold), and relays a bounded response. Privacy
 * invariant: the wire carries the opaque installId, never companyId.
 *
 * Failure posture is deliberate: NO retries (a tool call is not a
 * best-effort hint — the agent should see the failure and decide), a
 * per-endpoint circuit breaker (3 consecutive transport failures latch
 * 60 s), and a 64 KB response cap so a misbehaving endpoint can't pin
 * memory. Errors surface as HTTP 424 (< 500, so wrapToolErrors passes
 * the sanitized message through instead of masking it).
 */
@Injectable()
export class PackToolProxyService {
  private readonly logger = new Logger(PackToolProxyService.name);
  /** endpoint → consecutive transport failures + latch expiry. */
  private readonly breaker = new Map<string, { fails: number; until: number }>();

  async call(opts: {
    binding: PackToolBinding;
    tool: PackExternalToolSpec;
    args: Record<string, unknown>;
  }): Promise<PackToolCallResult> {
    const { binding, tool } = opts;
    const endpoint = tool.endpoint;
    const latched = this.breaker.get(endpoint);
    if (latched && Date.now() < latched.until) {
      throw upstreamError(
        'external tool endpoint is temporarily unavailable (circuit open)',
      );
    }
    if (!binding.webhookSecret || !binding.installId) {
      // Pre-0068 install rows lack the identity/secret pair; an
      // unsigned call is worse than none. Reinstalling mints both.
      throw upstreamError(
        `pack "${binding.packId}" has no install identity for external tools — reinstall the pack`,
      );
    }
    // Same SSRF fence as install time, re-run per call (the endpoint's
    // DNS answer may have changed since install).
    try {
      await assertPublicHttpUrl(endpoint, {
        allowHttp: envFlagEnabled(process.env.MCP_PACK_TOOLS_ALLOW_HTTP),
      });
    } catch (e) {
      if (e instanceof EgressDeniedError) throw upstreamError(e.message);
      throw e;
    }
    const payload = JSON.stringify({
      event: 'mcp_tool_call',
      tool: tool.name,
      packId: binding.packId,
      installId: binding.installId,
      requestId: randomUUID(),
      ts: new Date().toISOString(),
      args: opts.args,
    });
    const signature = createHmac('sha256', binding.webhookSecret)
      .update(payload)
      .digest('hex');
    const timeoutMs = Math.min(tool.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const text = await this.deliver({ endpoint, payload, signature, timeoutMs });
    return this.shapeResponse(endpoint, text);
  }

  /** One POST, no retries. Throws a recorded upstreamError on timeout /
   *  network error / non-200 / oversized body; returns the body text. */
  private async deliver(opts: {
    endpoint: string;
    payload: string;
    signature: string;
    timeoutMs: number;
  }): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(opts.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-brain-event': 'mcp_tool_call',
            'x-brain-signature': `sha256=${opts.signature}`,
          },
          body: opts.payload,
          redirect: 'error',
          signal: ctrl.signal,
        });
      } catch {
        this.recordFailure(opts.endpoint);
        throw upstreamError(
          ctrl.signal.aborted
            ? `external tool timed out after ${opts.timeoutMs}ms`
            : 'external tool endpoint unreachable',
        );
      }
      if (res.status !== 200) {
        this.recordFailure(opts.endpoint);
        throw upstreamError(
          `external tool endpoint answered HTTP ${res.status}`,
        );
      }
      const text = await readCapped(res, MAX_RESPONSE_BYTES);
      if (text === null) {
        this.recordFailure(opts.endpoint);
        throw upstreamError(
          `external tool response exceeded ${MAX_RESPONSE_BYTES / 1024} KB`,
        );
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Contract: 200 + JSON `{content: string|object}`. An `{error}` body
   * is an application-level failure — surfaced (sanitized, capped) but
   * NOT counted against the breaker; the endpoint is clearly alive.
   */
  private shapeResponse(endpoint: string, text: string): PackToolCallResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.recordFailure(endpoint);
      throw upstreamError('external tool returned malformed JSON');
    }
    this.breaker.delete(endpoint);
    const body = (parsed ?? {}) as { content?: unknown; error?: unknown };
    if (body.error !== undefined || body.content === undefined) {
      const detail =
        body.error === undefined
          ? 'response carries no content field'
          : sanitizePackText(
              typeof body.error === 'string'
                ? body.error
                : JSON.stringify(body.error),
              500,
            );
      throw upstreamError(`external tool returned an error: ${detail}`);
    }
    const content = body.content;
    if (typeof content === 'string') {
      return { content: [{ type: 'text', text: content }] };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(content, null, 2) }],
      structuredContent: content as Record<string, unknown>,
    };
  }

  private recordFailure(endpoint: string): void {
    const state = this.breaker.get(endpoint) ?? { fails: 0, until: 0 };
    state.fails += 1;
    if (state.fails >= BREAKER_THRESHOLD) {
      state.until = Date.now() + BREAKER_MS;
      state.fails = 0;
      this.logger.warn(
        `pack tool endpoint ${endpoint} latched for ${BREAKER_MS / 1000}s after ${BREAKER_THRESHOLD} consecutive failures`,
      );
    }
    this.breaker.set(endpoint, state);
  }
}

function upstreamError(message: string): HttpException {
  // 424 Failed Dependency: < 500 so the MCP error wrapper passes this
  // deliberate, sanitized message through to the calling agent.
  return new HttpException({ error: 'pack_tool_upstream', message }, 424);
}

/** Read the response body up to `cap` bytes; null = oversize (aborted). */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
