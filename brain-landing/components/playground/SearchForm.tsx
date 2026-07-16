'use client'

import { useState } from 'react'
import { usePlaygroundCall } from './usePlaygroundCall'
import { ResponseInspector } from './ResponseInspector'

interface SearchHit {
  entityId: string
  entityType: string
  canonicalName: string
  externalRefs?: Record<string, string>
  score: number
  facts: Array<{
    factId: string
    predicate: string
    object: string
    confidence: number
    score: number
    status: string
  }>
}

interface SearchResult {
  results: SearchHit[]
}

export function SearchForm() {
  const [query, setQuery] = useState('Sarah Kim designer')
  const [limit, setLimit] = useState(10)
  const [asOf, setAsOf] = useState('')
  const [predicates, setPredicates] = useState('')
  const call = usePlaygroundCall<SearchResult>()

  return (
    <div className="space-y-3">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          call.send('v1/search', {
            body: {
              query,
              limit,
              ...(asOf ? { asOf } : {}),
              ...(predicates
                ? {
                    predicates: predicates
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }
                : {}),
            },
          })
        }}
        className="space-y-2"
      >
        <label className="block text-xs text-[var(--text-muted)]">Query</label>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-sm text-[var(--text)]"
        />
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-xs text-[var(--text-muted)]">Limit</label>
            <input
              type="number"
              min={1}
              max={100}
              value={limit}
              // Backend caps limit at 100 (search.dto) — clamp here so a
              // free-typed value doesn't turn into an avoidable 400.
              onChange={(e) =>
                setLimit(
                  Math.min(100, Math.max(1, parseInt(e.target.value) || 10)),
                )
              }
              className="w-full border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-sm font-mono text-[var(--text)]"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)]">
              asOf (ISO)
            </label>
            <input
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              placeholder="2026-01-01T00:00:00Z"
              className="w-full border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-xs font-mono text-[var(--text)]"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)]">
              Predicates (csv)
            </label>
            <input
              value={predicates}
              onChange={(e) => setPredicates(e.target.value)}
              placeholder="works_at,role"
              className="w-full border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-xs font-mono text-[var(--text)]"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={call.loading}
          className="px-3 py-1.5 rounded-md bg-[var(--accent)] text-white text-sm disabled:opacity-50"
        >
          {call.loading ? 'Searching…' : 'POST /v1/search'}
        </button>
        {call.durationMs != null && (
          <span className="ml-3 text-xs text-[var(--text-faint)]">
            {call.durationMs}ms
          </span>
        )}
      </form>

      {call.error && (
        <div className="text-xs text-[var(--danger)] font-mono whitespace-pre-wrap">
          {call.error}
        </div>
      )}

      {call.data && (
        <ResponseInspector
          raw={call.data}
          trace={call.trace}
          pretty={
            <div className="space-y-2 text-sm">
              <div className="text-[var(--text-muted)] text-xs">
                {call.data.results?.length ?? 0} entities
              </div>
              {(call.data.results ?? []).map((hit, i) => (
                <div
                  key={hit.entityId}
                  className="border border-[var(--border)] rounded-md p-2"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-[var(--text-faint)] tabular-nums text-xs w-5">
                      #{i + 1}
                    </span>
                    <span className="font-medium text-[var(--text)] truncate">
                      {hit.canonicalName}
                    </span>
                    <span className="text-[10px] text-[var(--text-faint)] font-mono uppercase">
                      {hit.entityType}
                    </span>
                    <span className="ml-auto text-xs font-mono text-[var(--accent)]">
                      {hit.score.toFixed(3)}
                    </span>
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {hit.facts.slice(0, 5).map((f) => (
                      <li
                        key={f.factId}
                        className="text-xs flex items-baseline gap-2"
                      >
                        <span className="font-mono text-[var(--text-faint)]">
                          {f.predicate}
                        </span>
                        <span className="text-[var(--text)] truncate flex-1">
                          {f.object}
                        </span>
                        <span className="text-[10px] font-mono text-[var(--text-faint)]">
                          {f.score?.toFixed(2)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          }
        />
      )}
    </div>
  )
}
