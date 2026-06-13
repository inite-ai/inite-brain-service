'use client'

import { Check, X } from 'lucide-react'
import { DemoTraceStrip, TracePayload } from './DemoTraceStrip'

interface FactRow {
  factId: string
  predicate: string
  object: string
  status: string
  validFrom: string
  validUntil?: string
}

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
    facts: FactRow[]
  }>
  trace?: TracePayload
}

interface Props {
  title: string
  caption?: string
  result: QueryResult | null
  placeholder?: string
  /**
   * Predicate to render as the BIG answer. The card finds the first fact
   * with this predicate on the top hit and surfaces its object large.
   * Falls back to the first fact of any predicate if absent.
   */
  highlightPredicate?: string
}

const ISO_DAY = (iso: string) => iso.slice(0, 10)

export function DemoQueryCard({
  title,
  caption,
  result,
  placeholder,
  highlightPredicate,
}: Props) {
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
  const fact = top
    ? top.facts.find((f) => f.predicate === highlightPredicate) ??
      top.facts[0]
    : null

  return (
    <div
      className={`border rounded-lg p-6 md:p-8 bg-[var(--bg-elevated)] ${
        result.passed ? 'border-[var(--border)]' : 'border-[var(--danger)]/40'
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
      <div className="font-mono text-xs text-[var(--text-muted)] mb-3">
        “{result.query}”
        {result.asOf && (
          <span className="text-[var(--text-faint)]">
            {' '}
            · asOf {ISO_DAY(result.asOf)}
          </span>
        )}
      </div>

      {fact ? (
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] mb-1">
            {fact.predicate}
          </div>
          <div className="text-4xl md:text-5xl font-semibold text-[var(--text)] leading-none mb-2">
            {fact.object}
          </div>
          <div className="text-xs text-[var(--text-muted)] flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span>
              entity{' '}
              <span className="text-[var(--text)] font-mono">
                {top?.canonicalName}
              </span>
            </span>
            <span className="text-[var(--text-faint)]">
              valid {ISO_DAY(fact.validFrom)}
              {fact.validUntil ? ` → ${ISO_DAY(fact.validUntil)}` : ' → now'}
            </span>
            {fact.status !== 'active' && (
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-mono ${
                  fact.status === 'retracted'
                    ? 'bg-[var(--danger)]/15 text-[var(--danger)]'
                    : 'bg-[var(--bg-overlay)] text-[var(--text-muted)]'
                }`}
              >
                {fact.status}
              </span>
            )}
          </div>
        </div>
      ) : top ? (
        <div className="mt-4">
          <div className="text-2xl md:text-3xl font-semibold text-[var(--text)]">
            {top.canonicalName}
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-1 italic">
            entity surfaced but no facts came back (e.g. PII-gated predicate)
          </div>
        </div>
      ) : (
        <div className="mt-4 text-xl text-[var(--text-muted)] italic">
          ∅ no result — brain returned no hits
        </div>
      )}

      <DemoTraceStrip trace={result.trace} />
    </div>
  )
}
