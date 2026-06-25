'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n: end-user /app pages ship English-only for MVP (admin UI is too); queued for a dedicated i18n pass. */

import { useState } from 'react'
import {
  EntitySearch,
  type SearchHit,
} from '../../../../components/admin/EntitySearch'
import { EntityDetailDock } from '../../../../components/EntityDetailDock'

/**
 * Entities — find an entity and inspect its full profile: active facts,
 * external refs, and bitemporal lineage. The detail view reuses the
 * admin EntityPanel (rendered as a docked side panel). All fetches go
 * through the reduced-scope app BFF.
 */
export default function EntitiesPage() {
  const [selected, setSelected] = useState<SearchHit | null>(null)

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">Entities</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Search people, places, projects and topics in your memory. Open one
          to see its current facts and full bitemporal history.
        </p>
      </div>

      <div className="max-w-md">
        <EntitySearch onSelect={setSelected} />
      </div>

      <EntityDetailDock
        entityId={selected?.entityId ?? null}
        onClose={() => setSelected(null)}
        emptyTitle="Search above to pick an entity."
        emptyHint="Its profile and timeline will appear here."
      />
    </div>
  )
}
