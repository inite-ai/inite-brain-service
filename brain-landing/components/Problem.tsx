import { getMessages, type Lang } from '../lib/i18n'

/**
 * The pain, before any of the mechanism.
 *
 * Sits directly under the hero because the rest of the page explains how
 * memory is built, which only lands once the reader agrees there is
 * something wrong with not having it. Three failures, each answered
 * later on the page: re-pasted context (quickstart), client-bound memory
 * (the shared graph), unverifiable recall (provenance).
 */
export function Problem({ lang }: { lang: Lang }) {
  const m = getMessages(lang).problem
  return (
    <section className="py-16 border-t border-[var(--border)]" aria-labelledby="problem-title">
      <p className="u-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--signal)]">
        {m.eyebrow}
      </p>
      <h2
        id="problem-title"
        className="mt-3 u-display text-2xl sm:text-[30px] font-semibold tracking-[-0.02em] text-balance text-[var(--text)]"
      >
        {m.title}
      </h2>
      <p className="mt-4 text-base leading-relaxed text-[var(--text-muted)] max-w-2xl">
        {m.subtitle}
      </p>
      <div className="mt-10 grid md:grid-cols-3 gap-8 lg:gap-12">
        {m.items.map((item) => (
          <article key={item.label} className="border-t border-[var(--border-strong)] pt-5">
            <h3 className="u-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--text-faint)]">
              {item.label}
            </h3>
            <p className="mt-3 font-medium text-[var(--text)]">{item.title}</p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{item.desc}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
