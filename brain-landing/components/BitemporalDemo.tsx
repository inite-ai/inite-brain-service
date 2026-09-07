'use client'

import { useState } from 'react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

// Timeline runs Jan 1 → Jun 22 2026, measured in day-offsets.
const DAY_MAX = 172
const SWITCH_VALID = 68 // Mar 10 — Acme moves starter → growth
const RECORDED_TXN = 70 // Mar 12 — Brain learns about the switch

const MONTHS = { en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], ru: ['янв', 'фев', 'мар', 'апр', 'май', 'июн'] }
// cumulative day at the 1st of each month from Jan
const MONTH_DAY = [0, 31, 59, 90, 120, 151]

function fmt(day: number, lang: Lang): string {
  let m = 0
  while (m < MONTH_DAY.length - 1 && day >= MONTH_DAY[m + 1]) m++
  const d = day - MONTH_DAY[m] + 1
  return `${MONTHS[lang][m]} ${d}`
}

/**
 * Self-contained bitemporal demo — no API, deterministic. Two clocks:
 * valid time (when a fact is true) and transaction time (when Brain knew
 * it). Scrub the transaction clock back before Mar 12 and Brain answers
 * "starter" even for late-March validity — because that is what it
 * actually knew. History is replayed, not rewritten.
 */
export function BitemporalDemo({ lang }: Props) {
  const t = getMessages(lang)
  const d = t.bitemporal
  const [valid, setValid] = useState(DAY_MAX)
  const [txn, setTxn] = useState(DAY_MAX)

  // Knowledge state flips on the transaction clock.
  const knewSwitch = txn >= RECORDED_TXN
  const plan = !knewSwitch ? 'starter' : valid >= SWITCH_VALID ? 'growth' : 'starter'
  const isGrowth = plan === 'growth'

  // Which explanation applies right now.
  const note = !knewSwitch
    ? d.notes.unknown
    : isGrowth
      ? d.notes.current
      : d.notes.past

  return (
    <section className="py-16 border-t border-[var(--border)]">
      <SectionHeading title={d.title} subtitle={d.subtitle} />

      <div className="mt-8 lab-panel rounded-xl p-6 sm:p-8">
        <div className="grid lg:grid-cols-[1fr_280px] gap-8 items-start">
          {/* timelines */}
          <div className="space-y-7">
            <Axis
              lang={lang}
              label={d.validLabel}
              hint={fmt(valid, lang)}
              tone="signal"
              value={valid}
              onChange={setValid}
              marks={[{ at: SWITCH_VALID, label: d.markSwitch }]}
            />
            <Axis
              lang={lang}
              label={d.txnLabel}
              hint={fmt(txn, lang)}
              tone="data"
              value={txn}
              onChange={setTxn}
              marks={[{ at: RECORDED_TXN, label: d.markRecorded }]}
            />
          </div>

          {/* live answer */}
          <div className="rounded-lg border border-[var(--border-strong)] bg-[var(--bg)] p-5" aria-live="polite" aria-atomic="true">
            <div className="u-eyebrow">{d.answerLabel}</div>
            <div className="mt-3 u-mono text-[11px] text-[var(--text-faint)]">plan</div>
            <div
              className="u-display text-4xl font-bold leading-none mt-1 transition-colors"
              style={{ color: isGrowth ? 'var(--data)' : 'var(--signal)' }}
            >
              {plan}
            </div>
            <p className="mt-4 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
              {note}
            </p>
          </div>
        </div>

        <div className="mt-6 pt-5 border-t border-[var(--border)] u-mono text-[11px] text-[var(--text-faint)]">
          {d.scenario}
        </div>
      </div>
    </section>
  )
}

function Axis({
  lang,
  label,
  hint,
  tone,
  value,
  onChange,
  marks,
}: {
  lang: Lang
  label: string
  hint: string
  tone: 'signal' | 'data'
  value: number
  onChange: (v: number) => void
  marks: { at: number; label: string }[]
}) {
  const color = tone === 'signal' ? 'var(--signal)' : 'var(--data)'
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="u-mono text-[11px]" style={{ color }}>
          {label}
        </span>
        <span className="u-mono text-[12px] text-[var(--text)] tabular-nums">{hint}</span>
      </div>

      {/* month ticks */}
      <div className="relative mt-3 h-4">
        {MONTH_DAY.map((day, i) => (
          <span
            key={i}
            className="absolute -translate-x-1/2 u-mono text-[9px] text-[var(--text-faint)]"
            style={{ left: `${(day / DAY_MAX) * 100}%` }}
          >
            {MONTHS[lang][i]}
          </span>
        ))}
      </div>

      {/* event marks */}
      <div className="relative h-3">
        {marks.map((m) => (
          <span
            key={m.at}
            className="absolute -translate-x-1/2 flex flex-col items-center"
            style={{ left: `${(m.at / DAY_MAX) * 100}%` }}
          >
            <span className="u-mono text-[8.5px] whitespace-nowrap" style={{ color }}>
              {m.label}
            </span>
          </span>
        ))}
      </div>

      <input
        type="range"
        min={0}
        max={DAY_MAX}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={hint}
        className="w-full mt-1 bt-range"
        style={{ color }}
      />
    </div>
  )
}
