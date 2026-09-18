'use client'

import { useState } from 'react'
import { Check, Copy, Loader2, Webhook } from 'lucide-react'
import { Field, inputCls } from '../policies/ui'
import type {
  SourceCatalogEntry,
  SourceConnection,
  WebhookSetupResponse,
} from '../../../lib/contracts/admin-source-connections'
import {
  accentBtn,
  connectionPath,
  dangerBtn,
  errorMessage,
  fill,
  mutedBtn,
  stamp,
  type ConnectionsT,
} from './shared'

/**
 * A records connection's inbound webhook (W4.2c): switch it on — the
 * address to register at the vendor, the secret shown ONCE, the
 * vendor's how-to — rotate, switch off. Shown only for a connector
 * with a lane (the catalogue entry's `webhook.scheme`); tells the
 * operator when the deployment's flag is off.
 */
export function WebhookSection({
  connection,
  entry,
  webhooksOn,
  t,
  onChanged,
}: {
  connection: SourceConnection
  entry: SourceCatalogEntry | null
  /** The catalogue's `webhooks` — SOURCE_WEBHOOKS on this brain. */
  webhooksOn: boolean
  t: ConnectionsT
  onChanged: () => Promise<void>
}) {
  const w = t.webhook
  const scheme = entry?.webhook?.scheme ?? null
  const [secretInput, setSecretInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [setup, setSetup] = useState<WebhookSetupResponse | null>(null)
  const [copied, setCopied] = useState<'url' | 'secret' | null>(null)

  if (!scheme) return null
  const enabled = connection.webhook.enabled
  const vendorSecret = scheme === 'hubspot' || scheme === 'bitrix24'

  const enable = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(connectionPath(connection.id, '/webhook'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(secretInput.trim() ? { secret: secretInput.trim() } : {}),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setSetup(json as WebhookSetupResponse)
      setSecretInput('')
      await onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    if (!window.confirm(w.disablePrompt)) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(connectionPath(connection.id, '/webhook'), { method: 'DELETE' })
      if (!res.ok) throw new Error(errorMessage(await res.json().catch(() => null), res.status))
      setSetup(null)
      await onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = async (what: 'url' | 'secret', value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setCopied(null)
    }
  }

  return (
    <div className="space-y-2 rounded border border-[var(--border)] p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Webhook className="w-3.5 h-3.5 text-[var(--accent)]" />
        <span className="text-xs font-medium text-[var(--text)]">{w.title}</span>
        <span className={`text-[10px] ${enabled ? 'text-[var(--success)]' : 'text-[var(--text-faint)]'}`}>
          {enabled ? w.on : w.off}
        </span>
        <span className="text-[10px] font-mono text-[var(--text-faint)]">{w.scheme[scheme as keyof typeof w.scheme] ?? scheme}</span>
        {enabled && (
          <span className="text-[10px] text-[var(--text-faint)]">
            {connection.webhook.lastEventAt
              ? fill(w.lastEvent, { at: stamp(connection.webhook.lastEventAt) })
              : w.noEvent}
          </span>
        )}
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">{w.hint}</p>
      {!webhooksOn && <p className="text-[11px] text-[var(--warning)]">{w.flagOff}</p>}
      {webhooksOn && !setup && (
        <div className="space-y-2">
          {vendorSecret && (
            <Field label={w.secretLabel} hint={w.secretHint}>
              <input
                type="password"
                value={secretInput}
                onChange={(e) => setSecretInput(e.target.value)}
                autoComplete="new-password"
                className={`${inputCls} font-mono`}
              />
            </Field>
          )}
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void enable()} className={accentBtn}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Webhook className="w-3 h-3" />}
              {busy ? w.working : enabled ? w.rotate : w.enable}
            </button>
            {enabled && (
              <button type="button" disabled={busy} onClick={() => void disable()} className={dangerBtn}>
                {w.disable}
              </button>
            )}
          </div>
        </div>
      )}
      {setup && (
        <div className="space-y-2 text-[11px]">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{w.url}</div>
            <div className="flex items-center gap-2">
              <code className="break-all font-mono text-[11px] text-[var(--text)]">{setup.url}</code>
              <button type="button" onClick={() => void copy('url', setup.url)} className={mutedBtn}>
                {copied === 'url' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied === 'url' ? w.copied : w.copy}
              </button>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{w.secret}</div>
            <div className="flex items-center gap-2">
              <code className="break-all font-mono text-[11px] text-[var(--text)]">{setup.secret}</code>
              <button type="button" onClick={() => void copy('secret', setup.secret)} className={mutedBtn}>
                {copied === 'secret' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied === 'secret' ? w.copied : w.copy}
              </button>
            </div>
            <p className="text-[10px] text-[var(--warning)]">{w.secretOnce}</p>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{w.notes}</div>
            <ol className="list-decimal pl-4 space-y-0.5 text-[var(--text-muted)]">
              {setup.notes.map((n) => (
                <li key={n} className="break-words">
                  {n}
                </li>
              ))}
            </ol>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setSetup(null)} className={mutedBtn}>
              {t.detail.close}
            </button>
            <button type="button" disabled={busy} onClick={() => void disable()} className={dangerBtn}>
              {w.disable}
            </button>
          </div>
        </div>
      )}
      {error && <p className="font-mono text-[11px] text-[var(--danger)]">{error}</p>}
    </div>
  )
}
