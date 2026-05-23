import Link from 'next/link'
import { LanguageSwitcher } from './LanguageSwitcher'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
  /** Optional page-context slot next to the brand. */
  context?: string
}

/**
 * Sticky 1px-border header. Mirrors inite-auth's AppHeader chrome
 * without the user-menu (brain-landing is a public marketing surface,
 * no signed-in state). Locale switcher lives here.
 */
export function Header({ lang, context }: Props) {
  const t = getMessages(lang)
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur supports-[backdrop-filter]:bg-[var(--bg)]/60">
      <div className="max-w-6xl mx-auto h-12 px-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={`/${lang}`} className="flex items-center gap-2 group">
            <span
              className="w-5 h-5 rounded-[5px] bg-[var(--accent)] flex items-center justify-center text-[10px] font-bold text-white"
              aria-hidden="true"
            >
              B
            </span>
            <span className="text-sm font-semibold text-[var(--text)] tracking-tight">
              INITE Brain
            </span>
          </Link>
          {context && (
            <>
              <span className="text-[var(--text-faint)]" aria-hidden="true">/</span>
              <div className="text-sm text-[var(--text-muted)] truncate">{context}</div>
            </>
          )}
        </div>

        <nav className="flex items-center gap-1 text-sm">
          <Link
            href={`/${lang}/docs`}
            className="h-8 px-2.5 inline-flex items-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-overlay)] rounded-md"
          >
            {t.nav.docs}
          </Link>
          <Link
            href={`/${lang}/docs/skills`}
            className="h-8 px-2.5 inline-flex items-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-overlay)] rounded-md"
          >
            {t.nav.skills}
          </Link>
          <a
            href="https://github.com/inite/inite-brain-service"
            target="_blank"
            rel="noopener noreferrer"
            className="h-8 px-2.5 inline-flex items-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-overlay)] rounded-md"
          >
            {t.nav.github}
          </a>
          <LanguageSwitcher current={lang} />
        </nav>
      </div>
    </header>
  )
}
