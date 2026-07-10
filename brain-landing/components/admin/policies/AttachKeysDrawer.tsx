'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { useEffect, useMemo, useState } from 'react'
import { KeyRound } from 'lucide-react'
import type {
  AdminKeysResponse,
  PolicySet,
} from '../../../lib/contracts/admin-policies'
import { ModeBadge } from './PolicyBadges'
import { Drawer, ErrorLine } from './ui'

/**
 * Attach/detach the policy set for the tenant's static keys. Each row
 * shows the key's OTHER sets so stacking is visible; the footer note
 * states the combination semantics (deny in any set overrides allow).
 */
export function AttachKeysDrawer({
  policySet,
  onClose,
  onApplied,
}: {
  policySet: PolicySet
  onClose: () => void
  onApplied: () => void
}) {
  const [keys, setKeys] = useState<AdminKeysResponse['keys']>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/admin/proxy/v1/admin/keys', {
          cache: 'no-store',
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
        const list = (data as AdminKeysResponse).keys
        setKeys(list)
        setChecked(
          new Set(
            list
              .filter((k) => k.policySets.some((s) => s.name === policySet.name))
              .map((k) => k.subject),
          ),
        )
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [policySet.name])

  const initial = useMemo(
    () =>
      new Set(
        keys
          .filter((k) => k.policySets.some((s) => s.name === policySet.name))
          .map((k) => k.subject),
      ),
    [keys, policySet.name],
  )

  const apply = async () => {
    const attach = [...checked].filter((s) => !initial.has(s))
    const detach = [...initial].filter((s) => !checked.has(s))
    if (attach.length === 0 && detach.length === 0) {
      onClose()
      return
    }
    setBusy(true)
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/admin/policy-sets/${encodeURIComponent(policySet.name)}/attachments`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ attach, detach }),
        },
      )
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message?.message ?? data.error ?? `Failed ${res.status}`)
      }
      onApplied()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Drawer title={`Attach keys · ${policySet.name}`} onClose={onClose}>
      <ErrorLine error={error} />
      {loading ? (
        <p className="text-xs text-[var(--text-muted)]">loading keys…</p>
      ) : keys.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          No static keys registered for this tenant. JWT-minted keys attach via
          the token&apos;s <span className="font-mono">policy</span> claim
          instead.
        </p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => {
            const others = k.policySets.filter((s) => s.name !== policySet.name)
            return (
              <label
                key={k.subject}
                className="flex cursor-pointer items-start gap-2 rounded border border-[var(--border)] p-2 hover:border-[var(--accent)]/50"
              >
                <input
                  type="checkbox"
                  checked={checked.has(k.subject)}
                  onChange={(e) => {
                    const next = new Set(checked)
                    if (e.target.checked) next.add(k.subject)
                    else next.delete(k.subject)
                    setChecked(next)
                  }}
                  className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <KeyRound className="h-3 w-3 text-[var(--text-faint)]" />
                    <span className="font-mono text-xs text-[var(--text)]">
                      {k.keyId}
                    </span>
                    {k.name ? (
                      <span className="truncate text-[10px] text-[var(--text-muted)]">
                        {k.name}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    {k.scopes.map((s) => (
                      <span
                        key={s}
                        className="rounded bg-[var(--bg-overlay)] px-1 py-px font-mono text-[9px] text-[var(--text-muted)]"
                      >
                        {s}
                      </span>
                    ))}
                  </span>
                  {others.length > 0 ? (
                    <span className="mt-1 block text-[10px] text-[var(--text-faint)]">
                      also carries: {others.map((s) => s.name).join(', ')}
                    </span>
                  ) : null}
                </span>
              </label>
            )
          })}
          <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">
            Sets combine most-restrictive: a deny in any attached enforce set
            overrides an allow in another. <ModeBadge mode={policySet.mode} />{' '}
            sets never block — they log would-deny decisions.
          </p>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2 border-t border-[var(--border)] pt-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || loading}
          onClick={() => void apply()}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {busy ? 'applying…' : 'Apply'}
        </button>
      </div>
    </Drawer>
  )
}
