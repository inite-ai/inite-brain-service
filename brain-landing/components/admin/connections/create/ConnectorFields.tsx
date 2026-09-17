'use client'

import { Field, inputCls } from '../../policies/ui'
import type { ConnectionsT } from '../shared'
import { fill } from '../shared'
import type { FieldError, FieldSpec, FormContext, FormValues } from './specs'

type FieldText = { label: string; hint: string }

/** The i18n group a connector's fields live under (`admin.connections.form.fields.<group>`). */
export function fieldGroupOf(ctx: FormContext): string {
  if (ctx.entry.kind === 'mcp') return 'mcp'
  return ctx.entry.connector
}

function textOf(t: ConnectionsT, group: string, field: FieldSpec, ctx: FormContext): FieldText {
  const groups = t.form.fields as unknown as Record<string, Record<string, FieldText>>
  const dict = groups[group] ?? {}
  // The fs root reads differently on an agent: it is that machine's path.
  if (group === 'fs' && field.key === 'root' && ctx.host === 'agent' && dict['rootAgent']) {
    return dict['rootAgent']
  }
  return dict[field.key] ?? { label: field.key, hint: '' }
}

function errorText(t: ConnectionsT, error: FieldError, field: FieldSpec, ctx: FormContext): string {
  const e = t.form.errors
  switch (error) {
    case 'number':
      return fill(e.number, { min: field.min ?? 0 })
    case 'jail':
      return fill(e.jail, { roots: ctx.fsRoots.join(', ') })
    default:
      return e[error]
  }
}

/**
 * Renders one connector's fields from its spec — text / path / url as
 * inputs, numbers as number inputs, lists as one-per-line textareas,
 * booleans as checkboxes, selects with translated option labels. The
 * spec is the source of truth; nothing here knows a connector by name
 * except the i18n lookup.
 */
export function ConnectorFields({
  fields,
  values,
  errors,
  ctx,
  t,
  onChange,
  onBrowse,
}: {
  fields: FieldSpec[]
  values: FormValues
  errors: Record<string, FieldError>
  ctx: FormContext
  t: ConnectionsT
  onChange: (key: string, value: string | boolean) => void
  /** Opens the folder picker for a `browse` field. */
  onBrowse?: ((key: string) => void) | undefined
}) {
  const group = fieldGroupOf(ctx)
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {fields.map((f) => {
        const text = textOf(t, group, f, ctx)
        const error = errors[f.key]
        const hint = error ? errorText(t, error, f, ctx) : text.hint
        const wide = f.type === 'list' || (f.type === 'url' && f.key === 'url')
        return (
          <div key={f.key} className={wide ? 'md:col-span-2' : ''}>
            <Field label={f.required ? `${text.label} *` : text.label} hint={hint} error={!!error}>
              {f.browse && onBrowse ? (
                <div className="flex gap-2">
                  <div className="flex-1">
                    <FieldInput field={f} value={values[f.key]} t={t} onChange={(v) => onChange(f.key, v)} />
                  </div>
                  <button
                    type="button"
                    onClick={() => onBrowse(f.key)}
                    className="shrink-0 rounded border border-[var(--border)] px-2 text-[11px] text-[var(--accent)]"
                  >
                    {t.picker.browse}
                  </button>
                </div>
              ) : (
                <FieldInput field={f} value={values[f.key]} t={t} onChange={(v) => onChange(f.key, v)} />
              )}
            </Field>
          </div>
        )
      })}
    </div>
  )
}

function FieldInput({
  field,
  value,
  t,
  onChange,
}: {
  field: FieldSpec
  value: string | boolean | undefined
  t: ConnectionsT
  onChange: (value: string | boolean) => void
}) {
  const mono = field.mono ? `${inputCls} font-mono` : inputCls
  switch (field.type) {
    case 'boolean':
      return (
        <span className="inline-flex items-center py-1.5">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
        </span>
      )
    case 'list':
      return (
        <textarea
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          className={mono}
        />
      )
    case 'select': {
      const options = field.options ?? []
      const labels = t.form.authOptions as unknown as Record<string, string>
      return (
        <select
          value={typeof value === 'string' ? value : options[0]}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {labels[o] ?? o}
            </option>
          ))}
        </select>
      )
    }
    case 'number':
      return (
        <input
          type="number"
          min={field.min}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className={mono}
        />
      )
    default:
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          autoComplete="off"
          spellCheck={false}
          className={mono}
        />
      )
  }
}
