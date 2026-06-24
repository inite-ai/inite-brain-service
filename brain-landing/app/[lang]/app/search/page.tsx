'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n: end-user /app pages ship English-only for MVP (admin UI is too); queued for a dedicated i18n pass. */

import { useState } from 'react'
import { SearchForm } from '../../../../components/playground/SearchForm'
import { SynthesizeForm } from '../../../../components/playground/SynthesizeForm'

type Mode = 'search' | 'ask'

/**
 * Search & Ask — the product home. Two modes over the same memory:
 *  - Search: ranked entities + facts with scores.
 *  - Ask: a grounded answer with citations.
 *
 * Both forms expose a "trace" tab (the per-leg retrieval waterfall)
 * which is our differentiator: users can see *why* something was
 * retrieved, not just the result. Forms route through the reduced-scope
 * app BFF via the ProxyBaseProvider in the app layout.
 */
export default function SearchPage() {
  const [mode, setMode] = useState<Mode>('search')

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">Search &amp; Ask</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Query your brain in natural language. Open the{' '}
          <span className="font-mono text-[var(--text)]">trace</span> tab on any
          result to see <em>why</em> each fact was retrieved — the per-leg
          scores, fusion, and reranking behind the answer.
        </p>
      </div>

      <div className="inline-flex rounded-md border border-[var(--border)] p-0.5 text-sm">
        {(['search', 'ask'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`px-3 py-1 rounded ${
              mode === m
                ? 'bg-[var(--bg-overlay)] text-[var(--text)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            {m === 'search' ? 'Search' : 'Ask'}
          </button>
        ))}
      </div>

      {mode === 'search' ? <SearchForm /> : <SynthesizeForm />}
    </div>
  )
}
