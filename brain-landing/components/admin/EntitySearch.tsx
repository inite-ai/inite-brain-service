'use client'

import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { useProxyBase } from '../playground/usePlaygroundCall'

export interface SearchHit {
  entityId: string
  name: string
  type: string
  score?: number
}

interface Props {
  onSelect(hit: SearchHit): void
}

/**
 * Live-typing search box. Debounced 300ms, hits /api/admin/proxy/v1/search
 * via the BFF. Picks the brain backend default scope (read-only).
 */
export function EntitySearch({ onSelect }: Props) {
  const proxyBase = useProxyBase()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!q.trim()) {
      setResults([])
      return
    }
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      setLoading(true)
      setErr(null)
      try {
        const res = await fetch(`${proxyBase}/v1/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, limit: 10 }),
          signal: ctrl.signal,
        })
        const data = await res.json()
        if (!res.ok) {
          setErr(data?.error || `Search failed (${res.status})`)
          setResults([])
        } else {
          // Brain /v1/search returns
          //   { results: [{ entityId, entityType, canonicalName, facts, score }] }
          // (flat, not wrapped under `.entity`)
          const hits: SearchHit[] = (data?.results ?? data?.hits ?? [])
            .map((h: any) => ({
              entityId: h.entityId ?? h.entity?.id,
              name:
                h.canonicalName ??
                h.entity?.canonicalName ??
                h.name ??
                h.entityId,
              type: h.entityType ?? h.entity?.type ?? 'other',
              score: h.score,
            }))
            .filter((h: SearchHit) => h.entityId)
          setResults(hits)
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setErr((e as Error).message)
        }
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => {
      ctrl.abort()
      clearTimeout(t)
    }
  }, [q, proxyBase])

  return (
    <div className="relative">
      <div className="flex items-center gap-2 px-3 h-9 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
        <Search className="w-3.5 h-3.5 text-[var(--text-faint)]" />
        <input
          type="text"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search entities…"
          className="bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] outline-none flex-1"
        />
        {loading && (
          <span className="text-[10px] text-[var(--text-faint)]">…</span>
        )}
      </div>
      {open && (results.length > 0 || err) && (
        <div className="absolute z-40 left-0 right-0 mt-1 max-h-80 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] shadow-lg">
          {err && (
            <div className="px-3 py-2 text-xs text-[var(--danger)]">{err}</div>
          )}
          {results.map((r) => (
            <button
              key={r.entityId}
              type="button"
              onClick={() => {
                onSelect(r)
                setOpen(false)
                setQ('')
                setResults([])
              }}
              className="w-full text-left px-3 py-2 hover:bg-[var(--bg-overlay)] flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="text-sm text-[var(--text)] truncate">
                  {r.name}
                </div>
                <div className="text-[10px] text-[var(--text-faint)] font-mono uppercase tracking-wider">
                  {r.type}
                </div>
              </div>
              {r.score !== undefined && (
                <span className="text-[10px] text-[var(--text-faint)] font-mono shrink-0">
                  {r.score.toFixed(2)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
