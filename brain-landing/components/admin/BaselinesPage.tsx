'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Play,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import type { BaselineEntry } from '../../lib/contracts/admin-baselines'

interface DiffEntry {
  scenarioId: string
  metric: 'recallAt1' | 'recallAt5'
  baseline: number
  current: number
  delta: number
  verdict: 'regression' | 'improved' | 'stable'
}

interface DiffResult {
  baseline: string
  entries: DiffEntry[]
}

interface ScenarioSummary {
  id: string
  vertical: string
  description: string
}

const VERDICT_TONE: Record<DiffEntry['verdict'], string> = {
  improved: 'text-[var(--success)]',
  regression: 'text-[var(--danger)]',
  stable: 'text-[var(--text-muted)]',
}

const VERDICT_ICON: Record<DiffEntry['verdict'], typeof TrendingUp> = {
  improved: TrendingUp,
  regression: TrendingDown,
  stable: ArrowRight,
}

export function BaselinesPage() {
  const [items, setItems] = useState<BaselineEntry[]>([])
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [diffName, setDiffName] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [diffing, setDiffing] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [bRes, sRes] = await Promise.all([
        fetch('/api/admin/proxy/v1/admin/baselines', { cache: 'no-store' }),
        fetch('/api/admin/proxy/v1/admin/scenarios', { cache: 'no-store' }),
      ])
      const [bJson, sJson] = await Promise.all([bRes.json(), sRes.json()])
      if (!bRes.ok) throw new Error(bJson.error ?? `Failed ${bRes.status}`)
      setItems(Array.isArray(bJson) ? bJson : bJson.baselines ?? [])
      setScenarios(sJson.scenarios ?? [])
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

  const runDiff = useCallback(
    async (name: string) => {
      setDiffName(name)
      setDiffing(true)
      setDiff(null)
      try {
        const runOk = await fetch(
          '/api/admin/proxy/v1/admin/scenarios/run-batch',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        )
        const runJson = await runOk.json()
        if (!runOk.ok)
          throw new Error(runJson.error ?? `Run failed ${runOk.status}`)
        const res = await fetch(
          `/api/admin/proxy/v1/admin/baselines/${encodeURIComponent(name)}/diff`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outcomes: runJson.outcomes ?? [] }),
          },
        )
        const json = (await res.json()) as DiffResult
        if (!res.ok)
          throw new Error((json as { error?: string }).error ?? `Failed ${res.status}`)
        setDiff(json)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setDiffing(false)
      }
    },
    [],
  )

  const summary = useMemo(() => {
    if (!diff) return null
    const out = { improved: 0, regression: 0, stable: 0 }
    for (const e of diff.entries) out[e.verdict] += 1
    return out
  }, [diff])

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)]">
            Baselines
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Frozen scenario outcomes used for regression diff (3-pp tolerance).
            Saved at <code>var/admin/baselines/</code>.
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
            onClick={() => setShowCreate(true)}
            className="px-2.5 py-1.5 rounded-md bg-[var(--accent)] text-white text-xs flex items-center gap-1.5"
          >
            <ClipboardList className="w-3 h-3" /> Snapshot baseline
          </button>
        </div>
      </header>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      <div className="rounded-md border border-[var(--border)] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-2 font-medium">name</th>
              <th className="text-left px-3 py-2 font-medium">savedAt</th>
              <th className="text-right px-3 py-2 font-medium">scenarios</th>
              <th className="text-right px-3 py-2 font-medium">meanRecall@1</th>
              <th className="text-right px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr
                key={b.name}
                className="border-t border-[var(--border)] hover:bg-[var(--bg-overlay)]/40"
              >
                <td className="px-3 py-2 font-mono text-[var(--text)]">
                  {b.name}
                </td>
                <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)]">
                  {new Date(b.savedAt).toISOString().slice(0, 19).replace('T', ' ')}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {b.scenarios}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {(b.meanRecallAt1 * 100).toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => void runDiff(b.name)}
                    disabled={diffing}
                    className="px-2 py-1 rounded text-[10px] bg-[var(--bg-overlay)] text-[var(--text)] hover:bg-[var(--accent)] hover:text-white disabled:opacity-50 flex items-center gap-1 ml-auto"
                  >
                    <Play className="w-3 h-3" /> Run vs current
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-[var(--text-muted)] italic"
                >
                  No baselines yet. Snapshot one to start tracking regressions.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {diffName && (
        <section className="rounded-md border border-[var(--border)] p-3 bg-[var(--bg-elevated)]">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-[var(--text)]">
              Diff vs <code className="text-[var(--accent)]">{diffName}</code>
            </div>
            <button
              type="button"
              onClick={() => {
                setDiff(null)
                setDiffName(null)
              }}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              close
            </button>
          </div>
          {diffing && (
            <div className="text-xs text-[var(--text-muted)] italic">
              Running scenarios + computing diff…
            </div>
          )}
          {summary && (
            <div className="flex items-center gap-3 mb-2 text-xs">
              <Badge tone="success">
                <CheckCircle2 className="inline w-3 h-3 mr-1" />
                {summary.improved} improved
              </Badge>
              <Badge tone="warn">{summary.stable} stable</Badge>
              <Badge tone="danger">
                <TrendingDown className="inline w-3 h-3 mr-1" />
                {summary.regression} regressions
              </Badge>
            </div>
          )}
          {diff && diff.entries.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase text-[var(--text-faint)]">
                <tr>
                  <th className="text-left px-2 py-1">scenario</th>
                  <th className="text-left px-2 py-1">metric</th>
                  <th className="text-right px-2 py-1">baseline</th>
                  <th className="text-right px-2 py-1">current</th>
                  <th className="text-right px-2 py-1">Δ</th>
                  <th className="text-left px-2 py-1">verdict</th>
                </tr>
              </thead>
              <tbody>
                {diff.entries
                  .sort(
                    (a, b) =>
                      (a.verdict === 'regression' ? -1 : 0) -
                      (b.verdict === 'regression' ? -1 : 0),
                  )
                  .map((e, i) => {
                    const Icon = VERDICT_ICON[e.verdict]
                    return (
                      <tr
                        key={`${e.scenarioId}-${e.metric}-${i}`}
                        className="border-t border-[var(--border)]"
                      >
                        <td className="px-2 py-1 font-mono text-[10px]">
                          {e.scenarioId}
                        </td>
                        <td className="px-2 py-1 font-mono text-[10px] text-[var(--text-muted)]">
                          {e.metric}
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-[var(--text-muted)]">
                          {(e.baseline * 100).toFixed(1)}%
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums">
                          {(e.current * 100).toFixed(1)}%
                        </td>
                        <td
                          className={`px-2 py-1 text-right font-mono tabular-nums ${VERDICT_TONE[e.verdict]}`}
                        >
                          {e.delta >= 0 ? '+' : ''}
                          {(e.delta * 100).toFixed(1)}pp
                        </td>
                        <td className={`px-2 py-1 ${VERDICT_TONE[e.verdict]}`}>
                          <Icon className="inline w-3 h-3 mr-0.5" />
                          {e.verdict}
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {showCreate && (
        <CreateBaselineModal
          scenarios={scenarios}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false)
            void load()
          }}
        />
      )}
    </div>
  )
}

function Badge({
  tone,
  children,
}: {
  tone: 'success' | 'warn' | 'danger'
  children: React.ReactNode
}) {
  const cls =
    tone === 'success'
      ? 'text-[var(--success)] bg-[var(--success)]/10'
      : tone === 'danger'
        ? 'text-[var(--danger)] bg-[var(--danger)]/10'
        : 'text-[var(--text-muted)] bg-[var(--bg-overlay)]'
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-mono ${cls}`}>
      {children}
    </span>
  )
}

function CreateBaselineModal({
  scenarios,
  onClose,
  onSaved,
}: {
  scenarios: ScenarioSummary[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'running' | 'saving'>('idle')

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = async () => {
    if (!name.trim() || selectedIds.size === 0) return
    setBusy(true)
    setError(null)
    setPhase('running')
    try {
      const runRes = await fetch(
        '/api/admin/proxy/v1/admin/scenarios/run-batch',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [...selectedIds] }),
        },
      )
      const runJson = await runRes.json()
      if (!runRes.ok)
        throw new Error(runJson.error ?? `Run failed ${runRes.status}`)
      setPhase('saving')
      const saveRes = await fetch(
        `/api/admin/proxy/v1/admin/baselines/${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcomes: runJson.outcomes ?? [] }),
        },
      )
      const saveJson = await saveRes.json()
      if (!saveRes.ok)
        throw new Error(saveJson.error ?? `Save failed ${saveRes.status}`)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setPhase('idle')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-elevated)] border border-[var(--border)] rounded-md p-4 w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-[var(--text)] mb-3">
          Snapshot baseline
        </div>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          Runs the selected scenarios (cap 10) and saves their outcomes under{' '}
          <code>name</code>. Future runs compare against this snapshot.
        </p>
        <div className="space-y-3 text-xs">
          <div>
            <div className="mb-0.5 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
              name
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="v2.2.8-mainline"
              className="w-full border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1 font-mono"
            />
          </div>
          <div>
            <div className="mb-0.5 text-[10px] uppercase tracking-wider text-[var(--text-faint)] flex items-center justify-between">
              <span>scenarios — pick up to 10</span>
              <span>{selectedIds.size}/10 selected</span>
            </div>
            <div className="max-h-64 overflow-y-auto border border-[var(--border)] rounded-md divide-y divide-[var(--border)]">
              {scenarios.map((s) => {
                const checked = selectedIds.has(s.id)
                const disabled = !checked && selectedIds.size >= 10
                return (
                  <label
                    key={s.id}
                    className={`flex items-center gap-2 px-2 py-1 ${disabled ? 'opacity-40' : 'hover:bg-[var(--bg-overlay)]/40'}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(s.id)}
                    />
                    <div className="min-w-0">
                      <div className="font-mono text-[var(--text)] truncate">
                        {s.id}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] truncate">
                        {s.vertical} · {s.description}
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>
          {error && (
            <div className="text-xs text-[var(--danger)] font-mono">
              {error}
            </div>
          )}
          {phase === 'running' && (
            <div className="text-xs text-[var(--text-muted)] italic">
              Running scenarios…
            </div>
          )}
          {phase === 'saving' && (
            <div className="text-xs text-[var(--text-muted)] italic">
              Saving baseline…
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !name.trim() || selectedIds.size === 0}
              className="px-3 py-1.5 rounded-md bg-[var(--accent)] text-white text-xs disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Run + save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
