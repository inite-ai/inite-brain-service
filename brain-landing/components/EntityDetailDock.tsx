'use client'

import { EntityPanel } from './admin/EntityPanel'

/**
 * Docked entity-detail surface shared by the Entities and Timeline
 * pages: a bordered relative container that either shows the EntityPanel
 * for the selected entity or an empty-state placeholder. The Timeline
 * page additionally passes the bitemporal axes (asOf/recordedAt).
 */
export function EntityDetailDock({
  entityId,
  asOf,
  recordedAt,
  onClose,
  emptyTitle,
  emptyHint,
}: {
  entityId: string | null
  asOf?: string | null
  recordedAt?: string | null
  onClose(): void
  emptyTitle: string
  emptyHint: string
}) {
  return (
    <div className="relative min-h-[28rem] border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] overflow-hidden">
      {entityId ? (
        <EntityPanel
          entityId={entityId}
          asOf={asOf}
          recordedAt={recordedAt}
          onClose={onClose}
          onExpand={() => {
            /* graph expansion lives on the Graph page */
          }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-center text-[var(--text-muted)] px-4">
          <div>
            <div className="text-sm">{emptyTitle}</div>
            <div className="mt-1 text-xs text-[var(--text-faint)]">
              {emptyHint}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
