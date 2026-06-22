'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import { JsonView } from './JsonView'
import type { OperatorActionRow as ActionRow } from '../../lib/contracts/admin-operator-actions'

export function OperatorActionsPanel() {
  const [rows, setRows] = useState<ActionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actor, setActor] = useState('')
  const [pathPrefix, setPathPrefix] = useState('')
  const [since, setSince] = useState('')
  const [selected, setSelected] = useState<ActionRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (actor) params.set('actor', actor)
      if (pathPrefix) params.set('pathPrefix', pathPrefix)
      if (since) params.set('since', new Date(since).toISOString())
      params.set('limit', '300')
      const res = await fetch(
        `/api/admin/proxy/v1/admin/operator-actions?${params.toString()}`,
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
  }, [actor, pathPrefix, since])

  useEffect(() => {
    void load()
  }, [load])

  const methodTone = (m: string) =>
    m === 'GET'
      ? 'text-[var(--text-muted)]'
      : m === 'POST'
        ? 'text-[var(--accent)]'
        : m === 'DELETE'
          ? 'text-[var(--danger)]'
          : 'text-[var(--warning)]'

  const topPaths = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) {
      const k = `${r.method} ${r.path}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
  }, [rows])

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[var(--accent)]" /> Operator
            action log
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Every admin HTTP call (method, path, scopes, status, body summary,
            duration) — separate from data-change <code>audit_event</code>.
            Use to answer &quot;who turned on Dreams last Tuesday?&quot;
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

      <div className="flex gap-2 items-center flex-wrap text-xs">
        <input
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="actor (companyId)"
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] font-mono w-44"
        />
        <input
          value={pathPrefix}
          onChange={(e) => setPathPrefix(e.target.value)}
          placeholder="path prefix"
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] font-mono w-56"
        />
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

      {topPaths.length > 0 && (
        <section>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
            top paths (this view)
          </div>
          <div className="flex flex-wrap gap-1 text-[10px] font-mono">
            {topPaths.map(([k, n]) => (
              <span
                key={k}
                className="px-2 py-0.5 rounded bg-[var(--bg-overlay)] text-[var(--text-muted)]"
              >
                {k}{' '}
                <span className="text-[var(--accent)] tabular-nums">{n}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_22rem] gap-3">
        <div className="rounded-md border border-[var(--border)] overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-1.5">ts</th>
                <th className="text-left px-3 py-1.5">actor</th>
                <th className="text-left px-3 py-1.5">method</th>
                <th className="text-left px-3 py-1.5">path</th>
                <th className="text-left px-3 py-1.5">status</th>
                <th className="text-right px-3 py-1.5">ms</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.ts}-${i}`}
                  onClick={() => setSelected(r)}
                  className={`border-t border-[var(--border)] hover:bg-[var(--bg-overlay)]/40 cursor-pointer ${
                    selected === r ? 'bg-[var(--bg-overlay)]/60' : ''
                  }`}
                >
                  <td className="px-3 py-1 font-mono text-[10px] text-[var(--text-muted)]">
                    {new Date(r.ts).toISOString().slice(0, 19).replace('T', ' ')}
                  </td>
                  <td className="px-3 py-1 font-mono text-[10px]">
                    {r.actor}
                  </td>
                  <td
                    className={`px-3 py-1 font-mono text-[10px] ${methodTone(r.method)}`}
                  >
                    {r.method}
                  </td>
                  <td className="px-3 py-1 font-mono text-[10px] truncate">
                    {r.path}
                  </td>
                  <td
                    className={`px-3 py-1 font-mono text-[10px] ${
                      r.status >= 400 ? 'text-[var(--danger)]' : 'text-[var(--text)]'
                    }`}
                  >
                    {r.status}
                  </td>
                  <td className="px-3 py-1 text-right text-[10px] tabular-nums text-[var(--text-muted)]">
                    {r.durationMs}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-6 text-center text-[var(--text-muted)] italic"
                  >
                    No operator actions match the filter.
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
                {selected.actor}
              </div>
              <div className="font-mono text-[var(--text)]">
                <span className={methodTone(selected.method)}>
                  {selected.method}
                </span>{' '}
                {selected.path}
              </div>
              <div className="text-[10px] text-[var(--text-faint)]">
                {new Date(selected.ts).toISOString()} · status {selected.status}{' '}
                · {selected.durationMs}ms
              </div>
              <div className="text-[10px]">
                scopes:{' '}
                {selected.scopes.map((s) => (
                  <span
                    key={s}
                    className="ml-1 px-1.5 py-0.5 rounded bg-[var(--bg-overlay)] text-[var(--text-muted)] font-mono"
                  >
                    {s}
                  </span>
                ))}
              </div>
              {selected.query && (
                <section className="border-t border-[var(--border)] pt-2">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                    query
                  </div>
                  <JsonView value={selected.query} />
                </section>
              )}
              {selected.bodySummary && (
                <section className="border-t border-[var(--border)] pt-2">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                    body (truncated)
                  </div>
                  <JsonView value={selected.bodySummary} />
                </section>
              )}
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)] italic">
              Pick a row to drill.
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
