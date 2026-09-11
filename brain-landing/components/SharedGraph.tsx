import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'
import { CONNECT_TARGETS } from '../lib/connect-targets'

/**
 * The differentiator the page never stated: every client points at one
 * graph, and the graph is not inside any of them.
 *
 * The client chips are derived from CONNECT_TARGETS rather than written
 * out here, so the picture cannot promise a client the connect section
 * does not actually install — the two drift apart silently otherwise,
 * and this one is a claim, not decoration.
 */
export function SharedGraph({ lang }: { lang: Lang }) {
  const m = getMessages(lang).sharedGraph
  const clients = [...CONNECT_TARGETS.map((t) => t.label), m.sdkLabel]
  return (
    <section id="one-graph" className="py-16 border-t border-[var(--border)] scroll-mt-20">
      <p className="u-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--data)]">
        {m.eyebrow}
      </p>
      <div className="mt-3">
        <SectionHeading title={m.title} subtitle={m.subtitle} />
      </div>

      <div className="mt-9 lab-panel rounded-xl p-5 sm:p-7">
        <p className="u-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--text-faint)] text-center">
          {m.clientsLabel}
        </p>
        <ul className="mt-4 flex flex-wrap justify-center gap-2">
          {clients.map((label) => (
            <li
              key={label}
              className="rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-1.5 text-[12.5px] text-[var(--text-muted)]"
            >
              {label}
            </li>
          ))}
        </ul>

        {/* A bus, not a stray tick: the horizontal run collects the
            chips above it, the drop points at the one thing below. */}
        <div aria-hidden="true" className="flex flex-col items-center pt-6 pb-5">
          <span className="block h-px w-2/3 max-w-xl bg-[var(--border-strong)]" />
          <span className="block w-px h-9 bg-[var(--border-strong)]" />
        </div>

        <div className="mx-auto max-w-md rounded-lg border border-[var(--data)]/40 bg-[var(--data-faint)] p-5 text-center">
          <p className="u-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--data)]">
            {m.hubLabel}
          </p>
          <h3 className="mt-2 u-display text-lg font-semibold text-[var(--text)]">{m.hubTitle}</h3>
          <ul className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-[12.5px] text-[var(--text-muted)]">
            {m.hubItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <p className="mt-6 text-center text-xs text-[var(--text-faint)]">
          <span className="u-mono uppercase tracking-[0.18em]">{m.surfaceLabel}</span>
          <span className="mx-2">·</span>
          <span className="u-mono text-[var(--text-muted)]">{m.surface}</span>
        </p>
      </div>

      <div className="mt-8 grid md:grid-cols-3 gap-6 lg:gap-10">
        {m.facts.map((fact) => (
          <article key={fact.title} className="border-t border-[var(--border-strong)] pt-4">
            <h3 className="text-sm font-semibold text-[var(--text)]">{fact.title}</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">{fact.desc}</p>
          </article>
        ))}
      </div>

      <p className="mt-7 max-w-4xl text-xs leading-relaxed text-[var(--text-faint)]">{m.note}</p>

      <Link
        href="#connect"
        className="mt-4 inline-flex items-center gap-1 text-sm text-[var(--signal)] hover:underline"
      >
        {m.cta}
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </Link>
    </section>
  )
}
