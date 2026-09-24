'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useCallback, useMemo, useState } from 'react'
import { useLoader } from '../../hooks/useLoader'
import { AlertTriangle, Check, KeyRound, RefreshCw, RotateCcw, Settings2 } from 'lucide-react'
import { CONFIG_CATEGORIES } from '../../lib/contracts/admin-config'
import type { ConfigEntry } from '../../lib/contracts/admin-config'

// Display order = contract enum order. Derived (not copied) so a category
// added to the wire contract can never miss the dropdown / sort again.
export const CATEGORY_ORDER: readonly string[] = CONFIG_CATEGORIES

export function ConfigPanel() {
  const [entries, setEntries] = useState<ConfigEntry[]>([])
  const [secretsWritable, setSecretsWritable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<string>('')
  const [onlyOverridden, setOnlyOverridden] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/config', {
        cache: 'no-store',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
      setEntries(data.entries ?? [])
      setSecretsWritable(data.secretsWritable !== false)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const { loading, reload } = useLoader(load)

  const write = useCallback(
    async (key: string, value: string | null) => {
      const res = await fetch(
        `/api/admin/proxy/v1/admin/config/${encodeURIComponent(key)}`,
        value === null
          ? { method: 'DELETE' }
          : {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ value }),
            },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? data.message ?? `Failed ${res.status}`)
      await reload()
      return data as { restartRequired?: boolean }
    },
    [reload],
  )

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
      if (onlyOverridden && !e.overridden) return false
      return true
    })
  }, [entries, q, category, onlyOverridden])

  const categories = useMemo(() => {
    const seen = new Set<string>(entries.map((e) => e.category))
    return CATEGORY_ORDER.filter((c) => seen.has(c))
  }, [entries])

  const grouped = useMemo(() => {
    const map = new Map<string, ConfigEntry[]>()
    for (const e of filtered) {
      const arr = map.get(e.category) ?? []
      arr.push(e)
      map.set(e.category, arr)
    }
    return [...map.entries()].sort(
      (a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]),
    )
  }, [filtered])

  const overriddenCount = useMemo(() => entries.filter((e) => e.overridden).length, [entries])

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-[var(--accent)]" /> Config
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Every knob this deployment has. A value set here is stored in the
            service and applied over the one the deploy shipped — ● takes
            effect at once, ○ on the next restart. Other replicas pick it up
            within 30s. Secrets are stored encrypted and never shown again.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
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
          only set here ({overriddenCount})
        </label>
        <span className="text-[10px] text-[var(--text-faint)]">
          {filtered.length} / {entries.length} shown
        </span>
      </div>

      {error && <div className="text-xs text-[var(--danger)] font-mono">{error}</div>}
      {!secretsWritable && (
        <div className="text-[10px] text-[var(--warning)] flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          SOURCE_CREDENTIAL_ENCRYPTION_KEY is unset, so secrets cannot be
          stored here — a secret is never kept in the clear.
        </div>
      )}

      {grouped.map(([cat, rows]) => (
        <section key={cat}>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
            {cat} ({rows.length})
          </div>
          <table className="w-full text-xs border border-[var(--border)] rounded-md overflow-hidden table-fixed">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-1.5 w-[28%]">key</th>
                <th className="text-left px-3 py-1.5 w-[26%]">value</th>
                <th className="text-left px-3 py-1.5 w-[10%]">default</th>
                <th className="text-center px-3 py-1.5 w-[6%]">live</th>
                <th className="text-left px-3 py-1.5">description</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <ConfigRow
                  key={e.key}
                  entry={e}
                  secretsWritable={secretsWritable}
                  onWrite={write}
                />
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <div className="text-[10px] text-[var(--text-faint)] flex items-center gap-1">
        <AlertTriangle className="w-3 h-3" />
        ● = read on every request, a change bites immediately. ○ = captured at
        boot, a change needs a restart.
      </div>
    </div>
  )
}

function ConfigRow({
  entry,
  secretsWritable,
  onWrite,
}: {
  entry: ConfigEntry
  secretsWritable: boolean
  onWrite: (key: string, value: string | null) => Promise<{ restartRequired?: boolean }>
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  const locked = !entry.settable || (entry.secret === true && !secretsWritable)
  const lockReason = !entry.settable
    ? 'environment-only: read before the store, or it is what unlocks the store'
    : 'no encryption key configured — a secret is never stored in the clear'

  const run = async (value: string | null) => {
    setBusy(true)
    setRowError(null)
    try {
      await onWrite(entry.key, value)
      setDraft('')
    } catch (err) {
      setRowError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className="border-t border-[var(--border)] font-mono align-top">
      <td className="px-3 py-1 text-[var(--text)]">
        <span className="flex items-center gap-1">
          {entry.secret && <KeyRound className="w-3 h-3 text-[var(--text-faint)]" />}
          <span className="break-all">{entry.key}</span>
        </span>
        {entry.overridden && (
          <span className="block text-[10px] text-[var(--text-faint)] font-sans">
            set here by {entry.updatedBy ?? 'unknown'}
            {entry.updatedAt ? ` · ${entry.updatedAt.slice(0, 16).replace('T', ' ')}` : ''}
            {entry.deployValue !== undefined && (
              <> · deploy said {entry.deployValue === null ? 'nothing' : entry.deployValue}</>
            )}
          </span>
        )}
      </td>
      <td className="px-3 py-1">
        {locked ? (
          <span className="text-[var(--text-muted)]" title={lockReason}>
            {entry.currentValue}
          </span>
        ) : entry.isBooleanFlag ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(isOn(entry.currentValue) ? '0' : '1')}
            className={`px-2 py-0.5 rounded-md border text-[10px] ${
              isOn(entry.currentValue)
                ? 'border-[var(--success)] text-[var(--success)]'
                : 'border-[var(--border)] text-[var(--text-muted)]'
            }`}
          >
            {isOn(entry.currentValue) ? 'on' : 'off'}
          </button>
        ) : (
          <span className="flex items-center gap-1">
            <input
              type={entry.secret ? 'password' : 'text'}
              value={draft}
              disabled={busy}
              placeholder={entry.currentValue}
              onChange={(ev) => setDraft(ev.target.value)}
              className="w-full min-w-0 border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[var(--text)]"
            />
            <button
              type="button"
              disabled={busy || draft === ''}
              onClick={() => void run(draft)}
              title="save"
              className="text-[var(--accent)] disabled:text-[var(--text-faint)]"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          </span>
        )}
        {entry.overridden && !locked && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(null)}
            title="drop the override; the deploy's own value stands again"
            className="mt-0.5 text-[10px] text-[var(--text-faint)] hover:text-[var(--text)] flex items-center gap-1 font-sans"
          >
            <RotateCcw className="w-3 h-3" /> revert
          </button>
        )}
        {rowError && (
          <span className="block text-[10px] text-[var(--danger)] font-sans">{rowError}</span>
        )}
      </td>
      <td className="px-3 py-1 text-[10px] text-[var(--text-faint)] truncate">
        {entry.defaultValue ?? '—'}
      </td>
      <td className="px-3 py-1 text-center">
        <span
          className={`text-[10px] ${
            entry.runtimeMutable ? 'text-[var(--success)]' : 'text-[var(--text-faint)]'
          }`}
          title={
            entry.runtimeMutable
              ? 'read on every request — a change bites immediately'
              : 'captured at boot — a change needs a restart'
          }
        >
          {entry.runtimeMutable ? '●' : '○'}
        </span>
      </td>
      <td className="px-3 py-1 text-[10px] text-[var(--text-muted)] font-sans">
        {entry.description ?? ''}
      </td>
    </tr>
  )
}

function isOn(value: string): boolean {
  return value === '1' || value.toLowerCase() === 'true'
}
