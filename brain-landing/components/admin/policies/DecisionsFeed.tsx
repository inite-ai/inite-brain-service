'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { useCallback, useEffect, useState } from 'react'
import { Radio, RefreshCw, Scale } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  PolicyDecisionsResponse,
  PolicyDecisionsStatsResponse,
} from '../../../lib/contracts/admin-policies'
import { DecisionBadge, ModeBadge } from './PolicyBadges'
import { ErrorLine, Segmented } from './ui'

type DecisionFilter = 'all' | 'deny' | 'would_deny' | 'allow'

/**
 * The policy_decision stream: aggregate cards, report-only promotion
 * candidates, and the filterable event feed with cursor pagination.
 * (Charts + SSE live tail land with UI wave 2.)
 */
export function DecisionsFeed() {
  const [events, setEvents] = useState<PolicyDecisionsResponse['decisions']>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [stats, setStats] = useState<PolicyDecisionsStatsResponse | null>(null)
  const [filter, setFilter] = useState<DecisionFilter>('all')
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (before?: string) => {
      setLoading(true)
      try {
        const qs = new URLSearchParams()
        if (filter !== 'all') qs.set('decision', filter)
        if (before) qs.set('before', before)
        qs.set('limit', '50')
        const [feedRes, statsRes] = await Promise.all([
          fetch(`/api/admin/proxy/v1/admin/policy/decisions?${qs}`, {
            cache: 'no-store',
          }),
          before
            ? Promise.resolve(null)
            : fetch('/api/admin/proxy/v1/admin/policy/decisions/stats?windowDays=7', {
                cache: 'no-store',
              }),
        ])
        const feed = (await feedRes.json()) as PolicyDecisionsResponse
        if (!feedRes.ok) {
          throw new Error((feed as { error?: string }).error ?? `Failed ${feedRes.status}`)
        }
        setEvents((prev) => (before ? [...prev, ...feed.decisions] : feed.decisions))
        setCursor(feed.nextCursor)
        if (statsRes) {
          const s = (await statsRes.json()) as PolicyDecisionsStatsResponse
          if (statsRes.ok) setStats(s)
        }
        setError(null)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [filter],
  )

  useEffect(() => {
    void load()
  }, [load])

  // Live tail — plain polling (the decision sink flushes every ~5 s
  // anyway, so an SSE stream would buy nothing over a 10 s poll).
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => void load(), 10_000)
    return () => clearInterval(t)
  }, [live, load])

  const totals = stats?.series.reduce(
    (acc, d) => ({
      allow: acc.allow + d.allow,
      deny: acc.deny + d.deny,
      wouldDeny: acc.wouldDeny + d.wouldDeny,
    }),
    { allow: 0, deny: 0, wouldDeny: 0 },
  )

  return (
    <div className="p-6">
      <div className="mb-1 flex items-center gap-2">
        <Scale className="h-5 w-5 text-[var(--accent)]" />
        <h1 className="text-lg font-semibold text-[var(--text)]">Policy decisions</h1>
      </div>
      <p className="mb-4 text-xs text-[var(--text-muted)]">
        Every deny and report-only divergence lands here (allows are sampled).
      </p>

      {stats ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          <StatCard label="decisions · 7d" value={String((totals?.allow ?? 0) + (totals?.deny ?? 0) + (totals?.wouldDeny ?? 0))} />
          <StatCard
            label="denied"
            value={String(totals?.deny ?? 0)}
            tone="text-[var(--danger)]"
          />
          <StatCard
            label="would deny"
            value={String(totals?.wouldDeny ?? 0)}
            tone="text-[var(--warning)]"
          />
          <StatCard
            label="top denied action"
            value={stats.topDeniedActions[0]?.action ?? '—'}
            mono
          />
        </div>
      ) : null}

      {stats && stats.series.length > 0 ? (
        <div className="mb-4 grid gap-3 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
            <h2 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Decisions by day · {stats.windowDays}d
              {stats.truncated ? ' · window capped, lower bounds' : ''}
            </h2>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={stats.series}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="day"
                  stroke="var(--text-faint)"
                  fontSize={10}
                  tickFormatter={(d: string) => d.slice(5)}
                />
                <YAxis stroke="var(--text-faint)" fontSize={10} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    fontSize: 11,
                  }}
                />
                <Bar dataKey="allow" stackId="d" fill="var(--success)" />
                <Bar dataKey="wouldDeny" stackId="d" fill="var(--warning)" />
                <Bar dataKey="deny" stackId="d" fill="var(--danger)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
            <h2 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Top denied actions
            </h2>
            {stats.topDeniedActions.length === 0 ? (
              <p className="text-[11px] text-[var(--text-faint)]">
                nothing denied in the window
              </p>
            ) : (
              <ul className="space-y-1.5">
                {stats.topDeniedActions.slice(0, 8).map((a) => {
                  const max = stats.topDeniedActions[0]?.count ?? 1
                  return (
                    <li key={a.action} className="text-[11px]">
                      <div className="flex justify-between font-mono text-[var(--text-muted)]">
                        <span className="truncate">{a.action}</span>
                        <span>{a.count}</span>
                      </div>
                      <div className="mt-0.5 h-1 rounded bg-[var(--bg-overlay)]">
                        <div
                          className="h-1 rounded bg-[var(--danger)]/60"
                          style={{ width: `${Math.max(4, (a.count / max) * 100)}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {stats && stats.reportOnlySets.length > 0 ? (
        <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
          <h2 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            Report-only sets · promotion candidates
          </h2>
          <ul className="space-y-1">
            {stats.reportOnlySets.map((s) => (
              <li key={s.name} className="flex items-center gap-3 text-xs">
                <span className="font-mono text-[var(--text)]">{s.name}</span>
                <span className="text-[var(--text-faint)]">
                  {s.sinceDays}d in report-only
                </span>
                {s.wouldDeny === 0 ? (
                  <span className="rounded bg-[var(--success)]/10 px-1.5 py-0.5 text-[10px] text-[var(--success)]">
                    clean — safe to promote
                  </span>
                ) : (
                  <span className="rounded bg-[var(--warning)]/10 px-1.5 py-0.5 text-[10px] text-[var(--warning)]">
                    {s.wouldDeny} would-deny in 7d
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mb-3 flex items-center justify-between">
        <Segmented
          value={filter}
          options={[
            { value: 'all' as const, label: 'all' },
            { value: 'deny' as const, label: 'deny' },
            { value: 'would_deny' as const, label: 'would deny' },
            { value: 'allow' as const, label: 'allow (sampled)' },
          ]}
          onChange={setFilter}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            className={`inline-flex items-center gap-1 rounded border px-2 py-1.5 text-[11px] ${
              live
                ? 'border-[var(--success)]/50 text-[var(--success)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            <Radio className="h-3 w-3" /> {live ? 'live' : 'live off'}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-[var(--border)] p-1.5 text-[var(--text-muted)] hover:text-[var(--text)]"
            aria-label="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <ErrorLine error={error} />

      <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-[var(--bg-overlay)] text-left text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              <th className="px-3 py-2">ts</th>
              <th className="px-3 py-2">key</th>
              <th className="px-3 py-2">surface / action</th>
              <th className="px-3 py-2">decision</th>
              <th className="px-3 py-2">set · rule</th>
              <th className="px-3 py-2">rows</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-t border-[var(--border)]">
                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[10px] text-[var(--text-faint)]">
                  {new Date(e.ts).toLocaleString()}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
                  {e.keyId}
                </td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-[var(--text)]">
                  {e.action ?? '—'}
                  {e.kind === 'row' ? (
                    <span className="ml-1 text-[9px] text-[var(--text-faint)]">rows</span>
                  ) : null}
                </td>
                <td className="px-3 py-1.5">
                  <DecisionBadge decision={e.decision} />{' '}
                  <ModeBadge mode={e.mode} />
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
                  {e.policySet ?? '—'}
                  {e.ruleId ? ` · ${e.ruleId}` : ''}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
                  {e.rowCounts ? `${e.rowCounts.denied}/${e.rowCounts.total}` : '—'}
                </td>
              </tr>
            ))}
            {events.length === 0 && !loading ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-8 text-center text-[var(--text-faint)]"
                >
                  No decisions yet — attach a policy set to a key and let
                  traffic flow.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {cursor ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(cursor)}
          className="mt-3 rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50"
        >
          {loading ? 'loading…' : 'Load older'}
        </button>
      ) : null}
    </div>
  )
}

function StatCard({
  label,
  value,
  tone,
  mono,
}: {
  label: string
  value: string
  tone?: string
  mono?: boolean
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </div>
      <div
        className={`mt-1 truncate text-lg font-semibold ${tone ?? 'text-[var(--text)]'} ${
          mono ? 'font-mono text-sm' : ''
        }`}
      >
        {value}
      </div>
    </div>
  )
}
