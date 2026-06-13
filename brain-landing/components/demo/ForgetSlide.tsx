'use client'

import { Check, X } from 'lucide-react'
import { DemoFrame } from './DemoFrame'
import { DemoRunButton } from './DemoRunButton'
import { useScenarioRun } from './useScenarioRun'

const SCENARIO_ID = 'demo.forget-gdpr'

export function ForgetSlide() {
  const r = useScenarioRun()
  const marieNameAbsent = r.result?.memoryAssertionResults[0]
  const mariePlanAbsent = r.result?.memoryAssertionResults[1]
  const alexPresent = r.result?.memoryAssertionResults[2]

  return (
    <DemoFrame
      slideNumber="03"
      eyebrow="forget · GDPR Article 17"
      title="Marie запросила удаление. Alex продолжает работать."
      subtitle="Forget — это правовая операция. Каскадно удаляются факты, рёбра, эмбеддинги. Соседний клиент в том же tenant не страдает. Это не retract: тут речь о праве хранить, а не о корректности данных."
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
        <ForgetTile
          eyebrow="Marie Lefèvre — forgotten"
          probe="search «Marie Lefèvre»"
          passed={marieNameAbsent?.passed}
          live={!!marieNameAbsent}
          state="empty"
          detail={
            marieNameAbsent?.passed
              ? 'нулевой результат — субъекта нет на читающей поверхности'
              : marieNameAbsent?.detail
          }
        />
        <ForgetTile
          eyebrow="Marie's old plan — gone with her"
          probe="search «enterprise plan customer»"
          passed={mariePlanAbsent?.passed}
          live={!!mariePlanAbsent}
          state="empty"
          detail={
            mariePlanAbsent?.passed
              ? 'каскад снёс и факт plan=enterprise — он жил только на Marie'
              : mariePlanAbsent?.detail
          }
        />
        <ForgetTile
          eyebrow="Alex Hartman — untouched"
          probe="search «Alex Hartman»"
          passed={alexPresent?.passed}
          live={!!alexPresent}
          state="present"
          detail={
            alexPresent?.passed
              ? 'plan=growth по-прежнему surface’ится. Forget по-субъекту, не по-тенанту'
              : alexPresent?.detail
          }
        />
        <div className="border border-[var(--border)] rounded-lg p-6 md:p-8 bg-[var(--bg-elevated)] text-sm text-[var(--text-muted)] leading-relaxed">
          <span className="text-[var(--text)] text-base block mb-2">
            retract ≠ forget
          </span>
          retract оставляет факт виден в audit при правах. forget — правовое
          удаление, факт исчезает из читающей поверхности и остаётся только
          opaque-HMAC tombstone.
        </div>
      </div>

      <div className="mt-6 text-xs text-[var(--text-faint)] font-mono">
        scenario: {SCENARIO_ID}
      </div>
    </DemoFrame>
  )
}

function ForgetTile({
  eyebrow,
  probe,
  detail,
  passed,
  live,
  state,
}: {
  eyebrow: string
  probe: string
  detail?: string
  passed?: boolean
  live: boolean
  state: 'empty' | 'present'
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
        “{probe}”
      </div>
      <div className="text-2xl md:text-3xl font-semibold text-[var(--text)] mb-3">
        {state === 'empty' ? '∅ ничего' : 'найден'}
      </div>
      {detail && (
        <div className="text-sm text-[var(--text-muted)]">{detail}</div>
      )}
    </div>
  )
}
