import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { EgressDeniedError, isNonPublicAddress } from '../../common/egress-guard';

/**
 * One HTTP request whose socket can only reach an address the egress
 * policy allows. The pre-flight check (`assertPublicHttpUrl`) resolves
 * the host and judges it, but `fetch` then resolves it AGAIN to connect —
 * a name with a zero TTL can answer a public address to the check and
 * 169.254.169.254 to the connect (DNS rebinding). Here the judgement
 * runs inside the socket's own `lookup`, on the very addresses it dials,
 * so there is no second resolution to rebind. An IP literal never calls
 * `lookup`, and needs none: it cannot rebind, and the pre-flight judged it.
 *
 * `node:http(s)` rather than `fetch`: the global fetch takes no lookup
 * hook without a direct undici dependency. Redirects are never followed
 * here — the caller sees the 3xx and decides (safeFetch re-checks the hop).
 */
export type EgressPolicy = 'public' | 'not-link-local';

export interface PinnedRequestInit {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | Buffer | undefined;
  signal?: AbortSignal | undefined;
}

const LINK_LOCAL_V4 = /^169\.254\./;

/** Is this resolved address one the policy refuses? */
export function refusedAddress(policy: EgressPolicy, address: string, family: number): boolean {
  if (policy === 'public') return isNonPublicAddress(address, family);
  const v4 = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  return LINK_LOCAL_V4.test(v4) || /^fe[89ab][0-9a-f]:/i.test(address);
}

/** A `lookup` for `net.connect` that refuses, at connect time, every address the policy bars. */
export function guardedLookup(policy: EgressPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addrs: LookupAddress[]) => {
      if (err) return callback(err, '', 0);
      const bad = addrs.find((a) => refusedAddress(policy, a.address, a.family));
      if (bad || addrs.length === 0) {
        const why = bad ? `a refused address (${bad.address})` : 'no address';
        return callback(new EgressDeniedError(`"${hostname}" resolves to ${why}`), '', 0);
      }
      if (options.all) return callback(null, addrs);
      const first = addrs[0]!;
      return callback(null, first.address, first.family);
    });
  };
}

/** Statuses whose Response must carry no body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function toHeaders(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export function pinnedRequest(
  url: string,
  init: PinnedRequestInit,
  policy: EgressPolicy,
): Promise<Response> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: '*/*', ...(init.headers ?? {}) };
  // A body goes with its length: node:http would otherwise send it
  // chunked, which some token endpoints refuse (fetch never chunks a string).
  const hasLength = Object.keys(headers).some((h) => h.toLowerCase() === 'content-length');
  if (init.body !== undefined && !hasLength) {
    headers['content-length'] = String(Buffer.byteLength(init.body));
  }
  return new Promise<Response>((resolve, reject) => {
    const req = send(
      target,
      {
        method,
        headers,
        lookup: guardedLookup(policy),
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const empty = method === 'HEAD' || NULL_BODY.has(status);
        if (empty) res.resume();
        const body = empty
          ? null
          : (Readable.toWeb(res) as WebReadableStream<Uint8Array> as unknown as ReadableStream);
        resolve(
          new Response(body, {
            status,
            statusText: res.statusMessage ?? '',
            headers: toHeaders(res),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}
