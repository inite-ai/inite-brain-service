'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { ReactNode } from 'react'
import { X } from 'lucide-react'

/** Feature-local UI helpers (PredicateRegistry idiom — no global kit). */

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-5 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--text-faint)] hover:text-[var(--text)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Drawer({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-96 overflow-y-auto border-l border-[var(--border)] bg-[var(--bg-elevated)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--text-faint)] hover:text-[var(--text)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-[10px] text-[var(--text-faint)]">{hint}</span>
      ) : null}
    </label>
  )
}

export const inputCls =
  'w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]'

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  toneOf,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  toneOf?: (v: T) => string
}) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-[var(--border)]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-2 py-1 text-[11px] transition-colors ${
            value === o.value
              ? (toneOf?.(o.value) ??
                'bg-[var(--accent)]/15 text-[var(--accent)] font-medium')
              : 'text-[var(--text-muted)] hover:text-[var(--text)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="font-mono text-xs text-[var(--danger)]">{error}</div>
}

export function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
      <div className="mb-3 h-4 w-1/3 rounded bg-[var(--bg-overlay)]" />
      <div className="mb-2 h-3 w-2/3 rounded bg-[var(--bg-overlay)]" />
      <div className="h-3 w-1/2 rounded bg-[var(--bg-overlay)]" />
    </div>
  )
}
