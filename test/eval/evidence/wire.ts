/**
 * The evidence battery's wire layer — extracted for the same reason
 * test/eval/memory-fitness/interleave.ts and
 * test/eval/domain-packs/scorers.ts are: the runner is a scoring
 * narrative, and HTTP plumbing that never makes a decision does not
 * belong inside it (also the 800-line file gate).
 *
 * Three things live here and nothing else:
 *
 *  - `call` — a NON-THROWING JSON request. Every check on this plane
 *    asserts a STATUS (404 for a dark route, 409 for the dedup-probe
 *    fence, 400 for a bad locator, 413 for an over-cap blob), so a client
 *    that throws on non-2xx would turn the thing under test into an
 *    exception. It returns `{ status, json }` and lets the caller decide.
 *  - `bytes` — the same, for the raw-read gateway: the response BODY is
 *    the evidence, so the buffer and the security headers come back
 *    verbatim, unparsed.
 *  - `upload` — `multipart/form-data` through the platform `FormData` /
 *    `Blob` globals (Node >= 18). No new dependency: the battery ships
 *    with the repo and must run from a bare checkout.
 *
 * Credentials travel as an explicit `Wire` argument rather than module
 * state because two of the checks are cross-tenant: the same helper is
 * called with tenant A's key and tenant B's, and a hidden default would
 * make the tenant fence untestable.
 */
import { createHash } from 'node:crypto';

/** Who to call as — one tenant's base URL + bearer key. */
export interface Wire {
  baseUrl: string;
  apiKey: string;
  companyId: string;
}

export interface JsonResult {
  status: number;
  /** Parsed body, or null when the response carried no JSON. */
  json: unknown;
  /** Raw body text, capped — the detail line of a failing check. */
  text: string;
}

export interface BytesResult {
  status: number;
  body: Buffer;
  headers: Headers;
}

/** Body text kept in a report line — a 404 page must not flood the JSON. */
const TEXT_MAX = 400;

export const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

/**
 * One JSON request. `auth: false` omits the Authorization header (the
 * redeem route is unauthenticated by design and must stay that way).
 */
export async function call(
  wire: Wire,
  req: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: unknown;
    auth?: boolean;
  },
): Promise<JsonResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (req.auth !== false) headers.Authorization = `Bearer ${wire.apiKey}`;
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${wire.baseUrl}${req.path}`, {
    method: req.method,
    headers,
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text: text.slice(0, TEXT_MAX) };
}

/** A raw byte read — body and headers verbatim (no JSON parse). */
export async function bytes(
  wire: Wire,
  req: { path: string; auth?: boolean },
): Promise<BytesResult> {
  const headers: Record<string, string> = {};
  if (req.auth !== false) headers.Authorization = `Bearer ${wire.apiKey}`;
  const res = await fetch(`${wire.baseUrl}${req.path}`, { method: 'GET', headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: buf, headers: res.headers };
}

/** The metadata half of a blob upload — every value rides as a text part. */
export interface UploadFields {
  modality: string;
  mediaType?: string | undefined;
  occurredAt: string;
  vertical: string;
  userId?: string | undefined;
  /** '' is load-bearing: it means "classified clean", not "unclassified". */
  piiClasses?: string | undefined;
  recorder?: string | undefined;
  packId?: string | undefined;
}

/**
 * POST /v1/ingest/evidence-blob. `contentType` is what the FILE PART
 * declares; `fields.mediaType` (when set) is the caller's override — the
 * two are separate on purpose, because the allowlist check reads the
 * override first and one of the checks needs them to disagree.
 */
export async function upload(
  wire: Wire,
  blob: { data: Buffer; filename: string; contentType: string },
  fields: UploadFields,
): Promise<JsonResult> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, value);
  }
  form.append(
    'file',
    new Blob([new Uint8Array(blob.data)], { type: blob.contentType }),
    blob.filename,
  );
  const res = await fetch(`${wire.baseUrl}/v1/ingest/evidence-blob`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${wire.apiKey}`, Accept: 'application/json' },
    body: form,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text: text.slice(0, TEXT_MAX) };
}

/** Read one string field off an untrusted wire object. */
export function str(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object') return null;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

/** Read one number field off an untrusted wire object. */
export function num(value: unknown, key: string): number | null {
  if (value === null || typeof value !== 'object') return null;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : null;
}

/** Read one boolean field off an untrusted wire object. */
export function bool(value: unknown, key: string): boolean | null {
  if (value === null || typeof value !== 'object') return null;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'boolean' ? v : null;
}

/** Read one array field off an untrusted wire object. */
export function arr(value: unknown, key: string): unknown[] {
  if (value === null || typeof value !== 'object') return [];
  const v = (value as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : [];
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
