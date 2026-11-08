/**
 * The per-visitor bucket in front of `/api/auth/demo` (the same rule as
 * @inite/auth's kit, kit/demo.ts). auth.inite.ai throttles the demo grant
 * at 30 a minute per client; the product owns the per-visitor cap, so one
 * address cannot spend the whole client's minute.
 *
 * Fixed one-minute windows, in this process: enough for a button. The
 * process-wide cap holds whatever the per-address keys are, and the map is
 * bounded so a flood of addresses cannot grow it.
 */
export function minuteBuckets(perKey: number, total: number, maxKeys = 10_000) {
  let window = 0
  let all = 0
  const counts = new Map<string, number>()
  return {
    /** Seconds until the window turns when refused, else 0. */
    take(key: string, nowMs = Date.now()): number {
      const w = Math.floor(nowMs / 60_000)
      if (w !== window) {
        window = w
        all = 0
        counts.clear()
      }
      const retry = Math.max(1, Math.ceil(((w + 1) * 60_000 - nowMs) / 1000))
      const n = counts.get(key) ?? 0
      if (n >= perKey || all >= total) return retry
      if (!counts.has(key) && counts.size >= maxKeys) return retry
      counts.set(key, n + 1)
      all += 1
      return 0
    },
  }
}

/** The visitor's address: Cloudflare's header, then the proxy's, then the first hop. */
export function clientIp(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip')?.trim() ||
    headers.get('x-real-ip')?.trim() ||
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  )
}
