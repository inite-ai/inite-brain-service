/**
 * A JSON request with no client-side deadline, for the admin builds the
 * batteries trigger (scenes, backlink, beliefs, extraction drain).
 *
 * Global `fetch` gives up waiting for response headers after 300 s
 * (undici's default headersTimeout), and its dispatcher cannot be
 * replaced without a direct undici dependency. A scene build over a
 * battery corpus on a 2-vCPU runner answered 201 after 300.6 s while
 * the harness had already died on UND_ERR_HEADERS_TIMEOUT. These calls
 * are synchronous on purpose — the questions after them need the build
 * done — so the harness waits as long as the server works.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface LongResponse {
  status: number;
  /** Parsed body when the response is JSON, else null. */
  json: unknown;
}

export function longRequestJson(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: unknown,
): Promise<LongResponse> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method,
        headers: {
          ...headers,
          ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 0,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const isJson = (res.headers['content-type'] ?? '').includes('application/json');
          let json: unknown = null;
          if (isJson && text.length > 0) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
