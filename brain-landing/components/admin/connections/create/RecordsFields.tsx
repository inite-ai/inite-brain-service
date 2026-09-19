'use client'

import { useCallback, useState } from 'react'
import { Eye, Loader2 } from 'lucide-react'
import { Field, inputCls } from '../../policies/ui'
import type {
  MappingAssistResponse,
  RecordMapping,
  RecordsPreviewResponse,
  RestEntity,
  SourceCatalogEntry,
} from '../../../../lib/contracts/admin-source-connections'
import { PROXY, errorMessage, fill, type ConnectionsT } from '../shared'

export interface RecordsChoice {
  entities: string[]
  mapping: RecordMapping
  /** The custom REST source only: the endpoints the assistant proposed (and the operator edited). */
  endpoints?: Record<string, RestEntity>
  /** The custom REST source only: the proposal rows (type, reason, confidence, the fields the rows carry). */
  proposal?: MappingAssistResponse['entities']
}

/** What the mapping table lists: the connector's static entities, or the proposal's for the custom REST source. */
export function entitiesOf(entry: SourceCatalogEntry, value: RecordsChoice): SourceCatalogEntry['records'] extends infer R ? (R extends { entities: infer E } ? E : never) : never {
  if (value.proposal) {
    return value.proposal.map((e) => ({ type: e.type, label: e.label, defaultOn: true, fields: e.fields }))
  }
  return entry.records?.entities ?? []
}

/** The connector's preset as the starting choice: its default entities, its field → fact table. */
export function initialRecords(entry: SourceCatalogEntry): RecordsChoice {
  const r = entry.records
  if (!r) return { entities: [], mapping: {} }
  const mapping: RecordMapping = {}
  for (const e of r.entities) {
    const preset = (r.preset as Record<string, { fields?: Record<string, string> } | undefined>)[e.type]
    mapping[e.type] = { fields: { ...(preset?.fields ?? {}) } }
  }
  return { entities: r.entities.filter((e) => e.defaultOn).map((e) => e.type), mapping }
}

/**
 * The records half of a CRM connection: which entity types to sync and,
 * per type, which attribute becomes which fact — the connector's preset
 * pre-filled, every predicate of the pack on offer — with a live preview
 * of what the first records would become before anything is connected.
 */
