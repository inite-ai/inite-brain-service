import { getMessages, type Lang } from '../lib/i18n'

export function MemoryLayers({ lang }: { lang: Lang }) {
  const m = getMessages(lang).memoryLayers
  return (
    <section className="py-16 border-t border-[var(--border)]" aria-labelledby="memory-layers-title">
      <h2 id="memory-layers-title" className="u-display text-2xl sm:text-[30px] font-semibold text-balance">{m.title}</h2>
      <p className="mt-4 text-base leading-relaxed text-[var(--text-muted)] max-w-2xl">{m.subtitle}</p>
      <div className="mt-10 grid md:grid-cols-3 gap-8 lg:gap-12">
        {m.items.map((item) => (
          <article key={item.label} className="border-t border-[var(--border-strong)] pt-5">
            <h3 className="text-lg font-semibold text-[var(--data)]">{item.label}</h3>
            <p className="mt-4 font-medium">{item.title}</p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{item.desc}</p>
          </article>
        ))}
      </div>
      <p className="mt-8 max-w-4xl text-xs leading-relaxed text-[var(--text-faint)]">{m.note}</p>
    </section>
  )
}
