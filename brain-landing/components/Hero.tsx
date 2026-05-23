import Link from 'next/link'
import { ArrowRight, Bot } from 'lucide-react'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

export function Hero({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section className="pt-20 pb-16 text-center">
      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] text-[11px] text-[var(--text-muted)] mb-6">
        <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--success)]" />
        {t.hero.badge}
      </div>

      <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-[var(--text)] leading-[1.05] max-w-3xl mx-auto">
        {t.hero.title}
      </h1>
      <p className="mt-5 max-w-2xl mx-auto text-[15px] leading-relaxed text-[var(--text-muted)]">
        {t.hero.subtitle}
      </p>

      <div className="mt-8 flex items-center justify-center gap-2 flex-wrap">
        <Link
          href={`/${lang}/docs/getting-started`}
          className="h-9 px-3.5 inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] text-white text-sm font-medium hover:bg-[var(--accent-hover)]"
        >
          {t.hero.ctaPrimary}
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
        <Link
          href={`/${lang}/docs/mcp/setup`}
          className="h-9 px-3.5 inline-flex items-center gap-1.5 rounded-md border border-[var(--border-strong)] text-[var(--text)] text-sm font-medium hover:bg-[var(--bg-overlay)]"
        >
          <Bot className="w-3.5 h-3.5" />
          {t.hero.ctaSecondary}
        </Link>
      </div>

      <div className="mt-12 accent-underline" />
    </section>
  )
}
