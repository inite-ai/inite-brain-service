'use client'

import { DemoFrame } from './DemoFrame'

export function IntroSlide() {
  return (
    <DemoFrame
      slideNumber="00"
      eyebrow="brain · live demo"
      title="Память, которая не врёт."
      subtitle="Четыре сценария за пять минут. Каждый прогоняется прямо сейчас на боевом backend’е — никаких заглушек, никаких записанных видео."
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4 max-w-3xl">
        <IntroItem
          n="01"
          title="bitemporal"
          desc="«как было в феврале» — заморозить историческую правду одним asOf-параметром"
        />
        <IntroItem
          n="02"
          title="retract"
          desc="отозвать ошибочный факт. Audit видит, ответы — нет"
        />
        <IntroItem
          n="03"
          title="forget"
          desc="GDPR Article 17. Каскадное удаление по одному субъекту"
        />
        <IntroItem
          n="04"
          title="scopes"
          desc="один запрос, два ответа — по правам вызывающего"
        />
      </div>

      <div className="mt-12 text-sm text-[var(--text-muted)] max-w-2xl">
        Навигация — стрелки <kbd className="font-mono">←</kbd>{' '}
        <kbd className="font-mono">→</kbd> или пробел. Каждый слайд запускает
        свой сценарий по кнопке «run live». После прогона ephemeral-тенант
        дропается автоматически.
      </div>
    </DemoFrame>
  )
}

function IntroItem({
  n,
  title,
  desc,
}: {
  n: string
  title: string
  desc: string
}) {
  return (
    <div className="border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-baseline gap-3 mb-1">
        <span className="font-mono text-xs text-[var(--text-faint)]">{n}</span>
        <span className="font-medium text-[var(--text)]">{title}</span>
      </div>
      <div className="text-sm text-[var(--text-muted)]">{desc}</div>
    </div>
  )
}
