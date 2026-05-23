import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { DOCS_GROUPS } from '../../../lib/docs-nav'
import { getMessages, normalizeLang } from '../../../lib/i18n'

interface Props {
  params: Promise<{ lang: string }>
}

export default async function DocsIndex({ params }: Props) {
  const { lang: raw } = await params
  const lang = normalizeLang(raw)
  const t = getMessages(lang)

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-[var(--text)] mt-2 mb-2">
        {t.docs.indexTitle}
      </h1>
      <p className="text-[15px] leading-relaxed text-[var(--text-muted)] mb-8">
        {t.docs.indexSubtitle}
      </p>

      {DOCS_GROUPS.map((group) => (
        <section key={group.headingKey} className="mb-10">
          <h2 className="text-xs font-semibold tracking-[0.08em] text-[var(--text-faint)] uppercase mb-3">
            {t.docs.groups[group.headingKey]}
          </h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {group.pages.map((page) => {
              const meta = t.docs.pages[page.key as keyof typeof t.docs.pages]
              return (
                <Link
                  key={page.slug}
                  href={`/${lang}/docs/${page.slug}`}
                  className="p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)] transition-colors group"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-[var(--text)]">
                      {meta?.title}
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-[var(--text-faint)] group-hover:text-[var(--accent)] transition-colors" />
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
                    {meta?.description}
                  </p>
                </Link>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
