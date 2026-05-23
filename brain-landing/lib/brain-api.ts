/**
 * Server-side client to the brain backend.
 *
 * Lives in `/api/admin/proxy/[...path]/route.ts` only. The browser never
 * gets `BRAIN_SERVICE_KEY` — admin auth is enforced at the Next.js layer
 * via `withAdmin()` from `server-auth.ts`; once that gate is passed, we
 * impersonate brain as a service identity with full admin scopes.
 *
 * BRAIN_API_URL — internal address (docker network). Defaults to the
 * canonical public URL so dev `pnpm dev` against a remote brain works
 * without extra config.
 */

const BRAIN_API_URL =
  process.env.BRAIN_API_URL ||
  process.env.NEXT_PUBLIC_BRAIN_API_URL ||
  'https://brain.inite.ai'

const BRAIN_SERVICE_KEY = process.env.BRAIN_SERVICE_KEY || ''

export interface BrainFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | undefined>
  signal?: AbortSignal
}

export interface BrainResponse<T = unknown> {
  ok: boolean
  status: number
  data: T | null
  error?: string
}

function buildUrl(path: string, query?: BrainFetchOptions['query']): string {
  const url = new URL(path.replace(/^\/+/, '/'), BRAIN_API_URL)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

export async function brainFetch<T = unknown>(
  path: string,
  options: BrainFetchOptions = {},
): Promise<BrainResponse<T>> {
  if (!BRAIN_SERVICE_KEY) {
    return {
      ok: false,
      status: 500,
      data: null,
      error: 'BRAIN_SERVICE_KEY is not configured — admin proxy disabled',
    }
  }
  const url = buildUrl(path, options.query)
  try {
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BRAIN_SERVICE_KEY}`,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      cache: 'no-store',
    })
    const text = await res.text()
    let data: T | null = null
    try {
      data = text ? (JSON.parse(text) as T) : null
    } catch {
      // Keep raw text in error path
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data,
        error:
          (data && (data as { error?: string }).error) ||
          text.slice(0, 300) ||
          res.statusText,
      }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: (err as Error).message,
    }
  }
}
