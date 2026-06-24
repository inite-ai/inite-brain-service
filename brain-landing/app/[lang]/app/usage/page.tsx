'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n: end-user /app pages ship English-only for MVP (admin UI is too); queued for a dedicated i18n pass. */

import { useCallback, useEffect, useState } from 'react'
import {
  Boxes,
  CircleCheck,
  GitCompareArrows,
  Trash2,
  Users,
  Activity,
} from 'lucide-react'
import { useProxyBase } from '../../../../components/playground/usePlaygroundCall'

interface MemoryStats {
  entities: number
  factsActive: number
  factsCompeting: number
  factsRetracted: number
  communities: number
  factsLast7d: number
  asOf: string
}

const CARDS: Array<{
  key: keyof Omit<MemoryStats, 'asOf'>
  label: string
  icon: typeof Boxes
  hint: string
}> = [
  { key: 'entities', label: 'Entities', icon: Boxes, hint: 'people, places, projects, topics' },
  { key: 'factsActive', label: 'Active facts', icon: CircleCheck, hint: 'currently true statements' },
  { key: 'factsCompeting', label: 'Competing facts', icon: GitCompareArrows, hint: 'unresolved conflicts' },
  { key: 'factsRetracted', label: 'Retracted facts', icon: Trash2, hint: 'kept for audit history' },
  { key: 'communities', label: 'Communities', icon: Users, hint: 'entity clusters' },
  { key: 'factsLast7d', label: 'Learned (7d)', icon: Activity, hint: 'facts recorded this week' },
]

/**
 * Usage — per-company memory footprint. Real counts from
 * GET /v1/stats/overview through the reduced-scope app BFF.
 */
export default function UsagePage() {
  const proxyBase = useProxyBase()
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch(`${proxyBase}/v1/stats/overview`)
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `Failed (${res.status})`)
      setStats(data as MemoryStats)
    } catch (e) {
      setErr((e as Error).message)
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [proxyBase])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">Usage</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          The size and shape of your brain&apos;s memory right now.
        </p>
      </div>

      {err && <div className="text-xs text-[var(--danger)] font-mono">{err}</div>}
      {loading && (
        <div className="text-sm text-[var(--text-muted)]">Loading…</div>
      )}

      {stats && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {CARDS.map((c) => {
              const Icon = c.icon
              return (
                <div
                  key={c.key}
                  className="border border-[var(--border)] rounded-md p-3"
                >
                  <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
                    <Icon className="w-3.5 h-3.5" />
                    <span className="text-xs">{c.label}</span>
                  </div>
                  <div className="mt-1 text-2xl font-semibold text-[var(--text)] tabular-nums">
                    {stats[c.key].toLocaleString()}
                  </div>
                  <div className="text-[10px] text-[var(--text-faint)]">
                    {c.hint}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="text-[10px] text-[var(--text-faint)] font-mono">
            as of {stats.asOf}
          </div>
        </>
      )}
    </div>
  )
}
