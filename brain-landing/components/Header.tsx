'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { LanguageSwitcher } from './LanguageSwitcher'
import { getMessages, type Lang } from '../lib/i18n'
import { useAuth } from '../hooks/useAuth'

interface Props {
  lang: Lang
  /** Optional page-context slot next to the brand. */
  context?: string
}

const REPO = 'inite/inite-brain-service'

/** Live star count, best-effort. Falls back to a plain "Star" CTA. */
function useStars(): string | null {
  const [stars, setStars] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    fetch(`https://api.github.com/repos/${REPO}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d || typeof d.stargazers_count !== 'number') return
        const n = d.stargazers_count as number
        setStars(n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return stars
}

/**
 * Sticky blueprint header. Mono wordmark, a GitHub-star CTA (open-source
 * signal), and the admin link for sessions that pass `/api/auth/me`.
 */
export function Header({ lang, context }: Props) {
  const t = getMessages(lang)
  const auth = useAuth()
  const stars = useStars()

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--bg)]/75 backdrop-blur supports-[backdrop-filter]:bg-[var(--bg)]/55">
      <div className="max-w-6xl mx-auto h-14 px-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={`/${lang}`} className="flex items-center gap-2.5 group">
            <span
              className="relative w-6 h-6 rounded-[6px] border border-[var(--signal)]/60 bg-[var(--signal-faint)] flex items-center justify-center"
              aria-hidden="true"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--signal)] live-dot" />
            </span>
            <span className="u-mono text-[13px] font-semibold tracking-[0.06em] text-[var(--text)]">
              INITE<span className="text-[var(--text-faint)]">//</span>BRAIN
            </span>
          </Link>
          {context && (
            <>
              <span className="text-[var(--text-faint)]" aria-hidden="true">
                /
              </span>
              <div className="text-sm text-[var(--text-muted)] truncate">
                {context}
              </div>
            </>
          )}
        </div>

        <nav className="flex items-center gap-1 text-sm">
          <Link
            href={`/${lang}/docs`}
            className="u-mono text-[12px] h-8 px-2.5 hidden sm:inline-flex items-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-overlay)] rounded-md"
          >
            {t.nav.docs}
          </Link>
          <Link
            href={`/${lang}/docs/skills`}
            className="u-mono text-[12px] h-8 px-2.5 hidden sm:inline-flex items-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-overlay)] rounded-md"
          >
            {t.nav.skills}
          </Link>
          <a
            href={`https://github.com/${REPO}`}
            target="_blank"
            rel="noopener noreferrer"
            className="u-mono text-[12px] h-8 pl-2.5 pr-2 inline-flex items-center gap-1.5 rounded-md border border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--data)] transition-colors"
          >
            <Star className="w-3.5 h-3.5" />
            {t.nav.star}
            {stars && (
              <span className="ml-0.5 px-1 rounded bg-[var(--bg-overlay)] text-[var(--data)] tabular-nums">
                {stars}
              </span>
            )}
          </a>
          {auth.isAdmin && (
            <Link
              href={`/${lang}/admin/graph`}
              className="u-mono text-[12px] h-8 px-2.5 inline-flex items-center gap-1 rounded-md text-[var(--accent)] hover:bg-[var(--accent-faint)] font-medium"
            >
              Admin
            </Link>
          )}
          <LanguageSwitcher current={lang} />
        </nav>
      </div>
    </header>
  )
}
