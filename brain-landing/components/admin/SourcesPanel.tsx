'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { Fingerprint, Loader2, RefreshCw } from 'lucide-react'
import { ErrorLine, Field, Segmented, inputCls } from './policies/ui'
import { getMessages, normalizeLang } from '../../lib/i18n'
import {
  SOURCE_TYPES,
  type SourceDetailResponse,
  type SourceSummary,
  type SourceType,
  type TrustScopeRow,
} from '../../lib/contracts/admin-sources'

type AdminT = ReturnType<typeof getMessages>['admin']
type SourcesT = AdminT['sources']

const HISTORY_LIMIT = 20

function errorMessage(json: unknown, status: number): string {
  const j = json as { message?: unknown; error?: unknown } | null
  if (typeof j?.message === 'string') return j.message
  if (typeof j?.error === 'string') return j.error
  return `Failed ${status}`
}

function typeTone(type: SourceType): string {
  switch (type) {
    case 'human':
      return 'text-[var(--accent)] bg-[var(--accent)]/10'
    case 'agent':
      return 'text-[var(--warning)] bg-[var(--warning)]/10'
    case 'system':
      return 'text-[var(--text-faint)] bg-[var(--bg-overlay)]'
    default:
      return 'text-[var(--success)] bg-[var(--success)]/10'
  }
}

function trustCell(template: string, row: TrustScopeRow): string {
  return template
    .replace('{rate}', row.agreementRate.toFixed(2))
    .replace('{n}', String(row.sampleCount))
}

export function SourcesPanel() {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  const t = getMessages(lang).admin
  const s = t.sources

  const [sources, setSources] = useState<SourceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<SourceDetailResponse | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/sources', {
        cache: 'no-store',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setSources((json as { sources: SourceSummary[] }).sources ?? [])
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const loadDetail = useCallback(async (sourceKey: string) => {
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/admin/sources/${encodeURIComponent(sourceKey)}`,
        { cache: 'no-store' },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setDetail(json as SourceDetailResponse)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const select = useCallback(
    (sourceKey: string) => {
      setSelected(sourceKey)
      setDetail(null)
      void loadDetail(sourceKey)
    },
    [loadDetail],
  )

  const selectedSummary = useMemo(
    () => sources.find((row) => row.sourceKey === selected) ?? null,
    [selected, sources],
  )

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Fingerprint className="w-4 h-4 text-[var(--accent)]" /> {s.title}
          </h1>
          <p className="text-xs text-[var(--text-muted)]">{s.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          {t.common.refresh}
        </button>
      </header>

      <ErrorLine error={error} />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_24rem] gap-3">
        <div className="rounded-md border border-[var(--border)] overflow-hidden self-start">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2">
                  {s.table.headers.sourceKey}
                </th>
                <th className="text-left px-3 py-2">{s.table.headers.type}</th>
                <th className="text-right px-3 py-2">
                  {s.table.headers.authLevel}
                </th>
                <th className="text-right px-3 py-2">
                  {s.table.headers.globalTrust}
                </th>
                <th className="text-right px-3 py-2">
                  {s.table.headers.domains}
                </th>
              </tr>
            </thead>
            <tbody>
              {sources.map((row) => (
                <tr
                  key={row.sourceKey}
                  onClick={() => select(row.sourceKey)}
                  className={`border-t border-[var(--border)] hover:bg-[var(--bg-overlay)]/40 cursor-pointer ${
                    selected === row.sourceKey
                      ? 'bg-[var(--bg-overlay)]/60'
                      : ''
                  }`}
                >
                  <td className="px-3 py-1.5 font-mono text-[var(--text)]">
                    {row.sourceKey}
                  </td>
                  <td className="px-3 py-1.5">
                    {row.declared ? (
                      <TypeBadge type={row.declared.type} />
                    ) : (
                      <span className="text-[10px] text-[var(--text-faint)] italic">
                        {s.undeclared}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[var(--text-muted)]">
                    {row.declared ? row.declared.authLevel.toFixed(2) : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[var(--text-muted)]">
                    {row.globalTrust
                      ? trustCell(s.trustCell, row.globalTrust)
                      : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[var(--text-faint)]">
                    {row.scopedDomains}
                  </td>
                </tr>
              ))}
              {sources.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-4 text-center text-[var(--text-muted)] italic"
                  >
                    {s.table.empty}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <aside className="border border-[var(--border)] rounded-md p-3 bg-[var(--bg-elevated)] max-h-[75vh] overflow-y-auto">
          {selectedSummary && detail ? (
            <SourceDetail
              detail={detail}
              s={s}
              onDeclared={async () => {
                await Promise.all([load(), loadDetail(detail.sourceKey)])
              }}
            />
          ) : selected ? (
            <div className="text-xs text-[var(--text-muted)]">
              {t.common.loading}
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)] italic">
              {s.detail.prompt}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function TypeBadge({ type }: { type: SourceType }) {
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${typeTone(type)}`}
    >
      {type}
    </span>
  )
}

