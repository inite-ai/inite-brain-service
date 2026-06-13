'use client'

import { DemoFrame } from './DemoFrame'
import { DemoQueryCard } from './DemoQueryCard'
import { DemoRunButton } from './DemoRunButton'
import { useScenarioRun } from './useScenarioRun'

const SCENARIO_ID = 'demo.bitemporal-tariff'

export function BitemporalSlide() {
  const r = useScenarioRun()
  const current = r.result?.queryResults.find((q) => !q.asOf) ?? null
  const historical = r.result?.queryResults.find((q) => q.asOf) ?? null

  return (
    <DemoFrame
      slideNumber="01"
      eyebrow="bitemporal"
      title="В марте мы видим мартовскую истину."
      subtitle="Acme переехала с тарифа starter на growth 10 марта. Один и тот же запрос про тариф возвращает growth сейчас и starter, если спросить «как было в феврале»."
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
        <DemoQueryCard
          title="как сейчас"
          caption="дефолтный поиск — без asOf"
          result={current}
          placeholder="growth"
        />
        <DemoQueryCard
          title="как было в феврале"
          caption="asOf 2026-02-01 — историческая правда заморожена"
          result={historical}
          placeholder="starter"
        />
      </div>

      <div className="mt-6 text-xs text-[var(--text-faint)] font-mono">
        scenario: {SCENARIO_ID}
      </div>
    </DemoFrame>
  )
}
