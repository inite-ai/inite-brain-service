'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, RefreshCw, Skull } from 'lucide-react'
import type { AdminForgottenRow as ForgottenRow } from '../../lib/contracts/admin-overview'

export function ForgottenPanel() {
  const [rows, setRows] = useState<ForgottenRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tenant, setTenant] = useState('')
  const [since, setSince] = useState('')
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (tenant) params.set('companyId', tenant)
      if (since) params.set('since', new Date(since).toISOString())
      if (reason) params.set('reason', reason)
      params.set('limit', '500')
      const res = await fetch(
        `/api/admin/proxy/v1/admin/forgotten?${params.toString()}`,
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
  }, [tenant, since, reason])

  useEffect(() => {
    void load()
  }, [load])

  const reasons = useMemo(
    () => Array.from(new Set(rows.map((r) => r.reason))).sort(),
    [rows],
  )

  const exportCertificate = () => {
    const params = new URLSearchParams()
    if (tenant) params.set('companyId', tenant)
    if (since) params.set('since', new Date(since).toISOString())
    const url = `/api/admin/proxy/v1/admin/forgotten/export?${params.toString()}`
    window.open(url, '_blank')
  }

  const totalsByReason = useMemo(() => {
    const map: Record<string, number> = {}
    for (const r of rows) {
      map[r.reason] = (map[r.reason] ?? 0) + 1
    }
    return map
  }, [rows])

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Skull className="w-4 h-4 text-[var(--danger)]" /> Forgotten
            entities
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            GDPR Art. 17 proof-of-erasure log. Each row is a tombstone: the
            entity payload is gone, only the hashed identifier + counts
            remain. Export a JSON certificate to hand to a DPO.
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
            onClick={exportCertificate}
            className="text-xs bg-[var(--accent)] text-white rounded-md px-2.5 py-1.5 flex items-center gap-1"
          >
            <Download className="w-3 h-3" /> Export certificate
          </button>
        </div>
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
        <input
          type="datetime-local"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] font-mono"
        />
        <span className="text-[10px] text-[var(--text-faint)]">
          {rows.length} rows
        </span>
      </div>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      {Object.keys(totalsByReason).length > 0 && (
        <div className="flex flex-wrap gap-2 text-[10px] font-mono">
          {Object.entries(totalsByReason).map(([k, v]) => (
            <span
              key={k}
              className="px-2 py-0.5 rounded bg-[var(--bg-overlay)] text-[var(--text-muted)]"
            >
              {k}: <span className="text-[var(--text)]">{v}</span>
            </span>
          ))}
        </div>
      )}

      <div className="rounded-md border border-[var(--border)] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-1.5">forgottenAt</th>
              <th className="text-left px-3 py-1.5">tenant</th>
              <th className="text-left px-3 py-1.5">reason</th>
              <th className="text-left px-3 py-1.5">entityHash</th>
              <th className="text-right px-3 py-1.5">facts</th>
              <th className="text-right px-3 py-1.5">edges</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.companyId}-${r.entityIdHash}`}
                className="border-t border-[var(--border)] font-mono"
              >
                <td className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
                  {new Date(r.forgottenAt)
                    .toISOString()
                    .slice(0, 19)
                    .replace('T', ' ')}
                </td>
                <td className="px-3 py-1 text-[10px]">{r.companyId}</td>
                <td className="px-3 py-1 text-[var(--text)]">{r.reason}</td>
                <td className="px-3 py-1 text-[10px] text-[var(--text-faint)] truncate max-w-[24ch]">
                  {r.entityIdHash}
                </td>
                <td className="px-3 py-1 text-right tabular-nums">
                  {r.factsDeleted}
                </td>
                <td className="px-3 py-1 text-right tabular-nums">
                  {r.edgesDeleted}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-[var(--text-muted)] italic"
                >
                  No erasure events match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
