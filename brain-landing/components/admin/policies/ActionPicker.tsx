'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { useMemo, useState } from 'react'
import { ChevronDown, Sparkles, X } from 'lucide-react'
import type { PolicyRegistryResponse } from '../../../lib/contracts/admin-policies'

const FAMILY_LABEL: Record<string, string> = {
  mcp_read: 'MCP · read',
  mcp_write: 'MCP · write',
  mcp_community: 'Communities',
  mcp_procedural: 'Procedural',
  mcp_source: 'Sources',
  rest: 'REST endpoints',
}

/**
 * Chip input + grouped picker for action rules. Macros render as
 * accent-outlined chips with their expansion size; everything comes
 * from the registry endpoint — nothing hardcoded.
 */
export function ActionPicker({
  registry,
  selected,
  onChange,
}: {
  registry: PolicyRegistryResponse | null
  selected: string[]
  onChange: (actions: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const grouped = useMemo(() => {
    const out = new Map<string, PolicyRegistryResponse['actions']>()
    for (const a of registry?.actions ?? []) {
      if (q && !a.name.includes(q.toLowerCase())) continue
      const list = out.get(a.family) ?? []
      list.push(a)
      out.set(a.family, list)
    }
    return out
  }, [registry, q])

  const toggle = (name: string) => {
    onChange(
      selected.includes(name)
        ? selected.filter((x) => x !== name)
        : [...selected, name],
    )
  }

  const macroSize = (id: string) =>
    registry?.macros.find((m) => m.id === id)?.actions.length ?? 0

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((a) => (
          <span
            key={a}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] ${
              a.startsWith('@')
                ? 'border border-[var(--accent)]/50 text-[var(--accent)]'
                : 'bg-[var(--bg-overlay)] text-[var(--text)]'
            }`}
            title={
              a.startsWith('@') ? `macro — expands to ${macroSize(a)} actions` : undefined
            }
          >
            {a.startsWith('@') ? <Sparkles className="h-2.5 w-2.5" /> : null}
            {a}
            <button
              type="button"
              onClick={() => toggle(a)}
              className="text-[var(--text-faint)] hover:text-[var(--danger)]"
              aria-label={`Remove ${a}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded border border-dashed border-[var(--border-strong,var(--border))] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          add action <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </div>

      {open ? (
        <div className="mt-2 max-h-64 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg)] p-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter actions…"
            className="mb-2 w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(registry?.macros ?? []).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => toggle(m.id)}
                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                  selected.includes(m.id)
                    ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]'
                    : 'border-[var(--accent)]/40 text-[var(--accent)]/80 hover:border-[var(--accent)]'
                }`}
                title={`expands to ${m.actions.length} actions`}
              >
                <Sparkles className="h-2.5 w-2.5" />
                {m.id}
                <span className="text-[9px] opacity-70">({m.actions.length})</span>
              </button>
            ))}
          </div>
          {[...grouped.entries()].map(([family, actions]) => (
            <div key={family} className="mb-2">
              <div className="mb-1 text-[9px] font-medium uppercase tracking-wider text-[var(--text-faint)]">
                {FAMILY_LABEL[family] ?? family} · {actions.length}
              </div>
              <div className="grid grid-cols-2 gap-x-2">
                {actions.map((a) => (
                  <label
                    key={a.name}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-[var(--bg-overlay)]"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(a.name)}
                      onChange={() => toggle(a.name)}
                      className="h-3 w-3 accent-[var(--accent)]"
                    />
                    <span
                      className={`font-mono text-[10px] ${
                        a.kind === 'write'
                          ? 'text-[var(--warning)]'
                          : 'text-[var(--text-muted)]'
                      }`}
                      title={a.title}
                    >
                      {a.name}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
