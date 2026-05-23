import { METRICS } from '../lib/metrics'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

export function Stats({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section className="py-12">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-[var(--text)] tracking-tight">
          {t.stats.title}
        </h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">{t.stats.subtitle}</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {METRICS.map((m) => (
          <div
            key={m.label}
            className="p-5 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]"
            title={m.hint}
          >
            <div className="text-[11px] uppercase tracking-wider text-[var(--text-faint)]">
              {m.label}
            </div>
            <div className="mt-1.5 text-2xl font-semibold tracking-tight text-[var(--text)] font-mono tabular-nums">
              {m.value}
            </div>
            <div className="mt-1 text-[11px] text-[color:var(--success)] font-mono">
              gate {m.floor}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
