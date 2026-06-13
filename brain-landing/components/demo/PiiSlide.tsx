'use client'

import { Check, ShieldAlert, X } from 'lucide-react'
import { DemoFrame } from './DemoFrame'
import { DemoRunButton } from './DemoRunButton'
import { DemoTraceStrip } from './DemoTraceStrip'
import { useScenarioRun } from './useScenarioRun'

const SCENARIO_ID = 'demo-pii-gating'

export function PiiSlide() {
  const r = useScenarioRun()
  const q = r.result?.queryResults[0]
  const top = q?.topHits[0]
  const facts = top?.facts ?? []
  const hasAddress = facts.some((f) => f.predicate === 'address')

  return (
    <DemoFrame
      slideNumber="04"
      eyebrow="scopes"
      title="Один запрос. Два ответа. По правам."
      subtitle="Acme имеет email (identifier-класс — публичный контакт) и адрес головного офиса (sensitive-класс — gated). Поиск без PII-скоупа возвращает сущность и email, но адрес отрезается. Brain знает класс PII per-predicate, а не блокирует всю сущность целиком."
    >
      <div className="mb-8">
        <DemoRunButton
          loading={r.loading}
          hasResult={!!r.result}
          durationMs={r.result?.durationMs}
          passed={r.result?.passed}
          setupErrors={r.result?.setupSummary.errors}
          queryErrors={r.result?.queryResults.map((q) => ({
            query: q.query,
            error: q.error,
          }))}
          onRun={() => r.run(SCENARIO_ID)}
        />
        {r.error && (
          <div className="mt-3 text-sm text-[var(--danger)] font-mono">
            {r.error}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div
          className={`border rounded-lg p-6 md:p-8 bg-[var(--bg-elevated)] ${
            q && q.piiGatedCorrectly === false
              ? 'border-[var(--danger)]/40'
              : 'border-[var(--border)]'
          }`}
        >
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-faint)]">
              caller scope — brain:read
            </div>
            {q &&
              (q.piiGatedCorrectly ? (
                <Check className="w-5 h-5 text-[var(--accent)]" />
              ) : (
                <X className="w-5 h-5 text-[var(--danger)]" />
              ))}
          </div>
          <div className="font-mono text-xs text-[var(--text-muted)] mb-4">
            “{q?.query ?? 'Acme office address'}”
          </div>

          {top ? (
            <ul className="space-y-2 mb-4">
              {facts.map((f) => (
                <li
                  key={f.factId}
                  className="flex items-baseline gap-3 text-base"
                >
                  <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] w-20">
                    {f.predicate}
                  </span>
                  <span className="font-mono text-[var(--text)]">
                    {f.object}
                  </span>
                </li>
              ))}
              {!hasAddress && (
                <li className="flex items-baseline gap-3 text-base">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] w-20">
                    address
                  </span>
                  <span className="font-mono text-[var(--text-faint)] flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-[var(--warning)]" />
                    ✕ скрыт сервером
                  </span>
                </li>
              )}
            </ul>
          ) : (
            <div className="text-base text-[var(--text-muted)] italic mb-4">
              запустите Run — увидите сущность Acme + email, но без адреса.
            </div>
          )}

          <div className="text-sm text-[var(--text-muted)]">
            {q
              ? q.piiGatedCorrectly
                ? 'sensitive-факт не утёк. Identifier email surface’ится как и положено, sensitive address — нет.'
                : `утёк — predicate «${q.mustNotLeakPredicate}» surface’нулся вместе с сущностью.`
              : 'право доступа — свойство запроса, а не факта. Brain знает класс PII per-predicate.'}
          </div>

          <DemoTraceStrip trace={q?.trace} />
        </div>

        <div className="border border-[var(--border)] rounded-lg p-6 md:p-8 bg-[var(--bg-elevated)]">
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-faint)] mb-2">
            caller scope — brain:read + brain:read_pii
          </div>
          <div className="font-mono text-xs text-[var(--text-muted)] mb-4">
            “Acme office address”
          </div>
          <ul className="space-y-2 mb-4">
            <li className="flex items-baseline gap-3 text-base">
              <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] w-20">
                name
              </span>
              <span className="font-mono text-[var(--text)]">Acme</span>
            </li>
            <li className="flex items-baseline gap-3 text-base">
              <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] w-20">
                email
              </span>
              <span className="font-mono text-[var(--text)]">
                hello@acme.example
              </span>
            </li>
            <li className="flex items-baseline gap-3 text-base">
              <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] w-20">
                address
              </span>
              <span className="font-mono text-[var(--text)]">
                1 Market St, San Francisco
              </span>
            </li>
          </ul>
          <div className="text-sm text-[var(--text-muted)]">
            тот же запрос с PII-скоупом отдаёт address. Право доступа живёт
            на запросе, факт в базе один и тот же.
          </div>
        </div>
      </div>

      <div className="mt-6 text-xs text-[var(--text-faint)] font-mono">
        scenario: {SCENARIO_ID}
      </div>
    </DemoFrame>
  )
}
