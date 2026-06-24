'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n: end-user /app pages ship English-only for MVP (admin UI is too); queued for a dedicated i18n pass. */

import { useCallback, useEffect, useState } from 'react'
import { Users, Search } from 'lucide-react'
import { useProxyBase } from '../../../../components/playground/usePlaygroundCall'

interface Community {
  communityId: string
  label: string
  summary: string
  memberCount: number
  builtAt: string
  similarity?: number
}

/**
 * Communities — clusters of densely-connected entities the brain builds
 * off-hours. Lists the largest clusters and supports semantic search
 * over their summaries. Backed by GET /v1/communities and
 * /v1/communities/search through the reduced-scope app BFF.
 */
export default function CommunitiesPage() {
  const proxyBase = useProxyBase()
  const [items, setItems] = useState<Community[]>([])
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch(`${proxyBase}/v1/communities?limit=50`)
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `Failed (${res.status})`)
      setItems((data?.communities ?? []) as Community[])
      setSearching(false)
    } catch (e) {
      setErr((e as Error).message)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [proxyBase])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        void loadList()
        return
      }
      setLoading(true)
      setErr(null)
      try {
        const res = await fetch(
          `${proxyBase}/v1/communities/search?query=${encodeURIComponent(q)}&limit=10`,
        )
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error ?? `Failed (${res.status})`)
        setItems((data?.communities ?? []) as Community[])
        setSearching(true)
      } catch (e) {
        setErr((e as Error).message)
        setItems([])
      } finally {
        setLoading(false)
      }
    },
    [proxyBase, loadList],
  )

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">Communities</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Groups of densely-connected entities your brain has clustered
          together, each with a rolled-up summary.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void runSearch(query)
        }}
        className="flex items-center gap-2"
      >
        <div className="flex items-center gap-2 px-3 h-9 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
          <Search className="w-3.5 h-3.5 text-[var(--text-faint)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search communities by topic…"
            className="bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] outline-none flex-1"
          />
        </div>
        <button
          type="submit"
          className="px-3 h-9 rounded-md bg-[var(--accent)] text-white text-sm"
        >
          Search
        </button>
        {searching && (
          <button
            type="button"
            onClick={() => {
              setQuery('')
              void loadList()
            }}
            className="px-3 h-9 rounded-md border border-[var(--border)] text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            Clear
          </button>
        )}
      </form>

      {err && <div className="text-xs text-[var(--danger)] font-mono">{err}</div>}
      {loading && (
        <div className="text-sm text-[var(--text-muted)]">Loading…</div>
      )}

      {!loading && items.length === 0 && !err && (
        <div className="border border-[var(--border)] rounded-md p-8 flex flex-col items-center text-center gap-2 text-[var(--text-muted)]">
          <Users className="w-6 h-6 text-[var(--text-faint)]" />
          <div className="text-sm">
            {searching
              ? 'No communities match that query.'
              : 'No communities yet.'}
          </div>
          <div className="text-xs text-[var(--text-faint)] max-w-sm">
            Communities are built off-hours once the graph has enough connected
            entities.
          </div>
        </div>
      )}

      <div className="space-y-2">
        {items.map((c) => (
          <div
            key={c.communityId}
            className="border border-[var(--border)] rounded-md p-3"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-medium text-[var(--text)] truncate">
                {c.label || 'Untitled cluster'}
              </span>
              <span className="text-[10px] font-mono text-[var(--text-faint)]">
                {c.memberCount} members
              </span>
              {c.similarity !== undefined && (
                <span className="ml-auto text-xs font-mono text-[var(--accent)]">
                  {c.similarity.toFixed(3)}
                </span>
              )}
            </div>
            {c.summary && (
              <p className="mt-1 text-sm text-[var(--text-muted)]">{c.summary}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
