'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useEffect, useState } from 'react'
import { CheckCircle2, Heart, Loader2, RefreshCw, XCircle, AlertTriangle } from 'lucide-react'
import type {
  HealthComponentsResponse as HealthResponse,
  HealthComponent as Component,
} from '../../lib/contracts/admin-health-components'

export type { Component }

const STATUS_TONE: Record<Component['status'], string> = {
  ok: 'text-[var(--success)] bg-[var(--success)]/10',
  warming: 'text-[var(--accent)] bg-[var(--accent)]/10',
  degraded: 'text-[var(--warning)] bg-[var(--warning)]/10',
  disabled: 'text-[var(--text-faint)] bg-[var(--bg-overlay)]',
  unreachable: 'text-[var(--danger)] bg-[var(--danger)]/10',
}

const STATUS_ICON: Record<Component['status'], typeof CheckCircle2> = {
  ok: CheckCircle2,
  warming: Loader2,
  degraded: AlertTriangle,
  disabled: XCircle,
  unreachable: XCircle,
}

export function HealthPanel() {
  const [data, setData] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [auto, setAuto] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/health/components', {
        cache: 'no-store',
      })
      const json = (await res.json()) as HealthResponse | { error?: string }
      if (!res.ok) {
        const err = (json as { error?: string }).error
        throw new Error(err ?? `Failed ${res.status}`)
      }
      setData(json as HealthResponse)
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
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [auto])

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Heart className="w-4 h-4 text-[var(--danger)]" /> Health components
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Per-component status grid (DB / embedder / intent classifier /
            OpenAI key / changefeed / calibration). Deeper than the binary{' '}
            <code>/health</code> liveness probe.
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
            auto 10s
          </label>
        </div>
      </header>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      {data && (
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.components.map((c) => {
            const Icon = STATUS_ICON[c.status]
            return (
              <article
                key={c.name}
                className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]"
              >
                <header className="flex items-center gap-2 mb-2">
                  <Icon
                    className={`w-4 h-4 ${
                      STATUS_TONE[c.status].split(' ')[0]
                    } ${c.status === 'warming' ? 'animate-spin' : ''}`}
                  />
                  <h2 className="text-sm font-mono text-[var(--text)] truncate">
                    {c.name}
                  </h2>
                  <span
                    className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-mono ${STATUS_TONE[c.status]}`}
                  >
                    {c.status}
                  </span>
                </header>
                {c.message && (
                  <div className="text-[10px] text-[var(--text-muted)]">
                    {c.message}
                  </div>
                )}
                {typeof c.latencyMs === 'number' && (
                  <div className="text-[10px] text-[var(--text-faint)] font-mono mt-1">
                    ping: {c.latencyMs}ms
                  </div>
                )}
              </article>
            )
          })}
        </section>
      )}

      {data && (
        <div className="text-[10px] text-[var(--text-faint)] font-mono">
          generated {data.generatedAt}
        </div>
      )}
    </div>
  )
}
