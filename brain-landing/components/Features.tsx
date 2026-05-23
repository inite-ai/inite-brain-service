import { Clock, Tag, RefreshCcw, Scale, Bot, Layers } from 'lucide-react'
import type { ComponentType } from 'react'
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
    <section className="py-12 border-t border-[var(--border)]">
      <h2 className="text-lg font-semibold text-[var(--text)] tracking-tight">
        {t.features.title}
      </h2>
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {t.features.items.map((f, i) => {
          const Icon = ICONS[i % ICONS.length]
          return (
            <div
              key={f.title}
              className="p-5 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)] transition-colors"
            >
              <div className="w-8 h-8 rounded-md bg-[var(--bg-overlay)] border border-[var(--border)] flex items-center justify-center text-[var(--accent)] mb-3">
                <Icon className="w-4 h-4" />
              </div>
              <h3 className="text-sm font-semibold text-[var(--text)] tracking-tight">
                {f.title}
              </h3>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
                {f.desc}
              </p>
            </div>
          )
        })}
      </div>
    </section>
  )
}
