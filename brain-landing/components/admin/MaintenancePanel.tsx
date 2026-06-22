'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Cpu,
  Loader2,
  Moon,
  Play,
  RefreshCw,
  Sigma,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { getMessages, normalizeLang } from '../../lib/i18n'

type AdminT = ReturnType<typeof getMessages>['admin']

interface CronEntry {
  name: string
  cronTime: string
  lastFireAt: string | null
  nextFireAt: string | null
  running: boolean
}

interface JobRow {
  runId: string
  jobType: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  triggeredBy: 'cron' | 'manual' | 'startup'
  triggeredByActor?: string | null
  startedAt: string
  finishedAt?: string | null
  progress?: Record<string, unknown> | null
  result?: Record<string, unknown> | null
  error?: { message: string; name?: string } | null
  companyId: string
}

interface ChangefeedState {
  stats: {
    enabled: boolean
    inFlight: boolean
    lastTickAt: string | null
    lastPendingRemaining: number
    totalConsumed: number
    tickCount: number
    lastError: { message: string; ts: string } | null
    sources: readonly string[]
    perBatchLimit: number
  }
  cursors: Array<{ companyId: string; source: string; cursor: number }>
}

/**
 * Operator-daily cockpit. Five maintenance jobs (4 cron + changefeed
 * tick) shown as a grid of action cards with: last-run timestamp +
 * relative age, next-fire ETA, status colour, last-result summary,
 * "Run now" button. Plus changefeed lag + drain control + recent
 * jobs strip pulled from job_run.
 */
