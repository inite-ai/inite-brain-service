'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useState } from 'react'

interface Row {
  companyId: string
  id: string
  reason: string
  rejectedAt: string
  payload: Record<string, unknown>
}

interface Props {
  rows: Row[]
}

export function DeadLetterTable({ rows }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--text)] mb-2 tracking-tight">
        Recent dead-letter ({rows.length})
      </h2>
      <div className="rounded-md border border-[var(--border)] overflow-hidden">
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-[var(--text-muted)] text-xs">
            No rejected ingests in the recent window.
          </div>
        )}
        {rows.map((r) => {
          const isOpen = expanded === r.id
          return (
            <div key={r.id} className="border-b border-[var(--border)] last:border-b-0">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : r.id)}
                className="w-full text-left px-3 py-2 hover:bg-[var(--bg-overlay)]/50 flex items-baseline justify-between gap-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-[var(--text)] truncate">
                    {r.reason}
                  </div>
                  <div className="text-[10px] text-[var(--text-faint)] font-mono">
                    {r.companyId} · {r.rejectedAt.slice(0, 16).replace('T', ' ')}
                  </div>
                </div>
                <span className="text-[10px] text-[var(--text-faint)] font-mono">
                  {isOpen ? '▾' : '▸'}
                </span>
              </button>
              {isOpen && (
                <pre className="px-3 pb-3 text-[11px] font-mono text-[var(--text-muted)] overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(r.payload, null, 2)}
                </pre>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
