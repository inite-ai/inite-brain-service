'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { normalizeLang } from '../../lib/i18n'
import type { ScenarioListItem } from '../../lib/contracts/admin-scenarios'

export type ScenarioSummary = ScenarioListItem

export function ScenarioCard({
  s,
  selectable,
  selected,
  onToggle,
}: {
  s: ScenarioSummary
  selectable?: boolean
  selected?: boolean
  onToggle?: () => void
}) {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  return (
    <div
      className={`relative border rounded-md p-3 transition-colors ${
        selected
          ? 'border-[var(--accent)] bg-[var(--accent)]/5'
          : 'border-[var(--border)] hover:bg-[var(--bg-overlay)]'
      }`}
    >
      {selectable && (
        <label
          className="absolute top-2 right-2 z-10 cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={!!selected}
            onChange={(e) => {
              e.stopPropagation()
              onToggle?.()
            }}
          />
        </label>
      )}
      <Link
        href={`/${lang}/admin/scenarios/${encodeURIComponent(s.id)}`}
        className="block"
      >
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--bg-overlay)] text-[var(--text-muted)]">
            {s.vertical}
          </span>
          <span className="font-mono text-xs text-[var(--text)] truncate">
            {s.id}
          </span>
        </div>
        <div className="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">
          {s.description}
        </div>
        <div className="mt-2 flex gap-3 text-[10px] text-[var(--text-faint)]">
          <span>{s.setupSteps} setup</span>
          <span>{s.queries} queries</span>
          {s.hasMemoryAssertions && <span>· mem-assert</span>}
          {s.hasIdentityMerge && <span>· identity</span>}
          {s.hasSynthesize && (
            <span className="text-[var(--warning)]" title="synthesize queries are not auto-validated by the admin runner">
              · synth (skipped)
            </span>
          )}
        </div>
      </Link>
    </div>
  )
}
