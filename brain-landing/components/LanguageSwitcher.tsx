'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LANGS, type Lang } from '../lib/i18n'

interface Props {
  current: Lang
}

/**
 * EN ↔ RU pill. Rewrites the current pathname's `[lang]` segment so
 * the user stays on the page they were reading (`/en/docs/...` →
 * `/ru/docs/...`). Hard nav, no client router — server-rendered MDX
 * needs a fresh document for the new locale.
 */
export function LanguageSwitcher({ current }: Props) {
  const pathname = usePathname() ?? `/${current}`
  return (
    <div
      className="ml-1 inline-flex items-center gap-0.5 p-0.5 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]"
      role="group"
      aria-label="Language"
    >
      {LANGS.map((lang) => {
        const target = swapLang(pathname, current, lang)
        const active = lang === current
        return (
          <Link
            key={lang}
            href={target}
            aria-current={active ? 'true' : undefined}
            className={`px-1.5 py-0.5 text-[11px] uppercase tracking-wider rounded ${
              active
                ? 'bg-[var(--bg-overlay)] text-[var(--text)]'
                : 'text-[var(--text-faint)] hover:text-[var(--text-muted)]'
            }`}
          >
            {lang}
          </Link>
        )
      })}
    </div>
  )
}

function swapLang(pathname: string, from: Lang, to: Lang): string {
  if (pathname === '/' || pathname === '') return `/${to}`
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] === from) segments[0] = to
  else segments.unshift(to)
  return '/' + segments.join('/')
}
