'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useEffect, useState } from 'react'
import {
  X,
  ExternalLink,
  Clock,
  ShieldOff,
  CircleDot,
} from 'lucide-react'
import { useProxyBase } from '../playground/usePlaygroundCall'

/**
 * Brain returns externalRefs in two shapes depending on the path:
 *   - search hit:   { vertical__id: 'id' }  (object-flat, double-underscore key)
 *   - timeline row: [{vertical, id}]
 * Normalise to a single array shape for rendering.
 */
function normalizeExternalRefs(
  raw: Record<string, string> | Array<{ vertical: string; id: string }> | undefined | null,
): Array<{ vertical: string; id: string }> {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  return Object.entries(raw).map(([k, v]) => {
    const [vertical, ...rest] = k.split('__')
    return { vertical: vertical ?? 'unknown', id: rest.join('__') || String(v) }
  })
}

interface Props {
  entityId: string | null
  asOf?: string | null
  recordedAt?: string | null
  onClose(): void
  onExpand(entityId: string): void
}

interface EntityProfile {
  // Brain /v1/entities/:id returns flat shape — entityId/type at top level,
  // externalRefs as a Record<string, string> not an array of {vertical,id}.
  entityId: string
  type: string
  canonicalName?: string
  name?: string
  externalRefs?: Record<string, string> | Array<{ vertical: string; id: string }>
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

/**
 * Backend GET /v1/entities/:id/timeline returns EVENTS, not fact rows:
 *   { type: 'fact.recorded',  at, factId, predicate, object, source, confidence }
 *   { type: 'fact.retracted', at, factId, retractedBy, reason, supersededBy }
 * `at` is the transaction-time instant of the event.
 */
interface TimelineEvent {
  type: 'fact.recorded' | 'fact.retracted'
  at: string
  factId: string
  predicate?: string
  object?: string | null
  source?: { vertical?: string; recorder?: string } | null
  confidence?: number
  retractedBy?: string
  reason?: string
  supersededBy?: string
}

export function EntityPanel({
  entityId,
  asOf,
  recordedAt,
  onClose,
  onExpand,
}: Props) {
  const proxyBase = useProxyBase()
  const [profile, setProfile] = useState<EntityProfile | null>(null)
  const [timeline, setTimeline] = useState<TimelineEvent[] | null>(null)
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
    // Axis wiring: asOf (world-time) shapes the PROFILE's active-fact
    // set only; timeline events live on the transaction-time axis, so
    // the tx slider (recordedAt) is the one that cuts both surfaces.
    // (Previously asOf was mis-mapped to the timeline's `until`, which
    // filters recordedAt — the wrong axis.)
    const profileParams = new URLSearchParams()
    if (asOf) profileParams.set('asOf', asOf)
    if (recordedAt) profileParams.set('recordedAt', recordedAt)
    const profileQs = profileParams.toString()
      ? `?${profileParams.toString()}`
      : ''
    const timelineParams = new URLSearchParams()
    if (recordedAt) timelineParams.set('recordedAt', recordedAt)
    const timelineQs = timelineParams.toString()
      ? `?${timelineParams.toString()}`
      : ''
    Promise.all([
      fetch(
        `${proxyBase}/v1/entities/${encodeURIComponent(entityId)}${profileQs}`,
      ),
      fetch(
        `${proxyBase}/v1/entities/${encodeURIComponent(entityId)}/timeline${timelineQs}`,
      ),
    ])
      .then(async ([p, t]) => {
        const profileData = await p.json()
        const timelineData = await t.json()
        if (!p.ok) throw new Error(profileData?.error ?? `Profile ${p.status}`)
        setProfile(profileData as EntityProfile)
        setTimeline((timelineData?.events ?? []) as TimelineEvent[])
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false))
  }, [entityId, asOf, recordedAt, proxyBase])

  if (!entityId) return null

  return (
    <div className="absolute top-0 right-0 h-full w-[26rem] max-w-[90vw] border-l border-[var(--border)] bg-[var(--bg-elevated)] flex flex-col z-30">
      <div className="flex items-center justify-between gap-2 px-4 h-12 border-b border-[var(--border)]">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
            entity
          </div>
          <div className="text-sm font-medium text-[var(--text)] truncate">
            {profile?.canonicalName ?? profile?.name ?? entityId}
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
                {profile.type}
              </div>
            </section>

            {(() => {
              const refs = normalizeExternalRefs(profile.externalRefs)
              if (refs.length === 0) return null
              return (
                <section>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                    external refs
                  </div>
                  <ul className="space-y-1">
                    {refs.map((r, i) => (
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
              )
            })()}

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
              <LineageTimeline events={timeline} />
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

function LineageTimeline({ events }: { events: TimelineEvent[] }) {
  // Newest first by the event's tx instant — operator's eye lands on
  // the most recent thing the graph learned (or unlearned).
  const sorted = [...events].sort((a, b) =>
    (b.at ?? '').localeCompare(a.at ?? ''),
  )
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1 flex items-center gap-1">
        <Clock className="w-3 h-3" /> bitemporal lineage ({events.length})
      </div>
      <ul className="space-y-1 relative">
        <div className="absolute left-2 top-2 bottom-2 w-px bg-[var(--border)]" />
        {sorted.slice(0, 24).map((e) => (
          <LineageRow key={`${e.type}:${e.factId}`} e={e} />
        ))}
        {sorted.length > 24 && (
          <li className="pl-6 text-[10px] text-[var(--text-faint)]">
            … {sorted.length - 24} earlier events truncated
          </li>
        )}
      </ul>
    </section>
  )
}

const shortId = (id: string) => id.replace(/^knowledge_fact:/, '')

function LineageRow({ e }: { e: TimelineEvent }) {
  const retracted = e.type === 'fact.retracted'
  const atShort = (e.at ?? '').slice(0, 16).replace('T', ' ') || '—'
  const Icon = retracted ? ShieldOff : CircleDot
  const accent = retracted ? 'text-[var(--danger)]' : 'text-[var(--success)]'
  return (
    <li className="pl-6 relative">
      <Icon className={`w-3 h-3 absolute left-1 top-0.5 ${accent}`} />
      {retracted ? (
        <>
          <div className="text-xs flex items-baseline gap-1.5">
            <span className="font-mono text-[10px] text-[var(--danger)]">
              retracted
            </span>
            <span className="flex-1 truncate line-through text-[var(--text-faint)]">
              {e.reason ?? shortId(e.factId)}
            </span>
          </div>
          <div className="text-[10px] font-mono text-[var(--text-faint)] flex flex-wrap gap-x-2">
            <span className="text-[var(--danger)]">tx: {atShort}</span>
            {e.retractedBy && <span>by: {e.retractedBy}</span>}
            {e.supersededBy && (
              <span>superseded by: {shortId(e.supersededBy)}</span>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="text-xs flex items-baseline gap-1.5">
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              {e.predicate ?? 'fact'}
            </span>
            <span className="flex-1 truncate text-[var(--text)]">
              {e.object ?? <em className="text-[var(--text-faint)]">[gated]</em>}
            </span>
            {e.confidence !== undefined && (
              <span className="text-[10px] text-[var(--text-faint)] font-mono">
                {e.confidence.toFixed(2)}
              </span>
            )}
          </div>
          <div className="text-[10px] font-mono text-[var(--text-faint)] flex flex-wrap gap-x-2">
            <span>tx: {atShort}</span>
            {e.source?.vertical && <span>src: {e.source.vertical}</span>}
          </div>
        </>
      )}
    </li>
  )
}
