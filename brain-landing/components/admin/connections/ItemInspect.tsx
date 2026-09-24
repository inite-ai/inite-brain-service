'use client'

import { useCallback, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useLoader } from '../../../hooks/useLoader'
import { Modal } from '../policies/ui'
import type {
  SourceItem,
  SourceItemFact,
  SourceItemInspectResponse,
} from '../../../lib/contracts/admin-source-connections'
import { accentBtn, connectionPath, errorMessage, fill, stamp, type ConnectionsT } from './shared'

/**
 * One catalogue row followed all the way: what it is at the source, the
 * document it became (or the asset it was stored as and what the
 * processors extracted from it), and the facts that cite it — each with
 * the revision it was read at against the one the catalogue now holds,
 * so drift is visible before the sweep marks it.
 */
export function ItemInspect({
  connectionId,
  item,
  catalogueOnly,
  t,
  onClose,
  onRead,
}: {
  connectionId: string
  item: SourceItem
  /** The connection only catalogues (contentPolicy: manifest) — this row can be READ on demand (W6). */
  catalogueOnly: boolean
  t: ConnectionsT
  onClose: () => void
  onRead: () => Promise<void>
}) {
  const s = t.item
  const [data, setData] = useState<SourceItemInspectResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        connectionPath(connectionId, `/items/${encodeURIComponent(item.id)}`),
        { cache: 'no-store' },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setData(json as SourceItemInspectResponse)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [connectionId, item.id])

  const { loading, reload } = useLoader(load)
  const row = data?.item ?? item

  /**
   * Read this one row now. A catalogued item is a filename the brain
   * has never opened; this is the operator's own version of what a
   * retrieval hit schedules — the same deepening, asked for by hand.
   */
  const readNow = async () => {
    setReading(true)
    setError(null)
    try {
      const res = await fetch(connectionPath(connectionId, '/sync'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inline: true, itemIds: [row.id] }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      await reload()
      await onRead()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setReading(false)
    }
  }

  return (
    <Modal title={`${s.title}: ${row.path ?? row.title ?? row.externalId}`} onClose={onClose} wide>
      <div className="space-y-4 text-xs max-h-[75vh] overflow-y-auto pr-1">
        {error && <div className="font-mono text-[var(--danger)]">{error}</div>}
        {loading && !data && (
          <div className="flex items-center gap-2 text-[var(--text-muted)]">
            <Loader2 className="w-3 h-3 animate-spin" />
          </div>
        )}

        {catalogueOnly && row.state !== 'gone' && (
          <div className="flex items-center gap-2 flex-wrap rounded-md border border-[var(--border)] p-2">
            <button className={accentBtn} disabled={reading} onClick={() => void readNow()}>
              {reading ? <Loader2 className="w-3 h-3 animate-spin" /> : s.readNow}
            </button>
            <span className="text-[10px] text-[var(--text-muted)]">
              {row.deepenedAt ? fill(s.readAlready, { at: stamp(row.deepenedAt) }) : s.readHint}
            </span>
          </div>
        )}

        <Block title={s.identity}>
          <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
            <Row k={s.externalId} v={row.externalId} mono />
            <Row k={s.origin} v={row.originUri ?? '—'} mono />
            <Row k={s.path} v={row.path ?? '—'} mono />
            <Row k={s.mediaType} v={row.mediaType ?? '—'} mono />
            <Row k={s.size} v={row.size === null ? '—' : String(row.size)} mono />
            <Row k={s.revision} v={row.revision ?? '—'} mono />
            <Row
              k={s.fetchedRevision}
              v={row.fetchedRevision ?? '—'}
              mono
              tone={
                row.fetchedRevision && row.revision && row.fetchedRevision !== row.revision
                  ? 'warning'
                  : undefined
              }
            />
            <Row k={s.modifiedAt} v={stamp(row.modifiedAt)} mono />
            <Row k={s.firstSeen} v={stamp(row.firstSeenAt)} mono />
            <Row k={s.lastSeen} v={stamp(row.lastSeenAt)} mono />
            {row.goneAt && <Row k={s.goneAt} v={stamp(row.goneAt)} mono tone="muted" />}
            {row.episodeId && <Row k={s.episode} v={row.episodeId} mono />}
            {row.lastError && <Row k={s.error} v={row.lastError} mono tone="danger" />}
          </dl>
        </Block>

        {data?.episode && (
          <Block title={s.turn}>
            <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
              <Row k={s.turnFields.speaker} v={data.episode.speaker ?? '—'} />
              <Row k={s.turnFields.conversation} v={data.episode.conversationId ?? '—'} mono />
              <Row k={s.turnFields.messageId} v={data.episode.messageId ?? '—'} mono />
              <Row k={s.turnFields.at} v={stamp(data.episode.occurredAt)} mono />
            </dl>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-[var(--text)] max-h-64 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg)] p-2">
              {data.episode.text}
            </pre>
          </Block>
        )}

        <Block title={s.documents}>
          {data && data.documents.length === 0 && (
            <p className="text-[var(--text-muted)] italic">
              {data.episode ? s.documentsNoneTurn : s.documentsNone}
            </p>
          )}
          {data && data.documents.length > 0 && (
            <table className="w-full">
              <thead className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                <tr>
                  <th className="text-left py-1 pr-3">{s.title}</th>
                  <th className="text-left py-1 pr-3">{s.document.kind}</th>
                  <th className="text-left py-1 pr-3">{s.document.status}</th>
                  <th className="text-left py-1">{s.document.created}</th>
                </tr>
              </thead>
              <tbody>
                {data.documents.map((d) => (
                  <tr key={d.id} className="border-t border-[var(--border)]">
                    <td className="py-1 pr-3">
                      <div className="text-[var(--text)]">{d.title ?? d.id}</div>
                      <div className="font-mono text-[10px] text-[var(--text-faint)]">{d.id}</div>
                    </td>
                    <td className="py-1 pr-3 font-mono text-[var(--text-muted)]">{d.kind ?? '—'}</td>
                    <td className="py-1 pr-3 font-mono text-[var(--text-muted)]">{d.status ?? '—'}</td>
                    <td className="py-1 font-mono text-[10px] text-[var(--text-muted)]">
                      {stamp(d.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Block>

        {data?.asset && (
          <Block title={s.asset}>
            <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
              <Row k={s.externalId} v={data.asset.id} mono />
              <Row k={s.assetFields.mediaType} v={data.asset.mediaType} mono />
              <Row k={s.assetFields.modality} v={data.asset.modality} mono />
              <Row k={s.assetFields.bytes} v={String(data.asset.byteLength)} mono />
              <Row k={s.assetFields.availability} v={data.asset.availability} mono />
              {data.asset.quarantineStatus && (
                <Row k={s.assetFields.quarantine} v={data.asset.quarantineStatus} mono tone="warning" />
              )}
            </dl>
            <div className="mt-2 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
              {s.representations}
            </div>
            {data.asset.representations.length === 0 ? (
              <p className="text-[var(--text-muted)] italic">{s.representationsNone}</p>
            ) : (
              <table className="w-full">
                <thead className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                  <tr>
                    <th className="text-left py-1 pr-3">{s.representation.kind}</th>
                    <th className="text-left py-1 pr-3">{s.representation.producer}</th>
                    <th className="text-right py-1 pr-3">{s.representation.chars}</th>
                    <th className="text-left py-1">{s.representation.created}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.asset.representations.map((r) => (
                    <tr key={r.id} className="border-t border-[var(--border)] font-mono">
                      <td className="py-1 pr-3 text-[var(--text)]">{r.kind}</td>
                      <td className="py-1 pr-3 text-[var(--text-muted)]">{r.producerVersion}</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-[var(--text-muted)]">
                        {r.chars}
                      </td>
                      <td className="py-1 text-[10px] text-[var(--text-muted)]">{stamp(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Block>
        )}

        <Block title={s.facts}>
          {data && data.facts.length === 0 && (
            <p className="text-[var(--text-muted)] italic">{s.factsEmpty}</p>
          )}
          {data && data.facts.length > 0 && (
            <table className="w-full">
              <thead className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                <tr>
                  <th className="text-left py-1 pr-3">{s.factHeaders.predicate}</th>
                  <th className="text-left py-1 pr-3">{s.factHeaders.object}</th>
                  <th className="text-left py-1 pr-3">{s.factHeaders.version}</th>
                  <th className="text-left py-1">{s.factHeaders.state}</th>
                </tr>
              </thead>
              <tbody>
                {data.facts.map((f) => (
                  <FactRow key={f.id} fact={f} revision={row.revision} t={t} />
                ))}
              </tbody>
            </table>
          )}
          {data?.factsTruncated && (
            <p className="mt-1 text-[10px] text-[var(--warning)]">{s.factsTruncated}</p>
          )}
        </Block>
      </div>
    </Modal>
  )
}

function FactRow({
  fact,
  revision,
  t,
}: {
  fact: SourceItemFact
  revision: string | null
  t: ConnectionsT
}) {
  const s = t.item
  const state = factState(fact, revision)
  const label =
    state === 'retracted'
      ? s.factState.retracted.replace('{status}', fact.status)
      : s.factState[state]
  return (
    <tr className="border-t border-[var(--border)]">
      <td className="py-1 pr-3 font-mono text-[var(--text)]" title={fact.entityId}>
        {fact.predicate}
      </td>
      <td className="py-1 pr-3 text-[var(--text)] max-w-[20rem] truncate" title={fact.object}>
        {fact.object}
      </td>
      <td
        className="py-1 pr-3 font-mono text-[10px] text-[var(--text-muted)] max-w-[10rem] truncate"
        title={fact.version ?? undefined}
      >
        {fact.version ?? '—'}
      </td>
      <td className="py-1">
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] ${factTone(state)}`}
          title={state === 'drifted' ? s.driftHint : (fact.staleReason ?? undefined)}
        >
          {label}
        </span>
      </td>
    </tr>
  )
}

type FactState = 'current' | 'drifted' | 'stale' | 'closed' | 'retracted'

/** What the drift sweep sees on one fact against the catalogue's revision. */
export function factState(fact: SourceItemFact, revision: string | null): FactState {
  if (fact.validUntil) return 'closed'
  if (fact.status !== 'active') return 'retracted'
  if (fact.staleAt) return 'stale'
  if (fact.version && revision && fact.version !== revision) return 'drifted'
  return 'current'
}

function factTone(state: FactState): string {
  switch (state) {
    case 'current':
      return 'text-[var(--success)] bg-[var(--success)]/10'
    case 'drifted':
    case 'stale':
      return 'text-[var(--warning)] bg-[var(--warning)]/10'
    default:
      return 'text-[var(--text-faint)] bg-[var(--bg-overlay)] line-through'
  }
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{title}</h3>
      {children}
    </section>
  )
}

function Row({
  k,
  v,
  mono,
  tone,
}: {
  k: string
  v: string
  mono?: boolean
  tone?: 'warning' | 'danger' | 'muted' | undefined
}) {
  const color =
    tone === 'warning'
      ? 'text-[var(--warning)]'
      : tone === 'danger'
        ? 'text-[var(--danger)]'
        : tone === 'muted'
          ? 'text-[var(--text-faint)]'
          : 'text-[var(--text)]'
  return (
    <>
      <dt className="text-[var(--text-muted)]">{k}</dt>
      <dd className={`${color} break-all ${mono ? 'font-mono' : ''}`}>{v}</dd>
    </>
  )
}
