'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n: end-user /app pages ship English-only for MVP (admin UI is too); queued for a dedicated i18n pass. */

import { useCallback, useState } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import {
  EntitySearch,
  type SearchHit,
} from '../../../../components/admin/EntitySearch'
import { useProxyBase } from '../../../../components/playground/usePlaygroundCall'

interface Fact {
  factId: string
  predicate: string
  object: string | null
  status?: string
  confidence?: number
  validFrom?: string
}

interface Profile {
  entityId: string
  canonicalName?: string
  facts: Fact[]
}

/**
 * Conflicts — surface competing facts and let the user resolve them by
 * retracting the wrong one. Brain's conflict resolver marks rival facts
 * `competing` when their scores are within margin; this page groups an
 * entity's facts by predicate and flags predicates that carry more than
 * one live value. Retraction calls POST /v1/facts/:id/retract (audited,
 * brain:write).
 */
export default function ReviewPage() {
  const proxyBase = useProxyBase()
  const [selected, setSelected] = useState<SearchHit | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(
    async (entityId: string) => {
      setLoading(true)
      setErr(null)
      try {
        const res = await fetch(
          `${proxyBase}/v1/entities/${encodeURIComponent(entityId)}`,
        )
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error ?? `Failed (${res.status})`)
        setProfile(data as Profile)
      } catch (e) {
        setErr((e as Error).message)
        setProfile(null)
      } finally {
        setLoading(false)
      }
    },
    [proxyBase],
  )

  const onSelect = useCallback(
    (hit: SearchHit) => {
      setSelected(hit)
      void load(hit.entityId)
    },
    [load],
  )

  const retract = useCallback(
    async (factId: string) => {
      setBusy(factId)
      setErr(null)
      try {
        const res = await fetch(
          `${proxyBase}/v1/facts/${encodeURIComponent(factId)}/retract`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'manual conflict resolution' }),
          },
        )
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.error ?? `Retract failed (${res.status})`)
        if (selected) await load(selected.entityId)
      } catch (e) {
        setErr((e as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [proxyBase, selected, load],
  )

  // Group live facts by predicate; a predicate with >1 entry is a conflict.
  const groups = groupConflicts(profile?.facts ?? [])

  return (
    <div className="max-w-3xl space-y-3">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">Conflicts</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          When memory holds two competing values for the same attribute, pick
          the right one — retract the other. Retractions are audited and
          reversible in history.
        </p>
      </div>

      <div className="max-w-md">
        <EntitySearch onSelect={onSelect} />
      </div>

      {err && (
        <div className="text-xs text-[var(--danger)] font-mono">{err}</div>
      )}
      {loading && (
        <div className="text-sm text-[var(--text-muted)]">Loading…</div>
      )}

      {profile && !loading && (
        <div className="space-y-3">
          {groups.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-[var(--success)]">
              <Check className="w-4 h-4" />
              No competing facts for{' '}
              <span className="font-medium">
                {profile.canonicalName ?? profile.entityId}
              </span>
              .
            </div>
          ) : (
            groups.map((g) => (
              <div
                key={g.predicate}
                className="border border-[var(--warning)]/40 rounded-md p-3"
              >
                <div className="flex items-center gap-1.5 text-xs text-[var(--warning)] mb-2">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span className="font-mono">{g.predicate}</span>
                  <span className="text-[var(--text-faint)]">
                    · {g.facts.length} competing values
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {g.facts.map((f) => (
                    <li
                      key={f.factId}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span className="flex-1 text-[var(--text)] truncate">
                        {f.object ?? (
                          <em className="text-[var(--text-faint)]">[gated]</em>
                        )}
                      </span>
                      {f.confidence !== undefined && (
                        <span className="text-[10px] font-mono text-[var(--text-faint)]">
                          {f.confidence.toFixed(2)}
                        </span>
                      )}
                      <button
                        type="button"
                        disabled={busy === f.factId}
                        onClick={() => retract(f.factId)}
                        className="px-2 py-1 rounded border border-[var(--border)] text-xs text-[var(--text-muted)] hover:text-[var(--danger)] hover:border-[var(--danger)] disabled:opacity-50"
                      >
                        {busy === f.factId ? 'Retracting…' : 'Retract'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

const LIVE_STATUSES = new Set(['active', 'competing'])

function groupConflicts(
  facts: Fact[],
): Array<{ predicate: string; facts: Fact[] }> {
  const byPred = new Map<string, Fact[]>()
  for (const f of facts) {
    if (f.status && !LIVE_STATUSES.has(f.status)) continue
    const arr = byPred.get(f.predicate) ?? []
    arr.push(f)
    byPred.set(f.predicate, arr)
  }
  return [...byPred.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([predicate, arr]) => ({ predicate, facts: arr }))
}
