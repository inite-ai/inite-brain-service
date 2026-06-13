'use client'

import { Check, ShieldAlert, X } from 'lucide-react'
import { DemoFrame } from './DemoFrame'
import { DemoRunButton } from './DemoRunButton'
import { useScenarioRun } from './useScenarioRun'

const SCENARIO_ID = 'demo.pii-gating'

export function PiiSlide() {
  const r = useScenarioRun()
  const q = r.result?.queryResults[0]

  return (
    <DemoFrame
      slideNumber="04"
      eyebrow="scopes"
      title="Один запрос. Два ответа. По правам."
      subtitle="Support-агент без PII-скоупа спрашивает email Acme. Brain возвращает сущность — потому что без неё агент слеп, — но email отрезается на сервере. Embedding-поиск так не умеет: у векторов нет scope."
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
        <PiiTile
          eyebrow="caller scope — brain:read"
          query="“Acme contact email”"
          factShown="Acme · plan=growth"
          factHidden="email = ✕ скрыт"
          verdict={
            q
              ? q.piiGatedCorrectly
                ? 'не утёк ни одной строкой. Сущность найдена, gated-факт остался на сервере.'
                : `утёк — predicate «${q.mustNotLeakPredicate}» surface’нулся вместе с сущностью.`
              : 'без сценария — это просто статичный пример. Запустите Run, чтобы увидеть живой verdict.'
          }
          live={!!q}
          passed={q?.piiGatedCorrectly === true}
        />
        <PiiTile
          eyebrow="caller scope — brain:read + brain:read_pii"
          query="“Acme contact email”"
          factShown="Acme · plan=growth · email=ceo@acme.example"
          verdict="С PII-скоупом тот же запрос отдаёт email. Право доступа — свойство запроса, а не факта."
        />
      </div>

      <div className="mt-6 text-xs text-[var(--text-faint)] font-mono">
        scenario: {SCENARIO_ID}
      </div>
    </DemoFrame>
  )
}

function PiiTile({
  eyebrow,
  query,
  factShown,
  factHidden,
  verdict,
  live,
  passed,
}: {
  eyebrow: string
  query: string
  factShown: string
  factHidden?: string
  verdict: string
  live?: boolean
  passed?: boolean
}) {
  return (
    <div className="border border-[var(--border)] rounded-lg p-6 md:p-8 bg-[var(--bg-elevated)]">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-faint)]">
          {eyebrow}
        </div>
        {live &&
          (passed ? (
            <Check className="w-5 h-5 text-[var(--accent)]" />
          ) : (
            <X className="w-5 h-5 text-[var(--danger)]" />
          ))}
      </div>
      <div className="font-mono text-xs text-[var(--text-muted)] mb-3">
        {query}
      </div>
      <div className="text-base md:text-lg font-mono text-[var(--text)] mb-1">
        {factShown}
      </div>
      {factHidden && (
        <div className="text-base md:text-lg font-mono text-[var(--text-faint)] mb-2 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-[var(--warning)]" />
          {factHidden}
        </div>
      )}
      <div className="text-sm text-[var(--text-muted)] mt-4">{verdict}</div>
    </div>
  )
}