function SourceDetail({
  detail,
  s,
  onDeclared,
}: {
  detail: SourceDetailResponse
  s: SourcesT
  onDeclared: () => Promise<void>
}) {
  const d = s.detail
  const history = detail.history.slice(0, HISTORY_LIMIT)
  return (
    <div className="space-y-4 text-xs">
      <header>
        <div className="font-mono text-[var(--text)] break-all">
          {detail.sourceKey}
        </div>
        {detail.declared && (
          <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] font-mono text-[var(--text-muted)]">
            <TypeBadge type={detail.declared.type} />
            <span className="tabular-nums">
              {detail.declared.authLevel.toFixed(2)}
            </span>
            {detail.declared.owner && (
              <span>
                <span className="uppercase tracking-wider text-[var(--text-faint)]">
                  {d.ownerLabel}
                </span>{' '}
                {detail.declared.owner}
              </span>
            )}
            <span>
              <span className="uppercase tracking-wider text-[var(--text-faint)]">
                {d.updatedLabel}
              </span>{' '}
              {detail.declared.updatedAt.slice(0, 10)}
            </span>
          </div>
        )}
        {detail.declared?.note && (
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">
            {detail.declared.note}
          </p>
        )}
      </header>

      <section>
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
          {d.trustTitle}
        </div>
        {detail.trust.length > 0 ? (
          <table className="w-full text-[10px] font-mono">
            <thead className="text-[var(--text-faint)] uppercase tracking-wider">
              <tr>
                <th className="text-left px-1 py-1">{d.trustHeaders.domain}</th>
                <th className="text-right px-1 py-1">{d.trustHeaders.rate}</th>
                <th className="text-right px-1 py-1">
                  {d.trustHeaders.samples}
                </th>
                <th className="text-right px-1 py-1">{d.trustHeaders.wins}</th>
                <th className="text-right px-1 py-1">
                  {d.trustHeaders.losses}
                </th>
                <th className="text-right px-1 py-1">
                  {d.trustHeaders.lastSeen}
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.trust.map((row, i) => (
                <tr
                  key={`${row.domain ?? ''}-${i}`}
                  className="border-t border-[var(--border)]"
                >
                  <td className="px-1 py-1">
                    {row.domain ?? (
                      <span className="text-[var(--accent)]">{d.global}</span>
                    )}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums text-[var(--text)]">
                    {row.agreementRate.toFixed(2)}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums">
                    {row.sampleCount}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums text-[var(--success)]">
                    {row.winCount}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums text-[var(--danger)]">
                    {row.lossCount}
                  </td>
                  <td className="px-1 py-1 text-right text-[var(--text-faint)]">
                    {row.lastSeenAt ? row.lastSeenAt.slice(0, 10) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[10px] text-[var(--text-muted)] italic">
            {d.trustEmpty}
          </p>
        )}
      </section>

      <section>
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
          {d.historyTitle}
        </div>
        {history.length > 0 ? (
          <>
            <table className="w-full text-[10px] font-mono">
              <thead className="text-[var(--text-faint)] uppercase tracking-wider">
                <tr>
                  <th className="text-left px-1 py-1">
                    {d.historyHeaders.domain}
                  </th>
                  <th className="text-right px-1 py-1">
                    {d.historyHeaders.rate}
                  </th>
                  <th className="text-right px-1 py-1">
                    {d.historyHeaders.samples}
                  </th>
                  <th className="text-right px-1 py-1">
                    {d.historyHeaders.recorded}
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.map((row, i) => (
                  <tr
                    key={`${row.recordedAt}-${i}`}
                    className="border-t border-[var(--border)]"
                  >
                    <td className="px-1 py-1">
                      {row.domain ?? (
                        <span className="text-[var(--accent)]">{d.global}</span>
                      )}
                    </td>
                    <td className="px-1 py-1 text-right tabular-nums text-[var(--text)]">
                      {row.agreementRate.toFixed(2)}
                    </td>
                    <td className="px-1 py-1 text-right tabular-nums">
                      {row.sampleCount}
                    </td>
                    <td className="px-1 py-1 text-right text-[var(--text-faint)]">
                      {row.recordedAt.slice(0, 16).replace('T', ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.history.length > HISTORY_LIMIT && (
              <p className="mt-1 text-[10px] text-[var(--text-faint)]">
                {d.historyMore
                  .replace('{n}', String(HISTORY_LIMIT))
                  .replace('{total}', String(detail.history.length))}
              </p>
            )}
          </>
        ) : (
          <p className="text-[10px] text-[var(--text-muted)] italic">
            {d.historyEmpty}
          </p>
        )}
      </section>

      <DeclareForm
        key={detail.sourceKey}
        detail={detail}
        s={s}
        onDeclared={onDeclared}
      />
    </div>
  )
}

function DeclareForm({
  detail,
  s,
  onDeclared,
}: {
  detail: SourceDetailResponse
  s: SourcesT
  onDeclared: () => Promise<void>
}) {
  const [type, setType] = useState<SourceType>(detail.declared?.type ?? 'human')
  const [authLevel, setAuthLevel] = useState(
    detail.declared ? String(detail.declared.authLevel) : '0.5',
  )
  const [owner, setOwner] = useState(detail.declared?.owner ?? '')
  const [note, setNote] = useState(detail.declared?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsedAuth = Number(authLevel)
  const authValid =
    Number.isFinite(parsedAuth) && parsedAuth >= 0 && parsedAuth <= 1

  const save = async () => {
    if (!authValid) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/admin/sources/${encodeURIComponent(detail.sourceKey)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type,
            authLevel: parsedAuth,
            ...(owner.trim() ? { owner: owner.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          }),
        },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setSaved(true)
      await onDeclared()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="border-t border-[var(--border)] pt-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
        {s.declare.title}
      </div>
      <Field label={s.declare.typeLabel}>
        <div className="overflow-x-auto">
          <Segmented
            value={type}
            options={SOURCE_TYPES.map((v) => ({ value: v, label: v }))}
            onChange={setType}
          />
        </div>
      </Field>
      <div className="grid grid-cols-[7rem_1fr] gap-2">
        <Field label={s.declare.authLevelLabel} hint={s.declare.authLevelHint}>
          <input
            value={authLevel}
            onChange={(e) => setAuthLevel(e.target.value)}
            type="number"
            min={0}
            max={1}
            step={0.05}
            className={`${inputCls} font-mono ${
              authValid ? '' : 'border-[var(--danger)]'
            }`}
          />
        </Field>
        <Field label={s.declare.ownerLabel}>
          <input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            maxLength={256}
            className={inputCls}
          />
        </Field>
      </div>
      <Field label={s.declare.noteLabel}>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1024}
          rows={2}
          className={inputCls}
        />
      </Field>
      <ErrorLine error={error} />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saving || !authValid}
          onClick={() => void save()}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 flex items-center gap-1"
        >
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          {saving ? s.declare.saving : s.declare.save}
        </button>
        {saved && (
          <span className="text-[10px] text-[var(--success)]">
            {s.declare.saved} ✓
          </span>
        )}
      </div>
    </section>
  )
}
