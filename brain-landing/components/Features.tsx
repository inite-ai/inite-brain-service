import { Clock, Tag, RefreshCcw, Scale, Bot, Layers } from 'lucide-react'
import type { ComponentType } from 'react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'

const ICONS: ComponentType<{ className?: string }>[] = [
  Clock,
  Tag,
  RefreshCcw,
  Scale,
  Bot,
  Layers,
]

interface Props {
  lang: Lang
}

export function Features({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section className="py-16 border-t border-[var(--border)]">
      <SectionHeading index="03" eyebrow={t.features.eyebrow} title={t.features.title} />

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {t.features.items.map((f, i) => {
          const Icon = ICONS[i % ICONS.length]
          const featured = i === 0
          return (
            <div
              key={f.title}
              className={`lab-panel group rounded-xl p-5 transition-colors hover:border-[var(--border-strong)] ${
                featured ? 'md:col-span-2 lg:col-span-1 lg:row-span-1' : ''
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="w-9 h-9 rounded-md bg-[var(--bg-overlay)] border border-[var(--border)] flex items-center justify-center text-[var(--signal)] group-hover:border-[var(--signal)]/40 transition-colors">
                  <Icon className="w-4 h-4" />
                </span>
                <span className="u-mono text-[10px] text-[var(--text-faint)]">
                  F{String(i + 1).padStart(2, '0')}
                </span>
              </div>
              <h3 className="u-display mt-4 text-[15px] font-semibold tracking-tight text-[var(--text)]">
                {f.title}
              </h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
                {f.desc}
              </p>
            </div>
          )
        })}
      </div>
    </section>
  )
}
