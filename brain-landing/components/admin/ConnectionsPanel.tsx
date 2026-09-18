'use client'

import { useCallback, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  Cloud,
  CloudCog,
  Folder,
  GitBranch,
  Globe,
  HardDrive,
  Package,
  KeyRound,
  Laptop,
  Loader2,
  Pause,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import { useLoader } from '../../hooks/useLoader'
import { ErrorLine } from './policies/ui'
import { getMessages, normalizeLang } from '../../lib/i18n'
import type {
  SourceAgent,
  SourceAvailability,
  SourceCatalogResponse,
  SourceConnection,
  SourceConnectionsListResponse,
  SyncNowResponse,
} from '../../lib/contracts/admin-source-connections'
import { AccountsSection } from './connections/AccountsSection'
import { AgentSetupModal } from './connections/AgentSetupModal'
import { ConnectionCreateModal } from './connections/ConnectionCreateModal'
import { ConnectionDetail } from './connections/ConnectionDetail'
import { cardsOf, familyOf, type SourceCard, type SourceFamily } from './connections/kinds'
import {
  PROXY,
  accentBtn,
  connectionPath,
  dangerBtn,
  errorMessage,
  fill,
  mutedBtn,
  stamp,
  type ConnectionsT,
} from './connections/shared'

/**
 * Source-plane operator surface: the connections this tenant has, the
 * catalogue of what it could connect (every pack's declared `sources`
 * with consent + connector state), and the deployment fences a
 * connection has to fit inside. Mirrors /v1/admin/source-connections
 * one-to-one; the panel invents no verb the API lacks.
 */
export function ConnectionsPanel() {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  const admin = getMessages(lang).admin
  const t = admin.connections

  const [data, setData] = useState<SourceConnectionsListResponse | null>(null)
  const [catalog, setCatalog] = useState<SourceCatalogResponse | null>(null)
  const [agents, setAgents] = useState<SourceAgent[]>([])
  const [off, setOff] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [creating, setCreating] = useState<SourceCard | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [list, cat, ag] = await Promise.all([
        fetch(PROXY, { cache: 'no-store' }),
        fetch(`${PROXY}/catalog`, { cache: 'no-store' }),
        fetch(`${PROXY}/agents`, { cache: 'no-store' }),
      ])
      if (list.status === 404) {
        setOff(true)
        setData(null)
        setCatalog(null)
        setError(null)
        return
      }
      const listJson = await list.json()
      if (!list.ok) throw new Error(errorMessage(listJson, list.status))
      const catJson = await cat.json()
      if (!cat.ok) throw new Error(errorMessage(catJson, cat.status))
      const agJson = await ag.json()
      setOff(false)
      setData(listJson as SourceConnectionsListResponse)
      setCatalog(catJson as SourceCatalogResponse)
      setAgents(ag.ok ? (agJson as { agents: SourceAgent[] }).agents : [])
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const { loading, reload } = useLoader(load)

  const selected = useMemo(
    () => data?.connections.find((c) => c.id === selectedId) ?? null,
    [data, selectedId],
  )
  const selectedEntry = useMemo(
    () =>
      selected
        ? (catalog?.sources.find(
            (e) => e.packId === selected.packId && e.sourceId === selected.sourceId,
          ) ?? null)
        : null,
    [catalog, selected],
  )

  const act = useCallback(
    async (id: string, run: () => Promise<string | null>) => {
      setBusy(id)
      setError(null)
      setNotice(null)
      try {
        const msg = await run()
        if (msg) setNotice(msg)
        await reload()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [reload],
  )

  const sync = useCallback(
    (c: SourceConnection, full: boolean) =>
      act(c.id, async () => {
        const res = await fetch(connectionPath(c.id, '/sync'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ full }),
        })
        const json = (await res.json()) as SyncNowResponse
        if (!res.ok) throw new Error(errorMessage(json, res.status))
        if (!json.enqueued) return null
        return fill(json.created ? t.list.enqueued : t.list.alreadyQueued, {
          runId: json.runId,
        })
      }),
    [act, t],
  )

  const setStatus = useCallback(
    (c: SourceConnection, status: 'active' | 'paused') =>
      act(c.id, async () => {
        const res = await fetch(connectionPath(c.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(errorMessage(json, res.status))
        return null
      }),
    [act],
  )

  const remove = useCallback(
    (c: SourceConnection) => {
      const label = labelOf(c)
      const confirmation = window.prompt(fill(t.list.deletePrompt, { label }))
      if (confirmation === null) return
      if (confirmation !== label) {
        setError(t.list.confirmMismatch)
        return
      }
      void act(c.id, async () => {
        const res = await fetch(connectionPath(c.id), { method: 'DELETE' })
        const json = await res.json()
        if (!res.ok) throw new Error(errorMessage(json, res.status))
        if (selectedId === c.id) setSelectedId(null)
        return fill(t.list.deleted, {
          label,
          n: (json as { items: number }).items,
        })
      })
    },
    [act, selectedId, t],
  )

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Plug className="w-4 h-4 text-[var(--accent)]" /> {t.title}
          </h1>
          <p className="text-xs text-[var(--text-muted)] max-w-3xl">
            {t.subtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          {admin.common.refresh}
        </button>
      </header>

      <ErrorLine error={error} />
      {notice && (
        <div className="text-xs text-[var(--success)] font-mono">{notice}</div>
      )}

      {off && (
        <article className="p-3 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/5 space-y-1">
          <h2 className="text-sm font-semibold text-[var(--text)]">
            {t.off.title}
          </h2>
          <p className="text-xs text-[var(--text-muted)] font-mono">
            {t.off.body}
          </p>
        </article>
      )}

      {!off && (
        <Section title={t.list.title} subtitle={t.list.subtitle}>
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-1.5">{t.list.headers.label}</th>
                <th className="text-left px-3 py-1.5">{t.list.headers.source}</th>
                <th className="text-left px-3 py-1.5">
                  {t.list.headers.connector}
                </th>
                <th className="text-left px-3 py-1.5">
                  {t.list.headers.schedule}
                </th>
                <th className="text-left px-3 py-1.5">{t.list.headers.status}</th>
                <th className="text-left px-3 py-1.5">
                  {t.list.headers.lastSync}
                </th>
                <th className="text-right px-3 py-1.5">
                  {t.list.headers.actions}
                </th>
              </tr>
            </thead>
            <tbody>
              {(data?.connections ?? []).map((c) => (
                <tr
                  key={c.id}
                  className={`border-t border-[var(--border)] ${
                    c.id === selectedId ? 'bg-[var(--accent)]/5' : ''
                  }`}
                >
                  <td className="px-3 py-1.5 text-[var(--text)]">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedId(c.id === selectedId ? null : c.id)
                      }
                      className="text-left hover:text-[var(--accent)] font-medium"
                    >
                      {labelOf(c)}
                    </button>
                    {c.ownerUserId && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-overlay)] text-[var(--text-faint)]">
                        {t.list.personal}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-[var(--text-muted)]">
                    <KindLabel family={familyOf(c)} connector={c.connector} t={t} />
                    <span className="text-[var(--text-faint)]">
                      {' · '}
                      {c.shape === 'binary' ? t.form.shape.binary : t.form.shape.document}
                    </span>
                    <div className="font-mono text-[10px] text-[var(--text-faint)]">
                      {c.packId}
                      {'/'}
                      {c.sourceId}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-[var(--text-muted)]">
                    {c.host === 'server' ? (
                      t.detail.hostServer
                    ) : (
                      <span className="inline-flex items-center gap-1 font-mono">
                        <Laptop className="w-3 h-3" /> {c.host.slice('agent:'.length)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[var(--text-muted)]">
                    {c.schedule}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${statusTone(c.status)}`}>
                      {t.status[c.status]}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
                    {c.lastSyncAt ? stamp(c.lastSyncAt) : t.list.neverSynced}
                    {c.lastSyncStatus && (
                      <span className={`ml-1 ${syncTone(c.lastSyncStatus)}`}>
                        {c.lastSyncStatus}
                      </span>
                    )}
                    {c.lastError && (
                      <div className="text-[var(--danger)] max-w-[16rem] truncate" title={c.lastError}>
                        {c.lastError}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <span className="inline-flex gap-1.5 flex-wrap justify-end">
                      <button
                        type="button"
                        disabled={busy === c.id || c.status !== 'active' || c.host !== 'server'}
                        onClick={() => void sync(c, false)}
                        className={accentBtn}
                        title={c.host !== 'server' ? t.agents.subtitle : undefined}
                      >
                        {busy === c.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Play className="w-3 h-3" />
                        )}
                        {t.list.sync}
                      </button>
                      <button
                        type="button"
                        disabled={busy === c.id || c.status !== 'active' || c.host !== 'server'}
                        onClick={() => void sync(c, true)}
                        className={accentBtn}
                        title={c.host !== 'server' ? t.agents.subtitle : undefined}
                      >
                        <RotateCcw className="w-3 h-3" /> {t.list.full}
                      </button>
                      {c.status === 'active' ? (
                        <button
                          type="button"
                          disabled={busy === c.id}
                          onClick={() => void setStatus(c, 'paused')}
                          className={mutedBtn}
                        >
                          <Pause className="w-3 h-3" /> {t.list.pause}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy === c.id || c.status === 'deleting'}
                          onClick={() => void setStatus(c, 'active')}
                          className={mutedBtn}
                        >
                          <Play className="w-3 h-3" /> {t.list.resume}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedId(c.id === selectedId ? null : c.id)
                        }
                        className={mutedBtn}
                      >
                        <Search className="w-3 h-3" /> {t.list.inspect}
                      </button>
                      <button
                        type="button"
                        disabled={busy === c.id}
                        onClick={() => remove(c)}
                        className={dangerBtn}
                      >
                        <Trash2 className="w-3 h-3" /> {t.list.delete}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
              {data && data.connections.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-[var(--text-muted)] italic">
                    {t.list.empty}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>
      )}

      {selected && (
        <ConnectionDetail
          key={selected.id}
          connection={selected}
          entry={selectedEntry}
          t={t}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}

      {!off && data && <AgentsSection connections={data.connections} agents={agents} t={t} />}

      {!off && data && <AccountsSection connections={data.connections} refreshKey={data.connections.length} t={t} />}

      {catalog && (
        <div className="space-y-2">
          <div>
            <h2 className="text-sm font-medium text-[var(--text)]">{t.catalog.title}</h2>
            <p className="text-[11px] text-[var(--text-muted)] max-w-3xl">{t.catalog.subtitle}</p>
          </div>
          {catalog.sources.length === 0 ? (
            <p className="rounded-md border border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--text-muted)] italic">
              {t.catalog.empty}
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {cardsOf(catalog.sources).map((card) => (
                <SourceKindCard key={card.key} card={card} t={t} lang={lang} onConnect={() => setCreating(card)} />
              ))}
            </div>
          )}
          <details className="text-xs">
            <summary className="cursor-pointer text-[var(--text-muted)]">{t.kinds.deployment}</summary>
            <div className="mt-2">
              <Fences catalog={catalog} t={t} />
            </div>
          </details>
        </div>
      )}

      {creating && catalog && (
        <ConnectionCreateModal
          card={creating}
          catalog={catalog}
          t={t}
          onClose={() => setCreating(null)}
          onCreated={(created) => {
            setCreating(null)
            const first = created[0]
            if (first) {
              setNotice(
                fill(created.length > 1 ? t.create.createdBoth : t.create.created, {
                  label: labelOf(first),
                }),
              )
              setSelectedId(first.id)
            }
            void reload()
          }}
        />
      )}
    </div>
  )
}

function labelOf(c: SourceConnection): string {
  return c.label ?? `${c.packId}/${c.sourceId}`
}

function statusTone(status: SourceConnection['status']): string {
  switch (status) {
    case 'active':
      return 'text-[var(--success)] bg-[var(--success)]/10'
    case 'paused':
      return 'text-[var(--warning)] bg-[var(--warning)]/10'
    default:
      return 'text-[var(--text-faint)] bg-[var(--bg-overlay)]'
  }
}

function syncTone(status: string): string {
  if (status === 'succeeded') return 'text-[var(--success)]'
  if (status === 'failed') return 'text-[var(--danger)]'
  return 'text-[var(--warning)]'
}

function availabilityTone(a: SourceAvailability): string {
  switch (a) {
    case 'ready':
      return 'text-[var(--success)] bg-[var(--success)]/10'
    case 'disabled':
      return 'text-[var(--warning)] bg-[var(--warning)]/10'
    case 'missing':
      return 'text-[var(--danger)] bg-[var(--danger)]/10'
    default:
      return 'text-[var(--text-muted)] bg-[var(--bg-overlay)]'
  }
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-medium text-[var(--text)]">{title}</h2>
        <p className="text-[11px] text-[var(--text-muted)] max-w-3xl">
          {subtitle}
        </p>
      </div>
      <div className="rounded-md border border-[var(--border)] overflow-x-auto">
        {children}
      </div>
    </div>
  )
}

function Fences({
  catalog,
  t,
}: {
  catalog: SourceCatalogResponse
  t: ConnectionsT
}) {
  const f = t.fences
  return (
    <article className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
      <h2 className="text-xs font-semibold text-[var(--text)] mb-2">
        {f.title}
      </h2>
      <dl className="grid grid-cols-1 md:grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-[11px]">
        <dt className="text-[var(--text-muted)]">{f.connectors}</dt>
        <dd className="flex flex-wrap gap-1.5">
          {catalog.connectors.map((c) => (
            <span
              key={c.kind}
              className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                c.state === 'ready'
                  ? 'text-[var(--success)] bg-[var(--success)]/10'
                  : 'text-[var(--warning)] bg-[var(--warning)]/10'
              }`}
              title={c.state === 'ready' ? c.flag : fill(f.connectorOff, { flag: c.flag })}
            >
              {c.kind}
              {c.state === 'disabled' && ` — ${fill(f.connectorOff, { flag: c.flag })}`}
            </span>
          ))}
        </dd>
        <dt className="text-[var(--text-muted)]">{f.fsRoots}</dt>
        <dd className="font-mono text-[var(--text)]">
          {catalog.fsRoots.length === 0 ? (
            <span className="text-[var(--text-faint)]">{f.fsRootsNone}</span>
          ) : (
            catalog.fsRoots.join(', ')
          )}
        </dd>
        <dt className="text-[var(--text-muted)]">{f.egress}</dt>
        <dd className={catalog.egressAllowPrivate ? 'text-[var(--warning)]' : 'text-[var(--text)]'}>
          {catalog.egressAllowPrivate ? f.egressOn : f.egressOff}
        </dd>
      </dl>
    </article>
  )
}

interface AgentRow {
  agentId: string
  connections: SourceConnection[]
  lastSyncAt: string | null
  lastSyncStatus: string | null
  /** The agent's own check-in, when it has ever made one. */
  presence: SourceAgent | null
}

/** Agent-host connections grouped by agent — who checked in, and how to run one. */
function agentRows(connections: SourceConnection[], agents: SourceAgent[]): AgentRow[] {
  const byAgent = new Map<string, AgentRow>()
  for (const a of agents) {
    byAgent.set(a.agentId, { agentId: a.agentId, connections: [], lastSyncAt: null, lastSyncStatus: null, presence: a })
  }
  for (const c of connections) {
    if (!c.host.startsWith('agent:')) continue
    const agentId = c.host.slice('agent:'.length)
    const row = byAgent.get(agentId) ?? {
      agentId,
      connections: [],
      lastSyncAt: null,
      lastSyncStatus: null,
      presence: null,
    }
    row.connections.push(c)
    if (c.lastSyncAt && (!row.lastSyncAt || c.lastSyncAt > row.lastSyncAt)) {
      row.lastSyncAt = c.lastSyncAt
      row.lastSyncStatus = c.lastSyncStatus
    }
    byAgent.set(agentId, row)
  }
  return [...byAgent.values()].sort((a, b) => a.agentId.localeCompare(b.agentId))
}

function AgentsSection({
  connections,
  agents,
  t,
}: {
  connections: SourceConnection[]
  agents: SourceAgent[]
  t: ConnectionsT
}) {
  const a = t.agents
  const rows = useMemo(() => agentRows(connections, agents), [connections, agents])
  const [setup, setSetup] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">{a.title}</h2>
          <p className="text-[11px] text-[var(--text-muted)] max-w-3xl">{a.subtitle}</p>
        </div>
        <button type="button" onClick={() => setSetup('')} className={accentBtn}>
          <Laptop className="w-3 h-3" /> {a.setupNew}
        </button>
      </div>
      <div className="rounded-md border border-[var(--border)] overflow-x-auto">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-xs text-[var(--text-muted)] italic">{a.none}</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-1.5">{a.headers.agent}</th>
                <th className="text-left px-3 py-1.5">{a.headers.seen}</th>
                <th className="text-left px-3 py-1.5">{a.headers.connections}</th>
                <th className="text-left px-3 py-1.5">{a.headers.lastSync}</th>
                <th className="text-left px-3 py-1.5">{a.headers.status}</th>
                <th className="text-right px-3 py-1.5">{a.setup}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.agentId} className="border-t border-[var(--border)] align-top">
                  <td className="px-3 py-1.5 font-mono text-[var(--text)]">
                    <span className="inline-flex items-center gap-1">
                      <Laptop className="w-3 h-3 text-[var(--accent)]" /> {row.agentId}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-[10px] text-[var(--text-muted)]">
                    {row.presence ? (
                      <>
                        <div className="font-mono">
                          {fill(a.seenAt, {
                            at: stamp(row.presence.lastSeenAt),
                            hostname: row.presence.hostname ?? '?',
                            platform: row.presence.platform ?? '?',
                            version: row.presence.version ?? '?',
                          })}
                        </div>
                        {row.presence.roots.length > 0 && (
                          <div className="font-mono text-[var(--text-faint)]" title={row.presence.roots.map((r) => r.path).join('\n')}>
                            {a.roots}
                            {': '}
                            {row.presence.roots.map((r) => r.path).join(', ')}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-[var(--warning)]">{a.seenNever}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-[var(--text-muted)]">
                    {row.connections.map((c) => (
                      <div key={c.id} className="text-[11px]">
                        {c.label ?? `${c.packId}/${c.sourceId}`}
                        <span className="text-[var(--text-faint)]">
                          {' · '}
                          <KindLabel family={familyOf(c)} connector={c.connector} t={t} />
                        </span>
                      </div>
                    ))}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
                    {row.lastSyncAt ? stamp(row.lastSyncAt) : a.never}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px]">
                    {row.lastSyncStatus ? (
                      <span className={syncTone(row.lastSyncStatus)}>{row.lastSyncStatus}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button type="button" onClick={() => setSetup(row.agentId)} className={mutedBtn}>
                      <KeyRound className="w-3 h-3" /> {a.issueKey}
                    </button>
                    <div className="mt-1 text-[10px] text-[var(--text-faint)] max-w-xs ml-auto">{a.installHint}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-[10px] text-[var(--text-faint)]">{a.setupHint}</p>
      {setup !== null && <AgentSetupModal initialAgentId={setup} t={t} onClose={() => setSetup(null)} />}
    </div>
  )
}

const KIND_ICONS: Record<SourceFamily, React.ComponentType<{ className?: string }>> = {
  folder: Folder,
  site: Globe,
  bucket: Cloud,
  mcp: Plug,
  repo: GitBranch,
  gdrive: HardDrive,
  onedrive: CloudCog,
  dropbox: Package,
  external: Upload,
  other: Plug,
}

function kindTitle(t: ConnectionsT, family: SourceFamily, connector: string): string {
  return fill(t.kinds[family].title, { connector })
}

function KindLabel({
  family,
  connector,
  t,
}: {
  family: SourceFamily
  connector: string
  t: ConnectionsT
}) {
  const Icon = KIND_ICONS[family]
  return (
    <span className="inline-flex items-center gap-1 text-[var(--text)]">
      <Icon className="w-3 h-3 text-[var(--text-muted)]" /> {kindTitle(t, family, connector)}
    </span>
  )
}

/**
 * One kind of thing the packs here can read — a folder, a site, a
 * bucket, an MCP server, a repository — with what it is in plain words,
 * whether it can be connected right now (and what to do if not), and
 * the pack behind it in small print.
 */
function SourceKindCard({
  card,
  t,
  lang,
  onConnect,
}: {
  card: SourceCard
  t: ConnectionsT
  lang: string
  onConnect: () => void
}) {
  const k = t.kinds
  const Icon = KIND_ICONS[card.family]
  const flag = `SOURCE_KIND_${card.connector.toUpperCase()}`
  const status = card.accepted ? card.availability : 'notAccepted'
  const connectable = card.accepted && card.availability !== 'missing'
  const oauth = card.entries[0]?.oauth ?? null
  const hint =
    status === 'ready' && oauth && !oauth.configured
      ? fill(k.statusHint.oauthUnconfigured, {
          provider: oauth.title,
          flag: `SOURCE_OAUTH_${oauth.provider.toUpperCase()}_CLIENT_ID`,
        })
      : fill(k.statusHint[status], { flag })
  const shapes = [...new Set(card.entries.map((e) => e.shape))]
  return (
    <article
      className={`flex flex-col rounded-md border p-3 ${
        connectable ? 'border-[var(--border)] bg-[var(--bg-elevated)]' : 'border-[var(--border)] bg-[var(--bg)] opacity-80'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded bg-[var(--accent)]/10 text-[var(--accent)]">
            <Icon className="w-4 h-4" />
          </span>
          <div>
            <h3 className="text-sm font-medium text-[var(--text)]">
              {kindTitle(t, card.family, card.connector)}
              {card.ambiguous && (
                <span className="ml-1 text-[10px] font-normal text-[var(--text-faint)]">
                  {fill(k.viaPack, { packId: card.packId })}
                </span>
              )}
            </h3>
            <div className="text-[10px] text-[var(--text-faint)]">
              {shapes
                .filter((sh) => sh === 'document' || sh === 'binary')
                .map((sh) => (sh === 'binary' ? k[card.family].shapes.binary : k[card.family].shapes.document))
                .join(' · ')}
            </div>
          </div>
        </div>
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${availabilityTone(status === 'notAccepted' ? 'disabled' : status)}`} title={hint || undefined}>
          {k.status[status]}
        </span>
      </div>
      <p className="mt-2 text-[11px] text-[var(--text-muted)] flex-1">
        {k[card.family].body || card.entries[0]?.description || ''}
      </p>
      {hint && (
        <p className="mt-1 text-[10px] text-[var(--warning)]">
          {hint}
          {status === 'notAccepted' && (
            <>
              {' '}
              <Link href={`/${lang}/admin/packs`} className="underline">
                {t.catalog.reinstall}
              </Link>
            </>
          )}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-[var(--text-faint)]" title={card.entries.map((e) => e.sourceId).join(', ')}>
          {card.packId}
          {' '}
          {card.packVersion}
          {card.builtin ? ` · ${t.catalog.builtin}` : ''}
        </span>
        <button type="button" disabled={!connectable} onClick={onConnect} className={accentBtn}>
          <Plug className="w-3 h-3" /> {k.connect}
        </button>
      </div>
    </article>
  )
}
