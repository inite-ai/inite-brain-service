'use client'

import { useCallback, useState } from 'react'
import { Loader2, Plug } from 'lucide-react'
import { Field, Modal, Segmented, inputCls } from '../policies/ui'
import {
  SOURCE_CONTENT_POLICIES,
  SOURCE_DELETE_POLICIES,
  SOURCE_SCHEDULES,
  type SourceCatalogEntry,
  type SourceConnection,
} from '../../../lib/contracts/admin-source-connections'
import { PROXY, errorMessage, fill, type ConnectionsT } from './shared'

/**
 * The create form for one catalogue entry. Everything an operator can
 * set at creation is here; `config` is a JSON editor pre-filled from
 * the connector's own example so the keys are never guessed, and the
 * credential is a separate write-only field (the backend never returns
 * it). Defaults for schedule / policies come from the pack entry.
 */
export function ConnectionCreateModal({
  entry,
  t,
  onClose,
  onCreated,
}: {
  entry: SourceCatalogEntry
  t: ConnectionsT
  onClose: () => void
  onCreated: (created: SourceConnection) => void
}) {
  const c = t.create
  const [label, setLabel] = useState('')
  // An agent-only entry (git, stdio MCP) runs on a local agent: the host
  // is `agent:<id>` and the operator names the agent. A server-run entry
  // may also be pointed at an agent — the same folder on a laptop instead
  // of a mounted volume.
  const agentOnly = entry.availability === 'agent'
  const [onAgent, setOnAgent] = useState(agentOnly)
  const [agentId, setAgentId] = useState('')
  const [vertical, setVertical] = useState(entry.packId)
  const [config, setConfig] = useState(
    JSON.stringify(entry.configExample ?? {}, null, 2),
  )
  const [credential, setCredential] = useState('')
  const [schedule, setSchedule] = useState<string>(entry.defaults.schedule)
  const [contentPolicy, setContentPolicy] = useState<string>(
    entry.defaults.contentPolicy,
  )
  const [deletePolicy, setDeletePolicy] = useState<string>(
    entry.defaults.deletePolicy,
  )
  const [fetchBudget, setFetchBudget] = useState('')
  const [ownerUserId, setOwnerUserId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async () => {
    let parsedConfig: unknown
    try {
      parsedConfig = config.trim() ? JSON.parse(config) : {}
    } catch {
      setError(c.invalidJson)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        packId: entry.packId,
        sourceId: entry.sourceId,
        vertical: vertical.trim(),
        config: parsedConfig,
        schedule,
        contentPolicy,
        deletePolicy,
        ...(onAgent ? { host: `agent:${agentId.trim()}` } : {}),
      }
      if (label.trim()) body.label = label.trim()
      if (credential) body.credential = credential
      if (fetchBudget.trim()) body.fetchBudget = Number(fetchBudget)
      if (ownerUserId.trim()) body.ownerUserId = ownerUserId.trim()
      const res = await fetch(PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      onCreated(json as SourceConnection)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [
    agentId,
    c,
    config,
    contentPolicy,
    credential,
    deletePolicy,
    entry,
    fetchBudget,
    label,
    onAgent,
    onCreated,
    ownerUserId,
    schedule,
    vertical,
  ])

  return (
    <Modal
      title={fill(c.title, { packId: entry.packId, sourceId: entry.sourceId })}
      onClose={onClose}
      wide
    >
      {entry.description && (
        <p className="mb-3 text-[11px] text-[var(--text-muted)]">
          {entry.description}
        </p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label={c.host} hint={agentOnly ? c.hostAgentOnly : c.hostHint}>
          <Segmented<'server' | 'agent'>
            value={onAgent ? 'agent' : 'server'}
            options={[
              { value: 'server', label: c.hostServer },
              { value: 'agent', label: c.hostAgent },
            ]}
            onChange={(v) => {
              if (agentOnly) return
              setOnAgent(v === 'agent')
            }}
          />
        </Field>
        {onAgent ? (
          <Field label={c.agentId} hint={c.agentIdHint}>
            <input
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="laptop-1"
              className={`${inputCls} font-mono`}
            />
          </Field>
        ) : (
          <div className="hidden md:block" />
        )}
        <Field label={c.label} hint={c.labelHint}>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label={c.vertical} hint={c.verticalHint}>
          <input
            value={vertical}
            onChange={(e) => setVertical(e.target.value)}
            className={`${inputCls} font-mono`}
          />
        </Field>
        <div className="md:col-span-2">
          <Field label={c.config} hint={c.configHint}>
            <textarea
              value={config}
              onChange={(e) => setConfig(e.target.value)}
              rows={6}
              className={`${inputCls} font-mono`}
            />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field
            label={c.credential}
            hint={entry.credentialHint ?? c.credentialNone}
          >
            <input
              type="password"
              autoComplete="off"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Field>
        </div>
        <Field label={c.schedule}>
          <select
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            className={inputCls}
          >
            {SOURCE_SCHEDULES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label={c.contentPolicy}>
          <select
            value={contentPolicy}
            onChange={(e) => setContentPolicy(e.target.value)}
            className={inputCls}
          >
            {SOURCE_CONTENT_POLICIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label={c.deletePolicy}>
          <select
            value={deletePolicy}
            onChange={(e) => setDeletePolicy(e.target.value)}
            className={inputCls}
          >
            {SOURCE_DELETE_POLICIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label={c.fetchBudget} hint={c.fetchBudgetHint}>
          <input
            type="number"
            min={1}
            value={fetchBudget}
            onChange={(e) => setFetchBudget(e.target.value)}
            className={`${inputCls} font-mono`}
          />
        </Field>
        <div className="md:col-span-2">
          <Field label={c.ownerUserId} hint={c.ownerUserIdHint}>
            <input
              value={ownerUserId}
              onChange={(e) => setOwnerUserId(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Field>
        </div>
      </div>
      {error && (
        <div className="mt-3 font-mono text-xs text-[var(--danger)]">{error}</div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)]"
        >
          {c.cancel}
        </button>
        <button
          type="button"
          disabled={busy || !vertical.trim() || (onAgent && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agentId.trim()))}
          onClick={() => void submit()}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white inline-flex items-center gap-1 disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Plug className="w-3 h-3" />
          )}
          {busy ? c.submitting : c.submit}
        </button>
      </div>
    </Modal>
  )
}
