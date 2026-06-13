'use client'

import { DemoFrame } from './DemoFrame'
import { DemoQueryCard } from './DemoQueryCard'
import { DemoRunButton } from './DemoRunButton'
import { useScenarioRun } from './useScenarioRun'

const SCENARIO_ID = 'demo.retract-correction'

export function RetractSlide() {
  const r = useScenarioRun()
  const q = r.result?.queryResults[0] ?? null

  // The "before retract" tile is a static narrative — we describe what
  // the noisy mention put in the graph BEFORE ops corrected it. The
  // "after retract" tile pulls the LIVE answer (fact object `fintech`)
  // straight from the scenario run.
  return (
    <DemoFrame
      slideNumber="02"
      eyebrow="retract"
      title="Факт был, теперь отозван."
      subtitle="Шумная экстракция пометила Acme как media. Опс исправил на fintech и отозвал старый факт. После retract в живых ответах media больше нет — но в audit он остаётся, потому что retract это исправление, а не удаление."
    >
      <div className="mb-8">
        <DemoRunButton
          loading={r.loading}
          hasResult={!!r.result}
          durationMs={r.result?.durationMs}
          passed={r.result?.passed}
          onRun={() => r.run(SCENARIO_ID)}
        />
        {r.error && (
          <div className="mt-3 text-sm text-[var(--danger)] font-mono">
            {r.error}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-[var(--border)] rounded-lg p-6 md:p-8 bg-[var(--bg-elevated)]">
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-faint)] mb-2">
            до retract
          </div>
          <div className="font-mono text-xs text-[var(--text-muted)] mb-3">
            inbox-экстракция, confidence 0.55
          </div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] mb-1">
            industry
          </div>
          <div className="text-4xl md:text-5xl font-semibold text-[var(--text-faint)] line-through leading-none mb-3">
            media
          </div>
          <div className="text-sm text-[var(--text-muted)]">
            ошибочный факт. Опс заметил, retract-ом отозвал — теперь он остаётся
            только в audit timeline.
          </div>
        </div>

        <DemoQueryCard
          title="после retract"
          caption="живой запрос — “Acme industry”"
          result={q}
          placeholder="fintech"
          highlightPredicate="industry"
        />
      </div>

      <div className="mt-6 text-xs text-[var(--text-faint)] font-mono">
        scenario: {SCENARIO_ID}
      </div>
    </DemoFrame>
  )
}
