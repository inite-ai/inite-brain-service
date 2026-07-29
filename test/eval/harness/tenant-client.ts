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
 */
export class TenantClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly tenant: string,
  ) {}

  call<T>(method: string, path: string, body?: unknown): Promise<T> {
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
            ...(payload !== undefined
              ? { 'Content-Length': Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(
                new Error(
                  `HTTP ${status} ${method} ${path}: ${text.slice(0, 300)}`,
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              reject(
                new Error(
                  `non-JSON response ${method} ${path}: ${text.slice(0, 120)}`,
                ),
              );
            }
          });
        },
      );
      req.setTimeout(0); // long admin calls: no response deadline
      req.on('error', (e) =>
        reject(new Error(`${method} ${path}: ${(e as Error).message}`)),
      );
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}
