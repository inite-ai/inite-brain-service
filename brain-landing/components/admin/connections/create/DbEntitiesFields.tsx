'use client'

import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Field, inputCls } from '../../policies/ui'
import type { SourceAgent } from '../../../../lib/contracts/admin-source-connections'
import { PROXY, fill, type ConnectionsT } from '../shared'
import { EMPTY_DB_ENTITY, dbDraftsOf, type DbEntityDraft, type FieldError, type FormValues } from './specs'

/**
 * The `db` source's own fields (W4.4): the database by the name the
 * agent knows it as — the names the agent reported at its last check-in
 * are offered, any other can be typed — and one row per table or view:
 * the record type it becomes, its key / name / change columns, the
 * columns to read and the foreign keys read as relations. No connection
 * string is ever asked for: it lives on the agent.
 */
export function DbEntitiesFields({
  values,
  errors,
  agentId,
  t,
  onChange,
}: {
  values: FormValues
  errors: Record<string, FieldError>
  agentId: string
  t: ConnectionsT
  onChange: (key: string, value: string) => void
}) {
  const f = t.form.fields.db
  const drafts = dbDraftsOf(String(values['entities'] ?? ''))
  // What the named agent reported, keyed by the agent it was read for: another agent id = not known yet.
  const [reported, setReported] = useState<{ agentId: string; names: string[] } | null>(null)
  const known = agentId && reported?.agentId === agentId ? reported.names : null

  useEffect(() => {
    if (!agentId) return
    let alive = true
    void (async () => {
      let names: string[] = []
      try {
        const res = await fetch(`${PROXY}/agents`, { cache: 'no-store' })
        const json = (await res.json()) as { agents?: SourceAgent[] }
        names = json.agents?.find((a) => a.agentId === agentId)?.databases ?? []
      } catch {
        names = []
      }
      if (alive) setReported({ agentId, names })
    })()
    return () => {
      alive = false
    }
  }, [agentId])

  const setDrafts = (next: DbEntityDraft[]) => onChange('entities', JSON.stringify(next))
  const setDraft = (i: number, patch: Partial<DbEntityDraft>) =>
    setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)))

  const database = String(values['database'] ?? '')
  return (
    <div className="space-y-3">
      <Field label={`${f.database.label} *`} hint={f.database.hint} error={!!errors['database']}>
        <input
          list="db-known-databases"
          value={database}
          onChange={(e) => onChange('database', e.target.value)}
          placeholder="crm"
          className={`${inputCls} font-mono`}
        />
        {known && known.length > 0 && (
          <datalist id="db-known-databases">
            {known.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        )}
        {known && (
          <p className="mt-1 text-[10px] text-[var(--text-faint)]">
            {known.length > 0 ? fill(f.databaseKnown, { names: known.join(', ') }) : f.databaseNone}
          </p>
        )}
        {errors['database'] && <p className="mt-1 text-[11px] text-[var(--danger)]">{t.form.errors.required}</p>}
      </Field>

      <Field label={`${f.entities.label} *`} hint={f.entities.hint} error={!!errors['entities']}>
        <div className="space-y-2">
          {drafts.map((d, i) => (
            <div key={i} className="rounded border border-[var(--border)] p-2 space-y-1.5">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-1.5">
                <Small label={f.entityType} value={d.type} placeholder="deal" onChange={(v) => setDraft(i, { type: v })} />
                <Small label={f.entityTable} value={d.table} placeholder="deals_v" onChange={(v) => setDraft(i, { table: v })} />
                <Small label={f.entityId} value={d.idColumn} placeholder="id" onChange={(v) => setDraft(i, { idColumn: v })} />
                <Small label={f.entityName} value={d.nameColumn} placeholder="name" onChange={(v) => setDraft(i, { nameColumn: v })} />
                <Small label={f.entityUpdated} value={d.updatedAtColumn} placeholder="updated_at" onChange={(v) => setDraft(i, { updatedAtColumn: v })} />
              </div>
              <Small label={f.entityColumns} value={d.columns} placeholder="stage, amount, owner_id" onChange={(v) => setDraft(i, { columns: v })} />
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">{f.entityRelations}</span>
                <textarea
                  value={d.relations}
                  onChange={(e) => setDraft(i, { relations: e.target.value })}
                  rows={2}
                  spellCheck={false}
                  placeholder="organization = company_id -> organization"
                  className={`${inputCls} font-mono text-[11px]`}
                />
                <span className="text-[10px] text-[var(--text-faint)]">{f.relationsHint}</span>
              </label>
              <button
                type="button"
                onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}
                className="inline-flex items-center gap-1 text-[10px] text-[var(--danger)]"
              >
                <Trash2 className="w-3 h-3" /> {f.removeEntity}
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setDrafts([...drafts, { ...EMPTY_DB_ENTITY }])}
            className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--accent)]"
          >
            <Plus className="w-3 h-3" /> {f.addEntity}
          </button>
          {errors['entities'] && (
            <p className="text-[11px] text-[var(--danger)]">
              {errors['entities'] === 'required' ? t.form.errors.required : t.form.errors.identifier}
            </p>
          )}
        </div>
      </Field>
    </div>
  )
}

function Small({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (v: string) => void
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={`${inputCls} font-mono text-[11px]`}
      />
    </label>
  )
}
