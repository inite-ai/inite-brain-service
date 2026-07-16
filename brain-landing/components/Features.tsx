import {
  Scale,
  Fingerprint,
  Eraser,
  ShieldCheck,
  Waypoints,
  Sparkles,
  BadgeCheck,
  Package,
  FileText,
  Wrench,
  KeyRound,
  Boxes,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'

// Order mirrors locales/<lang>/common.json → features.items.
const ICONS: ComponentType<{ className?: string }>[] = [
  Scale, // conflict resolution
  BadgeCheck, // source-aware trust
  Fingerprint, // identity resolution
  Waypoints, // multi-hop
  Sparkles, // synthesize
  Package, // domain packs + registry + marketplace
  FileText, // document pipeline + external indexers
  Wrench, // pack MCP tools
  KeyRound, // ABAC policies
  ShieldCheck, // pii fence
  Eraser, // gdpr forget
  Boxes, // per-tenant isolation
]

interface Props {
  lang: Lang
}

export function Features({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section className="py-16 border-t border-[var(--border)]">
      <SectionHeading index="04" eyebrow={t.features.eyebrow} title={t.features.title} subtitle={t.features.subtitle} />

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {t.features.items.map((f, i) => {
          const Icon = ICONS[i % ICONS.length]
          return (
            <div
              key={f.title}
              className="lab-panel group rounded-xl p-5 transition-colors hover:border-[var(--border-strong)]"
            >
              <div className="flex items-center justify-between">
                <span className="w-9 h-9 rounded-md bg-[var(--bg-overlay)] border border-[var(--border)] flex items-center justify-center text-[var(--signal)] group-hover:border-[var(--signal)]/40 transition-colors">
                  <Icon className="w-4 h-4" />
                </span>
                <span className="u-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--data)] border border-[var(--border)] rounded px-1.5 py-0.5">
                  {f.tag}
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
