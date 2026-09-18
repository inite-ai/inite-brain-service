import { safeFetch } from './safe-fetch';

/**
 * Bulk API 2.0 query for the first walk of a large org (docs/roadmap/
 * crm-sources-2026-09.md § 4.2.1): one query job per object, polled to
 * `JobComplete`, its results read in CSV pages by `Sforce-Locator`. The
 * rows come back with the same column names the query endpoint uses
 * (relationship fields flattened to `Owner.Name`), so the envelope
 * builder is shared. Used only when the connection asks (`config.bulk`)
 * and the run is a full walk — the incremental walk stays on the query
 * endpoint, whose pages are ready at once.
 */

export interface BulkPageState {
  jobId: string;
  locator: string | null;
}

export interface BulkHttp {
  token: string;
  private: boolean;
  signal: AbortSignal;
}

const POLL_MS = 2_000;
const POLL_MAX_MS = 10 * 60_000;
const RESULT_MAX_RECORDS = 10_000;
const RESULT_MAX_BYTES = 64 * 1024 * 1024;

/** Create the job and wait for it; aborts with the run. */
export async function startBulkQuery(p: {
  http: BulkHttp;
  instanceUrl: string;
  apiVersion: string;
  soql: string;
}): Promise<BulkPageState> {
  const root = `${p.instanceUrl}/services/data/${p.apiVersion}/jobs/query`;
  const created = await bulkJson(p.http, root, {
    method: 'POST',
    body: JSON.stringify({ operation: 'query', query: p.soql }),
  });
  const jobId = typeof created.id === 'string' ? created.id : '';
  if (!jobId) throw new Error('salesforce bulk: the job answer named no id');
  const started = Date.now();
  for (;;) {
    const job = await bulkJson(p.http, `${root}/${encodeURIComponent(jobId)}`, { method: 'GET' });
    const state = typeof job.state === 'string' ? job.state : '';
    if (state === 'JobComplete') return { jobId, locator: null };
    if (state === 'Failed' || state === 'Aborted') {
      throw new Error(
        `salesforce bulk: job ${jobId} ${state}${typeof job.errorMessage === 'string' ? ` — ${job.errorMessage}` : ''}`,
      );
    }
    if (Date.now() - started > POLL_MAX_MS) {
      throw new Error(`salesforce bulk: job ${jobId} still ${state || 'pending'} after 10 min`);
    }
    await sleep(POLL_MS, p.http.signal);
  }
}

/** One page of a finished job's results; `next` is null on the last page. */
export async function readBulkPage(p: {
  http: BulkHttp;
  instanceUrl: string;
  apiVersion: string;
  state: BulkPageState;
}): Promise<{ rows: Array<Record<string, string>>; next: BulkPageState | null }> {
  const url = new URL(
    `${p.instanceUrl}/services/data/${p.apiVersion}/jobs/query/${encodeURIComponent(p.state.jobId)}/results`,
  );
  url.searchParams.set('maxRecords', String(RESULT_MAX_RECORDS));
  if (p.state.locator) url.searchParams.set('locator', p.state.locator);
  const res = await safeFetch(url.toString(), {
    method: 'GET',
    headers: { authorization: `Bearer ${p.http.token}`, accept: 'text/csv' },
    allowPrivate: p.http.private,
    signal: p.http.signal,
    maxBytes: RESULT_MAX_BYTES,
    timeoutMs: 120_000,
  });
  if (res.status !== 200) {
    throw new Error(`salesforce bulk: results answered ${res.status}`);
  }
  const locator = res.headers.get('sforce-locator');
  const rows = parseCsv(res.body.toString('utf8'));
  const next = locator && locator !== 'null' ? { jobId: p.state.jobId, locator } : null;
  return { rows, next };
}

/** RFC 4180: quoted fields with commas, quotes and newlines; the first row names the columns. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  const [header, ...body] = records;
  if (!header) return [];
  return body
    .filter((r) => r.length > 1 || (r[0] ?? '').length > 0)
    .map((r) => {
      const out: Record<string, string> = {};
      header.forEach((k, i) => {
        out[k] = r[i] ?? '';
      });
      return out;
    });
}

async function bulkJson(
  http: BulkHttp,
  url: string,
  init: { method: 'GET' | 'POST'; body?: string },
): Promise<Record<string, unknown>> {
  const res = await safeFetch(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${http.token}`,
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
    allowPrivate: http.private,
    signal: http.signal,
    maxBytes: 1024 * 1024,
    timeoutMs: 60_000,
  });
  let json: unknown;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new Error(`salesforce bulk: ${url} answered ${res.status} with a non-JSON body`);
  }
  if (res.status >= 400) {
    const first = Array.isArray(json) ? json[0] : json;
    const msg =
      first &&
      typeof first === 'object' &&
      typeof (first as { message?: unknown }).message === 'string'
        ? (first as { message: string }).message
        : `http ${res.status}`;
    throw new Error(`salesforce bulk: ${msg}`);
  }
  return json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
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
