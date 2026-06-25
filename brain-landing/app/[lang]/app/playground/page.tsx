'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n: end-user /app pages ship English-only for MVP (admin UI is too); queued for a dedicated i18n pass. */

import { useState } from 'react'
import { SearchForm } from '../../../../components/playground/SearchForm'
import { SynthesizeForm } from '../../../../components/playground/SynthesizeForm'
import { MentionForm } from '../../../../components/playground/MentionForm'

type Tab = 'search' | 'synthesize' | 'record'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'search', label: 'Search' },
  { id: 'synthesize', label: 'Synthesize' },
  { id: 'record', label: 'Record' },
]

/**
 * Playground — the developer surface. Exercise the brain API directly
 * (record a mention, search, synthesize) and inspect the raw response
 * plus the per-request trace waterfall. Every call goes through the
 * reduced-scope app BFF, so it behaves exactly like an integration on
 * a brain:read/brain:write key.
 */
export default function PlaygroundPage() {
  const [tab, setTab] = useState<Tab>('search')

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">Playground</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Test ingestion and retrieval interactively. Each response carries a{' '}
          <span className="font-mono text-[var(--text)]">raw</span> and{' '}
          <span className="font-mono text-[var(--text)]">trace</span> tab so you
          can see exactly what the API returns and why.
        </p>
      </div>

      <div className="inline-flex rounded-md border border-[var(--border)] p-0.5 text-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-1 rounded ${
              tab === t.id
                ? 'bg-[var(--bg-overlay)] text-[var(--text)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'search' && <SearchForm />}
      {tab === 'synthesize' && <SynthesizeForm />}
      {tab === 'record' && <MentionForm />}
    </div>
  )
}
