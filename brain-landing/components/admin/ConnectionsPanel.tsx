'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { KeyRound, Laptop, Plug, Plus, RefreshCw } from 'lucide-react'
import { useLoader } from '../../hooks/useLoader'
import { ErrorLine } from './policies/ui'
import { getMessages, normalizeLang } from '../../lib/i18n'
import type {
  SourceAgent,
  SourceCatalogResponse,
  SourceConnection,
  SourceConnectionsListResponse,
  SyncNowResponse,
} from '../../lib/contracts/admin-source-connections'
import { AccountsSection } from './connections/AccountsSection'
import { AgentsSection } from './connections/AgentsSection'
import { CatalogSection } from './connections/CatalogSection'
import { ConnectionCreateModal } from './connections/ConnectionCreateModal'
import { ConnectionDetail } from './connections/ConnectionDetail'
import { ConnectionsTable, type ConnectionActions } from './connections/ConnectionsTable'
import { cardsOf, labelOf, type SourceCard } from './connections/kinds'
import {
  PROXY,
  connectionPath,
  errorMessage,
  fill,
  type ConnectionsT,
} from './connections/shared'

type Tab = 'connections' | 'catalog' | 'agents' | 'accounts'
const TABS: readonly Tab[] = ['connections', 'catalog', 'agents', 'accounts']

/**
 * Source-plane operator surface, four tabs: the connections this tenant
 * has (folded by source group, with the one it is looking at underneath),
 * the catalogue of what it could connect (every pack's declared `sources`
 * with consent + connector state, by group), the local agents, and the
 * accounts cloud sources are read as. Mirrors /v1/admin/source-connections
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
  const [chosenTab, setChosenTab] = useState<Tab | null>(null)

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

  const connections = useMemo(() => data?.connections ?? [], [data])
  // Nothing connected yet → open on the catalogue; otherwise on what is connected.
  const tab: Tab = chosenTab ?? (data && connections.length === 0 ? 'catalog' : 'connections')
  const counts = useMemo(
    () => ({
      connections: connections.length,
      catalog: catalog ? cardsOf(catalog.sources).length : 0,
      agents: new Set([
        ...agents.map((a) => a.agentId),
        ...connections.filter((c) => c.host.startsWith('agent:')).map((c) => c.host.slice('agent:'.length)),
      ]).size,
    }),
    [connections, catalog, agents],
  )

  const selected = useMemo(
    () => connections.find((c) => c.id === selectedId) ?? null,
    [connections, selectedId],
  )
  // The detail sits under a table that can be a screen tall: bring it into view when the choice changes.
  const detailRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selectedId) detailRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [selectedId])
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

  const actions = useMemo<ConnectionActions>(
    () => ({
      select: (c) => setSelectedId((cur) => (cur === c.id ? null : c.id)),
      sync: (c, full) =>
        void act(c.id, async () => {
          const res = await fetch(connectionPath(c.id, '/sync'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ full }),
          })
          const json = (await res.json()) as SyncNowResponse
          if (!res.ok) throw new Error(errorMessage(json, res.status))
          if (!json.enqueued) return null
          return fill(json.created ? t.list.enqueued : t.list.alreadyQueued, { runId: json.runId })
        }),
      setStatus: (c, status) =>
        void act(c.id, async () => {
          const res = await fetch(connectionPath(c.id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          })
          const json = await res.json()
          if (!res.ok) throw new Error(errorMessage(json, res.status))
          return null
        }),
      remove: (c) => {
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
          setSelectedId((cur) => (cur === c.id ? null : cur))
          return fill(t.list.deleted, { label, n: (json as { items: number }).items })
        })
      },
    }),
    [act, t],
  )

  const onCreated = useCallback(
    (created: SourceConnection[]) => {
      setCreating(null)
      const first = created[0]
      if (first) {
        setNotice(
          fill(created.length > 1 ? t.create.createdBoth : t.create.created, { label: labelOf(first) }),
        )
        setSelectedId(first.id)
        setChosenTab('connections')
      }
      void reload()
    },
    [reload, t],
  )

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Plug className="w-4 h-4 text-[var(--accent)]" /> {t.title}
          </h1>
          <p className="text-xs text-[var(--text-muted)] max-w-3xl">{t.subtitle}</p>
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
      {notice && <div className="text-xs text-[var(--success)] font-mono">{notice}</div>}

      {off && (
        <article className="p-3 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/5 space-y-1">
          <h2 className="text-sm font-semibold text-[var(--text)]">{t.off.title}</h2>
          <p className="text-xs text-[var(--text-muted)] font-mono">{t.off.body}</p>
        </article>
      )}

      {!off && data && (
        <>
          <TabBar tab={tab} counts={counts} t={t} onChange={setChosenTab} />

          {tab === 'connections' && (
            <div className="space-y-4">
              <ConnectionsTable
                connections={connections}
                selectedId={selectedId}
                busy={busy}
                t={t}
                actions={actions}
                onAddSource={() => setChosenTab('catalog')}
              />
              {selected && (
                <div ref={detailRef} className="scroll-mt-4">
                  <ConnectionDetail
                    key={selected.id}
                    connection={selected}
                    entry={selectedEntry}
                    webhooksOn={catalog?.webhooks === true}
                    t={t}
                    onClose={() => setSelectedId(null)}
                    onChanged={reload}
                  />
                </div>
              )}
            </div>
          )}

          {tab === 'catalog' && catalog && (
            <CatalogSection catalog={catalog} t={t} lang={lang} onConnect={setCreating} />
          )}

          {tab === 'agents' && <AgentsSection connections={connections} agents={agents} t={t} />}

          {tab === 'accounts' && (
            <AccountsSection connections={connections} refreshKey={connections.length} t={t} />
          )}
        </>
      )}

      {creating && catalog && (
        <ConnectionCreateModal
          card={creating}
          catalog={catalog}
          t={t}
          onClose={() => setCreating(null)}
          onCreated={onCreated}
        />
      )}
    </div>
  )
}

const TAB_ICONS: Record<Tab, React.ComponentType<{ className?: string }>> = {
  connections: Plug,
  catalog: Plus,
  agents: Laptop,
  accounts: KeyRound,
}

function TabBar({
  tab,
  counts,
  t,
  onChange,
}: {
  tab: Tab
  counts: { connections: number; catalog: number; agents: number }
  t: ConnectionsT
  onChange: (tab: Tab) => void
}) {
  return (
    <nav role="tablist" className="flex gap-1 border-b border-[var(--border)]">
      {TABS.map((id) => {
        const Icon = TAB_ICONS[id]
        const active = id === tab
        const count = id === 'accounts' ? null : counts[id]
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={`-mb-px px-3 py-1.5 text-xs inline-flex items-center gap-1.5 border-b-2 ${
              active
                ? 'border-[var(--accent)] text-[var(--text)]'
                : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            <Icon className={`w-3.5 h-3.5 ${active ? 'text-[var(--accent)]' : ''}`} />
            {t.tabs[id]}
            {count !== null && (
              <span className="font-mono text-[10px] text-[var(--text-faint)]">{count}</span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
