'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { useState } from 'react'
import { Columns2, Rows3 } from 'lucide-react'
import type { SimulateSearchResponse } from '../../../lib/contracts/admin-policies'
import { DECISION_TONE } from './PolicyBadges'
import { Segmented } from './ui'

type Row = SimulateSearchResponse['rows'][number]

function Redaction() {
  return (
    <span className="select-none font-mono tracking-tighter text-[var(--text-faint)]">
      ▮▮▮▮▮▮▮▮▮▮
    </span>
  )
}

function ReasonChips({ row }: { row: Row }) {
  if (row.decision === 'allow' || row.reasons.length === 0) return null
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {row.reasons.map((r, i) => (
        <span
          key={i}
          title={r.detail}
          className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[9px] ${DECISION_TONE[row.decision]}`}
        >
          {row.decision === 'would_deny' ? 'would deny' : 'denied'} · {r.policySet}
          {r.ruleId ? ` · ${r.ruleId}` : ' · posture'}
        </span>
      ))}
    </span>
  )
}

function FactLine({ row, redactDenied }: { row: Row; redactDenied: boolean }) {
  const blocked = row.decision !== 'allow'
  return (
    <div
      className={`rounded border border-[var(--border)] px-2.5 py-1.5 ${
        blocked
          ? `border-l-2 ${
              row.decision === 'deny'
                ? 'border-l-[var(--danger)] bg-[var(--danger)]/5'
                : 'border-l-[var(--warning)] bg-[var(--warning)]/5'
            } opacity-70`
          : ''
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-mono text-[var(--text-muted)]">{row.canonicalName}</span>
        <span className="font-mono text-[10px] text-[var(--text-faint)]">
          {row.predicate}
        </span>
        <span className="text-[var(--text)]">
          {blocked && redactDenied ? <Redaction /> : row.object}
        </span>
        <span className="ml-auto font-mono text-[9px] text-[var(--text-faint)]">
          {row.source.vertical ?? '—'}
          {row.source.meta?.data_class ? ` · ${String(row.source.meta.data_class)}` : ''}
          {' · '}
          {row.confidence.toFixed(2)}
        </span>
      </div>
      <ReasonChips row={row} />
    </div>
  )
}

/**
 * The data lens: unified view by default (denied rows greyed inline
 * with the rule chip that fired), Split toggle renders the same payload
 * as "full tenant view" vs "what the key sees" — zero extra fetches.
 */
export function LensResults({ result }: { result: SimulateSearchResponse }) {
  const [view, setView] = useState<'unified' | 'split'>('unified')
  const { summary, rows } = result
  const pct =
    summary.total > 0 ? Math.round((summary.visible / summary.total) * 100) : 100

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--text)]">
          {summary.total} facts →{' '}
          <span className="font-medium text-[var(--success)]">
            {summary.visible} visible ({pct}%)
          </span>
          {summary.denied > 0 ? (
            <span className="text-[var(--danger)]"> · {summary.denied} denied</span>
          ) : null}
          {summary.wouldDeny > 0 ? (
            <span className="text-[var(--warning)]">
              {' '}
              · {summary.wouldDeny} would deny
            </span>
          ) : null}
        </p>
        <Segmented
          value={view}
          options={[
            { value: 'unified' as const, label: 'unified' },
            { value: 'split' as const, label: 'split' },
          ]}
          onChange={setView}
        />
      </div>

      {view === 'unified' ? (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <FactLine key={row.factId} row={row} redactDenied />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
              <Rows3 className="h-3 w-3" /> Full tenant view
            </h3>
            <div className="space-y-1.5">
              {rows.map((row) => (
                <FactLine
                  key={row.factId}
                  row={{ ...row, decision: 'allow', reasons: [] }}
                  redactDenied={false}
                />
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-2 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
              <Columns2 className="h-3 w-3" /> What the subject sees
            </h3>
            <div className="space-y-1.5">
              {rows.map((row) => (
                <FactLine key={row.factId} row={row} redactDenied />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
