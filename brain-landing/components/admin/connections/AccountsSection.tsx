'use client'

import { useCallback, useMemo, useState } from 'react'
import { useLoader } from '../../../hooks/useLoader'
import { KeyRound, Loader2, Unplug } from 'lucide-react'
import type {
  SourceConnection,
  SourceOAuthGrant,
  SourceOAuthGrantsResponse,
} from '../../../lib/contracts/admin-source-connections'
import { PROXY, dangerBtn, errorMessage, fill, stamp, tokenWords, type ConnectionsT } from './shared'

/**
 * The accounts the brain reads cloud sources as (W4): one row per
 * grant — provider, account, status, which connections run as it, how
 * its token lives — with Disconnect; and the providers this deployment
 * can connect (an app registered or not, the redirect URI to register).
 * Nothing here is a token: the brain never sends one.
 */
export function AccountsSection({
  connections,
  refreshKey,
  t,
}: {
  connections: SourceConnection[]
  /** Bump to reload (a connection was created or an account connected elsewhere). */
  refreshKey: number
  t: ConnectionsT
}) {
  const a = t.accounts
  const [data, setData] = useState<SourceOAuthGrantsResponse | null>(null)
  const [off, setOff] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // `refreshKey` is read so the loader's identity — and the fetch — follow it.
  const load = useCallback(async () => {
    void refreshKey
    try {
      const res = await fetch(`${PROXY}/oauth/grants`, { cache: 'no-store' })
      if (res.status === 404) {
        setOff(true)
        return
      }
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setOff(false)
      setData(json as SourceOAuthGrantsResponse)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [refreshKey])

  const { reload } = useLoader(load)

  const usedBy = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of connections) if (c.grantId) m.set(c.grantId, (m.get(c.grantId) ?? 0) + 1)
    return m
  }, [connections])

  const disconnect = useCallback(
    async (g: SourceOAuthGrant) => {
      if (!window.confirm(fill(a.disconnectPrompt, { account: g.account ?? g.id }))) return
      setBusy(g.id)
      setNotice(null)
      try {
        const res = await fetch(`${PROXY}/oauth/grants/${encodeURIComponent(g.id)}`, { method: 'DELETE' })
        const json = await res.json()
        if (!res.ok) throw new Error(errorMessage(json, res.status))
        const r = json as { providerRevoked: boolean }
        setNotice(
          fill(a.disconnected, { provider: r.providerRevoked ? a.providerRevoked : a.providerNotRevoked }),
        )
        await reload()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [a, reload],
  )

  // Dark (SOURCE_OAUTH_CLIENT off): the section does not exist, like the routes.
  if (off) return null
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-medium text-[var(--text)]">{a.title}</h2>
        <p className="text-[11px] text-[var(--text-muted)] max-w-3xl">{a.subtitle}</p>
      </div>
      {error && <p className="font-mono text-xs text-[var(--danger)]">{error}</p>}
      {notice && <p className="text-xs text-[var(--success)]">{notice}</p>}
      {data && !data.ready && <p className="text-[11px] text-[var(--warning)]">{a.notReady}</p>}
      <div className="rounded-md border border-[var(--border)] overflow-x-auto">
        {!data ? (
          <Loader2 className="m-3 w-3 h-3 animate-spin text-[var(--text-muted)]" />
        ) : data.grants.length === 0 ? (
          <p className="px-3 py-4 text-xs text-[var(--text-muted)] italic">{a.none}</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-1.5">{a.headers.provider}</th>
                <th className="text-left px-3 py-1.5">{a.headers.account}</th>
                <th className="text-left px-3 py-1.5">{a.headers.status}</th>
                <th className="text-left px-3 py-1.5">{a.headers.usedBy}</th>
                <th className="text-left px-3 py-1.5">{a.headers.expires}</th>
                <th className="text-right px-3 py-1.5">{a.headers.actions}</th>
              </tr>
            </thead>
            <tbody>
              {data.grants.map((g) => {
                const n = usedBy.get(g.id) ?? 0
                const tone =
                  g.status === 'active'
                    ? 'text-[var(--success)]'
                    : g.status === 'broken'
                      ? 'text-[var(--danger)]'
                      : 'text-[var(--text-faint)]'
                return (
                  <tr key={g.id} className="border-t border-[var(--border)] align-top">
                    <td className="px-3 py-1.5 text-[var(--text)]">
                      {g.provider === 'mcp'
                        ? a.mcpProvider
                        : (data.providers.find((p) => p.id === g.provider)?.title ?? g.provider)}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[var(--text)]">
                      {g.account ?? g.id}
                      <div className="text-[10px] text-[var(--text-faint)]" title={g.scopes.join(' ')}>
                        {g.ownerUserId ? `${t.list.personal} · ` : ''}
                        {stamp(g.createdAt)}
                        {g.apiBase ? ` · ${fill(a.org, { url: g.apiBase })}` : ''}
                      </div>
                    </td>
                    <td className={`px-3 py-1.5 ${tone}`}>
                      {a.status[g.status]}
                      {g.lastError && (
                        <div className="font-mono text-[10px] text-[var(--danger)] max-w-xs truncate" title={g.lastError}>
                          {g.lastError}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">
                      {n === 0 ? a.unused : n === 1 ? a.usedByOne : fill(a.usedBy, { n })}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">
                      {g.status === 'active' && (
                        <>
                          <span title={g.accessExpiresAt ? fill(a.expiresAt, { at: stamp(g.accessExpiresAt) }) : undefined}>
                            {tokenWords(g, a)}
                          </span>
                          {g.lastRefreshAt && (
                            <div className="text-[10px] text-[var(--text-faint)]">{stamp(g.lastRefreshAt)}</div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {g.status !== 'revoked' && (
                        <button type="button" disabled={busy === g.id} onClick={() => void disconnect(g)} className={dangerBtn}>
                          {busy === g.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unplug className="w-3 h-3" />}
                          {a.disconnect}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {data && (
        <details className="text-[11px] text-[var(--text-muted)]">
          <summary className="cursor-pointer">
            <KeyRound className="inline w-3 h-3 mr-1" />
            {a.providers}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {data.providers.map((p) => (
              <li key={p.id} className="font-mono text-[10px]">
                <span className="text-[var(--text)]">{p.title}</span>
                {' — '}
                {p.configured
                  ? a.configured
                  : fill(a.notConfigured, { flag: `SOURCE_OAUTH_${p.id.toUpperCase()}_CLIENT_ID` })}
                {' · '}
                {a.redirect}: {p.redirectUri}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
