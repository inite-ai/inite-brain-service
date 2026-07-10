'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { Copy, Trash2 } from 'lucide-react'
import type {
  PolicyRegistryResponse,
  PolicyRule,
} from '../../../lib/contracts/admin-policies'
import { ActionPicker } from './ActionPicker'
import { AttributeMatchBuilder } from './AttributeMatchBuilder'
import { Segmented, inputCls } from './ui'

/**
 * One rule card. Effect tints the left border (instant visual scan of
 * the whole set); switching kind swaps the body between the action
 * picker and the attribute-match builder.
 */
export function RuleRow({
  rule,
  registry,
  onChange,
  onDuplicate,
  onDelete,
}: {
  rule: PolicyRule
  registry: PolicyRegistryResponse | null
  onChange: (rule: PolicyRule) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={`rounded-lg border border-[var(--border)] border-l-2 bg-[var(--bg-elevated)] p-3 ${
        rule.effect === 'deny'
          ? 'border-l-[var(--danger)]'
          : 'border-l-[var(--success)]'
      } ${rule.enabled ? '' : 'opacity-50'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={rule.effect}
          options={[
            { value: 'allow' as const, label: 'allow' },
            { value: 'deny' as const, label: 'deny' },
          ]}
          toneOf={(v) =>
            v === 'deny'
              ? 'bg-[var(--danger)]/15 text-[var(--danger)] font-medium'
              : 'bg-[var(--success)]/15 text-[var(--success)] font-medium'
          }
          onChange={(effect) => onChange({ ...rule, effect })}
        />
        <Segmented
          value={rule.kind}
          options={[
            { value: 'action' as const, label: 'actions' },
            { value: 'source' as const, label: 'source' },
          ]}
          onChange={(kind) =>
            onChange({
              ...rule,
              kind,
              ...(kind === 'action'
                ? { actions: rule.actions ?? [], match: undefined }
                : { match: rule.match ?? [], actions: undefined }),
            })
          }
        />
        <input
          value={rule.id}
          onChange={(e) =>
            onChange({
              ...rule,
              id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
            })
          }
          placeholder="rule-id"
          className={`${inputCls} !w-40 font-mono`}
          title="Rule id — referenced by explain traces and the decisions feed"
        />
        <div className="ml-auto flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1 text-[10px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
              className="h-3 w-3 accent-[var(--accent)]"
            />
            enabled
          </label>
          <button
            type="button"
            onClick={onDuplicate}
            className="text-[var(--text-faint)] hover:text-[var(--text)]"
            aria-label="Duplicate rule"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="text-[var(--text-faint)] hover:text-[var(--danger)]"
            aria-label="Delete rule"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2.5">
        {rule.kind === 'action' ? (
          <ActionPicker
            registry={registry}
            selected={rule.actions ?? []}
            onChange={(actions) => onChange({ ...rule, actions })}
          />
        ) : (
          <AttributeMatchBuilder
            registry={registry}
            match={rule.match ?? []}
            onChange={(match) => onChange({ ...rule, match })}
          />
        )}
      </div>
    </div>
  )
}
