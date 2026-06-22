import { METRICS } from '../lib/metrics'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

/** Parse the leading number out of a string like "0.965" or "≥ 0.6". */
function num(s: string): number {
  const m = s.match(/[\d.]+/)
  return m ? parseFloat(m[0]) : 0
}

export function Stats({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section className="py-16 border-t border-[var(--border)]">
      <SectionHeading
        index="02"
        eyebrow={t.stats.eyebrow}
        title={t.stats.title}
        subtitle={t.stats.subtitle}
      />

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {METRICS.map((m) => {
          const value = num(m.value)
          const floor = num(m.floor)
          return (
            <div
              key={m.label}
              className="lab-panel rounded-lg p-5"
              title={m.hint}
            >
              <div className="u-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--text-faint)]">
                {m.label}
              </div>
              <div className="mt-2 u-display text-3xl font-bold tracking-tight text-[var(--text)] tabular-nums">
                {m.value}
              </div>

              {/* readout bar: fill = value, tick = CI floor */}
              <div className="relative mt-3 h-1.5 rounded-full bg-[var(--border-strong)] overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{
                    width: `${Math.min(value, 1) * 100}%`,
                    background:
                      'linear-gradient(90deg, var(--data), var(--signal))',
                  }}
                />
              </div>
              <div className="relative h-3 mt-0.5">
                <span
                  className="absolute -translate-x-1/2 u-mono text-[9px] text-[var(--text-faint)] whitespace-nowrap"
                  style={{ left: `${Math.min(floor, 1) * 100}%` }}
                >
                  ▲ {m.floor}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <p className="mt-5 u-mono text-[11px] text-[var(--text-faint)]">
        {t.stats.footnote}
      </p>
    </section>
  )
}
