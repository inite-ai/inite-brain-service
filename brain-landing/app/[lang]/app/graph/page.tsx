'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n: end-user /app pages ship English-only for MVP (admin UI is too); queued for a dedicated i18n pass. */

import { GraphExplorer } from '../../../../components/admin/GraphExplorer'

/**
 * Knowledge graph — interactive force-directed explorer over the
 * caller's memory. Search to seed, click for a profile, double-click to
 * expand neighbours. Reuses the admin GraphExplorer; all its fetches go
 * through the reduced-scope app BFF via ProxyBaseProvider.
 */
export default function GraphPage() {
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">
          Knowledge graph
        </h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Search an entity to seed the graph, then expand its relationships.
          Drag the bitemporal slider to see the graph as it was at any point in
          time.
        </p>
      </div>
      <div className="h-[calc(100vh-12rem)] min-h-[28rem]">
        <GraphExplorer />
      </div>
    </div>
  )
}
