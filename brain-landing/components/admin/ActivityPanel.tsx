'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useEffect, useState } from 'react'
import { Loader2, Radio, RefreshCw } from 'lucide-react'
import type {
  NowResponse as ActivityResponse,
  InFlightRequest,
} from '../../lib/contracts/admin-now'

export type { InFlightRequest }

export function ActivityPanel() {
  const [data, setData] = useState<ActivityResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [auto, setAuto] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [, force] = useState({})

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/now', {
        cache: 'no-store',
      })
      const json = (await res.json()) as ActivityResponse | { error?: string }
      if (!res.ok) {
        const err = (json as { error?: string }).error
        throw new Error(err ?? `Failed ${res.status}`)
      }
      setData(json as ActivityResponse)
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
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [auto])

  // Re-tick every 500ms so "elapsed" updates even while no new fetch
  useEffect(() => {
    const t = setInterval(() => force({}), 500)
    return () => clearInterval(t)
  }, [])

  const now = Date.now()
  const rows = (data?.inFlight ?? []).map((r) => ({
    ...r,
    elapsedMs: now - r.startedAtMs,
  }))

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Radio className="w-4 h-4 text-[var(--accent)]" /> In-flight
            requests
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Currently open HTTP requests, oldest first. Live elapsed counter
            ticks even between polls so slow handlers float to the top.
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
            auto 2s
          </label>
        </div>
      </header>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      <div className="rounded-md border border-[var(--border)] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-1.5">elapsed</th>
              <th className="text-left px-3 py-1.5">method</th>
              <th className="text-left px-3 py-1.5">path</th>
              <th className="text-left px-3 py-1.5">actor</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const tone =
                r.elapsedMs > 30_000
                  ? 'text-[var(--danger)]'
                  : r.elapsedMs > 5_000
                    ? 'text-[var(--warning)]'
                    : 'text-[var(--text)]'
              return (
                <tr
                  key={r.id}
                  className="border-t border-[var(--border)] font-mono"
                >
                  <td className={`px-3 py-1 tabular-nums ${tone}`}>
                    <Loader2 className="inline w-3 h-3 mr-1 animate-spin opacity-60" />
                    {formatElapsed(r.elapsedMs)}
                  </td>
                  <td className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
                    {r.method}
                  </td>
                  <td className="px-3 py-1 text-[10px] text-[var(--text)] truncate">
                    {r.path}
                  </td>
                  <td className="px-3 py-1 text-[10px] text-[var(--text-faint)]">
                    {r.companyId ?? 'anon'}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-6 text-center text-[var(--text-muted)] italic"
                >
                  Nothing in flight. Either the service is idle or this admin
                  request is the only one (it self-excludes).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}
