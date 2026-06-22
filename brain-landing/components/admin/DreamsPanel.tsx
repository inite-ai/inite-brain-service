'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useCallback, useEffect, useState } from 'react'
import {
  ArrowRightLeft,
  Link as LinkIcon,
  Loader2,
  Moon,
  Play,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { JsonView } from './JsonView'

interface JobRow {
  runId: string
  jobType: string
  status: string
  startedAt: string
  finishedAt?: string | null
  triggeredBy: string
  triggeredByActor?: string | null
  result?: Record<string, unknown> | null
  progress?: Record<string, unknown> | null
  error?: { message: string } | null
  companyId: string
}

interface DreamEmit {
  runId: string
  kind: 'identity_link' | 'resolution' | 'summary' | string
  ts: string
  subject?: string | null
  object?: string | null
  detail?: Record<string, unknown> | null
  companyId: string
}

interface Summary {
  runs: JobRow[]
  aggregates30d: {
    totalRuns: number
    failed: number
    identityLinksCreated: number
    resolutionsApplied: number
  }
}

const OPS = ['dedup', 'resolve', 'summarize'] as const
type Op = (typeof OPS)[number]

export function DreamsPanel() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [emits, setEmits] = useState<DreamEmit[] | null>(null)
  const [selectedRun, setSelectedRun] = useState<JobRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickedOps, setPickedOps] = useState<Set<Op>>(
    new Set(['dedup', 'resolve']),
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/dreams/summary', {
        cache: 'no-store',
      })
      const data = (await res.json()) as Summary
      if (!res.ok)
        throw new Error((data as unknown as { error?: string }).error ?? `Failed ${res.status}`)
      setSummary(data)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selectedRun) {
      setEmits(null)
      return
    }
    const params = new URLSearchParams()
    params.set('companyId', selectedRun.companyId)
    fetch(
      `/api/admin/proxy/v1/admin/dreams/runs/${encodeURIComponent(selectedRun.runId)}/emits?${params.toString()}`,
      { cache: 'no-store' },
    )
      .then((r) => r.json())
      .then((data) => setEmits(data.emits ?? []))
      .catch(() => setEmits([]))
  }, [selectedRun])

  const trigger = useCallback(async () => {
    if (pickedOps.size === 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        '/api/admin/proxy/v1/admin/maintenance/dreams/run',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operations: [...pickedOps] }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [pickedOps, load])

  const toggleOp = (op: Op) => {
    setPickedOps((prev) => {
      const next = new Set(prev)
      if (next.has(op)) next.delete(op)
      else next.add(op)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Moon className="w-4 h-4 text-[var(--accent)]" /> Dreams
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Nightly self-improvement: near-duplicate dedup + competing-fact
            resolution + optional warm-tier summarisation. Each run persists
            to <code>dreams_run</code> + per-emit detail in{' '}
            <code>dream_emit</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          refresh
        </button>
      </header>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      {summary && (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat
              label="runs (30d)"
              value={summary.aggregates30d.totalRuns.toString()}
            />
            <Stat
              label="failed (30d)"
              value={summary.aggregates30d.failed.toString()}
              tone={summary.aggregates30d.failed > 0 ? 'warn' : 'good'}
            />
            <Stat
              label="identity links (30d)"
              value={summary.aggregates30d.identityLinksCreated.toString()}
              hint="dedup"
            />
            <Stat
              label="resolutions (30d)"
              value={summary.aggregates30d.resolutionsApplied.toString()}
              hint="competing-fact judgments"
            />
          </section>

          <section className="rounded-md border border-[var(--border)] p-3 bg-[var(--bg-elevated)]">
            <div className="text-sm font-semibold text-[var(--text)] mb-2 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[var(--accent)]" /> Run dreams now
            </div>
            <div className="flex items-center gap-2 text-xs flex-wrap">
              {OPS.map((op) => (
                <label
                  key={op}
                  className={`px-2 py-1 rounded border cursor-pointer ${
                    pickedOps.has(op)
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={pickedOps.has(op)}
                    onChange={() => toggleOp(op)}
                    className="mr-1 align-middle"
                  />
                  {op}
                </label>
              ))}
              <button
                type="button"
                onClick={() => void trigger()}
                disabled={busy || pickedOps.size === 0}
                className="ml-auto px-3 py-1 rounded bg-[var(--accent)] text-white text-xs flex items-center gap-1 disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Play className="w-3 h-3" />
                )}
                Run for my tenant
              </button>
            </div>
            <p className="text-[10px] text-[var(--text-faint)] mt-2 font-mono">
              Scoped to caller&apos;s API key tenant. Cron runs across all
              tenants daily at 04:00 UTC.
            </p>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-[1fr_22rem] gap-3">
            <div className="rounded-md border border-[var(--border)] overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-3 py-2">started</th>
                    <th className="text-left px-3 py-2">tenant</th>
                    <th className="text-left px-3 py-2">trigger</th>
                    <th className="text-left px-3 py-2">status</th>
                    <th className="text-right px-3 py-2">links</th>
                    <th className="text-right px-3 py-2">res</th>
                    <th className="text-right px-3 py-2">dur</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.runs.map((r) => {
                    const res = r.result as
                      | Record<string, number>
                      | null
                    return (
                      <tr
                        key={r.runId}
                        onClick={() => setSelectedRun(r)}
                        className={`border-t border-[var(--border)] hover:bg-[var(--bg-overlay)]/40 cursor-pointer ${
                          selectedRun?.runId === r.runId
                            ? 'bg-[var(--bg-overlay)]/60'
                            : ''
                        }`}
                      >
                        <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
                          {new Date(r.startedAt)
                            .toISOString()
                            .slice(0, 19)
                            .replace('T', ' ')}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
                          {r.companyId}
                        </td>
                        <td className="px-3 py-1.5 text-[10px] font-mono text-[var(--text-faint)]">
                          {r.triggeredBy}
                        </td>
                        <td className="px-3 py-1.5">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                              r.status === 'succeeded'
                                ? 'text-[var(--success)] bg-[var(--success)]/10'
                                : r.status === 'failed'
                                  ? 'text-[var(--danger)] bg-[var(--danger)]/10'
                                  : 'text-[var(--accent)] bg-[var(--accent)]/10'
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[10px]">
                          {res?.identityLinksCreated ?? 0}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[10px]">
                          {res?.resolutionsApplied ?? 0}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[10px] text-[var(--text-muted)]">
                          {r.finishedAt
                            ? `${Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 100) / 10}s`
                            : '—'}
                        </td>
                      </tr>
                    )
                  })}
                  {summary.runs.length === 0 && !loading && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-3 py-4 text-center text-[var(--text-muted)] italic"
                      >
                        No dreams runs persisted yet. Either no cron has fired
                        or DREAMS_ENABLED!=1.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <aside className="border border-[var(--border)] rounded-md p-3 bg-[var(--bg-elevated)] max-h-[70vh] overflow-y-auto">
              {selectedRun ? (
                <RunDrill run={selectedRun} emits={emits} />
              ) : (
                <div className="text-xs text-[var(--text-muted)] italic">
                  Pick a run to see per-emit detail.
                </div>
              )}
            </aside>
          </section>
        </>
      )}
    </div>
  )
}

function RunDrill({
  run,
  emits,
}: {
  run: JobRow
  emits: DreamEmit[] | null
}) {
  return (
    <div className="space-y-3 text-xs">
      <header>
        <div className="font-mono text-[var(--text)]">{run.runId}</div>
        <div className="text-[10px] text-[var(--text-faint)]">
          {new Date(run.startedAt).toISOString()} · {run.companyId}
        </div>
      </header>
      {run.result && (
        <section>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
            result
          </div>
          <JsonView value={run.result} />
        </section>
      )}
      {run.error && (
        <div className="text-[10px] text-[var(--danger)] font-mono">
          {run.error.message}
        </div>
      )}
      <section>
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
          emits ({emits?.length ?? '…'})
        </div>
        {!emits && (
          <div className="text-[10px] text-[var(--text-muted)] italic">
            Loading…
          </div>
        )}
        {emits && emits.length === 0 && (
          <div className="text-[10px] text-[var(--text-faint)] italic">
            No per-emit rows. Run may pre-date migration 0026 or had nothing to
            emit.
          </div>
        )}
        <ul className="space-y-1">
          {(emits ?? []).map((e, i) => (
            <li
              key={i}
              className="border border-[var(--border)] rounded p-2"
            >
              <div className="flex items-center gap-1.5">
                {e.kind === 'identity_link' ? (
                  <LinkIcon className="w-3 h-3 text-[var(--success)]" />
                ) : (
                  <ArrowRightLeft className="w-3 h-3 text-[var(--accent)]" />
                )}
                <span className="font-mono text-[10px] text-[var(--text)]">
                  {e.kind}
                </span>
                <span className="ml-auto font-mono text-[10px] text-[var(--text-faint)]">
                  {new Date(e.ts).toISOString().slice(11, 19)}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10px] text-[var(--text-muted)]">
                <div className="truncate">subject: {e.subject ?? '—'}</div>
                <div className="truncate">object: {e.object ?? '—'}</div>
              </div>
              {e.detail && (
                <details className="mt-1">
                  <summary className="text-[10px] text-[var(--text-faint)] cursor-pointer">
                    detail
                  </summary>
                  <div className="mt-1">
                    <JsonView value={e.detail} />
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      </section>
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
