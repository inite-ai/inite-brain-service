'use client'

import { useCallback, useMemo, useState } from 'react'
import { Check, Copy, KeyRound, Loader2, Plug } from 'lucide-react'
import { getMessages, type Lang } from '../../lib/i18n'
import { clientSnippets, installLinks } from '../../lib/client-snippets'
import { useLoader } from '../../hooks/useLoader'

/**
 * The Keys screen.
 *
 * What it replaces: a static block containing `brain_YOUR_API_KEY` and
 * `YOUR_COMPANY_ID`, and the sentence "contact your workspace admin".
 * Both values now come from the backend, and the key comes from a button.
 *
 * The plaintext lives in component state only, from the issuing response
 * until the user dismisses it — it is never re-fetchable, because the
 * server keeps only a hash.
 */

interface KeySummary {
  id: string
  name: string
  prefix: string
  scopes: string[]
  createdAt?: string
  expiresAt?: string
  revokedAt?: string
  lastUsedAt?: string
}

interface KeysPayload {
  companyId: string
  mcpUrl: string
  keys: KeySummary[]
  issuingEnabled: boolean
  issuableScopes: string[]
}

interface IssuedPayload {
  key: string
  companyId: string
  mcpUrl: string
  keyRecord: KeySummary
}

const PROXY = '/api/app/proxy/v1/keys'

