import 'server-only'
import { NextRequest } from 'next/server'

/**
 * Shared mechanics for the brain BFF proxies (admin + end-user). Keeps
 * path extraction and allow-list matching in one place so a security fix
 * (e.g. segment anchoring) can't drift between the two routes.
 */

/** Pull the [...path] segments out of `/<routePrefix>/a/b/c`. */
export function extractProxyPath(
  request: NextRequest,
  routePrefix: string,
): string[] {
  const prefix = routePrefix.endsWith('/') ? routePrefix : `${routePrefix}/`
  const { pathname } = request.nextUrl
  const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
  return rest.split('/').filter(Boolean)
}

/** Collect the request's query string into a plain object. */
export function collectQuery(request: NextRequest): Record<string, string> {
  const query: Record<string, string> = {}
  request.nextUrl.searchParams.forEach((v, k) => {
    query[k] = v
  })
  return query
}

export interface AllowlistOptions {
  allow: string[]
  /** Case-insensitive, segment-aware suffix denies (e.g. '/forget'). */
  deny?: string[]
}

/**
 * Allow-list match anchored on path-segment boundaries. A prefix `p`
 * matches a path only when the path equals `p` or continues with `/`
 * after `p` — so `v1/search` does NOT match `v1/searchsecret`. Denies
 * are checked first, case-insensitively, on a trailing segment so
 * `/forget`, `/forget/`, `/FORGET` are all rejected.
 */
export function isPathAllowed(
  rawPath: string,
  { allow, deny = [] }: AllowlistOptions,
): boolean {
  const normalized = rawPath.replace(/^\/+/, '').replace(/\?.*$/, '')
  const lower = normalized.toLowerCase()
  for (const d of deny) {
    const dl = d.toLowerCase()
    // match `.../forget` and `.../forget/` (trailing slash)
    if (lower.endsWith(dl) || lower.endsWith(`${dl}/`)) return false
  }
  return allow.some((p) => {
    const pn = p.replace(/^\/+/, '')
    if (normalized === pn) return true
    const boundary = pn.endsWith('/') ? pn : `${pn}/`
    return normalized.startsWith(boundary)
  })
}
