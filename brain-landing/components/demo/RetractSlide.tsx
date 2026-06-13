'use client'

import { Check, X } from 'lucide-react'
import { DemoFrame } from './DemoFrame'
import { DemoRunButton } from './DemoRunButton'
import { useScenarioRun } from './useScenarioRun'

const SCENARIO_ID = 'demo.retract-correction'

export function RetractSlide() {
  const r = useScenarioRun()
  const mediaAbsent = r.result?.memoryAssertionResults.find(
    (a) => a.kind === 'search_object_absent',
  )
  const fintechPresent = r.result?.memoryAssertionResults.find(
    (a) => a.kind === 'search_object_present',
  )

  return (
    <DemoFrame
      slideNumber="02"
      eyebrow="retract"
      title="Факт был, теперь отозван."
      subtitle="Шумная экстракция пометила Acme как media. Опс исправил на fintech и отозвал старый факт. После retract — старое больше не влияет на ответы. Но в audit оно остаётся, потому что отзыв — это исправление, а не удаление."
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
        <AssertionTile
          eyebrow="до retract"
          claim="industry: media"
          verdict="это был ошибочный факт. Уверенность 0.55, источник — inbox-экстракция."
          fact="media"
          factDim
        />

        <AssertionTile
          eyebrow="после retract"
          claim="industry: fintech"
          verdict={
            fintechPresent && mediaAbsent
              ? `media больше не surface'ится (${mediaAbsent.passed ? 'verified' : mediaAbsent.detail}); fintech surface'ится (${fintechPresent.passed ? 'verified' : fintechPresent.detail}).`
              : 'Запустите сценарий — увидите, что media исчез из живых ответов, а fintech пришёл на замену.'
          }
          fact="fintech"
          live={!!fintechPresent}
          passed={fintechPresent?.passed && mediaAbsent?.passed}
        />
      </div>

      <div className="mt-6 text-xs text-[var(--text-faint)] font-mono">
        scenario: {SCENARIO_ID}
      </div>
    </DemoFrame>
  )
}

function AssertionTile({
  eyebrow,
  claim,
  verdict,
  fact,
  factDim,
  live,
  passed,
}: {
  eyebrow: string
  claim: string
  verdict: string
  fact: string
  factDim?: boolean
  live?: boolean
  passed?: boolean
}) {
  return (
    <div className="border border-[var(--border)] rounded-lg p-6 md:p-8 bg-[var(--bg-elevated)]">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-faint)]">
          {eyebrow}
        </div>
        {live && (
          <span>
            {passed ? (
              <Check className="w-5 h-5 text-[var(--accent)]" />
            ) : (
              <X className="w-5 h-5 text-[var(--danger)]" />
            )}
          </span>
        )}
      </div>
      <div
        className={`text-2xl md:text-3xl font-semibold mb-3 ${
          factDim
            ? 'text-[var(--text-faint)] line-through'
            : 'text-[var(--text)]'
        }`}
      >
        {fact}
      </div>
      <div className="text-sm text-[var(--text-muted)]">{verdict}</div>
    </div>
  )
}
