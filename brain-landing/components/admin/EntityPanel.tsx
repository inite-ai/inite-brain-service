'use client'

import { useEffect, useState } from 'react'
import { X, ExternalLink, Clock } from 'lucide-react'

interface Props {
  entityId: string | null
  asOf?: string | null
  onClose(): void
  onExpand(entityId: string): void
}

interface EntityProfile {
  entity: {
    id: string
    canonicalName?: string
    name?: string
    type: string
    externalRefs?: Array<{ vertical: string; id: string }>
  }
  facts: Array<{
    factId: string
    predicate: string
    object: string | null
    validFrom: string
    validUntil?: string | null
    status?: string
    confidence?: number
  }>
}

interface TimelineRow {
  factId?: string
  predicate?: string
  object?: string | null
  validFrom?: string
  validUntil?: string | null
  recordedAt?: string
  retractedAt?: string | null
  status?: string
}

export function EntityPanel({ entityId, asOf, onClose, onExpand }: Props) {
  const [profile, setProfile] = useState<EntityProfile | null>(null)
  const [timeline, setTimeline] = useState<TimelineRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!entityId) {
      setProfile(null)
      setTimeline(null)
      return
    }
    setLoading(true)
    setErr(null)
    const profileQs = asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''
    const timelineQs = asOf ? `?until=${encodeURIComponent(asOf)}` : ''
    Promise.all([
      fetch(
        `/api/admin/proxy/v1/entities/${encodeURIComponent(entityId)}${profileQs}`,
      ),
      fetch(
        `/api/admin/proxy/v1/entities/${encodeURIComponent(entityId)}/timeline${timelineQs}`,
      ),
    ])
      .then(async ([p, t]) => {
        const profileData = await p.json()
        const timelineData = await t.json()
        if (!p.ok) throw new Error(profileData?.error ?? `Profile ${p.status}`)
        setProfile(profileData as EntityProfile)
        setTimeline(
          (timelineData?.events ?? timelineData?.facts ?? []) as TimelineRow[],
        )
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false))
  }, [entityId, asOf])

  if (!entityId) return null

  return (
    <div className="absolute top-0 right-0 h-full w-[26rem] max-w-[90vw] border-l border-[var(--border)] bg-[var(--bg-elevated)] flex flex-col z-30">
      <div className="flex items-center justify-between gap-2 px-4 h-12 border-b border-[var(--border)]">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
            entity
          </div>
          <div className="text-sm font-medium text-[var(--text)] truncate">
            {profile?.entity?.canonicalName ??
              profile?.entity?.name ??
              entityId}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-md hover:bg-[var(--bg-overlay)] text-[var(--text-muted)]"
          aria-label="Close panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {loading && (
          <div className="text-sm text-[var(--text-muted)]">Loading…</div>
        )}
        {err && (
          <div className="text-xs text-[var(--danger)] font-mono">{err}</div>
        )}
        {profile && (
          <>
            <section>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                type
              </div>
              <div className="text-sm text-[var(--text)] font-mono">
                {profile.entity.type}
              </div>
            </section>

            {profile.entity.externalRefs?.length ? (
              <section>
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                  external refs
                </div>
                <ul className="space-y-1">
                  {profile.entity.externalRefs.map((r, i) => (
                    <li
                      key={`${r.vertical}.${r.id}.${i}`}
                      className="text-xs font-mono text-[var(--text)] flex items-center gap-1"
                    >
                      <ExternalLink className="w-3 h-3 text-[var(--text-faint)]" />
                      <span className="text-[var(--text-muted)]">
                        {r.vertical}.
                      </span>
                      {r.id}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                active facts ({profile.facts?.length ?? 0})
              </div>
              <ul className="space-y-1.5">
                {profile.facts?.slice(0, 12).map((f) => (
                  <li
                    key={f.factId}
                    className="text-xs flex items-baseline gap-1.5"
                  >
                    <span className="text-[var(--text-faint)] font-mono">
                      {f.predicate}
                    </span>
                    <span className="text-[var(--text)] flex-1 truncate">
                      {f.object ?? <em className="text-[var(--text-faint)]">[gated]</em>}
                    </span>
                    {f.confidence !== undefined && (
                      <span className="text-[10px] text-[var(--text-faint)] font-mono">
                        {f.confidence.toFixed(2)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            {timeline && timeline.length > 0 && (
              <section>
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1 flex items-center gap-1">
                  <Clock className="w-3 h-3" /> timeline ({timeline.length})
                </div>
                <ul className="space-y-1">
                  {timeline.slice(0, 8).map((t, i) => (
                    <li
                      key={t.factId ?? i}
                      className={`text-xs flex items-baseline gap-1.5 ${
                        t.status === 'retracted'
                          ? 'text-[var(--text-faint)] line-through'
                          : 'text-[var(--text-muted)]'
                      }`}
                    >
                      <span className="font-mono text-[10px]">
                        {(t.validFrom ?? t.recordedAt ?? '').slice(0, 10)}
                      </span>
                      <span>{t.predicate}</span>
                      <span className="text-[var(--text)] flex-1 truncate">
                        {t.object ?? '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
      <div className="border-t border-[var(--border)] p-3 flex gap-2">
        <button
          type="button"
          onClick={() => onExpand(entityId)}
          className="flex-1 h-8 rounded-md bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)]"
        >
          Expand neighbours
        </button>
      </div>
    </div>
  )
}
