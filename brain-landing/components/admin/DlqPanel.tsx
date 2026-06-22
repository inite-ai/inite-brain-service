'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, RefreshCw, Trash2 } from 'lucide-react'
import { JsonView } from './JsonView'

interface DlqRow {
  companyId: string
  id: string
  reason: string
  rejectedAt: string
  payload: Record<string, unknown>
}

export function DlqPanel() {
  const [rows, setRows] = useState<DlqRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tenant, setTenant] = useState('')
  const [reason, setReason] = useState('')
  const [selected, setSelected] = useState<DlqRow | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (tenant) params.set('companyId', tenant)
      if (reason) params.set('reason', reason)
      params.set('limit', '300')
      const res = await fetch(
        `/api/admin/proxy/v1/admin/dlq?${params.toString()}`,
        { cache: 'no-store' },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
      setRows(data.rows ?? [])
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [tenant, reason])

  useEffect(() => {
    void load()
  }, [load])

  const reasons = useMemo(
    () => Array.from(new Set(rows.map((r) => r.reason))).sort(),
    [rows],
  )

  const remove = useCallback(
    async (r: DlqRow) => {
      if (
        !confirm(
          `Delete dead-letter row ${r.id.slice(-12)} from tenant ${r.companyId}? Reversible only via DB backup.`,
        )
      )
        return
      setDeleting(r.id)
      try {
        const res = await fetch(
          `/api/admin/proxy/v1/admin/dlq/${encodeURIComponent(r.companyId)}/${encodeURIComponent(r.id)}`,
          { method: 'DELETE' },
        )
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
        if (selected?.id === r.id) setSelected(null)
        await load()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setDeleting(null)
      }
    },
    [load, selected],
  )

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-[var(--danger)]" /> Dead-letter
            queue
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Ingest payloads that failed validation. Click a row for the full
            payload + reason; delete after triage. Replay UI lands when the
            ingest pipeline accepts a synthetic re-emit token.
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

      <div className="flex gap-2 items-center text-xs">
        <input
          value={tenant}
          onChange={(e) => setTenant(e.target.value)}
          placeholder="companyId filter"
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] font-mono w-44"
        />
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)]"
        >
          <option value="">all reasons</option>
          {reasons.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <span className="text-[10px] text-[var(--text-faint)]">
          {rows.length} rows
        </span>
      </div>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_22rem] gap-3">
        <div className="rounded-md border border-[var(--border)] overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-1.5">rejected</th>
                <th className="text-left px-3 py-1.5">tenant</th>
                <th className="text-left px-3 py-1.5">reason</th>
                <th className="text-left px-3 py-1.5">id</th>
                <th className="text-right px-3 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.companyId}-${r.id}`}
                  onClick={() => setSelected(r)}
                  className={`border-t border-[var(--border)] hover:bg-[var(--bg-overlay)]/40 cursor-pointer ${
                    selected?.id === r.id ? 'bg-[var(--bg-overlay)]/60' : ''
                  }`}
                >
                  <td className="px-3 py-1 font-mono text-[10px] text-[var(--text-muted)]">
                    {new Date(r.rejectedAt)
                      .toISOString()
                      .slice(0, 19)
                      .replace('T', ' ')}
                  </td>
                  <td className="px-3 py-1 font-mono text-[10px]">
                    {r.companyId}
                  </td>
                  <td className="px-3 py-1 text-[var(--warning)]">{r.reason}</td>
                  <td className="px-3 py-1 font-mono text-[10px] text-[var(--text-faint)] truncate max-w-[16ch]">
                    {r.id}
                  </td>
                  <td
                    className="px-3 py-1 text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => void remove(r)}
                      disabled={deleting === r.id}
                      className="text-[10px] text-[var(--danger)] hover:underline disabled:opacity-40"
                    >
                      delete
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-6 text-center text-[var(--text-muted)] italic"
                  >
                    No dead-letter rows match the filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <aside className="border border-[var(--border)] rounded-md p-3 bg-[var(--bg-elevated)] max-h-[70vh] overflow-y-auto">
          {selected ? (
            <div className="space-y-2 text-xs">
              <div className="font-mono text-[10px] text-[var(--text-muted)]">
                {selected.companyId} · {selected.id}
              </div>
              <div className="text-[var(--warning)]">{selected.reason}</div>
              <div className="text-[10px] text-[var(--text-faint)]">
                {new Date(selected.rejectedAt).toISOString()}
              </div>
              <div className="border-t border-[var(--border)] pt-2">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1 flex items-center gap-1">
                  payload <ChevronRight className="w-3 h-3" />
                </div>
                <JsonView value={selected.payload} />
              </div>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)] italic">
              Pick a row for the rejected payload.
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
