'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n: end-user /app pages ship English-only for MVP (admin UI is too); queued for a dedicated i18n pass. */

import { useState } from 'react'
import {
  EntitySearch,
  type SearchHit,
} from '../../../../components/admin/EntitySearch'
import { EntityDetailDock } from '../../../../components/EntityDetailDock'
import { AsOfSlider } from '../../../../components/admin/AsOfSlider'

/**
 * Timeline — memory over time. Pick an entity, then sweep the two
 * bitemporal axes:
 *   - valid (asOf):     "what was true in the world at this moment?"
 *   - tx (recordedAt):  "what did we know about it as of this moment?"
 *
 * The EntityPanel re-fetches against both axes and renders the full
 * bitemporal lineage. This is the surface neither mem0 nor Zep offer —
 * watching memory evolve, not just reading the latest state.
 */
export default function TimelinePage() {
  const [selected, setSelected] = useState<SearchHit | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [recordedAt, setRecordedAt] = useState<string | null>(null)

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">Timeline</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          See how an entity&apos;s facts changed over time. Pick an entity, then
          move the bitemporal sliders to travel through both world-time and
          knowledge-time.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-72 max-w-full">
          <EntitySearch onSelect={setSelected} />
        </div>
        {selected && (
          <AsOfSlider
            asOf={asOf}
            recordedAt={recordedAt}
            onChange={({ asOf: nextAsOf, recordedAt: nextTx }) => {
              setAsOf(nextAsOf)
              setRecordedAt(nextTx ?? null)
            }}
          />
        )}
      </div>

      <EntityDetailDock
        entityId={selected?.entityId ?? null}
        asOf={asOf}
        recordedAt={recordedAt}
        onClose={() => setSelected(null)}
        emptyTitle="Pick an entity to see its history."
        emptyHint="Then scrub the sliders to replay how memory changed."
      />
    </div>
  )
}
