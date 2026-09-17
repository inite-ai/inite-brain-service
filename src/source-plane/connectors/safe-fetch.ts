import { promises as dns } from 'node:dns';
import { assertPublicHttpUrl, EgressDeniedError } from '../../common/egress-guard';
import { sourceEgressAllowPrivate } from '../../common/source-plane-flags';

/**
 * The one outbound HTTP path of the network connectors. Every hop —
 * the first request AND every redirect — passes the egress guard before
 * it is fetched, so a public URL redirecting into the metadata endpoint
 * is refused at the hop, not followed. Redirects are followed manually
 * (`redirect: 'manual'`) for exactly that reason. Bodies are read up to
 * `maxBytes` and refused beyond it; a timeout aborts the request.
 *
 * Private hosts need the double opt-in (SOURCE_EGRESS_ALLOW_PRIVATE on
 * the brain AND `allowPrivate` on the connection); with it, plain http
 * is also accepted — a LAN wiki rarely has a certificate. One target is
 * refused even then: the link-local range that carries every cloud's
 * instance-metadata endpoint (169.254.0.0/16) — no source lives there,
 * and a LAN opt-in must never become an IAM-credential read.
 */
export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD' | undefined;
  headers?: Record<string, string> | undefined;
  allowPrivate?: boolean | undefined;
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
  maxRedirects?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  headers: Headers;
  body: Buffer;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;

export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const allowHttp = opts.allowPrivate === true && sourceEgressAllowPrivate();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    await assertPublicHttpUrl(url, { allowHttp });
    if (allowHttp) await refuseLinkLocal(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { 'user-agent': 'inite-brain-source/1.0', ...(opts.headers ?? {}) },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error(`redirect without location from ${url}`);
        if (hop >= maxRedirects) throw new Error(`too many redirects from ${rawUrl}`);
        url = new URL(location, url).toString();
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`response over ${maxBytes} bytes from ${url}`);
      }
      const body = await readBounded(res, maxBytes, url);
      return { url, status: res.status, headers: res.headers, body };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** The metadata range is refused under the opt-in too — literal or resolved. */
async function refuseLinkLocal(rawUrl: string): Promise<void> {
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return; // unresolvable: fetch itself will fail
  }
  for (const { address } of addrs) {
    const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (/^169\.254\./.test(v4)) {
      throw new EgressDeniedError(
        `"${rawUrl}" resolves to the link-local metadata range — refused`,
      );
    }
  }
}

async function readBounded(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response over ${maxBytes} bytes from ${url}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export { EgressDeniedError };

/**
 * The guard as a `fetch` a client library can be handed (the MCP SDK's
 * Streamable HTTP transport takes one): every URL it is asked for passes
 * the same egress check as safeFetch's hops, redirects are never
 * followed (`manual` — a 3xx surfaces as the library's own error), and
 * the outer signal aborts in-flight requests. Bodies are the library's
 * to read; the MCP transport streams JSON-RPC, so no byte cap applies
 * here — the connector caps what it keeps.
 */
export function guardedFetch(opts: {
  allowPrivate?: boolean | undefined;
  signal?: AbortSignal | undefined;
}) {
  const allowHttp = opts.allowPrivate === true && sourceEgressAllowPrivate();
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    await assertPublicHttpUrl(target, { allowHttp });
    if (allowHttp) await refuseLinkLocal(target);
    const signal =
      opts.signal && init?.signal
        ? AbortSignal.any([opts.signal, init.signal])
        : (init?.signal ?? opts.signal);
    return fetch(target, {
      ...init,
      redirect: 'manual',
      ...(signal ? { signal } : {}),
    });
  };
}
