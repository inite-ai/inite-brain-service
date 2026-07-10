'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import type { SimulateActionsResponse } from '../../../lib/contracts/admin-policies'

type ActionVerdict = SimulateActionsResponse['actions'][number]

const FAMILY_LABEL: Record<string, string> = {
  mcp_read: 'MCP · read',
  mcp_write: 'MCP · write',
  mcp_community: 'Communities',
  mcp_procedural: 'Procedural',
  mcp_source: 'Sources',
  rest: 'REST endpoints',
}

const FAMILY_ORDER = [
  'mcp_read',
  'mcp_write',
  'mcp_community',
  'mcp_procedural',
  'mcp_source',
  'rest',
]

function CellIcon({ decision }: { decision: ActionVerdict['decision'] }) {
  if (decision === 'allow')
    return <CheckCircle2 className="h-3 w-3 shrink-0 text-[var(--success)]" />
  if (decision === 'deny')
    return <XCircle className="h-3 w-3 shrink-0 text-[var(--danger)]" />
  return <AlertTriangle className="h-3 w-3 shrink-0 text-[var(--warning)]" />
}

/**
 * All gateable actions as a family-grouped grid — callable, denied, or
 * would-deny at a glance. Click a cell for the deciding rule.
 */
export function ActionMatrix({ result }: { result: SimulateActionsResponse }) {
  const [selected, setSelected] = useState<ActionVerdict | null>(null)

  const families = useMemo(() => {
    const grouped = new Map<string, ActionVerdict[]>()
    for (const a of result.actions) {
      const list = grouped.get(a.family) ?? []
      list.push(a)
      grouped.set(a.family, list)
    }
    return [...grouped.entries()].sort(
      (a, b) => FAMILY_ORDER.indexOf(a[0]) - FAMILY_ORDER.indexOf(b[0]),
    )
  }, [result.actions])

  const callable = result.actions.filter((a) => a.decision === 'allow').length

  return (
    <div>
      <p className="mb-3 text-sm text-[var(--text)]">
        <span className="font-medium text-[var(--success)]">{callable}</span> of{' '}
        {result.actions.length} actions callable
      </p>
      <div className="space-y-4">
        {families.map(([family, actions]) => {
          const ok = actions.filter((a) => a.decision === 'allow').length
          return (
            <div key={family}>
              <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                {FAMILY_LABEL[family] ?? family} · {ok}/{actions.length} allowed
              </h3>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                {actions.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    onClick={() => setSelected(selected?.name === a.name ? null : a)}
                    className={`flex items-center gap-1.5 rounded border px-2 py-1.5 text-left transition-colors ${
                      selected?.name === a.name
                        ? 'border-[var(--accent)]'
                        : 'border-[var(--border)] hover:border-[var(--border-strong,var(--border))]'
                    } ${a.decision === 'deny' ? 'opacity-60' : ''}`}
                  >
                    <CellIcon decision={a.decision} />
                    <span className="truncate font-mono text-[10px] text-[var(--text)]">
                      {a.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {selected ? (
        <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
          <div className="flex items-center gap-2">
            <CellIcon decision={selected.decision} />
            <span className="font-mono text-xs font-medium text-[var(--text)]">
              {selected.name}
            </span>
            <span className="text-[10px] text-[var(--text-faint)]">
              {selected.kind}
            </span>
          </div>
          {selected.reasons.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {selected.reasons.map((r, i) => (
                <li key={i} className="font-mono text-[11px] text-[var(--text-muted)]">
                  {r.policySet} · {r.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">
              Allowed{selected.decision === 'allow' ? ' — no deny rule matched.' : ''}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}
