import Link from 'next/link'
import { ArrowRight, TerminalSquare } from 'lucide-react'
import { GraphField } from './GraphField'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

export function Hero({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section className="relative pt-20 pb-16 sm:pt-28 sm:pb-24">
      {/* ambient layers */}
      <div className="absolute inset-0 -z-10 lab-aura" aria-hidden="true" />
      <div
        className="absolute inset-0 -z-10 blueprint-grid opacity-70 [mask-image:radial-gradient(70%_60%_at_50%_0%,black,transparent)]"
        aria-hidden="true"
      />
      <GraphField className="absolute right-0 top-6 -z-10 w-[58%] max-w-3xl h-[440px] opacity-60 [mask-image:linear-gradient(to_left,black_30%,transparent)] hidden md:block" />

      <div className="grid lg:grid-cols-12 gap-10 items-center">
        {/* ── left: pitch ── */}
        <div className="lg:col-span-7">
          <div
            className="reveal inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-[var(--border-strong)] bg-[var(--bg-elevated)]/70"
            style={{ animationDelay: '0ms' }}
          >
            <span className="live-dot" />
            <span className="u-mono text-[10.5px] tracking-[0.18em] uppercase text-[var(--text-muted)]">
              {t.hero.eyebrow}
            </span>
          </div>

          <h1
            className="reveal u-display mt-6 text-[clamp(2.4rem,6vw,4.2rem)] leading-[0.98] font-bold tracking-[-0.02em] text-[var(--text)]"
            style={{ animationDelay: '80ms' }}
          >
            {t.hero.title}
          </h1>

          <p
            className="reveal mt-6 max-w-xl text-[15px] leading-relaxed text-[var(--text-muted)]"
            style={{ animationDelay: '160ms' }}
          >
            {t.hero.subtitle}
          </p>

          <div
            className="reveal mt-8 flex items-center gap-2.5 flex-wrap"
            style={{ animationDelay: '240ms' }}
          >
            <Link
              href={`/${lang}/docs/getting-started`}
              className="btn-signal h-10 px-4 inline-flex items-center gap-1.5 rounded-md text-sm"
            >
              {t.hero.ctaPrimary}
              <ArrowRight className="w-4 h-4" />
            </Link>
            <a
              href="#deploy"
              className="btn-ghost h-10 px-4 inline-flex items-center gap-1.5 rounded-md text-sm font-medium"
            >
              <TerminalSquare className="w-4 h-4" />
              {t.hero.ctaSecondary}
            </a>
          </div>

          <div
            className="reveal mt-7 flex items-center gap-x-5 gap-y-2 flex-wrap u-mono text-[11px] text-[var(--text-faint)]"
            style={{ animationDelay: '320ms' }}
          >
            <span className="text-[var(--data)]">{t.hero.trust.license}</span>
            <span aria-hidden>·</span>
            <span>{t.hero.trust.stack}</span>
            <span aria-hidden>·</span>
            <span>{t.hero.trust.eval}</span>
          </div>
        </div>

        {/* ── right: bitemporal readout panel ── */}
        <div className="lg:col-span-5">
          <div
            className="reveal lab-panel rounded-xl p-5"
            style={{ animationDelay: '280ms' }}
          >
            <div className="flex items-center justify-between">
              <span className="u-eyebrow">{t.hero.panel.title}</span>
              <span className="u-mono text-[10px] text-[var(--data)]">
                asOf=now
              </span>
            </div>

            {/* two time axes */}
            <div className="mt-5 space-y-4">
              <TimeAxis label={t.hero.panel.valid} marker={0.62} tone="signal" />
              <TimeAxis label={t.hero.panel.txn} marker={0.78} tone="data" />
            </div>

            <div className="mt-5 pt-4 border-t border-[var(--border)] u-mono text-[11px] leading-relaxed text-[var(--text-muted)]">
              {t.hero.panel.note}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** One labelled time axis with a value marker — the bitemporal motif. */
function TimeAxis({
  label,
  marker,
  tone,
}: {
  label: string
  marker: number
  tone: 'signal' | 'data'
}) {
  const color = tone === 'signal' ? 'var(--signal)' : 'var(--data)'
  return (
    <div>
      <div className="flex items-center justify-between u-mono text-[10.5px] text-[var(--text-faint)]">
        <span>{label}</span>
        <span>t →</span>
      </div>
      <div className="relative mt-1.5 h-[2px] bg-[var(--border-strong)] rounded-full">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${marker * 100}%`, background: color, opacity: 0.4 }}
        />
        <div
          className="absolute -top-[3px] w-2 h-2 rounded-full"
          style={{
            left: `calc(${marker * 100}% - 4px)`,
            background: color,
            boxShadow: `0 0 8px ${color}`,
          }}
        />
      </div>
    </div>
  )
}