export function RecordsFields({
  entry,
  value,
  credential,
  config,
  previewable,
  t,
  onChange,
}: {
  entry: SourceCatalogEntry
  value: RecordsChoice
  credential: string | undefined
  config: Record<string, unknown>
  /** False for a source the brain cannot read itself (a database on the agent): no preview button, a note instead. */
  previewable?: boolean
  t: ConnectionsT
  onChange: (v: RecordsChoice) => void
}) {
  const r = t.records
  const spec = { ...entry.records!, entities: entitiesOf(entry, value) }
  const [preview, setPreview] = useState<RecordsPreviewResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleEntity = (type: string) =>
    onChange({
      ...value,
      entities: value.entities.includes(type) ? value.entities.filter((x) => x !== type) : [...value.entities, type],
    })
  const setField = (type: string, key: string, predicate: string) => {
    const fields = { ...(value.mapping[type]?.fields ?? {}) }
    if (predicate) fields[key] = predicate
    else delete fields[key]
    onChange({ ...value, mapping: { ...value.mapping, [type]: { ...(value.mapping[type] ?? { fields: {} }), fields } } })
  }

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${PROXY}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packId: entry.packId,
          sourceId: entry.sourceId,
          config: {
            ...config,
            connector: entry.connector,
            entities: value.entities,
            mapping: value.mapping,
            ...(value.endpoints ? { endpoints: value.endpoints } : {}),
          },
          ...(credential ? { credential } : {}),
          limit: 3,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setPreview(json as RecordsPreviewResponse)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [config, credential, entry, value])

  return (
    <div className="space-y-3">
      {!value.proposal && (
      <Field label={r.entities} hint={r.entitiesHint}>
        <div className="flex flex-wrap gap-3 text-xs">
          {spec.entities.map((e) => (
            <label key={e.type} className="inline-flex items-center gap-1">
              <input type="checkbox" checked={value.entities.includes(e.type)} onChange={() => toggleEntity(e.type)} /> {e.label}
            </label>
          ))}
        </div>
      </Field>
      )}
      {spec.entities.length > 0 && (
        <Field label={r.mapping} hint={r.mappingHint}>
          <div className="space-y-2">
            {spec.entities
              .filter((e) => value.entities.includes(e.type))
              .map((e) => (
                <details key={e.type} open className="rounded border border-[var(--border)] p-2 text-xs">
                  <summary className="cursor-pointer text-[var(--text)]">{e.label}</summary>
                  <table className="mt-1 w-full text-[11px]">
                    <thead className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                      <tr>
                        <th className="text-left py-0.5">{r.field}</th>
                        <th className="text-left py-0.5">{r.predicate}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.fields.map((f) => (
                        <tr key={f.key}>
                          <td className="py-0.5 pr-3 font-mono text-[var(--text-muted)]">{f.label}</td>
                          <td className="py-0.5">
                            <select
                              value={value.mapping[e.type]?.fields[f.key] ?? ''}
                              onChange={(ev) => setField(e.type, f.key, ev.target.value)}
                              className={`${inputCls} py-0.5 text-[11px]`}
                            >
                              <option value="">{r.none}</option>
                              {spec.predicates.map((p) => (
                                <option key={p.localId} value={p.localId}>
                                  {p.label}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ))}
          </div>
        </Field>
      )}
      {previewable === false && <p className="text-[10px] text-[var(--text-faint)]">{t.form.fields.db.noPreview}</p>}
      {previewable !== false && (
      <div className="space-y-2">
        <button
          type="button"
          disabled={busy || value.entities.length === 0}
          onClick={() => void run()}
          className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--accent)] disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
          {busy ? r.previewing : r.preview}
        </button>
        <span className="ml-2 text-[10px] text-[var(--text-faint)]">{r.previewHint}</span>
        {error && <p className="font-mono text-[11px] text-[var(--danger)]">{error}</p>}
        {preview &&
          preview.entities.map((e) => (
            <div key={e.type} className="rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-[11px]">
              <div className="mb-1 text-[var(--text)]">{e.label}</div>
              {e.error && <p className="font-mono text-[var(--danger)]">{e.error}</p>}
              {!e.error && e.records.length === 0 && <p className="italic text-[var(--text-muted)]">{r.previewEmpty}</p>}
              {e.records.map((rec) => (
                <div key={rec.record.externalId} className="mb-1 border-t border-[var(--border)] pt-1">
                  <div className="font-mono text-[var(--text)]">
                    {rec.record.name} <span className="text-[var(--text-faint)]">{`#${rec.record.externalId}`}</span>
                  </div>
                  <ul className="ml-3 list-disc">
                    {rec.facts.map((f) => (
                      <li key={f.predicate}>
                        <span className="text-[var(--text-muted)]">{f.predicate.replace(/^[a-z_]+__/, '')}</span>: {f.object}
                      </li>
                    ))}
                    {rec.relations.map((x) => (
                      <li key={`${x.kind}:${x.target}`}>
                        <span className="text-[var(--text-muted)]">{x.kind}</span> → {x.target}
                      </li>
                    ))}
                  </ul>
                  {rec.unmapped.length > 0 && (
                    <div className="text-[10px] text-[var(--text-faint)]">{fill(r.unmapped, { fields: rec.unmapped.join(', ') })}</div>
                  )}
                  {rec.dropped.length > 0 && (
                    <div className="text-[10px] text-[var(--warning)]">
                      {fill(r.dropped, { items: rec.dropped.map((d) => `${d.key} (${d.reason})`).join(', ') })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
      </div>
      )}
    </div>
  )
}
