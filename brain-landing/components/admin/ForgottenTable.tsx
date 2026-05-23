'use client'

interface Row {
  companyId: string
  entityIdHash: string
  reason: string
  forgottenAt: string
  factsDeleted: number
  edgesDeleted: number
}

interface Props {
  rows: Row[]
}

export function ForgottenTable({ rows }: Props) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--text)] mb-2 tracking-tight">
        Recent GDPR forget ({rows.length})
      </h2>
      <div className="rounded-md border border-[var(--border)] overflow-hidden">
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-[var(--text-muted)] text-xs">
            No forget cascades in the recent window.
          </div>
        )}
        {rows.map((r) => (
          <div
            key={r.entityIdHash}
            className="border-b border-[var(--border)] last:border-b-0 px-3 py-2 flex items-baseline justify-between gap-3"
          >
            <div className="min-w-0 flex-1">
              <div className="text-xs text-[var(--text)] truncate" title={r.entityIdHash}>
                {r.reason}
              </div>
              <div className="text-[10px] text-[var(--text-faint)] font-mono truncate">
                {r.companyId} · hash {r.entityIdHash.slice(0, 12)}… ·{' '}
                {r.forgottenAt.slice(0, 16).replace('T', ' ')}
              </div>
            </div>
            <div className="text-[10px] text-[var(--text-faint)] font-mono shrink-0">
              {r.factsDeleted}f / {r.edgesDeleted}e
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
