import { Scale, Fingerprint, GitBranch, Package, FileText, Wrench, Boxes, Eraser } from 'lucide-react'
import type { ComponentType } from 'react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'

// Order mirrors locales/<lang>/common.json → features.items.
const ICONS: ComponentType<{ className?: string }>[] = [Scale, Fingerprint, GitBranch, Package, FileText, Wrench, Boxes, Eraser]

interface Props {
  lang: Lang
}

export function Features({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section className="py-16 border-t border-[var(--border)]">
      <SectionHeading title={t.features.title} subtitle={t.features.subtitle} />

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
        {t.features.items.map((f, i) => {
          const Icon = ICONS[i % ICONS.length]
          return (
            <div
              key={f.title}
              className="group border-t border-[var(--border-strong)] pt-5"
            >
              <div className="flex items-center justify-between">
                <span className="text-[var(--signal)]">
                  <Icon className="w-4 h-4" />
                </span>
                <span className="u-mono text-xs text-[var(--text-faint)]">
                  {f.tag}
                </span>
              </div>
              <h3 className="mt-4 text-lg font-semibold tracking-tight text-[var(--text)]">
                {f.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">
                {f.desc}
              </p>
            </div>
          )
        })}
      </div>
    </section>
  )
}
