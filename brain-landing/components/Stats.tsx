import { ArrowUpRight } from 'lucide-react'
import { getMessages, type Lang } from '../lib/i18n'
import { GITHUB_URL } from '../lib/seo'
import { SectionHeading } from './DualPath'

export function Stats({ lang }: { lang: Lang }) {
  const { stats: s } = getMessages(lang)
  return (
    <section className="py-16 border-t border-[var(--border)]">
      <SectionHeading title={s.title} subtitle={s.subtitle} />
      <dl className="mt-8 grid md:grid-cols-3 gap-8">
        {s.items.map((item) => (
          <div key={item.value} className="border-t border-[var(--border-strong)] pt-5">
            <dt className="text-lg font-semibold">{item.value}</dt>
            <dd className="mt-2 text-sm text-[var(--data)]">{item.label}</dd>
            <dd className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{item.floor}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-8 max-w-3xl text-sm leading-relaxed text-[var(--text-muted)]">{s.footnote}</p>
      <a href={`${GITHUB_URL}/blob/main/docs/eval-protocol.md`} className="inline-flex items-center gap-2 min-h-11 mt-3 text-sm text-[var(--signal)] hover:underline">
        {s.linkLabel}<ArrowUpRight className="size-4" aria-hidden="true" />
      </a>
    </section>
  )
}
