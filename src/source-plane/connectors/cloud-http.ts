import { safeFetch, type SafeFetchResult } from './safe-fetch';

/**
 * The HTTP the cloud connectors (gdrive, onedrive, dropbox) share: a
 * bearer from the connected account on every call, JSON in and out,
 * bytes bounded, 429 / 5xx retried with backoff (Retry-After honoured,
 * capped), 401 / 403 named for the operator ("reconnect the account"),
 * and everything through safeFetch — the egress guard on every hop,
 * the dev override's loopback only under the private opt-in.
 */
export interface CloudHttp {
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
  postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
  /** Bytes at `url`; `bearer: false` for a pre-authenticated download URL (never leak the token to it). */
  getBytes(
    url: string,
    opts: { maxBytes: number; bearer?: boolean | undefined; headers?: Record<string, string> },
  ): Promise<{ bytes: Buffer; mediaType: string | null }>;
  /** Bytes from a POST (Dropbox's RPC-style downloads carry their argument in a header). */
  postBytes(
    url: string,
    opts: { maxBytes: number; headers?: Record<string, string>; body?: string | undefined },
  ): Promise<{ bytes: Buffer; mediaType: string | null }>;
}

export class CloudHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_CAP_MS = 30_000;
const JSON_MAX_BYTES = 8 * 1024 * 1024;

export function cloudHttp(p: {
  token: string;
  private: boolean;
  signal: AbortSignal;
  timeoutMs?: number | undefined;
  /** False = the token does not ride as a bearer (a vendor's own header in `headers` carries it). */
  bearer?: boolean | undefined;
  /** Headers on every call (a vendor's own auth scheme). */
  headers?: Record<string, string> | undefined;
}): CloudHttp {
  const auth = {
    ...(p.bearer === false ? {} : { authorization: `Bearer ${p.token}` }),
    ...(p.headers ?? {}),
  };
  const base = { allowPrivate: p.private, signal: p.signal, timeoutMs: p.timeoutMs ?? 30_000 };

  const call = async (
    url: string,
    init: {
      method: 'GET' | 'POST';
      headers: Record<string, string>;
      body?: string;
      maxBytes: number;
    },
  ): Promise<SafeFetchResult> => {
    for (let attempt = 1; ; attempt++) {
      const res = await safeFetch(url, {
        ...base,
        method: init.method,
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        maxBytes: init.maxBytes,
      });
      if (res.status < 400) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw errorOf(res, url);
      await sleep(backoffMs(res, attempt), p.signal);
    }
  };

  return {
    async getJson(url, headers = {}) {
      const res = await call(url, {
        method: 'GET',
        headers: { ...auth, accept: 'application/json', ...headers },
        maxBytes: JSON_MAX_BYTES,
      });
      return parseJson(res, url);
    },
    async postJson(url, body, headers = {}) {
      const res = await call(url, {
        method: 'POST',
        headers: {
          ...auth,
          accept: 'application/json',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        maxBytes: JSON_MAX_BYTES,
      });
      return parseJson(res, url);
    },
    async getBytes(url, opts) {
      const res = await call(url, {
        method: 'GET',
        headers: { ...(opts.bearer === false ? {} : auth), ...(opts.headers ?? {}) },
        maxBytes: opts.maxBytes,
      });
      return { bytes: res.body, mediaType: res.headers.get('content-type') };
    },
    async postBytes(url, opts) {
      const res = await call(url, {
        method: 'POST',
        headers: { ...auth, ...(opts.headers ?? {}) },
        body: opts.body ?? '',
        maxBytes: opts.maxBytes,
      });
      return { bytes: res.body, mediaType: res.headers.get('content-type') };
    },
  };
}

function parseJson(res: SafeFetchResult, url: string): unknown {
  if (res.body.byteLength === 0) return null;
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new CloudHttpError(`non-JSON answer from ${url}`, res.status);
  }
}

function errorOf(res: SafeFetchResult, url: string): CloudHttpError {
  const snippet = res.body.toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
  if (res.status === 401)
    return new CloudHttpError('the connected account was rejected (401) — reconnect it', 401);
  if (res.status === 403) return new CloudHttpError(`forbidden (403) at ${url}: ${snippet}`, 403);
  if (res.status === 404) return new CloudHttpError(`not found (404): ${url}`, 404);
  if (res.status === 429) return new CloudHttpError(`rate limited (429) at ${url}`, 429);
  return new CloudHttpError(`http ${res.status} from ${url}: ${snippet}`, res.status);
}

function backoffMs(res: SafeFetchResult, attempt: number): number {
  const ra = Number(res.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, RETRY_AFTER_CAP_MS);
  return Math.min(500 * 2 ** (attempt - 1), RETRY_AFTER_CAP_MS);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
