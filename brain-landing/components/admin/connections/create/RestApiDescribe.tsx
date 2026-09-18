'use client'

import { useCallback, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Field, inputCls } from '../../policies/ui'
import {
  RestEntitySchema,
  type MappingAssistResponse,
  type RestEntity,
  type SourceCatalogEntry,
} from '../../../../lib/contracts/admin-source-connections'
import { PROXY, errorMessage, fill, type ConnectionsT } from '../shared'
import type { RecordsChoice } from './RecordsFields'

/**
 * "Describe the API": for the custom REST source the entities are not
 * a preset but a proposal — from an OpenAPI document (a URL the brain
 * fetches, or pasted JSON / YAML) and / or a sample list answer — that
 * the operator reads, switches on and off, edits as JSON per entity,
 * and then verifies with the preview below. Nothing is written until
 * the connection is created.
 */
export function RestApiDescribe({
  entry,
  value,
  config,
  t,
  onChange,
}: {
  entry: SourceCatalogEntry
  value: RecordsChoice
  config: Record<string, unknown>
  t: ConnectionsT
  onChange: (v: RecordsChoice) => void
}) {
  const r = t.records
  const [openapiUrl, setOpenapiUrl] = useState('')
  const [openapiText, setOpenapiText] = useState('')
  const [sampleJson, setSampleJson] = useState('')
  const [sampleType, setSampleType] = useState('')
  const [samplePath, setSamplePath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MappingAssistResponse | null>(null)
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [invalid, setInvalid] = useState<Record<string, string>>({})

  const propose = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      let sample: unknown
      if (sampleJson.trim()) {
        try {
          sample = JSON.parse(sampleJson)
        } catch {
          throw new Error(r.sampleInvalid)
        }
      }
      const res = await fetch(`${PROXY}/assist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packId: entry.packId,
          ...(openapiUrl.trim() || openapiText.trim()
            ? { openapi: { ...(openapiUrl.trim() ? { url: openapiUrl.trim() } : {}), ...(openapiText.trim() ? { text: openapiText } : {}) } }
            : {}),
          ...(sample !== undefined
            ? { samples: [{ json: sample, ...(sampleType.trim() ? { type: sampleType.trim() } : {}), ...(samplePath.trim() ? { path: samplePath.trim() } : {}) }] }
            : {}),
          ...(config['allowPrivate'] === true ? { allowPrivate: true } : {}),
          ...(value.endpoints && Object.keys(value.endpoints).length > 0 ? { endpoints: value.endpoints } : {}),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      const out = json as MappingAssistResponse
      setResult(out)
      setEditing({})
      setInvalid({})
      onChange({
        entities: out.entities.map((e) => e.type),
        mapping: out.mapping,
        endpoints: out.endpoints,
        proposal: out.entities,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [config, entry.packId, onChange, openapiText, openapiUrl, r.sampleInvalid, sampleJson, samplePath, sampleType, value.endpoints])

  const editEndpoint = (type: string, text: string) => {
    setEditing({ ...editing, [type]: text })
    try {
      const parsed = RestEntitySchema.safeParse(JSON.parse(text))
      if (!parsed.success) {
        setInvalid({ ...invalid, [type]: parsed.error.issues[0]?.message ?? 'invalid' })
        return
      }
      const next = { ...invalid }
      delete next[type]
      setInvalid(next)
      onChange({ ...value, endpoints: { ...(value.endpoints ?? {}), [type]: parsed.data as RestEntity } })
    } catch {
      setInvalid({ ...invalid, [type]: r.endpointInvalid })
    }
  }

  const canPropose = Boolean(openapiUrl.trim() || openapiText.trim() || sampleJson.trim())

  return (
    <div className="space-y-3 rounded border border-[var(--border)] p-3">
      <div className="text-xs text-[var(--text)]">{r.describe}</div>
      <p className="text-[11px] text-[var(--text-muted)]">{r.describeHint}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={r.openapiUrl} hint={r.openapiUrlHint}>
          <input
            value={openapiUrl}
            onChange={(e) => setOpenapiUrl(e.target.value)}
            placeholder="https://crm.example.com/openapi.json"
            className={`${inputCls} font-mono`}
          />
        </Field>
        <Field label={r.openapiText} hint={r.openapiTextHint}>
          <textarea
            value={openapiText}
            onChange={(e) => setOpenapiText(e.target.value)}
            rows={3}
            className={`${inputCls} font-mono text-[11px]`}
          />
        </Field>
      </div>
      <Field label={r.sample} hint={r.sampleHint}>
        <textarea
          value={sampleJson}
          onChange={(e) => setSampleJson(e.target.value)}
          rows={4}
          placeholder='{ "data": [ { "id": 1, "title": "…", "updated_at": "…" } ], "next_cursor": null }'
          className={`${inputCls} font-mono text-[11px]`}
        />
        <div className="mt-1 grid grid-cols-2 gap-2">
          <input
            value={samplePath}
            onChange={(e) => setSamplePath(e.target.value)}
            placeholder={r.samplePath}
            className={`${inputCls} font-mono text-[11px]`}
          />
          <input
            value={sampleType}
            onChange={(e) => setSampleType(e.target.value)}
            placeholder={r.sampleType}
            className={`${inputCls} font-mono text-[11px]`}
          />
        </div>
      </Field>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || !canPropose}
          onClick={() => void propose()}
          className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--accent)] disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          {busy ? r.proposing : r.propose}
        </button>
        {result && (
          <span className="text-[10px] text-[var(--text-faint)]">
            {result.refined ? r.refined : r.heuristicOnly}
          </span>
        )}
      </div>
      {error && <p className="font-mono text-[11px] text-[var(--danger)]">{error}</p>}
      {result?.warnings.map((w) => (
        <p key={w} className="text-[11px] text-[var(--warning)]">
          {w}
        </p>
      ))}
      {value.proposal && value.proposal.length > 0 && (
        <div className="space-y-2">
          {value.proposal.map((e) => {
            const endpoint = value.endpoints?.[e.type]
            const on = value.entities.includes(e.type)
            return (
              <div key={e.type} className="rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-[11px]">
                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-1 text-[var(--text)]">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        onChange({
                          ...value,
                          entities: on ? value.entities.filter((x) => x !== e.type) : [...value.entities, e.type],
                        })
                      }
                    />
                    <span className="font-mono">{e.type}</span>
                  </label>
                  <span className="rounded bg-[var(--surface)] px-1 text-[10px] text-[var(--text-faint)]">
                    {r.sourceOf[e.source]}
                  </span>
                  <span className="text-[10px] text-[var(--text-faint)]">
                    {fill(r.confidence, { pct: Math.round(e.confidence * 100) })}
                  </span>
                </div>
                {endpoint && (
                  <div className="mt-1 font-mono text-[10px] text-[var(--text-muted)]">
                    {endpoint.list.method ?? 'GET'} {endpoint.list.path}
                    {endpoint.items ? ` · ${r.rowsAt} ${endpoint.items}` : ''}
                    {endpoint.paging ? ` · ${r.pagingOf} ${endpoint.paging.style}${endpoint.paging.param ? ` (${endpoint.paging.param})` : ''}` : ''}
                    {endpoint.incremental ? ` · ${r.sinceOf} ${endpoint.incremental.param}` : ` · ${r.noSince}`}
                    {` · id ${endpoint.fields.id} · ${r.nameOf} ${endpoint.fields.name.join(' + ')}`}
                    {endpoint.fields.updatedAt ? ` · ${r.updatedOf} ${endpoint.fields.updatedAt}` : ''}
                  </div>
                )}
                <div className="mt-1 text-[10px] text-[var(--text-faint)]">{e.reason}</div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-[10px] text-[var(--accent)]">{r.editEndpoint}</summary>
                  <textarea
                    value={editing[e.type] ?? JSON.stringify(endpoint ?? {}, null, 2)}
                    onChange={(ev) => editEndpoint(e.type, ev.target.value)}
                    rows={8}
                    className={`${inputCls} mt-1 font-mono text-[10px]`}
                  />
                  {invalid[e.type] && <p className="font-mono text-[10px] text-[var(--danger)]">{invalid[e.type]}</p>}
                </details>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
