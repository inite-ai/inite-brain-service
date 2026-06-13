'use client'

import { DemoFrame } from './DemoFrame'

export function OutroSlide() {
  return (
    <DemoFrame
      slideNumber="05"
      eyebrow="итог"
      title="RAG достаёт похожее. Brain знает, что знает."
      subtitle="Память — это не когда агент что-то помнит. Память — это когда система может доказать: когда, откуда, почему и имела ли право этим пользоваться."
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6 max-w-4xl">
        <div className="border border-[var(--border)] rounded-lg p-6">
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-faint)] mb-2">
            RAG
          </div>
          <ul className="space-y-2 text-base text-[var(--text-muted)]">
            <li>достаёт похожее</li>
            <li>смешивает старое и новое</li>
            <li>не объясняет источник</li>
            <li>не знает, что было удалено</li>
            <li>уверенно врёт</li>
          </ul>
        </div>
        <div className="border border-[var(--accent)]/40 bg-[var(--accent)]/5 rounded-lg p-6">
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-faint)] mb-2">
            brain
          </div>
          <ul className="space-y-2 text-base text-[var(--text)]">
            <li>знает время и источник</li>
            <li>отвечает за доступ</li>
            <li>ведёт историю</li>
            <li>отделяет retract от forget</li>
            <li>не surface’ит то, чего не должен</li>
          </ul>
        </div>
      </div>

      <div className="mt-12 text-xs font-mono tracking-[0.2em] text-[var(--text-faint)]">
        INITE · governed memory
      </div>
    </DemoFrame>
  )
}
