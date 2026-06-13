'use client'

import { Check, X } from 'lucide-react'

interface QueryResult {
  query: string
  asOf?: string
  rankOfExpected: number
  topEntityRef: string | null
  passed: boolean
  topHits: Array<{
    entityId: string
    canonicalName: string
    score: number
    externalRefs: Record<string, string>
  }>
}

interface Props {
  title: string
  /** Optional caption above the query — e.g. "asOf 2026-02-01 — historical view". */
  caption?: string
  result: QueryResult | null
  /** Render this when no run has happened yet. */
  placeholder?: string
  /** Optional override of what to show as the "answer" — for retract/forget
   * we want to display fact objects (plan / industry) instead of just entity. */
  highlightFactPredicate?: string
  /** Fact objects to surface beside the entity name. */
  highlightFromOutcome?: {
    factsByPredicate: Record<string, string | null>
  }
}

/**
 * Large 1-question, 1-answer card for the projector. The card has three
 * visual states: placeholder (no run), running (skeleton), result (filled).
 */
export function DemoQueryCard({ title, caption, result, placeholder }: Props) {
  if (!result) {
    return (
      <div className="border border-[var(--border)] rounded-lg p-6 md:p-8 bg-[var(--bg-elevated)]">
        <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-faint)] mb-2">
          {title}
        </div>
        {caption && (
          <div className="text-sm text-[var(--text-muted)] mb-3">{caption}</div>
        )}
        <div className="text-base md:text-lg text-[var(--text-muted)] italic">
          {placeholder ?? 'Run the scenario to see the answer.'}
        </div>
      </div>
    )
  }

  const top = result.topHits[0]
  return (
    <div
      className={`border rounded-lg p-6 md:p-8 bg-[var(--bg-elevated)] ${
        result.passed
          ? 'border-[var(--border)]'
          : 'border-[var(--danger)]/40'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-faint)]">
          {title}
        </div>
        {result.passed ? (
          <Check className="w-5 h-5 text-[var(--accent)]" />
        ) : (
          <X className="w-5 h-5 text-[var(--danger)]" />
        )}
      </div>
      {caption && (
        <div className="text-sm text-[var(--text-muted)] mb-3">{caption}</div>
      )}
      <div className="font-mono text-xs text-[var(--text-muted)] mb-2">
        “{result.query}”
        {result.asOf && (
          <span className="text-[var(--text-faint)]"> · asOf {result.asOf.slice(0, 10)}</span>
        )}
      </div>
      {top ? (
        <div className="mt-4">
          <div className="text-2xl md:text-3xl font-semibold text-[var(--text)]">
            {top.canonicalName}
          </div>
          <div className="text-xs font-mono text-[var(--text-faint)] mt-1">
            rank #{result.rankOfExpected || '∞'} · score {top.score.toFixed(3)}
          </div>
        </div>
      ) : (
        <div className="mt-4 text-xl text-[var(--text-muted)] italic">
          no result — brain returned no hits
        </div>
      )}
    </div>
  )
}
