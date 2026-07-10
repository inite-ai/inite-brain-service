'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { useMemo } from 'react'
import { Plus, X } from 'lucide-react'
import type {
  MatchOp,
  PolicyMatchCondition,
  PolicyRegistryResponse,
} from '../../../lib/contracts/admin-policies'
import { inputCls } from './ui'

const OP_LABEL: Record<string, string> = {
  eq: '=',
  in: 'in',
  prefix: 'starts with',
  gte: '≥',
  gt: '>',
  lte: '≤',
  lt: '<',
  exists: 'exists',
  not_exists: 'not exists',
}

const META_PREFIX = 'source.meta.'

/**
 * attr → op → value rows, ANDed within one rule. Operators are
 * constrained by the attribute's type from the registry; `in` renders
 * comma-separated value chips; numeric attributes get a number input.
 */
export function AttributeMatchBuilder({
  registry,
  match,
  onChange,
}: {
  registry: PolicyRegistryResponse | null
  match: PolicyMatchCondition[]
  onChange: (match: PolicyMatchCondition[]) => void
}) {
  const attrs = registry?.attributes ?? []
  const dynamic = registry?.dynamicAttributes ?? []

  const specOf = useMemo(
    () => (attr: string) => {
      const fixed = attrs.find((a) => a.attr === attr)
      if (fixed) return fixed
      const dyn = dynamic.find((d) => attr.startsWith(d.prefix))
      if (dyn) {
        return { attr, type: dyn.type, ops: dyn.ops, description: dyn.description }
      }
      return null
    },
    [attrs, dynamic],
  )

  const update = (i: number, next: Partial<PolicyMatchCondition>) => {
    const copy = match.slice()
    copy[i] = { ...copy[i], ...next }
    onChange(copy)
  }

  const setAttr = (i: number, attr: string) => {
    const spec = specOf(attr)
    const op = (spec?.ops[0] ?? 'eq') as MatchOp
    const value =
      op === 'exists' || op === 'not_exists'
        ? undefined
        : spec?.type === 'number'
          ? 0
          : spec?.type === 'boolean'
            ? true
            : ''
    update(i, { attr, op, value })
  }

  const setOp = (i: number, op: MatchOp) => {
    const cond = match[i]
    const spec = specOf(cond.attr)
    let value: PolicyMatchCondition['value']
    if (op === 'exists' || op === 'not_exists') value = undefined
    else if (op === 'in') {
      value = Array.isArray(cond.value)
        ? cond.value
        : typeof cond.value === 'string' && cond.value
          ? [cond.value]
          : []
    } else if (spec?.type === 'number') {
      value = typeof cond.value === 'number' ? cond.value : 0
    } else if (spec?.type === 'boolean') {
      value = typeof cond.value === 'boolean' ? cond.value : true
    } else {
      value = typeof cond.value === 'string' ? cond.value : ''
    }
    update(i, { op, value })
  }

  return (
    <div className="space-y-1.5">
      {match.map((cond, i) => {
        const spec = specOf(cond.attr)
        const isMeta = cond.attr.startsWith(META_PREFIX)
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <select
              value={isMeta ? META_PREFIX : cond.attr}
              onChange={(e) => {
                const v = e.target.value
                setAttr(i, v === META_PREFIX ? `${META_PREFIX}data_class` : v)
              }}
              className={`${inputCls} !w-auto`}
            >
              {attrs.map((a) => (
                <option key={a.attr} value={a.attr} title={a.description}>
                  {a.attr}
                </option>
              ))}
              <option value={META_PREFIX}>source.meta.&lt;key&gt;</option>
            </select>
            {isMeta ? (
              <input
                value={cond.attr.slice(META_PREFIX.length)}
                onChange={(e) =>
                  update(i, { attr: `${META_PREFIX}${e.target.value.trim()}` })
                }
                placeholder="meta key"
                className={`${inputCls} !w-28 font-mono`}
              />
            ) : null}
            <select
              value={cond.op}
              onChange={(e) => setOp(i, e.target.value as MatchOp)}
              className={`${inputCls} !w-auto`}
            >
              {(spec?.ops ?? ['eq']).map((op) => (
                <option key={op} value={op}>
                  {OP_LABEL[op] ?? op}
                </option>
              ))}
            </select>
            {cond.op === 'exists' || cond.op === 'not_exists' ? null : cond.op ===
              'in' ? (
              <input
                value={Array.isArray(cond.value) ? cond.value.join(', ') : ''}
                onChange={(e) =>
                  update(i, {
                    value: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="value, value, …"
                list={spec?.values ? `values-${cond.attr}` : undefined}
                className={`${inputCls} !w-52 font-mono`}
              />
            ) : spec?.type === 'number' ? (
              <input
                type="number"
                step="0.05"
                value={typeof cond.value === 'number' ? cond.value : 0}
                onChange={(e) => update(i, { value: parseFloat(e.target.value) || 0 })}
                className={`${inputCls} !w-24 font-mono`}
              />
            ) : spec?.type === 'boolean' ? (
              <select
                value={String(cond.value ?? true)}
                onChange={(e) => update(i, { value: e.target.value === 'true' })}
                className={`${inputCls} !w-auto font-mono`}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <>
                <input
                  value={typeof cond.value === 'string' ? cond.value : ''}
                  onChange={(e) => update(i, { value: e.target.value })}
                  placeholder="value"
                  list={spec?.values ? `values-${cond.attr}` : undefined}
                  className={`${inputCls} !w-40 font-mono`}
                />
                {spec?.values ? (
                  <datalist id={`values-${cond.attr}`}>
                    {spec.values.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                ) : null}
              </>
            )}
            <button
              type="button"
              onClick={() => onChange(match.filter((_, j) => j !== i))}
              className="text-[var(--text-faint)] hover:text-[var(--danger)]"
              aria-label="Remove condition"
            >
              <X className="h-3 w-3" />
            </button>
            {i < match.length - 1 ? (
              <span className="text-[9px] font-medium uppercase text-[var(--text-faint)]">
                and
              </span>
            ) : null}
          </div>
        )
      })}
      <button
        type="button"
        onClick={() =>
          onChange([...match, { attr: 'source.vertical', op: 'eq', value: '' }])
        }
        className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)]"
      >
        <Plus className="h-3 w-3" /> condition
      </button>
      {match.length > 1 ? (
        <p className="text-[10px] text-[var(--text-faint)]">
          all conditions must match (AND)
        </p>
      ) : null}
    </div>
  )
}
