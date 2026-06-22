'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { Clock, History, RotateCcw } from 'lucide-react'

interface Props {
  /** validTime — "as of when in the world". ISO string or null = now. */
  asOf: string | null
  /** transactionTime — "as known by the system at this moment". ISO or null = latest. */
  recordedAt?: string | null
  onChange(next: { asOf: string | null; recordedAt?: string | null }): void
}

/**
 * Dual bitemporal scrubber: validTime (asOf) + transactionTime
 * (recordedAt). validTime asks "what was true in the world at time X?";
 * transactionTime asks "what did we know about it as of time Y?".
 *
 * The XTDB/Datomic admin pattern — operator can hold one axis fixed
 * while sweeping the other to debug "we wrote it on Tuesday but
 * effective Monday" cases. recordedAt is optional: when omitted, the
 * UI degrades to a single asOf slider (back-compat with callers that
 * haven't migrated yet).
 */
export function AsOfSlider({ asOf, recordedAt, onChange }: Props) {
  const valid = asOf ? toLocalInput(asOf) : ''
  const tx = recordedAt ? toLocalInput(recordedAt) : ''
  const showRecorded = recordedAt !== undefined
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] flex items-center gap-1">
          <Clock className="w-3 h-3" /> valid
        </span>
        <input
          type="datetime-local"
          value={valid}
          onChange={(e) => {
            const v = e.target.value
            onChange({
              asOf: v ? new Date(v).toISOString() : null,
              recordedAt,
            })
          }}
          className="h-8 px-2 rounded border border-[var(--border)] bg-[var(--bg)] text-[11px] font-mono text-[var(--text)] focus:border-[var(--accent)] outline-none"
          title="validTime — moment in the world we're asking about"
        />
      </div>
      {showRecorded && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] flex items-center gap-1">
            <History className="w-3 h-3" /> tx
          </span>
          <input
            type="datetime-local"
            value={tx}
            onChange={(e) => {
              const v = e.target.value
              onChange({
                asOf,
                recordedAt: v ? new Date(v).toISOString() : null,
              })
            }}
            className="h-8 px-2 rounded border border-[var(--border)] bg-[var(--bg)] text-[11px] font-mono text-[var(--text)] focus:border-[var(--accent)] outline-none"
            title="transactionTime — moment of system knowledge"
          />
        </div>
      )}
      {(asOf || recordedAt) && (
        <button
          type="button"
          onClick={() => onChange({ asOf: null, recordedAt: null })}
          className="p-1 rounded-md hover:bg-[var(--bg-overlay)] text-[var(--text-muted)]"
          aria-label="Reset to now"
          title="Reset both axes to now"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => n.toString().padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}
