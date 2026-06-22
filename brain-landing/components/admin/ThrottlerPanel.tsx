'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useEffect, useState } from 'react'
import { RefreshCw, SlidersHorizontal } from 'lucide-react'
import type {
  ThrottlerResponse as ThrottlerSnapshot,
  RouteRow,
  ActorRow,
} from '../../lib/contracts/admin-throttler'

export type { RouteRow, ActorRow }

export function ThrottlerPanel() {
  const [data, setData] = useState<ThrottlerSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [auto, setAuto] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/throttler', {
        cache: 'no-store',
      })
      const json = (await res.json()) as ThrottlerSnapshot | { error?: string }
      if (!res.ok) {
        const err = (json as { error?: string }).error
        throw new Error(err ?? `Failed ${res.status}`)
      }
      setData(json as ThrottlerSnapshot)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    if (!auto) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [auto])

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-[var(--accent)]" />{' '}
            Throttler
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            HTTP-level counter — total hits + 429s per route / per actor in
            the trailing 1h window. nestjs/throttler&apos;s native storage
            doesn&apos;t expose current bucket fill; this layer is the
            workaround.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            refresh
          </button>
          <label className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            auto 5s
          </label>
        </div>
      </header>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <section>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
              Top routes
            </div>
            <table className="w-full text-xs border border-[var(--border)] rounded-md overflow-hidden">
              <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="text-left px-3 py-1.5">route</th>
                  <th className="text-right px-3 py-1.5">total</th>
                  <th className="text-right px-3 py-1.5">429</th>
                  <th className="text-right px-3 py-1.5">rate</th>
                </tr>
              </thead>
              <tbody>
                {data.topRoutes.map((r) => (
                  <tr
                    key={r.route}
                    className="border-t border-[var(--border)] font-mono"
                  >
                    <td className="px-3 py-1 text-[10px] text-[var(--text)] truncate max-w-[28ch]">
                      {r.route}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums">
                      {r.total}
                    </td>
                    <td
                      className={`px-3 py-1 text-right tabular-nums ${
                        r.throttled > 0 ? 'text-[var(--danger)]' : 'text-[var(--text-faint)]'
                      }`}
                    >
                      {r.throttled}
                    </td>
                    <td
                      className={`px-3 py-1 text-right text-[10px] tabular-nums ${
                        r.throttledRate > 0.05
                          ? 'text-[var(--danger)]'
                          : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {(r.throttledRate * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
                {data.topRoutes.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-4 text-center text-[var(--text-muted)] italic"
                    >
                      No traffic in the last hour.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <section>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
              Top actors (talkers)
            </div>
            <table className="w-full text-xs border border-[var(--border)] rounded-md overflow-hidden">
              <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="text-left px-3 py-1.5">actor</th>
                  <th className="text-right px-3 py-1.5">total</th>
                  <th className="text-right px-3 py-1.5">429</th>
                  <th className="text-right px-3 py-1.5">rate</th>
                </tr>
              </thead>
              <tbody>
                {data.topActors.map((a) => (
                  <tr
                    key={a.actor}
                    className="border-t border-[var(--border)] font-mono"
                  >
                    <td className="px-3 py-1 text-[10px] text-[var(--text)] truncate">
                      {a.actor}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums">
                      {a.total}
                    </td>
                    <td
                      className={`px-3 py-1 text-right tabular-nums ${
                        a.throttled > 0 ? 'text-[var(--danger)]' : 'text-[var(--text-faint)]'
                      }`}
                    >
                      {a.throttled}
                    </td>
                    <td
                      className={`px-3 py-1 text-right text-[10px] tabular-nums ${
                        a.throttledRate > 0.05
                          ? 'text-[var(--danger)]'
                          : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {(a.throttledRate * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
                {data.topActors.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-4 text-center text-[var(--text-muted)] italic"
                    >
                      —
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {data && data.recentThrottled.length > 0 && (
        <section>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
            Recent 429s
          </div>
          <table className="w-full text-xs border border-[var(--border)] rounded-md overflow-hidden">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-1.5">ts</th>
                <th className="text-left px-3 py-1.5">actor</th>
                <th className="text-left px-3 py-1.5">bucket</th>
                <th className="text-left px-3 py-1.5">method</th>
                <th className="text-left px-3 py-1.5">path</th>
              </tr>
            </thead>
            <tbody>
              {data.recentThrottled.map((r, i) => (
                <tr
                  key={`${r.ts}-${i}`}
                  className="border-t border-[var(--border)] font-mono"
                >
                  <td className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
                    {new Date(r.ts).toISOString().slice(11, 19)}
                  </td>
                  <td className="px-3 py-1 text-[10px]">{r.actor}</td>
                  <td className="px-3 py-1 text-[10px]">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] ${
                        r.bucket === 'expensive'
                          ? 'text-[var(--warning)] bg-[var(--warning)]/10'
                          : 'text-[var(--text-muted)] bg-[var(--bg-overlay)]'
                      }`}
                    >
                      {r.bucket}
                    </span>
                  </td>
                  <td className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
                    {r.method}
                  </td>
                  <td className="px-3 py-1 text-[10px] truncate">{r.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
