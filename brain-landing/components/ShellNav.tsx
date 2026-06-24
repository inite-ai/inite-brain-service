'use client'

import Link from 'next/link'
import type { ComponentType } from 'react'

export interface ShellSection {
  slug: string
  title: string
  icon: ComponentType<{ className?: string }>
}

export interface ShellGroup {
  label: string
  items: ShellSection[]
}

/**
 * Shared sidebar nav for the admin and end-user shells. Each shell
 * passes its own groups, the active slug, and an `hrefFor` that turns a
 * slug into a route (so the admin/app base path lives with the caller).
 * Section titles/labels come from data, never hardcoded JSX literals.
 */
export function ShellNav({
  groups,
  currentSlug,
  hrefFor,
  onNavigate,
  ariaLabel,
}: {
  groups: ShellGroup[]
  currentSlug: string
  hrefFor: (slug: string) => string
  onNavigate?: () => void
  ariaLabel: string
}) {
  return (
    <nav aria-label={ariaLabel} className="space-y-3">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="px-2.5 mb-1 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
            {g.label}
          </div>
          <div className="space-y-0.5">
            {g.items.map((s) => {
              const active = currentSlug === s.slug
              const Icon = s.icon
              return (
                <Link
                  key={s.slug}
                  href={hrefFor(s.slug)}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
                    active
                      ? 'bg-[var(--bg-overlay)] text-[var(--text)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-overlay)]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {s.title}
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )
}
