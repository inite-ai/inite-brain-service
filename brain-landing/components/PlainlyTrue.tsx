import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'

/**
 * The closing argument: flat statements, including the unflattering
 * ones and the positioning, in one place.
 *
 * Everything here is checkable — where Brain sits, what it refuses to
 * be, where the data lives, what the licence costs, what a published
 * number means. The page argues for Brain everywhere else; this section
 * is where it says what Brain is not, which is the part a reader is
 * actually looking for by the time they reach the bottom.
 */
export function PlainlyTrue({ lang }: { lang: Lang }) {
  const m = getMessages(lang).plainly
  return (
    <section className="py-16 border-t border-[var(--border)]" aria-labelledby="plainly-title">
      <p className="u-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--text-faint)]">
        {m.eyebrow}
      </p>
      <div className="mt-3" id="plainly-title">
        <SectionHeading title={m.title} subtitle={m.subtitle} />
      </div>
      <ol className="mt-9 grid md:grid-cols-2 gap-x-10 gap-y-7">
        {m.items.map((item, i) => (
          <li key={item.title} className="flex gap-4">
            <span className="u-mono text-[11px] pt-0.5 text-[var(--data)] tabular-nums shrink-0">
              {String(i + 1).padStart(2, '0')}
            </span>
            <div className="border-t border-[var(--border-strong)] pt-3 -mt-3">
              <h3 className="font-medium text-[var(--text)]">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{item.desc}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
