import { Search, Sparkles } from 'lucide-react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

/** A compact explanation of the configurable retrieval and synthesis path. */
export function RetrievalPipeline({ lang }: Props) {
  const t = getMessages(lang)
  const r = t.retrieval
  const stages = r.stages
  return (
    <section className="py-16 border-t border-[var(--border)]">
      <SectionHeading title={r.title} subtitle={r.subtitle} />

      <div className="mt-8 lab-panel rounded-xl p-6 sm:p-8">
        {/* query in */}
        <div className="flex items-center gap-2 u-mono text-[12px] text-[var(--data)]">
          <Search className="w-4 h-4" />
          {r.queryIn}
        </div>

        <ol className="mt-4 space-y-px">
          {stages.map((s, i) => {
            return (
              <li
                key={i}
                className="relative grid grid-cols-[1.5rem_1fr] md:grid-cols-[1.5rem_210px_1fr] gap-x-4 items-center py-2.5 border-l border-[var(--border-strong)] pl-4 ml-3"
              >
                <span className="absolute -left-[7px] w-3 h-3 rounded-full bg-[var(--bg)] border border-[var(--signal)]" />
                <span className="u-mono text-[10px] text-[var(--signal)]">
                  S{String(i + 1).padStart(2, '0')}
                </span>
                <span className="text-base font-medium text-[var(--text)]">{s.name}</span>
                <span className="col-start-2 md:col-start-auto text-sm mt-2 md:mt-0 text-[var(--text-muted)] leading-snug">
                  {s.desc}
                </span>

              </li>
            )
          })}
        </ol>

        {/* answer out */}
        <div className="mt-4 flex items-center gap-2 u-mono text-[12px] text-[var(--signal)]">
          <Sparkles className="w-4 h-4" />
          {r.answerOut}
        </div>

        <div className="mt-6 pt-5 border-t border-[var(--border)] u-mono text-[11px] text-[var(--text-faint)]">
          {r.note}
        </div>
      </div>
    </section>
  )
}
