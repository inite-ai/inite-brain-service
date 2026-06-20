'use client'

import { useState } from 'react'
import { AlertTriangle, Cpu, Trash2 } from 'lucide-react'
import { JsonView } from './JsonView'

interface ReindexResult {
  tenantsScanned: number
  factsScanned: number
  factsUpdated: number
  durationMs: number
  dryRun: boolean
  provider: string
  error?: string
}

export function ReindexConsole() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-base font-semibold text-[var(--text)]">
          Re-embed & destructive ops
        </h1>
        <p className="text-xs text-[var(--text-muted)]">
          Long-running operator actions. Each requires explicit confirmation —
          treat as production-affecting.
        </p>
      </header>
      <ReindexCard />
      <DropTenantCard />
    </div>
  )
}

function ReindexCard() {
  const [tenant, setTenant] = useState('')
  const [dryRun, setDryRun] = useState(true)
  const [maxFacts, setMaxFacts] = useState('500')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ReindexResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (!dryRun) {
      const confirmation = window.prompt(
        `Re-embed ALL facts for ${tenant ? `tenant "${tenant}"` : 'EVERY tenant'} — this calls the embedder once per fact and rewrites vectors. Type REINDEX to confirm.`,
      )
      if (confirmation !== 'REINDEX') {
        setError('Confirmation phrase mismatch — aborting.')
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (tenant) params.set('tenant', tenant)
      params.set('dryRun', dryRun ? 'true' : 'false')
      if (maxFacts) params.set('maxFacts', maxFacts)
      const res = await fetch(
        `/api/admin/proxy/v1/admin/reindex/embeddings?${params.toString()}`,
        { method: 'POST' },
      )
      const json = (await res.json()) as ReindexResult
      if (!res.ok) throw new Error(json.error ?? `Failed ${res.status}`)
      setResult(json)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="border border-[var(--border)] rounded-md p-4 bg-[var(--bg-elevated)]">
      <div className="flex items-center gap-2 mb-2">
        <Cpu className="w-4 h-4 text-[var(--accent)]" />
        <h2 className="text-sm font-semibold text-[var(--text)]">
          Re-embed knowledge_fact
        </h2>
      </div>
      <p className="text-xs text-[var(--text-muted)] mb-3">
        After flipping <code>EMBEDDER_PROVIDER</code> (e.g. → bge-m3), historical
        facts must be re-embedded so cross-vector-space queries return them.
        Always start with <code>dryRun</code> to estimate batch size.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
        <Field label="tenant (blank = all)">
          <input
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            className="w-full border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1 font-mono"
            placeholder="co_acme"
          />
        </Field>
        <Field label="maxFacts">
          <input
            value={maxFacts}
            onChange={(e) => setMaxFacts(e.target.value)}
            className="w-full border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1 font-mono"
            type="number"
          />
        </Field>
        <Field label="">
          <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            dry run (count only, no writes)
          </label>
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className={`px-3 py-1.5 rounded-md text-xs disabled:opacity-50 ${
            dryRun
              ? 'bg-[var(--accent)] text-white'
              : 'bg-[var(--danger)] text-white'
          }`}
        >
          {busy ? 'Running…' : dryRun ? 'Estimate' : 'Re-embed (will write)'}
        </button>
        {!dryRun && (
          <span className="text-[10px] text-[var(--warning)] flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> destructive — requires typed
            confirmation
          </span>
        )}
      </div>
      {error && (
        <div className="text-xs text-[var(--danger)] font-mono mt-2">
          {error}
        </div>
      )}
      {result && (
        <div className="mt-3 p-3 rounded-md border border-[var(--border)] bg-[var(--bg)]">
          <JsonView value={result as unknown} />
        </div>
      )}
    </section>
  )
}

function DropTenantCard() {
  const [tenant, setTenant] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ dropped: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isEval = tenant.startsWith('eval_')

  const run = async () => {
    if (!isEval) {
      setError('Only ephemeral eval_* tenants can be dropped via this UI.')
      return
    }
    const confirmation = window.prompt(
      `Drop ENTIRE database for tenant "${tenant}". This is irreversible. Type DROP to confirm.`,
    )
    if (confirmation !== 'DROP') {
      setError('Confirmation phrase mismatch — aborting.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/admin/tenants/${encodeURIComponent(tenant)}`,
        { method: 'DELETE' },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `Failed ${res.status}`)
      setResult(json)
      setTenant('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="border border-[var(--danger)]/40 rounded-md p-4 bg-[var(--bg-elevated)]">
      <div className="flex items-center gap-2 mb-2">
        <Trash2 className="w-4 h-4 text-[var(--danger)]" />
        <h2 className="text-sm font-semibold text-[var(--text)]">
          Drop ephemeral eval tenant
        </h2>
      </div>
      <p className="text-xs text-[var(--text-muted)] mb-3">
        Backend refuses anything that doesn&apos;t start with{' '}
        <code>eval_</code>. Real <code>co_*</code> tenants cannot be dropped
        from the UI under any circumstance.
      </p>
      <div className="flex items-end gap-2">
        <Field label="tenant id">
          <input
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            className="border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1 font-mono text-xs w-64"
            placeholder="eval_scenario_xxx"
          />
        </Field>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !isEval}
          className="px-3 py-1.5 rounded-md bg-[var(--danger)] text-white text-xs disabled:opacity-50"
        >
          {busy ? 'Dropping…' : 'Drop'}
        </button>
      </div>
      {error && (
        <div className="text-xs text-[var(--danger)] font-mono mt-2">
          {error}
        </div>
      )}
      {result && (
        <div className="text-xs text-[var(--success)] font-mono mt-2">
          Dropped {result.dropped}
        </div>
      )}
    </section>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      {label && (
        <div className="mb-0.5 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
          {label}
        </div>
      )}
      {children}
    </div>
  )
}
