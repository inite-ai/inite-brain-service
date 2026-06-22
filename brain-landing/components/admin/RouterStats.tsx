'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { RouterStatsResponse } from '../../lib/contracts/admin-router-stats'

interface Sample {
  ts: number
  hitRate: number
  routeSize: number
  embedSize: number
  intentSize: number
  collapseSize: number
}

export function RouterStats() {
  const [data, setData] = useState<RouterStatsResponse | null>(null)
  const [tenant, setTenant] = useState('')
  const [auto, setAuto] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const samplesRef = useRef<Sample[]>([])
  const [samples, setSamples] = useState<Sample[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const url = new URL(
        '/api/admin/proxy/v1/admin/router/stats',
        window.location.origin,
      )
      if (tenant) url.searchParams.set('companyId', tenant)
      const res = await fetch(url.toString(), { cache: 'no-store' })
      const json = (await res.json()) as
        | RouterStatsResponse
        | { error?: string }
      if (!res.ok) {
        const err = (json as { error?: string }).error
        throw new Error(err ?? `Failed ${res.status}`)
      }
      const ok = json as RouterStatsResponse
      setData(ok)
      setError(null)
      const sample: Sample = {
        ts: Date.now(),
        hitRate: ok.routeCache.hitRate,
        routeSize: ok.routeCache.size,
        embedSize: ok.embedderCache.size,
        intentSize: ok.intentClassifier.cacheSize,
        collapseSize: ok.collapsePatternPoolSize,
      }
      samplesRef.current = [...samplesRef.current, sample].slice(-120)
      setSamples(samplesRef.current)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [tenant])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!auto) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [auto, load])

  const formattedSamples = samples.map((s) => ({
    ...s,
    t: new Date(s.ts).toLocaleTimeString().slice(0, 8),
    hitRatePct: Math.round(s.hitRate * 1000) / 10,
  }))

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)]">
            Hybrid router / cache
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Local-pre-pass observability: route cache hits, embedder LRU,
            zero-shot intent state, collapse-pattern pool. Drives LLM-skip rate.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <input
            placeholder="companyId (default: demo-live)"
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] font-mono w-44"
          />
          <button
            type="button"
            onClick={() => void load()}
            className="text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            refresh
          </button>
          <label className="flex items-center gap-1 text-[var(--text-muted)]">
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
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat
              label="route cache hit-rate"
              value={`${(data.routeCache.hitRate * 100).toFixed(1)}%`}
              hint={`${data.routeCache.hits} / ${data.routeCache.hits + data.routeCache.misses}`}
              tone={
                data.routeCache.hitRate > 0.6
                  ? 'good'
                  : data.routeCache.hitRate > 0.3
                    ? 'warn'
                    : undefined
              }
            />
            <Stat
              label="route cache size"
              value={data.routeCache.size.toString()}
              hint={data.routeCache.enabled ? 'enabled' : 'disabled'}
            />
            <Stat
              label="embedder cache"
              value={data.embedderCache.size.toString()}
              hint={data.embedderCache.provider}
            />
            <Stat
              label="intent classifier"
              value={
                data.intentClassifier.enabled
                  ? data.intentClassifier.ready
                    ? 'ready'
                    : 'warming'
                  : 'off'
              }
              hint={data.intentClassifier.model}
              tone={
                data.intentClassifier.enabled && data.intentClassifier.ready
                  ? 'good'
                  : data.intentClassifier.enabled
                    ? 'warn'
                    : undefined
              }
            />
            <Stat
              label="intent cache"
              value={data.intentClassifier.cacheSize.toString()}
              hint={`ask ≥ ${data.intentClassifier.askThreshold}`}
            />
            <Stat
              label="collapse patterns"
              value={data.collapsePatternPoolSize.toString()}
              hint={`tenant: ${data.tenant}`}
            />
          </section>

          <section>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
              Route cache hit-rate (rolling window)
            </div>
            <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={formattedSamples}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="t" stroke="var(--text-faint)" fontSize={10} />
                  <YAxis
                    stroke="var(--text-faint)"
                    fontSize={10}
                    domain={[0, 100]}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      fontSize: 11,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="hitRatePct"
                    stroke="var(--accent)"
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
              Cache sizes over time
            </div>
            <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={formattedSamples}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="t" stroke="var(--text-faint)" fontSize={10} />
                  <YAxis stroke="var(--text-faint)" fontSize={10} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      fontSize: 11,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="routeSize"
                    stroke="var(--accent)"
                    dot={false}
                    isAnimationActive={false}
                    name="route"
                  />
                  <Line
                    type="monotone"
                    dataKey="embedSize"
                    stroke="var(--success)"
                    dot={false}
                    isAnimationActive={false}
                    name="embed"
                  />
                  <Line
                    type="monotone"
                    dataKey="intentSize"
                    stroke="var(--warning)"
                    dot={false}
                    isAnimationActive={false}
                    name="intent"
                  />
                  <Line
                    type="monotone"
                    dataKey="collapseSize"
                    stroke="var(--text-muted)"
                    dot={false}
                    isAnimationActive={false}
                    name="collapse"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'good' | 'warn' | 'bad'
}) {
  const toneClass =
    tone === 'good'
      ? 'text-[var(--success)]'
      : tone === 'warn'
        ? 'text-[var(--warning)]'
        : tone === 'bad'
          ? 'text-[var(--danger)]'
          : 'text-[var(--text)]'
  return (
    <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold font-mono tabular-nums ${toneClass}`}>
        {value}
      </div>
      {hint && (
        <div className="text-[10px] text-[var(--text-faint)] font-mono mt-0.5 truncate">
          {hint}
        </div>
      )}
    </div>
  )
}
