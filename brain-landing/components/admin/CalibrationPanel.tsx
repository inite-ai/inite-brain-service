'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useEffect, useState } from 'react'
import {
  CartesianGrid,
  Cell,
  Bar,
  BarChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ComposedChart,
} from 'recharts'
import { Loader2, Play, RefreshCw } from 'lucide-react'

interface ReliabilityBin {
  lower: number
  upper: number
  midpoint: number
  n: number
  meanRaw: number
  meanCorrect: number
  meanCalibrated: number
}

interface CurvePoint {
  raw: number
  calibrated: number
}

interface CalibrationVersion {
  version: number
  sampleCount: number
  bins: number
  createdAt?: string
}

interface CalibrationResponse {
  disabled: boolean
  source: 'synthetic' | 'persisted'
  map: {
    thresholds: number[]
    values: number[]
    sampleCount: number
  } | null
  reliability: ReliabilityBin[]
  ece: number
  brier: number
  curve: CurvePoint[]
  versions?: CalibrationVersion[]
  error?: string
}

export function CalibrationPanel() {
  const [data, setData] = useState<CalibrationResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refitting, setRefitting] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/calibration', {
        cache: 'no-store',
      })
      const json = (await res.json()) as CalibrationResponse
      if (!res.ok) throw new Error(json.error ?? `Failed ${res.status}`)
      setData(json)
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

  const triggerRefit = async () => {
    setRefitting(true)
    setError(null)
    try {
      const res = await fetch(
        '/api/admin/proxy/v1/admin/maintenance/calibration-refit',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `Failed ${res.status}`)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRefitting(false)
    }
  }

  if (loading && !data) {
    return <div className="text-xs text-[var(--text-muted)]">Loading…</div>
  }
  if (error) {
    return (
      <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
    )
  }
  if (!data) return null

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)]">
            Confidence calibration
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Isotonic (PAV) map from raw extractor confidence to empirical
            accuracy. Source:{' '}
            <code className="text-[var(--accent)]">{data.source}</code> ·{' '}
            {data.map ? `${data.map.sampleCount} samples` : 'disabled'}
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
          <button
            type="button"
            onClick={() => void triggerRefit()}
            disabled={refitting}
            className="text-xs bg-[var(--accent)] text-white rounded-md px-2.5 py-1.5 flex items-center gap-1 disabled:opacity-50"
            title="Manual nightly-refit. Mirrors the 03:51 UTC cron — collects last-30d retraction outcomes, fits new isotonic map, persists a new version."
          >
            {refitting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Play className="w-3 h-3" />
            )}
            Refit now
          </button>
        </div>
      </header>

      {data.disabled && (
        <div className="border border-[var(--warning)]/40 bg-[var(--warning)]/5 rounded-md p-3 text-xs text-[var(--text)]">
          Calibration is disabled (<code>CALIBRATION_USE_GOLD_SET=0</code>).
          Raw confidence is passed through unchanged.
        </div>
      )}

      {!data.disabled && (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat
              label="ECE (raw vs gold)"
              value={(data.ece * 100).toFixed(2) + '%'}
              tone={
                data.ece < 0.05 ? 'good' : data.ece < 0.1 ? 'warn' : 'bad'
              }
              hint="Expected Calibration Error"
            />
            <Stat
              label="Brier (raw vs gold)"
              value={data.brier.toFixed(4)}
              hint="lower is better"
            />
            <Stat
              label="map bins"
              value={data.map?.thresholds.length.toString() ?? '—'}
              hint={`source: ${data.source}`}
            />
            <Stat
              label="sample count"
              value={data.map?.sampleCount.toString() ?? '—'}
              hint={
                (data.map?.sampleCount ?? 0) >= 40
                  ? 'above refit floor'
                  : 'below 40-pair floor'
              }
              tone={
                (data.map?.sampleCount ?? 0) >= 40 ? 'good' : 'warn'
              }
            />
          </section>

          <section>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
              Reliability diagram (gold set)
            </div>
            <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={data.reliability}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="midpoint"
                    type="number"
                    domain={[0, 1]}
                    tickFormatter={(v) => v.toFixed(1)}
                    stroke="var(--text-faint)"
                    fontSize={10}
                    label={{
                      value: 'predicted confidence',
                      position: 'insideBottom',
                      offset: -2,
                      style: { fill: 'var(--text-faint)', fontSize: 10 },
                    }}
                  />
                  <YAxis
                    type="number"
                    domain={[0, 1]}
                    tickFormatter={(v) => v.toFixed(1)}
                    stroke="var(--text-faint)"
                    fontSize={10}
                    label={{
                      value: 'empirical correctness',
                      angle: -90,
                      position: 'insideLeft',
                      style: { fill: 'var(--text-faint)', fontSize: 10 },
                    }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      fontSize: 11,
                    }}
                    formatter={(v, k) => [
                      typeof v === 'number' ? v.toFixed(3) : String(v),
                      String(k),
                    ]}
                  />
                  <ReferenceLine
                    segment={[
                      { x: 0, y: 0 },
                      { x: 1, y: 1 },
                    ]}
                    stroke="var(--text-faint)"
                    strokeDasharray="4 4"
                  />
                  <Bar
                    dataKey="meanCorrect"
                    name="empirical correctness"
                    fillOpacity={0.6}
                  >
                    {data.reliability.map((b, i) => (
                      <Cell
                        key={i}
                        fill={
                          b.n === 0
                            ? 'var(--bg-overlay)'
                            : Math.abs(b.meanRaw - b.meanCorrect) > 0.15
                              ? 'var(--danger)'
                              : Math.abs(b.meanRaw - b.meanCorrect) > 0.05
                                ? 'var(--warning)'
                                : 'var(--success)'
                        }
                      />
                    ))}
                  </Bar>
                  <Line
                    type="monotone"
                    dataKey="meanCalibrated"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                    name="calibrated"
                  />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="mt-2 text-[10px] text-[var(--text-faint)]">
                Bars = empirical correctness per raw-confidence bucket;
                dashed = perfect calibration; accent line = isotonic map
                output. Green/yellow/red ⇒ |raw − empirical| &lt; 5pp / 15pp / ≥
                15pp.
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <ChartCard title="Calibration curve (raw → calibrated)">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={data.curve}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="raw"
                    type="number"
                    domain={[0, 1]}
                    tickFormatter={(v) => v.toFixed(1)}
                    stroke="var(--text-faint)"
                    fontSize={10}
                  />
                  <YAxis
                    type="number"
                    domain={[0, 1]}
                    tickFormatter={(v) => v.toFixed(1)}
                    stroke="var(--text-faint)"
                    fontSize={10}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      fontSize: 11,
                    }}
                  />
                  <ReferenceLine
                    segment={[
                      { x: 0, y: 0 },
                      { x: 1, y: 1 },
                    ]}
                    stroke="var(--text-faint)"
                    strokeDasharray="4 4"
                  />
                  <Line
                    type="monotone"
                    dataKey="calibrated"
                    stroke="var(--accent)"
                    dot={false}
                    isAnimationActive={false}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Bucket counts (samples per bin)">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={data.reliability}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="midpoint"
                    type="number"
                    domain={[0, 1]}
                    tickFormatter={(v) => v.toFixed(1)}
                    stroke="var(--text-faint)"
                    fontSize={10}
                  />
                  <YAxis stroke="var(--text-faint)" fontSize={10} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      fontSize: 11,
                    }}
                  />
                  <Bar dataKey="n" fill="var(--text-muted)" />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </section>

          {data.versions && data.versions.length > 0 && (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                Persisted versions ({data.versions.length})
              </div>
              <table className="w-full text-xs border border-[var(--border)] rounded-md overflow-hidden">
                <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="text-right px-3 py-1.5">version</th>
                    <th className="text-right px-3 py-1.5">samples</th>
                    <th className="text-right px-3 py-1.5">bins</th>
                    <th className="text-left px-3 py-1.5">createdAt</th>
                  </tr>
                </thead>
                <tbody>
                  {data.versions.map((v) => (
                    <tr
                      key={v.version}
                      className="border-t border-[var(--border)] font-mono"
                    >
                      <td className="px-3 py-1 text-right text-[var(--accent)]">
                        {v.version}
                      </td>
                      <td className="px-3 py-1 text-right text-[var(--text)] tabular-nums">
                        {v.sampleCount.toLocaleString()}
                      </td>
                      <td className="px-3 py-1 text-right text-[var(--text-muted)] tabular-nums">
                        {v.bins}
                      </td>
                      <td className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
                        {v.createdAt ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {data.map && (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                Active map
              </div>
              <table className="w-full text-xs border border-[var(--border)] rounded-md overflow-hidden">
                <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-3 py-1.5">bin</th>
                    <th className="text-right px-3 py-1.5">upper</th>
                    <th className="text-right px-3 py-1.5">calibrated value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map.thresholds.map((t, i) => (
                    <tr
                      key={i}
                      className="border-t border-[var(--border)] font-mono"
                    >
                      <td className="px-3 py-1 text-[var(--text-muted)]">{i}</td>
                      <td className="px-3 py-1 text-right">{t.toFixed(3)}</td>
                      <td className="px-3 py-1 text-right text-[var(--accent)]">
                        {data.map?.values[i]?.toFixed(3) ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
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

function ChartCard({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
        {title}
      </div>
      {children}
    </div>
  )
}
