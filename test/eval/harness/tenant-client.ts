import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Minimal brain HTTP client pinned to one tenant via X-Brain-Tenant
 * (requires BRAIN_TENANT_OVERRIDE_ENABLED on the brain and an
 * admin-scoped key). One instance = one isolated eval world.
 *
 * Built on node:http rather than global fetch — a live-run finding:
 * undici's default headers timeout (~5 min) kills long synchronous
 * admin calls (`/maintenance/derive` LLM-derives a whole ~115k-token
 * haystack in one request), surfacing as a bare "fetch failed" while
 * the server keeps working. Here the response timeout is explicitly
 * unlimited; connect errors still reject.
 *
 * Transient failures retry with backoff (second live-run finding: one
 * OpenAI network blip surfaced as a brain 500 and killed a whole
 * world). Retryable: connection errors, 429, 5xx. 4xx besides 429 are
 * contract errors and fail fast. Retried admin calls are safe: derive
 * is force-rebuild, ingest is INSERT IGNORE, QA is a read.
 */
const RETRIES = 4;
const BACKOFF_MS = 2_000; // ×3 per attempt: 2s, 6s, 18s

export class TenantClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly tenant: string,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        return await this.callOnce<T>(method, path, body);
      } catch (e) {
        lastErr = e as Error;
        const m = /^HTTP (\d{3}) /.exec(lastErr.message);
        const status = m ? parseInt(m[1]!, 10) : undefined;
        const retryable = status === undefined || status === 429 || status >= 500;
        if (!retryable || attempt === RETRIES) throw lastErr;
        await new Promise((r) => setTimeout(r, BACKOFF_MS * Math.pow(3, attempt - 1)));
      }
    }
    throw lastErr ?? new Error('unreachable');
  }

  private callOnce<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<T>((resolve, reject) => {
      const req = doRequest(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'X-Brain-Tenant': this.tenant,
            ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`HTTP ${status} ${method} ${path}: ${text.slice(0, 300)}`));
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              reject(new Error(`non-JSON response ${method} ${path}: ${text.slice(0, 120)}`));
            }
          });
        },
      );
      req.setTimeout(0); // long admin calls: no response deadline
      req.on('error', (e) => reject(new Error(`${method} ${path}: ${(e as Error).message}`)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}
