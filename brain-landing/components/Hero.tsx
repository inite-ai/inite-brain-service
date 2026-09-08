import Link from 'next/link'
import { ArrowRight, GitBranch, Quote } from 'lucide-react'
import { getMessages, type Lang } from '../lib/i18n'

export function Hero({ lang }: { lang: Lang }) {
  const { hero: h } = getMessages(lang)
  return (
    <section className="landing-hero py-16 sm:py-24">
      <div className="grid lg:grid-cols-[1.15fr_1fr] gap-12 lg:gap-16 items-center">
        <div>
          <h1 className="u-display text-[clamp(2.35rem,4.6vw,4rem)] leading-[1.08] font-semibold tracking-[-0.03em] text-balance">{h.title}</h1>
          <p className="mt-7 max-w-xl text-base sm:text-lg leading-relaxed text-[var(--text-muted)]">{h.subtitle}</p>
          <div className="mt-8 flex gap-3 flex-wrap">
            <a href="#quickstart" className="btn-signal min-h-11 px-5 inline-flex items-center gap-2 rounded-md text-sm">
              {h.ctaPrimary}<ArrowRight className="size-4" aria-hidden="true" />
            </a>
            <Link href={`/${lang}/docs/getting-started`} className="btn-ghost min-h-11 px-5 inline-flex items-center rounded-md text-sm">{h.ctaSecondary}</Link>
          </div>
          <ul className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--text-faint)]">
            <li className="text-[var(--data)]">{h.trust.license}</li><li>{h.trust.stack}</li><li>{h.trust.eval}</li>
          </ul>
        </div>
        <figure className="memory-trace lab-panel rounded-xl overflow-hidden">
          <figcaption className="px-6 py-4 border-b border-[var(--border)] flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <GitBranch className="size-4 text-[var(--data)]" aria-hidden="true" />{h.panel.label}
          </figcaption>
          <div className="p-6 sm:p-7">
            <h2 className="text-lg font-semibold">{h.panel.question}</h2>
            <div className="my-6 flex items-center gap-4">
              <div className="flex-1"><p className="text-xs text-[var(--text-faint)]">{h.panel.before}</p><p className="u-mono mt-2 text-sm text-[var(--text-muted)]">PostgreSQL</p></div>
              <ArrowRight className="size-5 text-[var(--text-faint)] shrink-0" aria-hidden="true" />
              <div className="flex-1"><p className="text-xs text-[var(--text-faint)]">{h.panel.after}</p><p className="u-mono mt-2 text-lg text-[var(--data)]">SurrealDB</p></div>
            </div>
            <blockquote className="border-t border-[var(--border-strong)] pt-5">
              <Quote className="size-5 text-[var(--signal)] mb-3" aria-hidden="true" />
              <p className="text-sm leading-relaxed">{h.panel.quote}</p>
              <footer className="mt-3 text-xs text-[var(--text-faint)]">{h.panel.source}</footer>
            </blockquote>
          </div>
          <p className="px-6 py-4 border-t border-[var(--border)] text-xs leading-relaxed text-[var(--text-muted)]">{h.panel.note}</p>
        </figure>
      </div>
    </section>
  )
}
