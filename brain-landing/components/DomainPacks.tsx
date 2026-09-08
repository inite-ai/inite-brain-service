import Link from 'next/link'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'
import { GITHUB_URL } from '../lib/seo'

// A real path from packs/real-estate.pack.json → listing_lifecycle.
const LISTING_PATH = ['listed', 'under_offer', 'sold']

export function DomainPacks({ lang }: { lang: Lang }) {
  const p = getMessages(lang).domainPacks
  return (
    <section id="domain-packs" className="py-16 border-t border-[var(--border)] scroll-mt-32">
      <SectionHeading title={p.title} subtitle={p.subtitle} />
      <div className="mt-10 grid lg:grid-cols-2 gap-10 lg:gap-16 items-start">
        <dl className="space-y-6">
          {p.capabilities.map((item) => <div key={item.title}>
            <dt className="font-semibold">{item.title}</dt>
            <dd className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{item.desc}</dd>
          </div>)}
        </dl>
        <figure className="lab-panel rounded-xl overflow-hidden">
          <figcaption className="px-6 py-4 border-b border-[var(--border)] text-xs text-[var(--text-faint)]">{p.exampleLabel}</figcaption>
          <div className="p-6">
            <h3 className="text-xl font-semibold">{p.exampleTitle}</h3>
            <ol className="my-6 flex flex-wrap gap-x-3 gap-y-2 items-center u-mono text-xs text-[var(--data)]">
              {LISTING_PATH.map((state, index) => <li key={state} className="flex items-center gap-3">
                {index > 0 && <ArrowRight className="size-3" aria-hidden="true" />}{state}
              </li>)}
            </ol>
            <p className="text-sm leading-relaxed text-[var(--text-muted)]">{p.exampleNote}</p>
            <div className="mt-5 pt-5 border-t border-[var(--border)]">
              <p className="text-sm font-medium">{p.exampleScenes}</p>
              <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{p.exampleRetention}</p>
            </div>
          </div>
        </figure>
      </div>
      <h3 className="mt-12 text-lg font-semibold">{p.libraryTitle}</h3>
      <dl className="mt-5 grid sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-5">
        {p.library.map((pack) => <div key={pack.id} className="border-t border-[var(--border)] pt-4">
          <dt className="font-medium text-[var(--data)]">{pack.name}</dt>
          <dd className="mt-1 text-sm text-[var(--text-muted)]">{pack.desc}</dd>
        </div>)}
      </dl>
      <p className="mt-6 text-sm text-[var(--text-muted)]">{p.codeMemory}</p>
      <p className="mt-6 max-w-3xl text-sm leading-relaxed text-[var(--text-muted)]">{p.distribution}</p>
      <p className="mt-3 max-w-3xl text-xs leading-relaxed text-[var(--text-faint)]">{p.note}</p>
      <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2">
        <Link href={`/${lang}/docs/platform/domain-packs`} className="min-h-11 inline-flex items-center gap-2 text-sm text-[var(--signal)] hover:underline">{p.docsLink}<ArrowRight className="size-4" aria-hidden="true" /></Link>
        <a href={`${GITHUB_URL}/tree/main/packs`} className="min-h-11 inline-flex items-center gap-2 text-sm text-[var(--data)] hover:underline">{p.libraryLink}<ArrowUpRight className="size-4" aria-hidden="true" /></a>
      </div>
    </section>
  )
}
