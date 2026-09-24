'use client'

import { useCallback, useState } from 'react'
import { useLoader } from '../../../hooks/useLoader'
import { KeyRound, Loader2 } from 'lucide-react'
import { inputCls } from '../policies/ui'
import type {
  SourceConnection,
  SourceExternalIdentity,
  SourcePrincipalsResponse,
} from '../../../lib/contracts/admin-source-connections'
import { accentBtn, connectionPath, errorMessage, fill, mutedBtn, type ConnectionsT } from './shared'

/**
 * The ACL this connection mirrors (W5), and the one thing only a human
 * can do about it: say who an external account is.
 *
 * The plane refuses to guess — an account nobody has linked grants no
 * visibility at all — so the point of this panel is to make the
 * unlinked accounts VISIBLE rather than let them sit in a table nobody
 * reads. Shown for an org connection (no owner) on a deployment with
 * the membership plane switched on; a personal connection is
 * user-fenced by construction and has nothing to mirror.
 */
export function PrincipalsSection({
  connection,
  principalsOn,
  t,
}: {
  connection: SourceConnection
  /** The catalogue's `principals` — SOURCE_PRINCIPALS on this brain. */
  principalsOn: boolean
  t: ConnectionsT
}) {
  const p = t.principals
  const [data, setData] = useState<SourcePrincipalsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const personal = Boolean(connection.ownerUserId)

  // The panel is mounted either way (hooks are not conditional); the
  // load is a no-op when there is nothing to mirror.
  const load = useCallback(async () => {
    if (!principalsOn || personal) return
    try {
      const res = await fetch(connectionPath(connection.id, '/principals'), { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setData(json as SourcePrincipalsResponse)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [connection.id, principalsOn, personal])
  useLoader(load)

  if (!principalsOn || personal) return null

  const link = async (externalId: string, userId: string | null) => {
    setBusy(externalId)
    setError(null)
    try {
      const res = await fetch(connectionPath(connection.id, '/principals/link'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ externalId, userId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setData(json as SourcePrincipalsResponse)
      setDraft((prev) => ({ ...prev, [externalId]: '' }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const groupsOf = (identity: SourceExternalIdentity): number =>
    (data?.tuples ?? []).filter(
      (tuple) => tuple.subject.endsWith(`:account/${identity.externalId}`) && !tuple.revokedAt,
    ).length

  return (
    <div className="rounded-md border border-[var(--border)] p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
          <KeyRound className="w-3.5 h-3.5 text-[var(--accent)]" />
          {p.title}
        </h3>
        {data && (
          <span className="font-mono text-[10px] text-[var(--text-faint)]">
            {fill(p.epoch, { epoch: String(data.epoch) })}
          </span>
        )}
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">{p.subtitle}</p>
      {error && <div className="font-mono text-[11px] text-[var(--danger)]">{error}</div>}
      {data && data.identities.length === 0 && (
        <p className="text-[11px] text-[var(--text-faint)]">{p.empty}</p>
      )}
      {data && data.identities.length > 0 && (
        <table className="w-full text-[11px]">
          <thead className="text-[10px] uppercase text-[var(--text-faint)]">
            <tr>
              <th className="text-left font-normal py-1">{p.account}</th>
              <th className="text-left font-normal py-1">{p.groups}</th>
              <th className="text-left font-normal py-1">{p.user}</th>
            </tr>
          </thead>
          <tbody>
            {data.identities.map((identity) => (
              <tr key={identity.externalId} className="border-t border-[var(--border)]">
                <td className="py-1 pr-2 align-middle">
                  <span className="text-[var(--text)]">
                    {identity.displayName ?? identity.handle ?? identity.externalId}
                  </span>
                  {identity.email && (
                    <span className="ml-1 font-mono text-[10px] text-[var(--text-faint)]">
                      {identity.email}
                    </span>
                  )}
                </td>
                <td className="py-1 pr-2 align-middle font-mono text-[10px] text-[var(--text-faint)]">
                  {groupsOf(identity)}
                </td>
                <td className="py-1 align-middle">
                  {identity.userId ? (
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[10px] text-[var(--text)]">
                        {identity.userId}
                      </span>
                      <span className="text-[10px] text-[var(--text-faint)]">
                        {identity.linkedBy === 'email' ? p.byEmail : p.byOperator}
                      </span>
                      <button
                        className={mutedBtn}
                        disabled={busy === identity.externalId}
                        onClick={() => void link(identity.externalId, null)}
                      >
                        {busy === identity.externalId ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          p.unlink
                        )}
                      </button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <input
                        className={`${inputCls} max-w-[12rem] font-mono text-[11px]`}
                        placeholder={p.userPlaceholder}
                        value={draft[identity.externalId] ?? ''}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, [identity.externalId]: e.target.value }))
                        }
                      />
                      <button
                        className={accentBtn}
                        disabled={
                          busy === identity.externalId ||
                          (draft[identity.externalId] ?? '').trim().length === 0
                        }
                        onClick={() =>
                          void link(identity.externalId, (draft[identity.externalId] ?? '').trim())
                        }
                      >
                        {busy === identity.externalId ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          p.link
                        )}
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