export function MaintenancePanel() {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  const t = getMessages(lang).admin
  const [scheduler, setScheduler] = useState<{ cron: CronEntry[] } | null>(null)
  const [recentJobs, setRecentJobs] = useState<JobRow[]>([])
  const [changefeed, setChangefeed] = useState<ChangefeedState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [sRes, jRes, cRes] = await Promise.all([
        fetch('/api/admin/proxy/v1/admin/scheduler', { cache: 'no-store' }),
        fetch('/api/admin/proxy/v1/admin/jobs?limit=50', { cache: 'no-store' }),
        fetch('/api/admin/proxy/v1/admin/changefeed/state', {
          cache: 'no-store',
        }),
      ])
      const [sJson, jJson, cJson] = await Promise.all([
        sRes.json(),
        jRes.json(),
        cRes.json(),
      ])
      if (!sRes.ok) throw new Error(sJson.error ?? `scheduler ${sRes.status}`)
      if (!jRes.ok) throw new Error(jJson.error ?? `jobs ${jRes.status}`)
      if (!cRes.ok) throw new Error(cJson.error ?? `changefeed ${cRes.status}`)
      setScheduler(sJson)
      setRecentJobs(jJson.jobs ?? [])
      setChangefeed(cJson)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const lastByJobType = useMemo(() => {
    const map = new Map<string, JobRow>()
    for (const j of recentJobs) {
      const existing = map.get(j.jobType)
      if (!existing || existing.startedAt < j.startedAt) {
        map.set(j.jobType, j)
      }
    }
    return map
  }, [recentJobs])

  const trigger = useCallback(
    async (
      kind:
        | 'dreams'
        | 'compaction'
        | 'calibration_refit'
        | 'reindex_embeddings'
        | 'changefeed_drain',
    ) => {
      setBusy(kind)
      setError(null)
      try {
        const endpoint =
          kind === 'dreams'
            ? '/api/admin/proxy/v1/admin/maintenance/dreams/run'
            : kind === 'compaction'
              ? '/api/admin/proxy/v1/admin/maintenance/compaction'
              : kind === 'calibration_refit'
                ? '/api/admin/proxy/v1/admin/maintenance/calibration-refit'
                : kind === 'reindex_embeddings'
                  ? '/api/admin/proxy/v1/admin/maintenance/reindex'
                  : '/api/admin/proxy/v1/admin/changefeed/drain'
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
        await load()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [load],
  )

  // Card metadata is i18n-resolved at render via t.maintenance.cards.<kind>.
  // The kind / icon / cronName / canTrigger are infrastructure-coupled,
  // NOT localised — only title + description live in translations.
  const cardMeta: Array<{
    kind:
      | 'dreams'
      | 'compaction'
      | 'calibration_refit'
      | 'source_trust_refit'
      | 'reindex_embeddings'
      | 'changefeed_drain'
    cronName: string | null
    icon: typeof Moon
    canTrigger: boolean
  }> = [
    {
      kind: 'dreams',
      cronName: 'DreamsService.runDaily',
      icon: Moon,
      canTrigger: true,
    },
    {
      kind: 'compaction',
      cronName: 'CompactionService.runDaily',
      icon: Sparkles,
      canTrigger: true,
    },
    {
      kind: 'calibration_refit',
      cronName: 'CalibrationRefitService.refitCalibrationDaily',
      icon: Sigma,
      canTrigger: true,
    },
    {
      kind: 'source_trust_refit',
      cronName: 'CalibrationRefitService.refitSourceTrustDaily',
      icon: Sigma,
      canTrigger: false,
    },
    {
      kind: 'reindex_embeddings',
      cronName: null,
      icon: Cpu,
      canTrigger: true,
    },
    {
      kind: 'changefeed_drain',
      cronName: 'ChangefeedConsumerService.tick',
      icon: Clock,
      canTrigger: true,
    },
  ]

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)]">
            {t.maintenance.title}
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            {t.maintenance.subtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          {t.common.refresh}
        </button>
      </header>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {cardMeta.map((c) => {
          const cronEntry =
            scheduler?.cron.find((e) => e.name === c.cronName) ?? null
          const lastJob = lastByJobType.get(c.kind) ?? null
          const Icon = c.icon
          const cardCopy = t.maintenance.cards[c.kind]
          const cronT = t.maintenance.cron
          return (
            <article
              key={c.kind}
              className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] flex flex-col gap-2"
            >
              <header className="flex items-baseline gap-2">
                <Icon className="w-4 h-4 text-[var(--accent)]" />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-[var(--text)]">
                    {cardCopy.title}
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)]">
                    {cardCopy.description}
                  </div>
                </div>
                {c.canTrigger && (
                  <button
                    type="button"
                    onClick={() => void trigger(c.kind as never)}
                    disabled={busy === c.kind}
                    className="px-2 py-1 rounded text-[10px] bg-[var(--accent)] text-white flex items-center gap-1 disabled:opacity-40"
                  >
                    {busy === c.kind ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Play className="w-3 h-3" />
                    )}
                    {t.maintenance.runNow}
                  </button>
                )}
              </header>
              <div className="grid grid-cols-2 gap-1 text-[10px] font-mono text-[var(--text-muted)]">
                <CronLine
                  label={cronT.label}
                  value={cronEntry?.cronTime ?? cronT.noCron}
                />
                <CronLine
                  label={cronT.lastFire}
                  value={
                    cronEntry?.lastFireAt
                      ? new Date(cronEntry.lastFireAt).toISOString().slice(0, 19).replace('T', ' ')
                      : cronT.noCron
                  }
                />
                <CronLine
                  label={cronT.nextFire}
                  value={
                    cronEntry?.nextFireAt
                      ? new Date(cronEntry.nextFireAt).toISOString().slice(0, 19).replace('T', ' ')
                      : cronT.noCron
                  }
                />
                <CronLine
                  label={cronT.state}
                  value={cronEntry?.running ? cronT.running : cronT.idle}
                />
              </div>
              {lastJob && <LastRunSummary job={lastJob} lang={lang} t={t} />}
            </article>
          )
        })}
      </section>

      {changefeed && (
        <section className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
          <header className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-[var(--text)]">
              {t.maintenance.changefeed.title}
            </h2>
            <span
              className={`ml-2 text-[10px] px-1.5 py-0.5 rounded font-mono ${
                changefeed.stats.enabled
                  ? changefeed.stats.lastPendingRemaining > 0
                    ? 'bg-[var(--warning)]/10 text-[var(--warning)]'
                    : 'bg-[var(--success)]/10 text-[var(--success)]'
                  : 'bg-[var(--bg-overlay)] text-[var(--text-faint)]'
              }`}
            >
              {changefeed.stats.enabled
                ? t.maintenance.changefeed.enabled
                : t.maintenance.changefeed.disabled}
            </span>
            {changefeed.stats.inFlight && (
              <Loader2 className="w-3 h-3 text-[var(--accent)] animate-spin" />
            )}
          </header>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
            <Stat
              label={t.maintenance.changefeed.stats.lastTick}
              value={
                changefeed.stats.lastTickAt
                  ? new Date(changefeed.stats.lastTickAt).toISOString().slice(11, 19)
                  : t.common.noData
              }
            />
            <Stat
              label={t.maintenance.changefeed.stats.pending}
              value={changefeed.stats.lastPendingRemaining.toString()}
              tone={changefeed.stats.lastPendingRemaining > 0 ? 'warn' : undefined}
            />
            <Stat
              label={t.maintenance.changefeed.stats.consumedTotal}
              value={changefeed.stats.totalConsumed.toLocaleString()}
            />
            <Stat
              label={t.maintenance.changefeed.stats.ticks}
              value={changefeed.stats.tickCount.toString()}
            />
            <Stat
              label={t.maintenance.changefeed.stats.batchLimit}
              value={changefeed.stats.perBatchLimit.toString()}
            />
          </div>
          {changefeed.stats.lastError && (
            <div className="mt-2 text-[10px] text-[var(--danger)] font-mono">
              {changefeed.stats.lastError.ts}: {changefeed.stats.lastError.message}
            </div>
          )}
          {changefeed.cursors.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                {t.maintenance.changefeed.cursors}
              </div>
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase text-[var(--text-faint)]">
                  <tr>
                    <th className="text-left px-2 py-1">
                      {t.maintenance.changefeed.cursorHeaders.tenant}
                    </th>
                    <th className="text-left px-2 py-1">
                      {t.maintenance.changefeed.cursorHeaders.source}
                    </th>
                    <th className="text-right px-2 py-1">
                      {t.maintenance.changefeed.cursorHeaders.versionstamp}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {changefeed.cursors.map((c, i) => (
                    <tr
                      key={`${c.companyId}-${c.source}-${i}`}
                      className="border-t border-[var(--border)] font-mono"
                    >
                      <td className="px-2 py-1 text-[var(--text-muted)]">
                        {c.companyId}
                      </td>
                      <td className="px-2 py-1 text-[var(--text-muted)]">
                        {c.source}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {c.cursor}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section>
        <header className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-[var(--text)]">
            {t.maintenance.recentJobs}
          </h2>
          <Link
            href={`/${lang}/admin/jobs`}
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            {t.maintenance.fullHistory}
          </Link>
        </header>
        <table className="w-full text-xs border border-[var(--border)] rounded-md overflow-hidden">
          <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-1.5">{t.jobs.table.started}</th>
              <th className="text-left px-3 py-1.5">{t.jobs.table.type}</th>
              <th className="text-left px-3 py-1.5">{t.jobs.table.tenant}</th>
              <th className="text-left px-3 py-1.5">{t.jobs.table.trigger}</th>
              <th className="text-left px-3 py-1.5">{t.jobs.table.status}</th>
              <th className="text-right px-3 py-1.5">
                {t.jobs.table.duration}
              </th>
            </tr>
          </thead>
          <tbody>
            {recentJobs.slice(0, 10).map((j) => (
              <tr key={j.runId} className="border-t border-[var(--border)] font-mono">
                <td className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
                  {new Date(j.startedAt).toISOString().slice(0, 19).replace('T', ' ')}
                </td>
                <td className="px-3 py-1 text-[var(--text)]">{j.jobType}</td>
                <td className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
                  {j.companyId}
                </td>
                <td className="px-3 py-1 text-[10px] text-[var(--text-faint)]">
                  {j.triggeredBy}
                </td>
                <td className="px-3 py-1">
                  <StatusBadge status={j.status} />
                </td>
                <td className="px-3 py-1 text-right text-[10px] tabular-nums text-[var(--text-muted)]">
                  {j.finishedAt
                    ? `${Math.round((new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) / 100) / 10}s`
                    : '—'}
                </td>
              </tr>
            ))}
            {recentJobs.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-4 text-center text-[var(--text-muted)] italic"
                >
                  {t.maintenance.noRecentJobs}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function CronLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-[var(--text-faint)] uppercase tracking-wider">
        {label}:
      </span>
      <span className="text-[var(--text)]">{value}</span>
    </div>
  )
}

function LastRunSummary({
  job,
  lang,
  t,
}: {
  job: JobRow
  lang: string
  t: AdminT
}) {
  const skipped =
    job.result &&
    typeof (job.result as Record<string, unknown>).skipped === 'boolean' &&
    (job.result as Record<string, boolean>).skipped
  const Icon = job.status === 'succeeded'
    ? skipped
      ? AlertTriangle
      : CheckCircle2
    : job.status === 'running'
      ? Loader2
      : job.status === 'failed'
        ? XCircle
        : CalendarClock
  const tone =
    job.status === 'succeeded'
      ? skipped
        ? 'text-[var(--warning)]'
        : 'text-[var(--success)]'
      : job.status === 'failed'
        ? 'text-[var(--danger)]'
        : 'text-[var(--text-muted)]'
  return (
    <div className="mt-1 border-t border-[var(--border)] pt-2">
      <div className="flex items-center gap-1.5 text-[10px]">
        <Icon
          className={`w-3 h-3 ${tone} ${job.status === 'running' ? 'animate-spin' : ''}`}
        />
        <span className={tone}>
          {t.maintenance.lastRun.replace('{status}', job.status)}
        </span>
        <span className="text-[var(--text-faint)] font-mono">
          {new Date(job.startedAt).toISOString().slice(11, 19)}
        </span>
        <Link
          href={`/${lang}/admin/jobs?runId=${encodeURIComponent(job.runId)}`}
          className="ml-auto text-[var(--accent)] hover:underline"
        >
          {t.maintenance.drillLink}
        </Link>
      </div>
      {skipped && job.result && (
        <div className="text-[10px] text-[var(--warning)] font-mono mt-0.5">
          {String((job.result as Record<string, string>).skipReason ?? '')}
        </div>
      )}
      {job.error && (
        <div className="text-[10px] text-[var(--danger)] font-mono mt-0.5 truncate">
          {job.error.message}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: JobRow['status'] }) {
  const tone =
    status === 'succeeded'
      ? 'text-[var(--success)] bg-[var(--success)]/10'
      : status === 'failed'
        ? 'text-[var(--danger)] bg-[var(--danger)]/10'
        : status === 'running'
          ? 'text-[var(--accent)] bg-[var(--accent)]/10'
          : status === 'cancelled'
            ? 'text-[var(--warning)] bg-[var(--warning)]/10'
            : 'text-[var(--text-faint)] bg-[var(--bg-overlay)]'
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${tone}`}>
      {status}
    </span>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'warn' | 'bad' | 'good'
}) {
  const toneClass =
    tone === 'warn'
      ? 'text-[var(--warning)]'
      : tone === 'bad'
        ? 'text-[var(--danger)]'
        : tone === 'good'
          ? 'text-[var(--success)]'
          : 'text-[var(--text)]'
  return (
    <div className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
        {label}
      </div>
      <div className={`mt-0.5 font-mono text-sm tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  )
}
