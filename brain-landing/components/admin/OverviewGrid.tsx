'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useEffect, useState } from 'react'
import { Activity, Database, FileText, Trash2 } from 'lucide-react'
import { DeadLetterTable } from './DeadLetterTable'
import { ForgottenTable } from './ForgottenTable'
import { DreamsTrigger } from './DreamsTrigger'
import type { OverviewResponse as Overview } from '../../lib/contracts/admin-overview'

export function OverviewGrid() {
  const [data, setData] = useState<Overview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/admin/proxy/v1/admin/overview', { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json()
        if (cancelled) return
        if (!r.ok) {
          setErr(body?.error ?? `Failed ${r.status}`)
        } else {
          setData(body as Overview)
        }
      })
      .catch((e) => !cancelled && setErr((e as Error).message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <div className="text-sm text-[var(--text-muted)]">Loading overview…</div>
    )
  }
  if (err) {
    return (
      <div className="text-sm text-[var(--danger)] font-mono">{err}</div>
    )
  }
  if (!data) return null

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text)]">Overview</h1>
          <p className="text-xs text-[var(--text-faint)] font-mono">
            generated {data.generatedAt}
          </p>
        </div>
        <DreamsTrigger />
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          icon={Database}
          label="surrealdb"
          value={data.health.surrealdb}
          tone={data.health.surrealdb === 'ok' ? 'good' : 'bad'}
        />
        <Stat
          icon={Activity}
          label="tenants"
          value={data.totals.tenants.toString()}
        />
        <Stat
          icon={FileText}
          label="entities"
          value={data.totals.entities.toLocaleString()}
        />
        <Stat
          icon={FileText}
          label="facts active"
          value={data.totals.factsActive.toLocaleString()}
        />
        <Stat
          icon={Trash2}
          label="facts retracted"
          value={data.totals.factsRetracted.toLocaleString()}
        />
        <Stat
          icon={Trash2}
          label="dead-letter 24h"
          value={data.totals.deadLetterLast24h.toLocaleString()}
          tone={data.totals.deadLetterLast24h > 0 ? 'warn' : undefined}
        />
        <Stat
          icon={Trash2}
          label="forgotten 24h"
          value={data.totals.forgottenLast24h.toLocaleString()}
        />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-[var(--text)] mb-2 tracking-tight">
          Tenants
        </h2>
        <div className="rounded-md border border-[var(--border)] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2 font-medium">companyId</th>
                <th className="text-right px-3 py-2 font-medium">entities</th>
                <th className="text-right px-3 py-2 font-medium">facts active</th>
                <th className="text-right px-3 py-2 font-medium">retracted</th>
              </tr>
            </thead>
            <tbody>
              {data.tenants.map((t) => (
                <tr
                  key={t.companyId}
                  className="border-t border-[var(--border)] hover:bg-[var(--bg-overlay)]/50"
                >
                  <td className="px-3 py-2 font-mono text-xs text-[var(--text)]">
                    {t.companyId}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {t.entities >= 0 ? t.entities.toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {t.factsActive >= 0 ? t.factsActive.toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-[var(--text-muted)]">
                    {t.factsRetracted >= 0
                      ? t.factsRetracted.toLocaleString()
                      : '—'}
                  </td>
                </tr>
              ))}
              {data.tenants.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-4 text-center text-[var(--text-muted)] text-xs"
                  >
                    No tenants registered.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-[var(--text)] mb-2 tracking-tight">
          In-process counters
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Counter
            label="ingest facts"
            value={data.metrics.ingestFactsTotal}
            breakdown={data.metrics.ingestFactsByOutcome}
          />
          <Counter label="search calls" value={data.metrics.searchCallsTotal} />
          <Counter
            label="dreams emitted"
            value={Object.values(data.metrics.dreamsEmittedByKind).reduce(
              (a, b) => a + b,
              0,
            )}
            breakdown={data.metrics.dreamsEmittedByKind}
          />
          <Counter label="dreams runs" value={data.metrics.dreamsRunsTotal} />
          <Counter label="retracts" value={data.metrics.retractsTotal} />
          <Counter label="forgets" value={data.metrics.forgetsTotal} />
          <Counter
            label="openai calls"
            value={data.metrics.openaiCallsTotal}
          />
          <Counter
            label="openai tokens"
            value={data.metrics.openaiTokensTotal}
          />
        </div>
        <p className="mt-2 text-[10px] text-[var(--text-faint)]">
          Process-local. Resets on container restart. For long-term history,
          point Prometheus at <code className="text-[var(--text-muted)]">/metrics</code>.
        </p>
      </section>

      <div className="grid lg:grid-cols-2 gap-6">
        <DeadLetterTable rows={data.recentDeadLetter} />
        <ForgottenTable rows={data.recentForgotten} />
      </div>
    </div>
  )
}

function Counter({
  label,
  value,
  breakdown,
}: {
  label: string
  value: number
  breakdown?: Record<string, number>
}) {
  const entries = breakdown
    ? Object.entries(breakdown).filter(([, v]) => v > 0)
    : []
  return (
    <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-[var(--text)]">
        {value.toLocaleString()}
      </div>
      {entries.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {entries.map(([k, v]) => (
            <li
              key={k}
              className="text-[10px] font-mono text-[var(--text-muted)] flex items-baseline justify-between gap-2"
            >
              <span className="truncate">{k}</span>
              <span className="tabular-nums">{v.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  tone?: 'good' | 'warn' | 'bad'
}) {
  const toneClass =
    tone === 'good'
      ? 'text-[color:var(--success)]'
      : tone === 'warn'
        ? 'text-[color:var(--warning)]'
        : tone === 'bad'
          ? 'text-[color:var(--danger)]'
          : 'text-[var(--text)]'
  return (
    <div className="p-4 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div
        className={`mt-1 text-xl font-semibold font-mono tabular-nums ${toneClass}`}
      >
        {value}
      </div>
    </div>
  )
}
