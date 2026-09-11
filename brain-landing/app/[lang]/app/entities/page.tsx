'use client'

 

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
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
 *
 * `?entity=<id>` opens straight to that entity. This is what makes a
 * memory record citable: the MCP ChatGPT facade puts this URL on every
 * result it returns, and ChatGPT builds citation metadata only when the
 * link is real. A citation that lands on an empty search box is worse
 * than no citation at all.
 */
export default function EntitiesPage() {
  return (
    // useSearchParams needs a boundary; the fallback is the same screen
    // with nothing preselected, which is the pre-deep-link behaviour.
    <Suspense fallback={<EntitiesScreen initialEntityId={null} />}>
      <EntitiesFromUrl />
    </Suspense>
  )
}

function EntitiesFromUrl() {
  const params = useSearchParams()
  return <EntitiesScreen initialEntityId={params.get('entity')} />
}

function EntitiesScreen({ initialEntityId }: { initialEntityId: string | null }) {
  const [selected, setSelected] = useState<SearchHit | null>(null)
  const [deepLinked, setDeepLinked] = useState<string | null>(initialEntityId)
  const entityId = selected?.entityId ?? deepLinked

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
        <EntitySearch
          onSelect={(hit) => {
            setDeepLinked(null)
            setSelected(hit)
          }}
        />
      </div>

      <EntityDetailDock
        entityId={entityId}
        onClose={() => {
          setSelected(null)
          setDeepLinked(null)
        }}
        emptyTitle="Search above to pick an entity."
        emptyHint="Its profile and timeline will appear here."
      />
    </div>
  )
}