export function KeysManager({ lang }: { lang: Lang }) {
  const t = getMessages(lang).keys
  const [data, setData] = useState<KeysPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [expiresInDays, setExpiresInDays] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(PROXY, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(String(res.status))
      const payload = (await res.json()) as KeysPayload
      setData(payload)
      setScopes((current) =>
        current.length > 0 ? current : payload.issuableScopes.filter((s) => s !== 'brain:admin'),
      )
      setError(null)
    } catch {
      setError(t.loadError)
    }
  }, [t.loadError])

  // Shared loader: runs `load` from the lifecycle without writing state
  // inside an effect, and gives `reload` for after a mutation.
  const { loading, reload } = useLoader(load)

  async function issue(event: React.FormEvent) {
    event.preventDefault()
    if (!data || busy) return
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { name: name.trim() || 'agent', scopes }
      const days = Number(expiresInDays)
      if (Number.isFinite(days) && days > 0) body.expiresInDays = Math.floor(days)
      const res = await fetch(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 403) {
        setError(t.issuingForbidden)
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      setIssued((await res.json()) as IssuedPayload)
      setName('')
      await reload()
    } catch {
      setError(t.loadError)
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    if (!window.confirm(t.revokeConfirm)) return
    await fetch(`${PROXY}/${encodeURIComponent(id)}/revoke`, { method: 'POST' })
    await reload()
  }

  if (loading && !data) {
    return (
      <p className="text-sm text-[var(--text-muted)] inline-flex items-center gap-2">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t.loading}
      </p>
    )
  }

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-[var(--text)]">{t.title}</h1>
        <p className="text-sm text-[var(--text-muted)]">{t.subtitle}</p>
      </header>

      {data && (
        <dl className="grid sm:grid-cols-2 gap-3 text-xs">
          <Field label={t.tenantLabel} value={data.companyId} />
          <Field label={t.mcpUrlLabel} value={data.mcpUrl} />
        </dl>
      )}

      {error && (
        <p role="alert" className="text-sm text-[var(--warning)]">
          {error}
        </p>
      )}

      {issued && <IssuedKey issued={issued} lang={lang} onDismiss={() => setIssued(null)} />}

      {data && !data.issuingEnabled && (
        <p className="text-sm text-[var(--text-muted)]">{t.issuingDisabled}</p>
      )}

      {data?.issuingEnabled && (
        <form onSubmit={issue} className="space-y-4 border border-[var(--border)] rounded-xl p-4">
          <h2 className="text-sm font-medium text-[var(--text)] inline-flex items-center gap-2">
            <KeyRound className="size-4" aria-hidden="true" />
            {t.createTitle}
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="text-xs text-[var(--text-muted)] space-y-1">
              <span>{t.nameLabel}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.namePlaceholder}
                maxLength={80}
                className="w-full min-h-11 px-3 rounded-md bg-transparent border border-[var(--border)] text-sm text-[var(--text)]"
              />
            </label>
            <label className="text-xs text-[var(--text-muted)] space-y-1">
              <span>{t.expiryLabel}</span>
              <input
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                placeholder={t.expiryNever}
                className="w-full min-h-11 px-3 rounded-md bg-transparent border border-[var(--border)] text-sm text-[var(--text)]"
              />
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs text-[var(--text-muted)]">{t.scopesLabel}</legend>
            <div className="flex flex-wrap gap-3">
              {data.issuableScopes.map((scope) => (
                <label key={scope} className="inline-flex items-center gap-2 text-xs u-mono">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) =>
                      setScopes((current) =>
                        e.target.checked
                          ? [...current, scope]
                          : current.filter((s) => s !== scope),
                      )
                    }
                  />
                  {scope}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="submit"
            disabled={busy || scopes.length === 0}
            className="btn-signal min-h-11 px-4 rounded-md text-sm disabled:opacity-50"
          >
            {busy ? t.creating : t.createButton}
          </button>
        </form>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--text)]">{t.listTitle}</h2>
        {data && data.keys.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">{t.listEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[var(--text-faint)] text-left">
                <tr>
                  <th className="py-2 pr-4 font-normal">{t.colName}</th>
                  <th className="py-2 pr-4 font-normal">{t.colScopes}</th>
                  <th className="py-2 pr-4 font-normal">{t.colCreated}</th>
                  <th className="py-2 pr-4 font-normal">{t.colLastUsed}</th>
                  <th className="py-2 pr-4 font-normal">{t.colStatus}</th>
                  <th className="py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {data?.keys.map((key) => (
                  <tr key={key.id} className="border-t border-[var(--border)]">
                    <td className="py-2 pr-4">
                      <span className="text-[var(--text)]">{key.name}</span>
                      <span className="u-mono text-[var(--text-faint)] ml-2">{key.prefix}…</span>
                    </td>
                    <td className="py-2 pr-4 u-mono text-[var(--data)]">{key.scopes.join(' ')}</td>
                    <td className="py-2 pr-4 text-[var(--text-muted)]">{shortDate(key.createdAt)}</td>
                    <td className="py-2 pr-4 text-[var(--text-muted)]">
                      {key.lastUsedAt ? shortDate(key.lastUsedAt) : t.never}
                    </td>
                    <td className="py-2 pr-4 text-[var(--text-muted)]">{statusOf(key, t)}</td>
                    <td className="py-2 text-right">
                      {!key.revokedAt && (
                        <button
                          type="button"
                          onClick={() => void revoke(key.id)}
                          className="min-h-11 px-2 text-[var(--warning)] hover:underline"
                        >
                          {t.revoke}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[var(--border)] rounded-lg px-3 py-2">
      <dt className="text-[var(--text-faint)]">{label}</dt>
      <dd className="u-mono text-[var(--data)] break-all">{value}</dd>
    </div>
  )
}

function IssuedKey({
  issued,
  lang,
  onDismiss,
}: {
  issued: IssuedPayload
  lang: Lang
  onDismiss: () => void
}) {
  const t = getMessages(lang).keys
  const snippets = useMemo(
    () => clientSnippets({ key: issued.key, companyId: issued.companyId, mcpUrl: issued.mcpUrl }),
    [issued],
  )
  const links = useMemo(
    () => installLinks({ key: issued.key, companyId: issued.companyId, mcpUrl: issued.mcpUrl }),
    [issued],
  )
  const [active, setActive] = useState(0)
  const current = snippets[active]!

  return (
    <section className="border border-[var(--signal)] rounded-xl p-4 space-y-4">
      <h2 className="text-sm font-medium text-[var(--text)]">{t.issuedTitle}</h2>
      <CopyBox lang={lang} value={issued.key} mono />

      {/* One click where a client actually supports it. The rest get a
          snippet below — a button that silently did nothing would be
          worse than the copy-paste it replaced. */}
      <div className="flex flex-wrap gap-2">
        {links.map((link) => (
          <a
            key={link.id}
            href={link.href}
            className="btn-signal min-h-11 px-4 inline-flex items-center gap-2 rounded-md text-sm"
          >
            <Plug className="size-4" aria-hidden="true" />
            {link.label}
          </a>
        ))}
        <span className="self-center text-xs text-[var(--text-faint)]">{t.oneClickHint}</span>
      </div>

      <div>
        <h3 className="text-xs text-[var(--text-muted)] mb-2">{t.snippetsTitle}</h3>
        <div role="tablist" aria-label={t.snippetsTitle} className="flex flex-wrap gap-1 mb-2">
          {snippets.map((snippet, index) => (
            <button
              key={snippet.id}
              type="button"
              role="tab"
              aria-selected={index === active}
              onClick={() => setActive(index)}
              className={`min-h-11 px-3 text-xs border-b-2 ${
                index === active
                  ? 'border-[var(--signal)] text-[var(--signal)]'
                  : 'border-transparent text-[var(--text-muted)]'
              }`}
            >
              {snippet.label}
            </button>
          ))}
        </div>
        <p className="u-mono text-[11px] text-[var(--text-faint)] mb-1">{current.target}</p>
        <CopyBox lang={lang} value={current.code} mono block />
      </div>

      <button type="button" onClick={onDismiss} className="btn-ghost min-h-11 px-4 rounded-md text-sm">
        {t.issuedDismiss}
      </button>
    </section>
  )
}

function CopyBox({
  lang,
  value,
  mono,
  block,
}: {
  lang: Lang
  value: string
  mono?: boolean
  block?: boolean
}) {
  const t = getMessages(lang).keys
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="relative">
      <pre
        className={`p-3 pr-24 rounded-md bg-[var(--surface)] border border-[var(--border)] text-xs overflow-x-auto ${
          mono ? 'u-mono' : ''
        } ${block ? 'whitespace-pre' : 'whitespace-pre-wrap break-all'}`}
      >
        <code>{value}</code>
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute top-2 right-2 min-h-11 px-2 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        <span aria-live="polite">{copied ? t.copied : t.copy}</span>
      </button>
    </div>
  )
}

function shortDate(iso?: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10)
}

function statusOf(key: KeySummary, t: ReturnType<typeof getMessages>['keys']): string {
  if (key.revokedAt) return t.statusRevoked
  if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) return t.statusExpired
  return t.statusActive
}
