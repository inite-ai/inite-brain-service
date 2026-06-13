'use client'

import { ReactNode } from 'react'

interface Props {
  slideNumber: string
  eyebrow: string
  title: string
  subtitle?: string
  children: ReactNode
}

/**
 * Presenter-mode shell. Big type, single column, deck-style chrome.
 * Designed to be opened on a projector at 1920×1080 — the parent
 * /admin/demo page strips the admin sidebar and uses the full width.
 */
export function DemoFrame({
  slideNumber,
  eyebrow,
  title,
  subtitle,
  children,
}: Props) {
  return (
    <section className="min-h-[calc(100vh-3rem)] py-12 px-8 md:px-16 max-w-6xl mx-auto">
      <div className="flex items-baseline gap-3 mb-4">
        <span className="text-[10px] font-mono tracking-[0.3em] text-[var(--text-faint)]">
          {slideNumber}
        </span>
        <span className="text-[10px] font-mono tracking-[0.3em] text-[var(--text-muted)] uppercase">
          {eyebrow}
        </span>
      </div>
      <h2 className="text-3xl md:text-5xl font-semibold leading-tight text-[var(--text)] mb-3">
        {title}
      </h2>
      {subtitle && (
        <p className="text-base md:text-lg text-[var(--text-muted)] mb-8 max-w-3xl">
          {subtitle}
        </p>
      )}
      <div>{children}</div>
    </section>
  )
}
