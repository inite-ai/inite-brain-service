'use client'

import { useCallback, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ExternalLink, Loader2, Play, X } from 'lucide-react'
import { useLoader } from '../../../hooks/useLoader'
import { JsonView } from '../JsonView'
import { Segmented } from '../policies/ui'
import { normalizeLang } from '../../../lib/i18n'
import {
  SOURCE_ITEM_STATES,
  type SourceCatalogEntry,
  type SourceConnection,
  type SourceConnectionStats,
  type SourceItem,
  type SourceItemsListResponse,
  type SourceItemState,
  type SourceRun,
  type SourceRunsResponse,
  type SourceSyncSummary,
  type SyncNowResponse,
} from '../../../lib/contracts/admin-source-connections'
import { ItemInspect } from './ItemInspect'
import { WebhookSection } from './WebhookSection'
import {
  accentBtn,
  connectionPath,
  errorMessage,
  fill,
  stamp,
  type ConnectionsT,
} from './shared'

const PAGE = 50
const RUNS = 20

type StateFilter = '' | SourceItemState

/**
 * One connection opened: its identity and policies, what it produced
 * (catalogue rows by state, the facts it grounds), every run it had
 * (queued, inline, agent — one job_run each), the catalogue it built
 * (paged, filterable by state, every row openable to its document /
 * asset / facts) and an inline sync that shows the run's counters.
 */
