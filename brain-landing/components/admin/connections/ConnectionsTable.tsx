'use client'

import { useMemo, useState } from 'react'
import { Laptop, Loader2, Pause, Play, Plus, RotateCcw, Search, Trash2 } from 'lucide-react'
import type { SourceConnection } from '../../../lib/contracts/admin-source-connections'
import { GroupHeading, KindLabel } from './KindLabel'
import { familyOf, groupConnections, labelOf, matchesQuery, type SourceGroup } from './kinds'
import {
  accentBtn,
  dangerBtn,
  fill,
  mutedBtn,
  stamp,
  statusTone,
  syncTone,
  type ConnectionsT,
} from './shared'

export interface ConnectionActions {
  select: (c: SourceConnection) => void
  sync: (c: SourceConnection, full: boolean) => void
  setStatus: (c: SourceConnection, status: 'active' | 'paused') => void
  remove: (c: SourceConnection) => void
}

/**
 * The connections this tenant has, one table folded by source group
 * (files, web, MCP servers, code, records, pushed) with a filter and
 * the counts that matter at a glance — how many, how many paused, how
 * many whose last sync failed. Every verb is one the API has.
 */
export function ConnectionsTable({
  connections,
  selectedId,
  busy,
  t,
  actions,
  onAddSource,
}: {
  connections: SourceConnection[]
  selectedId: string | null
  busy: string | null
  t: ConnectionsT
  actions: ConnectionActions
  onAddSource: () => void
}) {
  const [query, setQuery] = useState('')
  const groups = useMemo(
    () => groupConnections(connections.filter((c) => matchesQuery(c, query))),
    [connections, query],
  )
  const paused = connections.filter((c) => c.status === 'paused').length
  const failed = connections.filter((c) => c.lastSyncStatus === 'failed').length
  const shown = groups.reduce((n, g) => n + g.items.length, 0)
  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-medium text-[var(--text)] flex items-center gap-2">
            {t.list.title}
            <span className="font-mono text-[10px] font-normal text-[var(--text-faint)]">{connections.length}</span>
            {paused > 0 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-normal text-[var(--warning)] bg-[var(--warning)]/10">
                {fill(t.list.pausedCount, { n: paused })}
              </span>
            )}
            {failed > 0 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-normal text-[var(--danger)] bg-[var(--danger)]/10">
                {fill(t.list.failedCount, { n: failed })}
              </span>
            )}
          </h2>
          <p className="text-[11px] text-[var(--text-muted)] max-w-3xl">{t.list.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {connections.length > 3 && (
            <label className="relative">
              <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-faint)]" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.list.filter}
                className="pl-6 pr-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-xs text-[var(--text)] w-56"
              />
            </label>
          )}
          <button type="button" onClick={onAddSource} className={accentBtn}>
            <Plus className="w-3 h-3" /> {t.list.addSource}
          </button>
        </div>
      </div>
      <div className="rounded-md border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-1.5">{t.list.headers.label}</th>
              <th className="text-left px-3 py-1.5">{t.list.headers.source}</th>
              <th className="text-left px-3 py-1.5">{t.list.headers.connector}</th>
              <th className="text-left px-3 py-1.5">{t.list.headers.schedule}</th>
              <th className="text-left px-3 py-1.5">{t.list.headers.status}</th>
              <th className="text-left px-3 py-1.5">{t.list.headers.lastSync}</th>
              <th className="text-right px-3 py-1.5">{t.list.headers.actions}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <GroupRows key={g.group} group={g.group} rows={g.items} t={t} selectedId={selectedId} busy={busy} actions={actions} />
            ))}
            {connections.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-[var(--text-muted)] italic">
                  {t.list.empty}
                </td>
              </tr>
            )}
            {connections.length > 0 && shown === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-[var(--text-muted)] italic">
                  {t.list.noMatch}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function GroupRows({
  group,
  rows,
  t,
  selectedId,
  busy,
  actions,
}: {
  group: SourceGroup
  rows: SourceConnection[]
  t: ConnectionsT
  selectedId: string | null
  busy: string | null
  actions: ConnectionActions
}) {
  return (
    <>
      <tr className="border-t border-[var(--border)] bg-[var(--bg-overlay)]/40">
        <td colSpan={7} className="px-3 py-1">
          <GroupHeading group={group} count={rows.length} t={t} as="span" />
        </td>
      </tr>
      {rows.map((c) => (
        <ConnectionRow key={c.id} c={c} t={t} selected={c.id === selectedId} busy={busy === c.id} actions={actions} />
      ))}
    </>
  )
}

function ConnectionRow({
  c,
  t,
  selected,
  busy,
  actions,
}: {
  c: SourceConnection
  t: ConnectionsT
  selected: boolean
  busy: boolean
  actions: ConnectionActions
}) {
  const onServer = c.host === 'server'
  return (
    <tr className={`border-t border-[var(--border)] ${selected ? 'bg-[var(--accent)]/5' : ''}`}>
      <td className="px-3 py-1.5 text-[var(--text)]">
        <button
          type="button"
          onClick={() => actions.select(c)}
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
        <span className="whitespace-nowrap">
          <KindLabel family={familyOf(c)} connector={c.connector} t={t} />
        </span>
        <span className="text-[var(--text-faint)]">
          {' · '}
          {c.shape === 'binary'
            ? t.form.shape.binary
            : c.shape === 'structure'
              ? t.form.shape.structure
              : t.form.shape.document}
        </span>
        <div className="font-mono text-[10px] text-[var(--text-faint)]">
          {c.packId}
          {'/'}
          {c.sourceId}
        </div>
      </td>
      <td className="px-3 py-1.5 text-[var(--text-muted)]">
        {onServer ? (
          t.detail.hostServer
        ) : (
          <span className="inline-flex items-center gap-1 font-mono">
            <Laptop className="w-3 h-3" /> {c.host.slice('agent:'.length)}
          </span>
        )}
      </td>
      <td className="px-3 py-1.5 font-mono text-[var(--text-muted)]">{c.schedule}</td>
      <td className="px-3 py-1.5">
        <span className={`px-1.5 py-0.5 rounded text-[10px] ${statusTone(c.status)}`}>{t.status[c.status]}</span>
      </td>
      <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
        {c.lastSyncAt ? stamp(c.lastSyncAt) : t.list.neverSynced}
        {c.lastSyncStatus && <span className={`ml-1 ${syncTone(c.lastSyncStatus)}`}>{c.lastSyncStatus}</span>}
        {c.lastError && (
          <div className="text-[var(--danger)] max-w-[16rem] truncate" title={c.lastError}>
            {c.lastError}
          </div>
        )}
      </td>
      <td className="px-3 py-1.5 text-right whitespace-nowrap">
        <span className="inline-flex gap-1 justify-end">
          <IconButton
            label={t.list.sync}
            disabled={busy || c.status !== 'active' || !onServer}
            hint={onServer ? undefined : t.agents.subtitle}
            onClick={() => actions.sync(c, false)}
            className={accentBtn}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          </IconButton>
          <IconButton
            label={t.list.full}
            disabled={busy || c.status !== 'active' || !onServer}
            hint={onServer ? undefined : t.agents.subtitle}
            onClick={() => actions.sync(c, true)}
            className={accentBtn}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </IconButton>
          {c.status === 'active' ? (
            <IconButton label={t.list.pause} disabled={busy} onClick={() => actions.setStatus(c, 'paused')} className={mutedBtn}>
              <Pause className="w-3.5 h-3.5" />
            </IconButton>
          ) : (
            <IconButton
              label={t.list.resume}
              disabled={busy || c.status === 'deleting'}
              onClick={() => actions.setStatus(c, 'active')}
              className={mutedBtn}
            >
              <Play className="w-3.5 h-3.5" />
            </IconButton>
          )}
          <IconButton label={t.list.inspect} onClick={() => actions.select(c)} className={mutedBtn}>
            <Search className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton label={t.list.delete} disabled={busy} onClick={() => actions.remove(c)} className={dangerBtn}>
            <Trash2 className="w-3.5 h-3.5" />
          </IconButton>
        </span>
      </td>
    </tr>
  )
}

/** A one-icon verb: the word lives in the tooltip and the accessible name. */
function IconButton({
  label,
  hint,
  disabled,
  onClick,
  className,
  children,
}: {
  label: string
  hint?: string
  disabled?: boolean
  onClick: () => void
  className: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={hint ? `${label} — ${hint}` : label}
      disabled={disabled}
      onClick={onClick}
      className={`${className} px-1.5 py-1`}
    >
      {children}
    </button>
  )
}
