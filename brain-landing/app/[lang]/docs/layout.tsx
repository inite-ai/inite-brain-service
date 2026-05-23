'use client'

import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Header } from '../../../components/Header'
import { DOCS_GROUPS, DOCS_PAGES, adjacentDocs } from '../../../lib/docs-nav'
import { getMessages, normalizeLang } from '../../../lib/i18n'

interface Props {
  children: ReactNode
}

/**
 * Docs shell: Header on top, persistent left sidebar of section groups,
 * content column with breadcrumb + prev/next pager. Sidebar collapses
 * under md.
 */
export default function DocsLayout({ children }: Props) {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  const t = getMessages(lang)
  const pathname = usePathname() ?? ''

  // Strip /<lang>/docs/ prefix to recover the docs slug (can include `/`).
  const prefix = `/${lang}/docs`
  const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
  const currentSlug = rest.replace(/^\/+/, '').replace(/\/+$/, '')

  const currentPage = DOCS_PAGES.find((p) => p.slug === currentSlug)
  const { prev, next } = adjacentDocs(currentSlug)
  const showRuPending = lang === 'ru'

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <Header lang={lang} context={t.nav.docs} />

      <div className="max-w-6xl mx-auto px-4 md:grid md:grid-cols-[14rem_1fr] lg:grid-cols-[16rem_1fr] md:gap-8">
        <aside className="hidden md:block sticky top-12 self-start py-8 max-h-[calc(100vh-3rem)] overflow-y-auto">
          <nav aria-label="Documentation">
            {DOCS_GROUPS.map((group) => (
              <div key={group.headingKey} className="mb-6">
                <p className="text-[10px] font-semibold tracking-[0.08em] text-[var(--text-faint)] uppercase mb-2">
                  {t.docs.groups[group.headingKey]}
                </p>
                <ul className="space-y-0.5">
                  {group.pages.map((page) => {
                    const active = currentSlug === page.slug
                    const pageTitle = t.docs.pages[page.key as keyof typeof t.docs.pages]?.title ?? page.slug
                    return (
                      <li key={page.slug}>
                        <Link
                          href={`/${lang}/docs/${page.slug}`}
                          aria-current={active ? 'page' : undefined}
                          className={`block px-2 py-1 text-sm rounded transition-colors ${
                            active
                              ? 'bg-[var(--bg-overlay)] text-[var(--text)]'
                              : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-overlay)]'
                          }`}
                        >
                          {pageTitle}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <main className="py-8 max-w-3xl min-w-0">
          {currentPage && (
            <nav
              aria-label="Breadcrumb"
              className="flex items-center gap-1.5 text-xs text-[var(--text-faint)] mb-4"
            >
              <Link href={`/${lang}/docs`} className="hover:text-[var(--text-muted)]">
                {t.nav.docs}
              </Link>
              <ChevronRight className="w-3 h-3" />
              <span className="text-[var(--text-muted)]">
                {t.docs.pages[currentPage.key as keyof typeof t.docs.pages]?.title}
              </span>
            </nav>
          )}

          {showRuPending && currentPage && (
            <div className="mb-4 px-3 py-2 rounded border border-[var(--border)] bg-[var(--bg-elevated)] text-[12px] text-[var(--text-muted)]">
              {t.docs.rev['ru-pending']}
            </div>
          )}

          <article className="docs-content">{children}</article>

          {(prev || next) && (
            <div className="mt-16 pt-6 border-t border-[var(--border)] grid grid-cols-2 gap-4">
              {prev ? (
                <Link
                  href={`/${lang}/docs/${prev.slug}`}
                  className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)] transition-colors"
                >
                  <span className="block text-[11px] text-[var(--text-faint)]">{t.docs.prev}</span>
                  <span className="block text-sm font-medium text-[var(--text)] mt-0.5">
                    {t.docs.pages[prev.key as keyof typeof t.docs.pages]?.title}
                  </span>
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link
                  href={`/${lang}/docs/${next.slug}`}
                  className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)] transition-colors text-right"
                >
                  <span className="block text-[11px] text-[var(--text-faint)]">{t.docs.next}</span>
                  <span className="block text-sm font-medium text-[var(--text)] mt-0.5">
                    {t.docs.pages[next.key as keyof typeof t.docs.pages]?.title}
                  </span>
                </Link>
              ) : (
                <span />
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
