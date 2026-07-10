'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import type { Decision, PolicySet } from '../../../lib/contracts/admin-policies'

export const MODE_TONE: Record<PolicySet['mode'], string> = {
  enforce: 'text-[var(--accent)] bg-[var(--accent)]/10',
  report_only: 'text-[var(--warning)] bg-[var(--warning)]/10',
  disabled: 'text-[var(--text-faint)] bg-[var(--bg-overlay)]',
}

export const DECISION_TONE: Record<Decision, string> = {
  allow: 'text-[var(--success)] bg-[var(--success)]/10',
  deny: 'text-[var(--danger)] bg-[var(--danger)]/10',
  would_deny: 'text-[var(--warning)] bg-[var(--warning)]/10',
}

export const DECISION_LABEL: Record<Decision, string> = {
  allow: 'allow',
  deny: 'deny',
  would_deny: 'would deny',
}

export function ModeBadge({ mode }: { mode: PolicySet['mode'] }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${MODE_TONE[mode]}`}
    >
      {mode === 'report_only' ? 'report only' : mode}
    </span>
  )
}

export function DecisionBadge({ decision }: { decision: Decision }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${DECISION_TONE[decision]}`}
    >
      {DECISION_LABEL[decision]}
    </span>
  )
}

export function EffectBadge({ effect }: { effect: 'allow' | 'deny' }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
        effect === 'allow'
          ? 'text-[var(--success)] bg-[var(--success)]/10'
          : 'text-[var(--danger)] bg-[var(--danger)]/10'
      }`}
    >
      {effect}
    </span>
  )
}

export function PostureChip({
  domain,
  posture,
}: {
  domain: 'actions' | 'reads'
  posture: 'allow' | 'deny'
}) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-[var(--text-muted)]">
      <span>{domain}:</span>
      <span
        className={
          posture === 'deny' ? 'text-[var(--success)]' : 'text-[var(--warning)]'
        }
      >
        default-{posture === 'deny' ? 'deny' : 'allow'}
      </span>
    </span>
  )
}
