'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, KeyRound, RefreshCw, Settings2 } from 'lucide-react'
import type { ConfigEntry } from '../../lib/contracts/admin-config'

const CATEGORY_ORDER = [
  'pipeline',
  'extractor',
  'embedder',
  'dreams',
  'compaction',
  'audit',
  'router',
  'search',
  'multihop',
  'calibration',
  'conflict',
  'cost',
  'throttle',
  'jobs',
  'auth',
  'misc',
]

export function ConfigPanel() {
  const [entries, setEntries] = useState<ConfigEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<string>('')
  const [onlyOverridden, setOnlyOverridden] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/config', {
        cache: 'no-store',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
      setEntries(data.entries ?? [])
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

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (category && e.category !== category) return false
      if (q) {
        const needle = q.toLowerCase()
        if (
          !e.key.toLowerCase().includes(needle) &&
          !e.category.toLowerCase().includes(needle) &&
          !(e.description ?? '').toLowerCase().includes(needle)
        ) {
          return false
        }
      }
      if (onlyOverridden && e.currentValue === (e.defaultValue ?? '∅')) {
        return false
      }
      return true
    })
  }, [entries, q, category, onlyOverridden])

  const categories = useMemo(() => {
    const seen = new Set(entries.map((e) => e.category))
    return CATEGORY_ORDER.filter((c) => seen.has(c as ConfigEntry['category']))
  }, [entries])

  const grouped = useMemo(() => {
    const map = new Map<string, ConfigEntry[]>()
    for (const e of filtered) {
      const arr = map.get(e.category) ?? []
      arr.push(e)
      map.set(e.category, arr)
    }
    return [...map.entries()].sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]),
    )
  }, [filtered])

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-[var(--accent)]" /> Config
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Catalogue of operator-relevant env knobs. <em>Read-only.</em> Most
            require restart; runtime-mutable flags are highlighted but cannot
            currently be flipped from the UI (lands in a follow-up).
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
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter key / description"
          className="flex-1 max-w-sm border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)]"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)]"
        >
          <option value="">all categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={onlyOverridden}
            onChange={(e) => setOnlyOverridden(e.target.checked)}
          />
          only overridden
        </label>
        <span className="text-[10px] text-[var(--text-faint)]">
          {filtered.length} / {entries.length} shown
        </span>
      </div>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      {grouped.map(([cat, rows]) => (
        <section key={cat}>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
            {cat} ({rows.length})
          </div>
          <table className="w-full text-xs border border-[var(--border)] rounded-md overflow-hidden">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-1.5">key</th>
                <th className="text-left px-3 py-1.5">current</th>
                <th className="text-left px-3 py-1.5">default</th>
                <th className="text-center px-3 py-1.5">mutable</th>
                <th className="text-left px-3 py-1.5">description</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const overridden = e.currentValue !== (e.defaultValue ?? '∅')
                return (
                  <tr
                    key={e.key}
                    className="border-t border-[var(--border)] font-mono"
                  >
                    <td className="px-3 py-1 text-[var(--text)] flex items-center gap-1">
                      {e.secret && (
                        <KeyRound className="w-3 h-3 text-[var(--text-faint)]" />
                      )}
                      {e.key}
                    </td>
                    <td
                      className={`px-3 py-1 ${
                        overridden
                          ? 'text-[var(--accent)]'
                          : 'text-[var(--text-muted)]'
                      } truncate max-w-[20ch]`}
                    >
                      {e.currentValue}
                    </td>
                    <td className="px-3 py-1 text-[10px] text-[var(--text-faint)] truncate max-w-[16ch]">
                      {e.defaultValue ?? '—'}
                    </td>
                    <td className="px-3 py-1 text-center">
                      {e.runtimeMutable ? (
                        <span
                          className="text-[10px] text-[var(--success)]"
                          title="Service reads on each request — runtime toggle is plausible (not yet wired in UI)"
                        >
                          ●
                        </span>
                      ) : (
                        <span
                          className="text-[10px] text-[var(--text-faint)]"
                          title="Read at boot — requires container restart"
                        >
                          ○
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1 text-[10px] text-[var(--text-muted)] font-sans">
                      {e.description ?? ''}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      ))}

      <div className="text-[10px] text-[var(--text-faint)] flex items-center gap-1">
        <AlertTriangle className="w-3 h-3" />
        ● = runtime-mutable (planned for UI flip), ○ = restart required.
      </div>
    </div>
  )
}
