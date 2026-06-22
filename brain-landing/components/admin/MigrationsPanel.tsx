'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Database, RefreshCw } from 'lucide-react'

interface Migration {
  id: string
  name: string
}

interface TenantState {
  companyId: string
  applied: string[]
  pending: string[]
}

interface MigrationsResponse {
  manifest: Migration[]
  perTenant: TenantState[]
  driftDetected: boolean
  error?: string
}

export function MigrationsPanel() {
  const [data, setData] = useState<MigrationsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/migrations', {
        cache: 'no-store',
      })
      const json = (await res.json()) as MigrationsResponse
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
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Database className="w-4 h-4 text-[var(--accent)]" /> Migrations
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Per-tenant view of <code>schema_migrations</code>. Each new tenant
            applies the full manifest on first request; drift means a tenant
            DB raced on a NS-level definition and didn&apos;t recover.
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
            <Stat label="migrations" value={data.manifest.length.toString()} />
            <Stat label="tenants" value={data.perTenant.length.toString()} />
            <Stat
              label="drift"
              value={data.driftDetected ? 'detected' : 'clean'}
              tone={data.driftDetected ? 'warn' : 'good'}
            />
            <Stat
              label="latest migration"
              value={data.manifest[data.manifest.length - 1]?.id ?? '—'}
            />
          </section>

          <section>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
              Manifest × tenant matrix
            </div>
            <div className="overflow-auto border border-[var(--border)] rounded-md">
              <table className="w-full text-xs">
                <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 sticky left-0 bg-[var(--bg-overlay)]">
                      migration
                    </th>
                    {data.perTenant.map((t) => (
                      <th
                        key={t.companyId}
                        className="text-center px-2 py-2 font-mono"
                      >
                        {t.companyId}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.manifest.map((m) => (
                    <tr
                      key={m.id}
                      className="border-t border-[var(--border)] font-mono"
                    >
                      <td className="px-3 py-1 sticky left-0 bg-[var(--bg)] text-[var(--text)]">
                        {m.id} <span className="text-[var(--text-faint)]">{m.name.replace(/^\d{4}_/, '')}</span>
                      </td>
                      {data.perTenant.map((t) => {
                        const applied = t.applied.includes(m.id)
                        return (
                          <td
                            key={t.companyId}
                            className="text-center px-2 py-1"
                          >
                            {applied ? (
                              <CheckCircle2 className="inline w-3 h-3 text-[var(--success)]" />
                            ) : (
                              <AlertTriangle className="inline w-3 h-3 text-[var(--warning)]" />
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {data.driftDetected && (
            <section className="border border-[var(--warning)]/40 bg-[var(--warning)]/5 rounded-md p-3">
              <div className="text-sm font-semibold text-[var(--text)] flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-[var(--warning)]" />
                Pending per tenant
              </div>
              <ul className="mt-2 text-xs font-mono space-y-1">
                {data.perTenant
                  .filter((t) => t.pending.length > 0)
                  .map((t) => (
                    <li key={t.companyId}>
                      <span className="text-[var(--text-muted)]">
                        {t.companyId}:
                      </span>{' '}
                      <span className="text-[var(--warning)]">
                        {t.pending.join(', ')}
                      </span>
                    </li>
                  ))}
              </ul>
              <p className="mt-2 text-[10px] text-[var(--text-muted)]">
                Pending migrations re-apply on the next tenant request via
                ensureSchema (idempotent IF NOT EXISTS guards). Manual
                back-fill via brain restart on the affected pod.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'good' | 'warn' | 'bad'
}) {
  const toneClass =
    tone === 'good'
      ? 'text-[var(--success)]'
      : tone === 'warn'
        ? 'text-[var(--warning)]'
        : tone === 'bad'
          ? 'text-[var(--danger)]'
          : 'text-[var(--text)]'
  return (
    <div className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold font-mono tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  )
}
