'use client'

import { useCallback, useState } from 'react'
import { Check, Copy, KeyRound, Loader2 } from 'lucide-react'
import { Field, Modal, inputCls } from '../policies/ui'
import type { IssuedKeyResponse } from '../../../lib/contracts/admin-keys'
import { errorMessage, fill, type ConnectionsT } from './shared'
import { AGENT_ID } from './create/specs'

const KEYS = '/api/admin/proxy/v1/keys'

/**
 * Setting up an agent is: name it, get a key, run one command on the
 * machine. The key is a tenant brain:write key labelled `agent:<id>`,
 * shown exactly once with the install command already filled in; the
 * brain never shows it again, and the admin credential that issued it
 * is never the one the agent carries.
 */
export function AgentSetupModal({
  initialAgentId,
  t,
  onClose,
}: {
  initialAgentId: string
  t: ConnectionsT
  onClose: () => void
}) {
  const m = t.agents.modal
  const [agentId, setAgentId] = useState(initialAgentId)
  const [roots, setRoots] = useState('')
  const [issued, setIssued] = useState<IssuedKeyResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const valid = AGENT_ID.test(agentId.trim())

  const issue = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(KEYS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `agent:${agentId.trim()}`, scopes: ['brain:write'] }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setIssued(json as IssuedKeyResponse)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [agentId])

  const copy = useCallback(async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // clipboard refused (insecure context) — the text stays selectable
    }
  }, [])

  const brainUrl = issued ? brainUrlOf(issued) : null
  const id = agentId.trim()
  const rootsFlag = roots.trim() ? ` --roots ${shellQuote(roots.trim())}` : ''
  const installCmd = issued
    ? `npx @inite/brain-agent install --url ${brainUrl} --key ${issued.key} --agent ${id}${rootsFlag}`
    : ''
  const ciCmd = issued
    ? `BRAIN_URL=${brainUrl} BRAIN_API_KEY=${issued.key} BRAIN_AGENT_ID=${id} npx @inite/brain-agent sync`
    : ''

  return (
    <Modal title={fill(m.title, { agentId: id || '…' })} onClose={onClose} wide>
      {!issued ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label={`${m.agentId} *`} hint={m.agentIdHint}>
              <input
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="laptop-1"
                autoComplete="off"
                className={`${inputCls} font-mono`}
              />
            </Field>
            <Field label={m.roots} hint={m.rootsHint}>
              <input
                value={roots}
                onChange={(e) => setRoots(e.target.value)}
                placeholder="/Users/me/Documents:/srv/docs"
                autoComplete="off"
                className={`${inputCls} font-mono`}
              />
            </Field>
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">{m.keyExplain}</p>
          {error && <div className="font-mono text-xs text-[var(--danger)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)]"
            >
              {t.create.cancel}
            </button>
            <button
              type="button"
              disabled={busy || !valid}
              onClick={() => void issue()}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white inline-flex items-center gap-1 disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}
              {busy ? m.issuing : m.issue}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[11px] text-[var(--warning)]">{m.keyOnce}</p>
          <Snippet
            title={m.install}
            hint={m.installHint}
            text={installCmd}
            copied={copied === 'install'}
            copyLabel={t.agents.copy}
            copiedLabel={t.agents.copied}
            onCopy={() => void copy('install', installCmd)}
          />
          <Snippet
            title={m.ci}
            hint={m.ciHint}
            text={ciCmd}
            copied={copied === 'ci'}
            copyLabel={t.agents.copy}
            copiedLabel={t.agents.copied}
            onCopy={() => void copy('ci', ciCmd)}
          />
          <p className="text-[10px] text-[var(--text-faint)]">
            {fill(m.keyRecord, { name: issued.keyRecord.name, prefix: issued.keyRecord.prefix })}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white"
            >
              {m.done}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Snippet({
  title,
  hint,
  text,
  copied,
  copyLabel,
  copiedLabel,
  onCopy,
}: {
  title: string
  hint: string
  text: string
  copied: boolean
  copyLabel: string
  copiedLabel: string
  onCopy: () => void
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">{title}</span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)]"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre className="rounded border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[11px] text-[var(--text)] whitespace-pre-wrap break-all">
        {text}
      </pre>
      <p className="mt-1 text-[10px] text-[var(--text-faint)]">{hint}</p>
    </div>
  )
}

/** The brain's base URL, from the MCP URL the key response carries (`<base>/mcp/<companyId>`). */
export function brainUrlOf(issued: { mcpUrl: string; companyId: string }): string {
  const suffix = `/mcp/${issued.companyId}`
  return issued.mcpUrl.endsWith(suffix) ? issued.mcpUrl.slice(0, -suffix.length) : issued.mcpUrl
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}
