'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import {
  ScenarioCard,
  ScenarioSummary,
} from '../../../../components/scenarios/ScenarioCard'
import {
  ScenarioRunResultView,
  ScenarioRunOutcome,
} from '../../../../components/scenarios/ScenarioRunResultView'

const BATCH_CAP = 10

export default function ScenariosListPage() {
  const [items, setItems] = useState<ScenarioSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [vertical, setVertical] = useState('')
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<ScenarioRunOutcome[] | null>(null)

  useEffect(() => {
    setLoading(true)
    fetch('/api/admin/proxy/v1/admin/scenarios')
      .then((r) => r.json())
      .then((data) => {
        if (data?.error) throw new Error(data.error)
        setItems(data.scenarios ?? [])
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [])

  const verticals = useMemo(
    () => Array.from(new Set(items.map((s) => s.vertical))).sort(),
    [items],
  )
  const filtered = useMemo(
    () =>
      items.filter(
        (s) =>
          (!vertical || s.vertical === vertical) &&
          (!q ||
            s.id.toLowerCase().includes(q.toLowerCase()) ||
            s.description.toLowerCase().includes(q.toLowerCase())),
      ),
    [items, q, vertical],
  )

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const runBatch = async () => {
    if (selectedIds.size === 0) return
    setRunning(true)
    setError(null)
    setResults(null)
    try {
      const res = await fetch(
        '/api/admin/proxy/v1/admin/scenarios/run-batch',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [...selectedIds] }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
      setResults(data.outcomes ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)]">
            Scenarios
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            {items.length} scenarios loaded from{' '}
            <code>test/eval/scenarios</code>. Each run defaults to an ephemeral
            tenant — no risk of polluting existing data.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => {
              setSelectMode((v) => !v)
              setSelectedIds(new Set())
              setResults(null)
            }}
            className={`px-2.5 py-1.5 rounded-md border ${
              selectMode
                ? 'bg-[var(--bg-overlay)] border-[var(--accent)] text-[var(--text)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            {selectMode ? 'Exit select' : 'Batch select'}
          </button>
          {selectMode && (
            <button
              type="button"
              onClick={() => void runBatch()}
              disabled={running || selectedIds.size === 0}
              className="px-2.5 py-1.5 rounded-md bg-[var(--accent)] text-white flex items-center gap-1 disabled:opacity-50"
            >
              <Play className="w-3 h-3" />
              {running
                ? 'Running…'
                : `Run ${selectedIds.size}/${BATCH_CAP}`}
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-2 items-center">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter id / description"
          className="flex-1 max-w-xs border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-sm text-[var(--text)]"
        />
        <select
          value={vertical}
          onChange={(e) => setVertical(e.target.value)}
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-sm text-[var(--text)]"
        >
          <option value="">all verticals</option>
          {verticals.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <span className="text-xs text-[var(--text-faint)]">
          {filtered.length} shown
        </span>
      </div>

      {loading && (
        <div className="text-xs text-[var(--text-muted)]">Loading…</div>
      )}
      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      {selectMode && selectedIds.size >= BATCH_CAP && (
        <div className="text-[10px] text-[var(--warning)] font-mono">
          Cap is {BATCH_CAP} per batch. Deselect to add more.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        {filtered.map((s) => {
          const isSelected = selectedIds.has(s.id)
          const disabled =
            selectMode && !isSelected && selectedIds.size >= BATCH_CAP
          return (
            <div key={s.id} className={disabled ? 'opacity-40' : ''}>
              <ScenarioCard
                s={s}
                selectable={selectMode}
                selected={isSelected}
                onToggle={() => {
                  if (!disabled) toggle(s.id)
                }}
              />
            </div>
          )
        })}
      </div>

      {results && (
        <section className="rounded-md border border-[var(--border)] p-3 bg-[var(--bg-elevated)] space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-[var(--text)]">
              Batch run — {results.length} scenarios
            </h2>
            <BatchSummary results={results} />
          </div>
          {results.map((r) => (
            <div key={r.scenarioId} className="border-t border-[var(--border)] pt-3">
              <div className="text-xs font-mono text-[var(--text)] mb-1">
                {r.scenarioId}
              </div>
              <ScenarioRunResultView outcome={r} />
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

function BatchSummary({ results }: { results: ScenarioRunOutcome[] }) {
  const passed = results.filter((r) => r.passed).length
  const meanRecall1 =
    results.reduce((a, r) => a + (r.metrics?.recallAt1 ?? 0), 0) /
    Math.max(1, results.length)
  return (
    <div className="flex items-center gap-3 text-xs">
      <span
        className={`font-mono ${
          passed === results.length
            ? 'text-[var(--success)]'
            : 'text-[var(--danger)]'
        }`}
      >
        {passed}/{results.length} passed
      </span>
      <span className="font-mono text-[var(--text-muted)]">
        recall@1 {(meanRecall1 * 100).toFixed(1)}%
      </span>
    </div>
  )
}
