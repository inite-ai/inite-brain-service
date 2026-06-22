'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useState } from 'react'
import { Play, X } from 'lucide-react'

type Op = 'dedup' | 'resolve' | 'summarize'

const OPS: Op[] = ['dedup', 'resolve', 'summarize']

/**
 * Trigger /v1/admin/dreams/run (which proxies to DreamsService). User
 * picks which sub-ops to fire; result is shown inline.
 */
export function DreamsTrigger() {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<Op>>(
    new Set(['dedup', 'resolve']),
  )
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function run() {
    setRunning(true)
    setErr(null)
    setResult(null)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/dreams/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: [...selected] }),
      })
      const body = await res.json()
      if (!res.ok) setErr(body?.error ?? `Failed (${res.status})`)
      else setResult(JSON.stringify(body, null, 2))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[var(--border-strong)] text-[var(--text)] text-xs hover:bg-[var(--bg-overlay)]"
      >
        <Play className="w-3 h-3" /> Trigger dreams
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => !running && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 h-12 border-b border-[var(--border)]">
              <h2 className="text-sm font-semibold text-[var(--text)]">
                Trigger dreams
              </h2>
              <button
                type="button"
                onClick={() => !running && setOpen(false)}
                className="p-1 rounded-md hover:bg-[var(--bg-overlay)] text-[var(--text-muted)]"
                disabled={running}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-xs text-[var(--text-muted)]">
                Runs the off-hours self-improvement pass against this caller&apos;s tenant. Each sub-op mutates state — see operator playbook for cost.
              </p>
              <div className="space-y-1.5">
                {OPS.map((op) => (
                  <label
                    key={op}
                    className="flex items-center gap-2 text-sm text-[var(--text)]"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(op)}
                      onChange={(e) => {
                        setSelected((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(op)
                          else next.delete(op)
                          return next
                        })
                      }}
                      disabled={running}
                    />
                    <span className="font-mono">{op}</span>
                  </label>
                ))}
              </div>
              {err && (
                <div className="text-xs text-[var(--danger)] font-mono">
                  {err}
                </div>
              )}
              {result && (
                <pre className="max-h-48 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-[11px] font-mono text-[var(--text)]">
                  {result}
                </pre>
              )}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
              <button
                type="button"
                onClick={() => !running && setOpen(false)}
                disabled={running}
                className="h-8 px-3 rounded-md text-[var(--text-muted)] text-xs hover:bg-[var(--bg-overlay)]"
              >
                Close
              </button>
              <button
                type="button"
                onClick={run}
                disabled={running || selected.size === 0}
                className="h-8 px-3 rounded-md bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                {running ? 'Running…' : 'Run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