export function ConnectionDetail({
  connection,
  entry,
  webhooksOn,
  t,
  onClose,
  onChanged,
}: {
  connection: SourceConnection
  /** The pack's catalogue entry this connection instantiates; null when the pack no longer declares it. */
  entry: SourceCatalogEntry | null
  /** SOURCE_WEBHOOKS on this brain (the catalogue says). */
  webhooksOn: boolean
  t: ConnectionsT
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  const d = t.detail
  const [items, setItems] = useState<SourceItemsListResponse | null>(null)
  const [stats, setStats] = useState<SourceConnectionStats | null>(null)
  const [runs, setRuns] = useState<SourceRunsResponse | null>(null)
  const [state, setState] = useState<StateFilter>('')
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<SourceSyncSummary | null>(null)
  const [running, setRunning] = useState(false)
  const [inspecting, setInspecting] = useState<SourceItem | null>(null)

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        limit: String(PAGE),
        offset: String(offset),
      })
      if (state) params.set('state', state)
      const [itemsRes, statsRes, runsRes] = await Promise.all([
        fetch(`${connectionPath(connection.id, '/items')}?${params.toString()}`, {
          cache: 'no-store',
        }),
        fetch(connectionPath(connection.id, '/stats'), { cache: 'no-store' }),
        fetch(`${connectionPath(connection.id, '/runs')}?limit=${RUNS}`, {
          cache: 'no-store',
        }),
      ])
      const itemsJson = await itemsRes.json()
      if (!itemsRes.ok) throw new Error(errorMessage(itemsJson, itemsRes.status))
      setItems(itemsJson as SourceItemsListResponse)
      const statsJson = await statsRes.json()
      if (!statsRes.ok) throw new Error(errorMessage(statsJson, statsRes.status))
      setStats(statsJson as SourceConnectionStats)
      const runsJson = await runsRes.json()
      if (!runsRes.ok) throw new Error(errorMessage(runsJson, runsRes.status))
      setRuns(runsJson as SourceRunsResponse)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [connection.id, offset, state])

  const { loading, reload } = useLoader(load)

  const runInline = useCallback(async () => {
    setRunning(true)
    setError(null)
    try {
      const res = await fetch(connectionPath(connection.id, '/sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inline: true }),
      })
      const json = (await res.json()) as SyncNowResponse
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      if (!json.enqueued) setSummary(json.summary)
      await Promise.all([reload(), onChanged()])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }, [connection.id, onChanged, reload])

  const total = items?.total ?? 0
  const title = connection.label ?? `${connection.packId}/${connection.sourceId}`
  const agentId = connection.host.startsWith('agent:')
    ? connection.host.slice('agent:'.length)
    : null

  return (
    <section className="rounded-md border border-[var(--accent)]/40 bg-[var(--bg-elevated)] p-3 space-y-3">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">
            {d.title}
            {': '}
            <span className="font-mono">{title}</span>
          </h2>
          <p className="text-[10px] font-mono text-[var(--text-faint)]">
            {connection.id}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[var(--text-faint)] hover:text-[var(--text)]"
          aria-label={d.close}
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="text-[11px]">
        <span className="text-[var(--text-muted)]">{d.source}</span>
        {': '}
        {entry ? (
          <>
            <span className="text-[var(--text)]">{entry.title ?? entry.sourceId}</span>
            <span className="font-mono text-[var(--text-faint)]">
              {' · '}
              {entry.packId}
              {'/'}
              {entry.sourceId}
              {' · '}
              {entry.connector}
              {' · '}
              {entry.shape}
            </span>
            {entry.description && (
              <div className="text-[10px] text-[var(--text-muted)] max-w-3xl">
                {entry.description}
              </div>
            )}
          </>
        ) : (
          <span className="text-[var(--warning)]">{d.sourceUnknown}</span>
        )}
      </div>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-[11px]">
        <Meta
          k={d.host}
          v={agentId ? fill(d.hostAgent, { agentId }) : d.hostServer}
          mono={agentId !== null}
        />
        <Meta k={d.sourceKey} v={connection.sourceKey} mono />
        <Meta k={d.recorder} v={connection.recorder} mono />
        <Meta k={d.vertical} v={connection.vertical} mono />
        <Meta k={d.mode} v={connection.mode} />
        <Meta k={d.contentPolicy} v={connection.contentPolicy} />
        <Meta k={d.deletePolicy} v={connection.deletePolicy} />
        <Meta
          k={d.fetchBudget}
          v={connection.fetchBudget === null ? '—' : String(connection.fetchBudget)}
        />
        <Meta
          k={d.credential}
          v={connection.hasCredential ? d.credentialStored : d.credentialNone}
        />
      </dl>

      {stats && <StatsStrip stats={stats} t={t} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
            {d.config}
          </div>
          <JsonView value={connection.config} />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
            {d.checkpoint}
          </div>
          <JsonView value={connection.checkpoint} />
        </div>
      </div>

      {connection.lastError && (
        <div className="text-[11px]">
          <span className="text-[var(--text-muted)]">{d.lastError}</span>
          {': '}
          <span className="font-mono text-[var(--danger)]">
            {connection.lastError}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={running || connection.status !== 'active' || agentId !== null}
          onClick={() => void runInline()}
          className={accentBtn}
          title={d.runInlineHint}
        >
          {running ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Play className="w-3 h-3" />
          )}
          {running ? d.running : d.runInline}
        </button>
        <span className="text-[10px] text-[var(--text-faint)]">
          {d.runInlineHint}
        </span>
      </div>

      {error && <div className="font-mono text-xs text-[var(--danger)]">{error}</div>}

      {summary && <SummaryCard summary={summary} t={t} />}

      {agentId === null && (
        <WebhookSection connection={connection} entry={entry} webhooksOn={webhooksOn} t={t} onChanged={onChanged} />
      )}

      {runs && <RunsTable runs={runs} t={t} lang={lang} />}

      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-xs font-medium text-[var(--text)]">
              {t.items.title}
            </h3>
            <p className="text-[10px] text-[var(--text-muted)]">
              {fill(t.items.subtitle, { total })}
              {' '}
              {t.item.openHint}
            </p>
          </div>
          <Segmented<StateFilter>
            value={state}
            options={[
              { value: '', label: t.items.all },
              ...SOURCE_ITEM_STATES.map((s) => ({
                value: s,
                label: t.items.state[s],
              })),
            ]}
            onChange={(v) => {
              setOffset(0)
              setState(v)
            }}
          />
        </div>
        <div className="rounded-md border border-[var(--border)] overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-1.5">{t.items.headers.item}</th>
                <th className="text-left px-3 py-1.5">{t.items.headers.state}</th>
                <th className="text-left px-3 py-1.5">
                  {t.items.headers.revision}
                </th>
                <th className="text-right px-3 py-1.5">{t.items.headers.size}</th>
                <th className="text-left px-3 py-1.5">
                  {t.items.headers.lastSeen}
                </th>
                <th className="text-left px-3 py-1.5">{t.items.headers.error}</th>
              </tr>
            </thead>
            <tbody>
              {(items?.items ?? []).map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-[var(--border)] cursor-pointer hover:bg-[var(--accent)]/5"
                  onClick={() => setInspecting(row)}
                >
                  <td className="px-3 py-1.5 font-mono text-[var(--text)] max-w-[24rem] truncate" title={row.originUri ?? row.externalId}>
                    {row.path ?? row.title ?? row.externalId}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${stateTone(row.state)}`}>
                      {t.items.state[row.state]}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)] max-w-[10rem] truncate" title={row.revision ?? undefined}>
                    {row.revision ?? '—'}
                    {row.fetchedRevision && row.revision && row.fetchedRevision !== row.revision && (
                      <span className="ml-1 text-[var(--warning)]">{'≠'}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[var(--text-muted)]">
                    {row.size === null ? '—' : row.size}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
                    {stamp(row.lastSeenAt)}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--danger)] max-w-[16rem] truncate" title={row.lastError ?? undefined}>
                    {row.lastError ?? ''}
                  </td>
                </tr>
              ))}
              {items && items.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-[var(--text-muted)] italic">
                    {t.items.empty}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
          <span className="font-mono">
            {offset + 1}
            {'–'}
            {Math.min(offset + PAGE, total)}
            {' / '}
            {total}
            {loading ? ' …' : ''}
          </span>
          <span className="inline-flex gap-1.5">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
              className="px-1.5 py-0.5 rounded bg-[var(--bg-overlay)] disabled:opacity-40"
            >
              {t.items.prev}
            </button>
            <button
              type="button"
              disabled={offset + PAGE >= total}
              onClick={() => setOffset((o) => o + PAGE)}
              className="px-1.5 py-0.5 rounded bg-[var(--bg-overlay)] disabled:opacity-40"
            >
              {t.items.next}
            </button>
          </span>
        </div>
      </div>

      {inspecting && (
        <ItemInspect
          connectionId={connection.id}
          item={inspecting}
          t={t}
          onClose={() => setInspecting(null)}
        />
      )}
    </section>
  )
}

function Meta({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-[var(--text-muted)]">{k}</dt>
      <dd className={`text-[var(--text)] truncate ${mono ? 'font-mono' : ''}`} title={v}>
        {v}
      </dd>
    </>
  )
}

function stateTone(state: SourceItemState): string {
  switch (state) {
    case 'indexed':
      return 'text-[var(--success)] bg-[var(--success)]/10'
    case 'gone':
      return 'text-[var(--text-faint)] bg-[var(--bg-overlay)] line-through'
    case 'fetched':
      return 'text-[var(--accent)] bg-[var(--accent)]/10'
    default:
      return 'text-[var(--warning)] bg-[var(--warning)]/10'
  }
}

/** Catalogue rows by state and the facts the connection grounds. */
function StatsStrip({ stats, t }: { stats: SourceConnectionStats; t: ConnectionsT }) {
  const s = t.stats
  const cells: Array<{ label: string; n: number | string; tone?: string }> = [
    { label: t.items.state.seen, n: stats.items.seen },
    { label: t.items.state.fetched, n: stats.items.fetched },
    { label: t.items.state.indexed, n: stats.items.indexed, tone: 'text-[var(--success)]' },
    { label: t.items.state.gone, n: stats.items.gone, tone: 'text-[var(--text-faint)]' },
  ]
  const facts: Array<{ label: string; n: number | string; tone?: string }> = stats.facts
    ? [
        { label: s.active, n: stats.facts.active, tone: 'text-[var(--success)]' },
        {
          label: s.stale,
          n: stats.facts.stale,
          tone: stats.facts.stale > 0 ? 'text-[var(--warning)]' : undefined,
        },
        { label: s.closed, n: stats.facts.closed, tone: 'text-[var(--text-faint)]' },
      ]
    : [{ label: s.facts, n: s.factsUnknown }]
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-[11px]" title={s.hint}>
      <div className="flex items-center gap-2 mb-1">
        <span className="font-medium text-[var(--text)]">{s.title}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1 items-center">
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
          {s.items}
          {' '}
          <span className="font-mono normal-case tracking-normal">{stats.items.total}</span>
        </span>
        <div className="flex flex-wrap gap-1">
          {cells.map((c) => (
            <Cell key={c.label} label={c.label} n={c.n} tone={c.tone} />
          ))}
        </div>
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
          {s.facts}
        </span>
        <div className="flex flex-wrap gap-1">
          {facts.map((c) => (
            <Cell key={c.label} label={c.label} n={c.n} tone={c.tone} />
          ))}
        </div>
      </div>
    </div>
  )
}

function Cell({ label, n, tone }: { label: string; n: number | string; tone?: string | undefined }) {
  return (
    <span className="rounded bg-[var(--bg-overlay)] px-1.5 py-0.5 inline-flex items-baseline gap-1">
      <span className="text-[9px] uppercase tracking-wider text-[var(--text-faint)]">{label}</span>
      <span className={`font-mono tabular-nums ${tone ?? 'text-[var(--text)]'}`}>{n}</span>
    </span>
  )
}

/** Every run of the connection, newest first — each a source_sync job. */
function RunsTable({ runs, t, lang }: { runs: SourceRunsResponse; t: ConnectionsT; lang: string }) {
  const r = t.runs
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-xs font-medium text-[var(--text)]">{r.title}</h3>
          <p className="text-[10px] text-[var(--text-muted)]">{r.subtitle}</p>
        </div>
        <Link
          href={`/${lang}/admin/jobs?jobType=source_sync`}
          className="text-[10px] text-[var(--accent)] inline-flex items-center gap-1"
        >
          <ExternalLink className="w-3 h-3" /> {t.detail.openJobs}
        </Link>
      </div>
      {!runs.persisted && (
        <p className="text-[10px] text-[var(--warning)]">{r.notPersisted}</p>
      )}
      <div className="rounded-md border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-1.5">{r.headers.started}</th>
              <th className="text-left px-3 py-1.5">{r.headers.ranBy}</th>
              <th className="text-left px-3 py-1.5">{r.headers.trigger}</th>
              <th className="text-left px-3 py-1.5">{r.headers.mode}</th>
              <th className="text-left px-3 py-1.5">{r.headers.status}</th>
              <th className="text-left px-3 py-1.5">{r.headers.counters}</th>
              <th className="text-right px-3 py-1.5">{r.headers.duration}</th>
              <th className="text-right px-3 py-1.5">{r.headers.job}</th>
            </tr>
          </thead>
          <tbody>
            {runs.runs.map((run) => (
              <RunRow key={run.runId} run={run} t={t} lang={lang} />
            ))}
            {runs.persisted && runs.runs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-3 text-center text-[var(--text-muted)] italic">
                  {r.empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {runs.runs.length >= RUNS && (
        <p className="text-[10px] text-[var(--text-faint)]">{fill(r.more, { n: RUNS })}</p>
      )}
    </div>
  )
}

function RunRow({ run, t, lang }: { run: SourceRun; t: ConnectionsT; lang: string }) {
  const r = t.runs
  const c = run.counters
  const counters = c
    ? [c.seen, c.new, c.changed, c.gone, c.fetched, c.ingested, c.failed, c.closed].join(' · ')
    : '—'
  return (
    <tr className="border-t border-[var(--border)]">
      <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
        {stamp(run.startedAt)}
      </td>
      <td className="px-3 py-1.5 font-mono text-[var(--text)]">
        {run.ranBy === 'server' ? r.server : run.ranBy}
      </td>
      <td className="px-3 py-1.5 font-mono text-[var(--text-muted)]">{run.triggeredBy}</td>
      <td className="px-3 py-1.5 font-mono text-[var(--text-muted)]">{run.mode ?? '—'}</td>
      <td className="px-3 py-1.5">
        <span className={`font-mono ${runTone(run.status)}`}>{run.status}</span>
        {run.skipped && (
          <span className="ml-1 font-mono text-[10px] text-[var(--warning)]">
            {fill(r.skipped, { reason: run.skipped })}
          </span>
        )}
        {run.error && (
          <div className="font-mono text-[10px] text-[var(--danger)] max-w-[16rem] truncate" title={run.error}>
            {run.error}
          </div>
        )}
      </td>
      <td className="px-3 py-1.5 font-mono tabular-nums text-[var(--text-muted)]">{counters}</td>
      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[var(--text-muted)]">
        {run.durationMs === null ? '—' : `${run.durationMs} ms`}
      </td>
      <td className="px-3 py-1.5 text-right">
        <Link
          href={`/${lang}/admin/jobs?runId=${encodeURIComponent(run.runId)}`}
          className="text-[10px] text-[var(--accent)]"
          title={run.runId}
        >
          {r.openJob}
        </Link>
      </td>
    </tr>
  )
}

function runTone(status: SourceRun['status']): string {
  if (status === 'succeeded') return 'text-[var(--success)]'
  if (status === 'failed' || status === 'cancelled') return 'text-[var(--danger)]'
  return 'text-[var(--warning)]'
}

function SummaryCard({
  summary,
  t,
}: {
  summary: SourceSyncSummary
  t: ConnectionsT
}) {
  const s = t.detail.summary
  const counters: Array<[string, number]> = [
    [s.seen, summary.seen],
    [s.new, summary.new],
    [s.changed, summary.changed],
    [s.unchanged, summary.unchanged],
    [s.gone, summary.gone],
    [s.fetched, summary.fetched],
    [s.ingested, summary.ingested],
    [s.deduplicated, summary.deduplicated],
    [s.failed, summary.failed],
    [s.closed, summary.closed],
  ]
  const tone =
    summary.status === 'succeeded'
      ? 'text-[var(--success)]'
      : summary.status === 'failed'
        ? 'text-[var(--danger)]'
        : 'text-[var(--warning)]'
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-[11px] space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-[var(--text)]">{s.title}</span>
        <span className={`font-mono ${tone}`}>{summary.status}</span>
        <span className="font-mono text-[var(--text-faint)]">{summary.mode}</span>
        <span className="font-mono text-[var(--text-faint)]">
          {fill(s.duration, { ms: summary.durationMs })}
        </span>
        {summary.skipped && (
          <span className="font-mono text-[var(--warning)]">
            {fill(s.skipped, { reason: summary.skipped })}
          </span>
        )}
      </div>
      <div className="grid grid-cols-5 md:grid-cols-10 gap-1">
        {counters.map(([label, n]) => (
          <div key={label} className="rounded bg-[var(--bg-overlay)] px-1.5 py-1">
            <div className="text-[9px] uppercase tracking-wider text-[var(--text-faint)]">
              {label}
            </div>
            <div className="font-mono tabular-nums text-[var(--text)]">{n}</div>
          </div>
        ))}
      </div>
      {summary.error && (
        <div className="font-mono text-[var(--danger)]">{summary.error}</div>
      )}
    </div>
  )
}
