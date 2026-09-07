import { ArrowDown, ArrowRight, ArrowUpRight } from 'lucide-react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'
import { GITHUB_URL } from '../lib/seo'

export function Architecture({ lang }: { lang: Lang }) {
  const a = getMessages(lang).architecture
  return (
    <section id="architecture" className="py-16 border-t border-[var(--border)] scroll-mt-32">
      <SectionHeading title={a.title} subtitle={a.subtitle} />
      <ol className="mt-10 grid lg:grid-cols-3 gap-10 lg:gap-8">
        {a.stages.map((stage, index) => (
          <li key={stage.title} className="relative border-t border-[var(--data)] pt-5">
            <h3 className="text-xl font-semibold">{stage.title}</h3>
            <p className="mt-4 text-xs u-mono leading-relaxed text-[var(--data)]">{stage.path}</p>
            <p className="mt-4 text-sm leading-relaxed text-[var(--text-muted)]">{stage.desc}</p>
            <p className="mt-5 text-xs text-[var(--text-faint)]">{stage.detail}</p>
            {index < a.stages.length - 1 && <>
              <ArrowRight aria-hidden="true" className="hidden lg:block absolute -right-6 top-6 size-4 text-[var(--data)]" />
              <ArrowDown aria-hidden="true" className="lg:hidden absolute -bottom-7 left-0 size-4 text-[var(--data)]" />
            </>}
          </li>
        ))}
      </ol>
      <a href="#domain-packs" className="mt-8 py-4 border-y border-[var(--border)] flex items-center justify-between gap-4 text-sm leading-relaxed text-[var(--signal)] hover:underline">
        {a.packBridge}<ArrowDown className="size-4 shrink-0" aria-hidden="true" />
      </a>
      <div className="mt-8 grid md:grid-cols-2 gap-8 lg:gap-12">
        {a.details.map((item) => <div key={item.title}>
          <h3 className="text-base font-semibold">{item.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{item.desc}</p>
        </div>)}
      </div>
      <a href={`${GITHUB_URL}/blob/main/docs/architecture.md`} className="mt-5 min-h-11 inline-flex items-center gap-2 text-sm text-[var(--data)] hover:underline">
        {a.link}<ArrowUpRight className="size-4" aria-hidden="true" />
      </a>
    </section>
  )
}
