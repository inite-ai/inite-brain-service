'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLoader } from '../../../../hooks/useLoader'
import { Check, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { Field } from '../../policies/ui'
import {
  OAuthPopupMessageSchema,
  type SourceCatalogEntry,
  type SourceOAuthGrant,
  type SourceOAuthGrantsResponse,
} from '../../../../lib/contracts/admin-source-connections'
import { PROXY, errorMessage, fill, type ConnectionsT } from '../shared'

/**
 * The credential of a cloud connector is an ACCOUNT the brain connected,
 * not a token typed here: pick one already connected (right provider,
 * active, with the scopes this connector needs) or connect another —
 * a popup to the provider's consent page; the brain's callback posts
 * `{ type: 'brain-source-oauth', grantId }` back to this window, from
 * the brain's origin only, and the new account is selected.
 */
export function AccountPicker({
  entry,
  value,
  error,
  t,
  onChange,
}: {
  entry: SourceCatalogEntry
  value: string
  error: string | null
  t: ConnectionsT
  onChange: (grantId: string) => void
}) {
  const c = t.form.credential
  const oauth = entry.oauth!
  const [data, setData] = useState<SourceOAuthGrantsResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const popupRef = useRef<Window | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${PROXY}/oauth/grants`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setData(json as SourceOAuthGrantsResponse)
      setLoadError(null)
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [])

  const { reload } = useLoader(load)

  const provider = data?.providers.find((p) => p.id === oauth.provider) ?? null
  const callbackOrigin = useMemo(() => {
    if (!provider) return null
    try {
      return new URL(provider.redirectUri).origin
    } catch {
      return null
    }
  }, [provider])

  const candidates = useMemo(
    () => (data?.grants ?? []).filter((g) => g.provider === oauth.provider && g.status === 'active'),
    [data, oauth.provider],
  )

  // The callback page's message — the brain's origin only, never the provider's.
  useEffect(() => {
    if (!callbackOrigin) return
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== callbackOrigin) return
      const parsed = OAuthPopupMessageSchema.safeParse(ev.data)
      if (!parsed.success) return
      setWaiting(false)
      if (parsed.data.ok) {
        setFlowError(null)
        onChange(parsed.data.grantId)
        void reload()
      } else {
        setFlowError(parsed.data.error)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [callbackOrigin, reload, onChange])

  // A popup closed by hand ends the wait.
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      if (popupRef.current?.closed) {
        setWaiting(false)
        popupRef.current = null
      }
    }, 500)
    return () => clearInterval(timer)
  }, [waiting])

  const connect = useCallback(async () => {
    setFlowError(null)
    // Open synchronously on the click (popup blockers), then point it.
    const popup = window.open('about:blank', 'brain-source-oauth', 'width=560,height=720')
    if (!popup) {
      setFlowError(c.popupBlocked)
      return
    }
    popupRef.current = popup
    setWaiting(true)
    try {
      const res = await fetch(`${PROXY}/oauth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: oauth.provider,
          connector: entry.connector,
          origin: window.location.origin,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      popup.location.href = (json as { authorizeUrl: string }).authorizeUrl
    } catch (e) {
      popup.close()
      setWaiting(false)
      setFlowError((e as Error).message)
    }
  }, [c.popupBlocked, entry.connector, oauth.provider])

  const flag = `SOURCE_OAUTH_${oauth.provider.toUpperCase()}_CLIENT_ID`
  const hint = error ?? flowError ?? loadError ?? c.accountHint
  return (
    <Field label={`${c.account} *`} hint={hint} error={!!(error || flowError || loadError)}>
      <div className="space-y-2 text-xs">
        {data && !data.ready && <p className="text-[11px] text-[var(--warning)]">{c.keyMissing}</p>}
        {provider && !provider.configured && (
          <p className="text-[11px] text-[var(--warning)]">
            {fill(c.notConfigured, { provider: oauth.title, flag })}
            <br />
            <span className="font-mono text-[10px]">{fill(c.redirectUri, { provider: oauth.title, uri: provider.redirectUri })}</span>
          </p>
        )}
        {candidates.length === 0 && data && (
          <p className="text-[11px] text-[var(--text-muted)]">{fill(c.noAccounts, { provider: oauth.title })}</p>
        )}
        {candidates.map((g) => (
          <AccountRow key={g.id} grant={g} needed={oauth.scopes} selected={value === g.id} t={t} onPick={() => onChange(g.id)} />
        ))}
        <button
          type="button"
          disabled={waiting || !data?.ready || provider?.configured === false}
          onClick={() => void connect()}
          className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--accent)] disabled:opacity-40"
        >
          {waiting ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
          {waiting
            ? fill(c.connecting, { provider: oauth.title })
            : candidates.length > 0
              ? c.connectAnother
              : fill(c.connectNew, { provider: oauth.title })}
        </button>
        {!data && !loadError && <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)]" />}
        {data && (
          <button type="button" onClick={() => void reload()} className="ml-2 inline-flex items-center gap-1 text-[10px] text-[var(--text-faint)]">
            <RefreshCw className="w-3 h-3" />
          </button>
        )}
      </div>
    </Field>
  )
}

function AccountRow({
  grant,
  needed,
  selected,
  t,
  onPick,
}: {
  grant: SourceOAuthGrant
  needed: string[]
  selected: boolean
  t: ConnectionsT
  onPick: () => void
}) {
  const narrower = needed.some((s) => !grant.scopes.includes(s))
  return (
    <label className={`flex items-center gap-2 rounded border px-2 py-1 cursor-pointer ${selected ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)]'}`}>
      <input type="radio" name="grant" checked={selected} onChange={onPick} />
      <span className="font-mono text-[11px] text-[var(--text)]">{grant.account ?? grant.id}</span>
      {selected && <Check className="w-3 h-3 text-[var(--accent)]" />}
      {narrower && <span className="ml-auto text-[10px] text-[var(--warning)]">{t.form.credential.scopesShort}</span>}
      {!grant.refreshable && !narrower && (
        <span className="ml-auto text-[10px] text-[var(--warning)]">{t.accounts.notRefreshable}</span>
      )}
    </label>
  )
}
