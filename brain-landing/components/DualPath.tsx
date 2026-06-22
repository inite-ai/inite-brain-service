import Link from 'next/link'
import { ArrowRight, Server, Cloud, Check } from 'lucide-react'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

/**
 * Two equal paths to run Brain — self-host (open source) and managed.
 * Anchored at #deploy; the hero's secondary CTA jumps here.
 */
export function DualPath({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section id="deploy" className="py-16 scroll-mt-20">
      <SectionHeading index="01" eyebrow={t.dualPath.eyebrow} title={t.dualPath.title} />

      <div className="mt-8 grid md:grid-cols-2 gap-4">
        {/* self-host */}
        <div className="lab-panel rounded-xl p-6 flex flex-col">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-md border border-[var(--data)]/40 bg-[var(--data-faint)] flex items-center justify-center text-[var(--data)]">
              <Server className="w-4 h-4" />
            </span>
            <div>
              <div className="u-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--data)]">
                {t.dualPath.selfHost.label}
              </div>
              <h3 className="u-display text-base font-semibold text-[var(--text)]">
                {t.dualPath.selfHost.title}
              </h3>
            </div>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-muted)]">
            {t.dualPath.selfHost.desc}
          </p>
          <ul className="mt-4 space-y-2">
            {t.dualPath.selfHost.bullets.map((b) => (
              <li key={b} className="flex items-start gap-2 text-[13px] text-[var(--text-muted)]">
                <Check className="w-3.5 h-3.5 mt-0.5 text-[var(--data)] shrink-0" />
                {b}
              </li>
            ))}
          </ul>
          <div className="mt-5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 u-mono text-[11.5px] text-[var(--text)] overflow-x-auto">
            <span className="text-[var(--text-faint)]">$ </span>
            {t.dualPath.selfHost.cmd}
          </div>
          <div className="mt-auto pt-5">
            <Link
              href={`/${lang}/docs/getting-started`}
              className="inline-flex items-center gap-1 text-sm text-[var(--data)] hover:underline u-mono"
            >
              {t.dualPath.selfHost.cta}
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>

        {/* managed */}
        <div className="lab-panel rounded-xl p-6 flex flex-col">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-md border border-[var(--signal)]/40 bg-[var(--signal-faint)] flex items-center justify-center text-[var(--signal)]">
              <Cloud className="w-4 h-4" />
            </span>
            <div>
              <div className="u-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--signal)]">
                {t.dualPath.managed.label}
              </div>
              <h3 className="u-display text-base font-semibold text-[var(--text)]">
                {t.dualPath.managed.title}
              </h3>
            </div>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-muted)]">
            {t.dualPath.managed.desc}
          </p>
          <ul className="mt-4 space-y-2">
            {t.dualPath.managed.bullets.map((b) => (
              <li key={b} className="flex items-start gap-2 text-[13px] text-[var(--text-muted)]">
                <Check className="w-3.5 h-3.5 mt-0.5 text-[var(--signal)] shrink-0" />
                {b}
              </li>
            ))}
          </ul>
          <div className="mt-5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 u-mono text-[11.5px] text-[var(--text-muted)]">
            {t.dualPath.managed.endpoint}
          </div>
          <div className="mt-auto pt-5">
            <a
              href="https://brain.inite.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-signal inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md text-sm"
            >
              {t.dualPath.managed.cta}
              <ArrowRight className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

/** Shared blueprint section heading — numbered eyebrow + display title. */
export function SectionHeading({
  index,
  eyebrow,
  title,
  subtitle,
}: {
  index: string
  eyebrow: string
  title: string
  subtitle?: string
}) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="u-mono text-[11px] text-[var(--signal)]">[{index}]</span>
        <span className="u-eyebrow">{eyebrow}</span>
        <span className="flex-1 lab-rule" />
      </div>
      <h2 className="u-display mt-3 text-2xl sm:text-[28px] font-semibold tracking-[-0.01em] text-[var(--text)]">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-2 text-sm text-[var(--text-muted)] max-w-2xl">{subtitle}</p>
      )}
    </div>
  )
}
