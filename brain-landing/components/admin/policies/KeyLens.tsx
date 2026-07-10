'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { KeyRound, Play, ScanEye } from 'lucide-react'
import type {
  AdminKeysResponse,
  PolicySetsListResponse,
  SimulateActionsResponse,
  SimulateSearchResponse,
} from '../../../lib/contracts/admin-policies'
import { ActionMatrix } from './ActionMatrix'
import { GraphLens } from './GraphLens'
import { LensResults } from './LensResults'
import { DRAFT_STORAGE_KEY } from './PolicySetEditor'
import { ModeBadge } from './PolicyBadges'
import { ErrorLine, Segmented, inputCls } from './ui'

type SubjectKind = 'key' | 'policySet' | 'draft'
type Tab = 'data' | 'actions' | 'graph'

/**
 * Key Lens — simulate what a key (or a saved set, or an unsaved draft
 * handed over from the editor) can see and call. The data lens runs the
 * REAL retrieval pipeline server-side and returns denied rows too; the
 * action matrix evaluates the whole action registry in one call.
 */
export function KeyLens() {
  const searchParams = useSearchParams()
  const [subjectKind, setSubjectKind] = useState<SubjectKind>('policySet')
  const [tab, setTab] = useState<Tab>('data')
  const [keys, setKeys] = useState<AdminKeysResponse['keys']>([])
  const [sets, setSets] = useState<PolicySetsListResponse['policySets']>([])
  const [keyId, setKeyId] = useState('')
  const [setNames, setSetNames] = useState<string[]>([])
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [enforceOverride, setEnforceOverride] = useState(true)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(10)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [searchResult, setSearchResult] = useState<SimulateSearchResponse | null>(null)
  const [actionsResult, setActionsResult] = useState<SimulateActionsResponse | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const [keysRes, setsRes] = await Promise.all([
          fetch('/api/admin/proxy/v1/admin/keys', { cache: 'no-store' }),
          fetch('/api/admin/proxy/v1/admin/policy-sets', { cache: 'no-store' }),
        ])
        const keysData = await keysRes.json()
        const setsData = await setsRes.json()
        if (keysRes.ok) setKeys((keysData as AdminKeysResponse).keys)
        if (setsRes.ok) {
          setSets((setsData as PolicySetsListResponse).policySets)
        }
      } catch (e) {
        setError((e as Error).message)
      }
    })()
  }, [])

  // Deep links: ?policySet=name from the list page, ?draft=1 from the editor.
  useEffect(() => {
    const preset = searchParams?.get('policySet')
    if (preset) {
      setSubjectKind('policySet')
      setSetNames([preset])
    }
    if (searchParams?.get('draft') === '1') {
      const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY)
      if (raw) {
        try {
          setDraft(JSON.parse(raw) as Record<string, unknown>)
          setSubjectKind('draft')
        } catch {
          /* stale/corrupt draft — ignore */
        }
      }
    }
  }, [searchParams])

  const subject = useMemo(() => {
    const base: Record<string, unknown> = {}
    if (subjectKind === 'key' && keyId) base.keyId = keyId
    if (subjectKind === 'policySet' && setNames.length > 0) {
      base.policyNames = setNames
    }
    if (subjectKind === 'draft' && draft) base.inline = draft
    if (enforceOverride) base.modeOverride = 'enforce'
    return base
  }, [subjectKind, keyId, setNames, draft, enforceOverride])

  const subjectReady =
    (subjectKind === 'key' && !!keyId) ||
    (subjectKind === 'policySet' && setNames.length > 0) ||
    (subjectKind === 'draft' && !!draft)

  const runActions = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/policy/simulate/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message?.message ?? data.error ?? `Failed ${res.status}`)
      }
      setActionsResult(data as SimulateActionsResponse)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [subject])

  const runSearch = useCallback(async () => {
    if (!query.trim()) return
    setBusy(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/policy/simulate/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject, query: { query, limit } }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message?.message ?? data.error ?? `Failed ${res.status}`)
      }
      setSearchResult(data as SimulateSearchResponse)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [limit, query, subject])

  // The action matrix costs one cheap call — refresh it whenever the
  // subject changes and the tab is open.
  useEffect(() => {
    if (tab === 'actions' && subjectReady) void runActions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, subject, subjectReady])

  return (
    <div className="p-6">
      <div className="mb-1 flex items-center gap-2">
        <ScanEye className="h-5 w-5 text-[var(--accent)]" />
        <h1 className="text-lg font-semibold text-[var(--text)]">Key Lens</h1>
      </div>
      <p className="mb-4 text-xs text-[var(--text-muted)]">
        Simulate what a key can see and call — against real tenant data,
        without enforcing anything.
      </p>

      <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            value={subjectKind}
            options={[
              { value: 'key' as const, label: 'Key' },
              { value: 'policySet' as const, label: 'Policy set' },
              { value: 'draft' as const, label: 'Draft' },
            ]}
            onChange={(v) => {
              setSubjectKind(v)
              setSearchResult(null)
              setActionsResult(null)
            }}
          />
          {subjectKind === 'key' ? (
            <select
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              className={`${inputCls} !w-auto font-mono`}
            >
              <option value="">select a key…</option>
              {keys.map((k) => (
                <option key={k.keyId} value={k.keyId}>
                  {k.keyId}
                  {k.name ? ` · ${k.name}` : ''}
                  {k.policySets.length > 0
                    ? ` (${k.policySets.map((s) => s.name).join(', ')})`
                    : ' (no policies)'}
                </option>
              ))}
            </select>
          ) : null}
          {subjectKind === 'policySet' ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {sets.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => {
                    setSetNames((prev) =>
                      prev.includes(s.name)
                        ? prev.filter((x) => x !== s.name)
                        : [...prev, s.name],
                    )
                  }}
                  className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[11px] ${
                    setNames.includes(s.name)
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]/50'
                  }`}
                >
                  {s.name} <ModeBadge mode={s.mode} />
                </button>
              ))}
              {sets.length === 0 ? (
                <span className="text-[11px] text-[var(--text-faint)]">
                  no policy sets yet
                </span>
              ) : null}
            </div>
          ) : null}
          {subjectKind === 'draft' ? (
            draft ? (
              <span className="rounded border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-2 py-1 font-mono text-[11px] text-[var(--warning)]">
                unsaved draft · {String((draft as { name?: string }).name ?? '?')}
              </span>
            ) : (
              <span className="text-[11px] text-[var(--text-faint)]">
                open a policy set editor and press “Try in Key Lens”
              </span>
            )
          ) : null}
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={enforceOverride}
              onChange={(e) => setEnforceOverride(e.target.checked)}
              className="h-3 w-3 accent-[var(--accent)]"
            />
            simulate as enforce
          </label>
        </div>
        {subjectKind === 'key' && keyId ? (
          <p className="mt-2 flex items-center gap-1 text-[10px] text-[var(--text-faint)]">
            <KeyRound className="h-3 w-3" /> simulating the full policy chain
            this key resolves at request time
          </p>
        ) : null}
      </div>

      <ErrorLine error={error} />

      <div className="mb-4 mt-2">
        <Segmented
          value={tab}
          options={[
            { value: 'data' as const, label: 'Data lens' },
            { value: 'actions' as const, label: 'Action matrix' },
            { value: 'graph' as const, label: 'Graph lens' },
          ]}
          onChange={setTab}
        />
      </div>

      {tab === 'data' ? (
        <div>
          <form
            className="mb-4 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void runSearch()
            }}
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search the tenant graph as this subject…"
              className={`${inputCls} max-w-md flex-1`}
            />
            <select
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value, 10))}
              className={`${inputCls} !w-auto`}
            >
              {[5, 10, 20, 50].map((n) => (
                <option key={n} value={n}>
                  top {n}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={busy || !subjectReady || !query.trim()}
              className="inline-flex items-center gap-1.5 rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              <Play className="h-3 w-3" /> {busy ? 'simulating…' : 'Simulate'}
            </button>
          </form>
          {searchResult ? (
            <LensResults result={searchResult} />
          ) : (
            <p className="text-xs text-[var(--text-faint)]">
              Pick a subject, type a query, and see the per-row verdicts —
              including what gets hidden and which rule hides it.
            </p>
          )}
        </div>
      ) : tab === 'actions' ? (
        actionsResult ? (
          <ActionMatrix result={actionsResult} />
        ) : (
          <p className="text-xs text-[var(--text-faint)]">
            {subjectReady
              ? 'evaluating…'
              : 'pick a subject to evaluate the action surface'}
          </p>
        )
      ) : searchResult ? (
        <GraphLens result={searchResult} />
      ) : (
        <p className="text-xs text-[var(--text-faint)]">
          Run a data-lens query first — the graph lens visualizes that result
          per entity.
        </p>
      )}
    </div>
  )
}
