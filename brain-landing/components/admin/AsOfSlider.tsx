'use client'

import { Clock, RotateCcw } from 'lucide-react'

interface Props {
  /** ISO string or null when "now". */
  asOf: string | null
  onChange(next: string | null): void
}

/**
 * Bitemporal scrubber. HTML5 datetime-local input — operator picks a
 * moment, graph re-fetches connections with that asOf. "Now" button
 * clears the param so default actual-now semantics resume.
 *
 * Stored value is ISO 8601; the input itself wants `YYYY-MM-DDTHH:mm`
 * sans timezone, so we round-trip through Date.
 */
export function AsOfSlider({ asOf, onChange }: Props) {
  const inputValue = asOf ? toLocalInput(asOf) : ''
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] flex items-center gap-1">
        <Clock className="w-3 h-3" /> asOf
      </span>
      <input
        type="datetime-local"
        value={inputValue}
        onChange={(e) => {
          const v = e.target.value
          onChange(v ? new Date(v).toISOString() : null)
        }}
        className="h-8 px-2 rounded border border-[var(--border)] bg-[var(--bg)] text-[11px] font-mono text-[var(--text)] focus:border-[var(--accent)] outline-none"
      />
      {asOf && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="p-1 rounded-md hover:bg-[var(--bg-overlay)] text-[var(--text-muted)]"
          aria-label="Reset to now"
          title="Reset to now"
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
