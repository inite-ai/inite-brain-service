'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { JsonView } from './JsonView'

interface AuditEvent {
  id: string
  companyId: string
  source: string
  recordId: string
  op: string
  ts: string
  versionstamp: number
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  consumedBy: string
}

interface AuditPage {
  events: AuditEvent[]
  totalsBySource: Record<string, number>
  totalsByOp: Record<string, number>
  hourly: Array<{ hour: string; count: number }>
  error?: string
}

const SOURCES = ['', 'knowledge_entity', 'knowledge_fact', 'knowledge_edge']
const OPS = ['', 'create', 'update', 'delete', 'define']

const OP_TONE: Record<string, string> = {
  create: 'text-[var(--success)]',
  update: 'text-[var(--accent)]',
  delete: 'text-[var(--danger)]',
  define: 'text-[var(--text-muted)]',
}

export function AuditLog() {
  const [data, setData] = useState<AuditPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState({
    companyId: '',
    source: '',
    op: '',
    since: '',
    limit: 200,
  })
  const [selected, setSelected] = useState<AuditEvent | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filter.companyId) params.set('companyId', filter.companyId)
      if (filter.source) params.set('source', filter.source)
      if (filter.op) params.set('op', filter.op)
      if (filter.since) params.set('since', filter.since)
      params.set('limit', String(filter.limit))
      const res = await fetch(
        `/api/admin/proxy/v1/admin/audit?${params.toString()}`,
        { cache: 'no-store' },
      )
      const json = (await res.json()) as AuditPage
      if (!res.ok) throw new Error(json.error ?? `Failed ${res.status}`)
      setData(json)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    void load()
  }, [load])

  const sourceData = useMemo(
    () =>
      Object.entries(data?.totalsBySource ?? {}).map(([source, count]) => ({
        source,
        count,
      })),
    [data],
  )
  const opData = useMemo(
    () =>
      Object.entries(data?.totalsByOp ?? {}).map(([op, count]) => ({
        op,
        count,
      })),
    [data],
  )

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)]">
            Audit log
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            CHANGEFEED tail (migration 0023). Per-tenant <code>audit_event</code>{' '}
            rows from <code>knowledge_entity / fact / edge</code> with
            before/after payloads. Read-only, retention 30d at the source.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          refresh
        </button>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 text-xs">
        <input
          placeholder="companyId"
          value={filter.companyId}
          onChange={(e) =>
            setFilter((f) => ({ ...f, companyId: e.target.value }))
          }
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] font-mono"
        />
        <select
          value={filter.source}
          onChange={(e) => setFilter((f) => ({ ...f, source: e.target.value }))}
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)]"
        >
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s || 'all sources'}
            </option>
          ))}
        </select>
        <select
          value={filter.op}
          onChange={(e) => setFilter((f) => ({ ...f, op: e.target.value }))}
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)]"
        >
          {OPS.map((o) => (
            <option key={o} value={o}>
              {o || 'all ops'}
            </option>
          ))}
        </select>
        <input
          type="datetime-local"
          value={filter.since}
          onChange={(e) => setFilter((f) => ({ ...f, since: e.target.value }))}
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] font-mono"
        />
        <input
          type="number"
          value={filter.limit}
          min={10}
          max={500}
          onChange={(e) =>
            setFilter((f) => ({
              ...f,
              limit: Math.min(500, Math.max(10, parseInt(e.target.value, 10))),
            }))
          }
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] font-mono"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <ChartCard title="By source">
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={sourceData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="source" stroke="var(--text-faint)" fontSize={10} />
              <YAxis stroke="var(--text-faint)" fontSize={10} />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  fontSize: 11,
                }}
              />
              <Bar dataKey="count" fill="var(--accent)" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="By op">
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={opData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="op" stroke="var(--text-faint)" fontSize={10} />
              <YAxis stroke="var(--text-faint)" fontSize={10} />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  fontSize: 11,
                }}
              />
              <Bar dataKey="count">
                {opData.map((o) => (
                  <Cell
                    key={o.op}
                    fill={
                      o.op === 'delete'
                        ? 'var(--danger)'
                        : o.op === 'create'
                          ? 'var(--success)'
                          : 'var(--accent)'
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Hourly volume">
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={data?.hourly ?? []}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="hour"
                stroke="var(--text-faint)"
                fontSize={9}
                tickFormatter={(h) => (h as string).slice(11, 13)}
              />
              <YAxis stroke="var(--text-faint)" fontSize={10} />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  fontSize: 11,
                }}
              />
              <Bar dataKey="count" fill="var(--accent)" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      <div className="rounded-md border border-[var(--border)] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-2 font-medium">ts</th>
              <th className="text-left px-3 py-2 font-medium">tenant</th>
              <th className="text-left px-3 py-2 font-medium">source</th>
              <th className="text-left px-3 py-2 font-medium">op</th>
              <th className="text-left px-3 py-2 font-medium">recordId</th>
              <th className="text-right px-3 py-2 font-medium">v#</th>
              <th className="text-right px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {(data?.events ?? []).map((e) => (
              <tr
                key={e.id}
                className="border-t border-[var(--border)] hover:bg-[var(--bg-overlay)]/40 cursor-pointer"
                onClick={() => setSelected(e)}
              >
                <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)]">
                  {new Date(e.ts).toISOString().slice(0, 19).replace('T', ' ')}
                </td>
                <td className="px-3 py-2 font-mono text-[10px] text-[var(--text)]">
                  {e.companyId}
                </td>
                <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)]">
                  {e.source}
                </td>
                <td
                  className={`px-3 py-2 font-mono text-[10px] ${OP_TONE[e.op] ?? ''}`}
                >
                  {e.op}
                </td>
                <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)] truncate max-w-[16ch]">
                  {e.recordId}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[10px] text-[var(--text-faint)] tabular-nums">
                  {e.versionstamp}
                </td>
                <td className="px-3 py-2 text-right">
                  <ChevronRight className="inline w-3 h-3 text-[var(--text-faint)]" />
                </td>
              </tr>
            ))}
            {(data?.events ?? []).length === 0 && !loading && (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-6 text-center text-[var(--text-muted)] italic"
                >
                  No audit events. The CHANGEFEED consumer may not have ticked
                  yet, or filters exclude everything.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <EventDrawer event={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

function ChartCard({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
        {title}
      </div>
      {children}
    </div>
  )
}

function EventDrawer({
  event,
  onClose,
}: {
  event: AuditEvent
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 flex items-stretch justify-end"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-elevated)] border-l border-[var(--border)] w-full max-w-2xl h-full overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--text)] font-mono">
              {event.op} · {event.source}
            </div>
            <div className="text-[10px] text-[var(--text-muted)] truncate">
              {event.recordId} · v#{event.versionstamp} ·{' '}
              {new Date(event.ts).toISOString()}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            close
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <Pane title="before" body={event.before ?? null} />
          <Pane title="after" body={event.after ?? null} />
        </div>
      </div>
    </div>
  )
}

function Pane({
  title,
  body,
}: {
  title: string
  body: Record<string, unknown> | null
}) {
  return (
    <div className="border border-[var(--border)] rounded-md bg-[var(--bg)] p-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
        {title}
      </div>
      {body ? (
        <JsonView value={body} />
      ) : (
        <div className="italic text-[var(--text-faint)]">∅</div>
      )}
    </div>
  )
}
