'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldAlert } from 'lucide-react'

interface PiiRow {
  companyId: string
  predicate: string
  piiClass: string
  requiresScope: string
  factCount: number
  retractedCount: number
}

const CLASS_TONE: Record<string, string> = {
  identifier: 'text-[var(--accent)] bg-[var(--accent)]/10',
  behavioral: 'text-[var(--text-muted)] bg-[var(--bg-overlay)]',
  text: 'text-[var(--text-muted)] bg-[var(--bg-overlay)]',
  sensitive: 'text-[var(--danger)] bg-[var(--danger)]/10',
}

export function PiiInventoryPanel() {
  const [rows, setRows] = useState<PiiRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tenantFilter, setTenantFilter] = useState('')
  const [classFilter, setClassFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/pii', {
        cache: 'no-store',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
      setRows(data.rows ?? [])
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

  const classes = useMemo(
    () => Array.from(new Set(rows.map((r) => r.piiClass))).sort(),
    [rows],
  )

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (tenantFilter && !r.companyId.includes(tenantFilter)) return false
        if (classFilter && r.piiClass !== classFilter) return false
        return true
      }),
    [rows, tenantFilter, classFilter],
  )

  const tenantTotals = useMemo(() => {
    const map = new Map<string, { facts: number; predicates: number }>()
    for (const r of rows) {
      const cur = map.get(r.companyId) ?? { facts: 0, predicates: 0 }
      cur.facts += r.factCount
      cur.predicates += 1
      map.set(r.companyId, cur)
    }
    return [...map.entries()]
      .map(([k, v]) => ({ companyId: k, ...v }))
      .sort((a, b) => b.facts - a.facts)
  }, [rows])

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-[var(--danger)]" /> PII
            inventory
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Per-tenant × per-predicate count of facts whose predicate carries a
            <code> requiresScope</code> annotation (anything other than{' '}
            <code>none</code>). Drives DSAR readiness and key-scope auditing.
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

      {tenantTotals.length > 0 && (
        <section>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
            Per-tenant totals
          </div>
          <div className="flex flex-wrap gap-2 text-[10px]">
            {tenantTotals.map((t) => (
              <span
                key={t.companyId}
                className="px-2 py-1 rounded bg-[var(--bg-elevated)] border border-[var(--border)] font-mono"
              >
                <span className="text-[var(--text)]">{t.companyId}</span>
                <span className="ml-2 text-[var(--text-faint)]">
                  {t.predicates}p ·
                </span>
                <span className="ml-1 text-[var(--accent)] tabular-nums">
                  {t.facts.toLocaleString()} facts
                </span>
              </span>
            ))}
          </div>
        </section>
      )}

      <div className="flex gap-2 items-center text-xs">
        <input
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
          placeholder="tenant filter"
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] font-mono w-44"
        />
        <select
          value={classFilter}
          onChange={(e) => setClassFilter(e.target.value)}
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)]"
        >
          <option value="">all PII classes</option>
          {classes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="text-[10px] text-[var(--text-faint)]">
          {filtered.length} rows
        </span>
      </div>

      <div className="rounded-md border border-[var(--border)] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-1.5">tenant</th>
              <th className="text-left px-3 py-1.5">predicate</th>
              <th className="text-left px-3 py-1.5">class</th>
              <th className="text-left px-3 py-1.5">requiresScope</th>
              <th className="text-right px-3 py-1.5">active</th>
              <th className="text-right px-3 py-1.5">retracted</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr
                key={`${r.companyId}-${r.predicate}-${i}`}
                className="border-t border-[var(--border)] font-mono"
              >
                <td className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
                  {r.companyId}
                </td>
                <td className="px-3 py-1 text-[var(--text)]">{r.predicate}</td>
                <td className="px-3 py-1">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] ${CLASS_TONE[r.piiClass] ?? ''}`}
                  >
                    {r.piiClass}
                  </span>
                </td>
                <td className="px-3 py-1 text-[10px] text-[var(--text-faint)]">
                  {r.requiresScope || '—'}
                </td>
                <td className="px-3 py-1 text-right tabular-nums">
                  {r.factCount.toLocaleString()}
                </td>
                <td className="px-3 py-1 text-right tabular-nums text-[var(--text-muted)]">
                  {r.retractedCount.toLocaleString()}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-[var(--text-muted)] italic"
                >
                  No PII predicates match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
