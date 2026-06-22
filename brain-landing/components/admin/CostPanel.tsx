'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useEffect, useState } from 'react'
import { Coins, RefreshCw } from 'lucide-react'
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

interface CostBucket {
  key: string
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  usd: number
}

interface CostResponse {
  total: { usd: number; tokens: number; calls: number }
  perModel: CostBucket[]
  perOperation: CostBucket[]
  perTenant: CostBucket[]
  pricing: Record<
    string,
    { promptPerMTok: number; completionPerMTok: number }
  >
  source: 'metrics'
  error?: string
}

export function CostPanel() {
  const [data, setData] = useState<CostResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/cost', {
        cache: 'no-store',
      })
      const json = (await res.json()) as CostResponse
      if (!res.ok) throw new Error(json.error ?? `Failed ${res.status}`)
      setData(json)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)]">
            Cost attribution
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            In-process token counters × env-overridable pricing. Per-tenant
            attribution lands when companyId is added to the OpenAI counter
            labels. Resets on container restart — point Prometheus at{' '}
            <code>/metrics</code> for long-term cost.
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

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}
      {data && (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat
              label="total spend"
              value={`$${data.total.usd.toFixed(4)}`}
              hint="since last restart"
              icon={<Coins className="w-3 h-3" />}
              accent
            />
            <Stat
              label="total tokens"
              value={data.total.tokens.toLocaleString()}
            />
            <Stat
              label="total calls"
              value={data.total.calls.toLocaleString()}
            />
            <Stat
              label="pricing source"
              value="env-overridable"
              hint="COST_*_USD_PER_MTOK"
            />
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <CostBreakdownCard
              title="Per operation (kind)"
              rows={data.perOperation}
            />
            <CostBreakdownCard title="Per model" rows={data.perModel} />
          </section>

          <section>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
              Spend by operation
            </div>
            <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={data.perOperation}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="key" stroke="var(--text-faint)" fontSize={10} />
                  <YAxis
                    stroke="var(--text-faint)"
                    fontSize={10}
                    tickFormatter={(v) => `$${v.toFixed(4)}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      fontSize: 11,
                    }}
                    formatter={(v) => `$${Number(v).toFixed(6)}`}
                  />
                  <Bar dataKey="usd">
                    {data.perOperation.map((b) => (
                      <Cell
                        key={b.key}
                        fill={
                          b.key === 'chat'
                            ? 'var(--accent)'
                            : b.key === 'embed'
                              ? 'var(--success)'
                              : 'var(--text-muted)'
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
              Active pricing ($/MTok)
            </div>
            <table className="w-full text-xs border border-[var(--border)] rounded-md overflow-hidden">
              <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="text-left px-3 py-1.5">model</th>
                  <th className="text-right px-3 py-1.5">prompt $/MTok</th>
                  <th className="text-right px-3 py-1.5">completion $/MTok</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.pricing).map(([model, p]) => (
                  <tr
                    key={model}
                    className="border-t border-[var(--border)] font-mono"
                  >
                    <td className="px-3 py-1 text-[var(--text)]">{model}</td>
                    <td className="px-3 py-1 text-right tabular-nums">
                      ${p.promptPerMTok.toFixed(2)}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums">
                      ${p.completionPerMTok.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}

function CostBreakdownCard({
  title,
  rows,
}: {
  title: string
  rows: CostBucket[]
}) {
  if (rows.length === 0) {
    return (
      <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
          {title}
        </div>
        <div className="text-xs text-[var(--text-muted)] italic">
          No activity yet.
        </div>
      </div>
    )
  }
  const max = Math.max(...rows.map((r) => r.usd))
  return (
    <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-2">
        {title}
      </div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.key} className="text-xs">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[var(--text)]">{r.key}</span>
              <span className="font-mono text-[var(--accent)] tabular-nums">
                ${r.usd.toFixed(6)}
              </span>
            </div>
            <div className="h-1 bg-[var(--bg-overlay)] rounded overflow-hidden mt-1">
              <div
                className="h-full bg-[var(--accent)]"
                style={{ width: max > 0 ? `${(r.usd / max) * 100}%` : '0%' }}
              />
            </div>
            <div className="text-[10px] text-[var(--text-faint)] font-mono mt-0.5">
              {r.calls.toLocaleString()} calls · {r.totalTokens.toLocaleString()}{' '}
              tokens ({r.promptTokens.toLocaleString()}p +{' '}
              {r.completionTokens.toLocaleString()}c)
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  accent,
  icon,
}: {
  label: string
  value: string
  hint?: string
  accent?: boolean
  icon?: React.ReactNode
}) {
  return (
    <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div
        className={`mt-1 text-lg font-semibold font-mono tabular-nums ${
          accent ? 'text-[var(--accent)]' : 'text-[var(--text)]'
        }`}
      >
        {value}
      </div>
      {hint && (
        <div className="text-[10px] text-[var(--text-faint)] font-mono mt-0.5 truncate">
          {hint}
        </div>
      )}
    </div>
  )
}
