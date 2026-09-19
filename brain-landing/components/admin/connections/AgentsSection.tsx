'use client'

import { useMemo, useState } from 'react'
import { KeyRound, Laptop } from 'lucide-react'
import type { SourceAgent, SourceConnection } from '../../../lib/contracts/admin-source-connections'
import { AgentSetupModal } from './AgentSetupModal'
import { KindLabel } from './KindLabel'
import { familyOf, labelOf } from './kinds'
import { accentBtn, fill, mutedBtn, stamp, syncTone, type ConnectionsT } from './shared'

interface AgentRow {
  agentId: string
  connections: SourceConnection[]
  lastSyncAt: string | null
  lastSyncStatus: string | null
  /** The agent's own check-in, when it has ever made one. */
  presence: SourceAgent | null
}

/** Agent-host connections grouped by agent — who checked in, and how to run one. */
function agentRows(connections: SourceConnection[], agents: SourceAgent[]): AgentRow[] {
  const byAgent = new Map<string, AgentRow>()
  for (const a of agents) {
    byAgent.set(a.agentId, { agentId: a.agentId, connections: [], lastSyncAt: null, lastSyncStatus: null, presence: a })
  }
  for (const c of connections) {
    if (!c.host.startsWith('agent:')) continue
    const agentId = c.host.slice('agent:'.length)
    const row = byAgent.get(agentId) ?? {
      agentId,
      connections: [],
      lastSyncAt: null,
      lastSyncStatus: null,
      presence: null,
    }
    row.connections.push(c)
    if (c.lastSyncAt && (!row.lastSyncAt || c.lastSyncAt > row.lastSyncAt)) {
      row.lastSyncAt = c.lastSyncAt
      row.lastSyncStatus = c.lastSyncStatus
    }
    byAgent.set(agentId, row)
  }
  return [...byAgent.values()].sort((a, b) => a.agentId.localeCompare(b.agentId))
}

export function AgentsSection({
  connections,
  agents,
  t,
}: {
  connections: SourceConnection[]
  agents: SourceAgent[]
  t: ConnectionsT
}) {
  const a = t.agents
  const rows = useMemo(() => agentRows(connections, agents), [connections, agents])
  const [setup, setSetup] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">{a.title}</h2>
          <p className="text-[11px] text-[var(--text-muted)] max-w-3xl">{a.subtitle}</p>
        </div>
        <button type="button" onClick={() => setSetup('')} className={accentBtn}>
          <Laptop className="w-3 h-3" /> {a.setupNew}
        </button>
      </div>
      <div className="rounded-md border border-[var(--border)] overflow-x-auto">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-xs text-[var(--text-muted)] italic">{a.none}</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-1.5">{a.headers.agent}</th>
                <th className="text-left px-3 py-1.5">{a.headers.seen}</th>
                <th className="text-left px-3 py-1.5">{a.headers.connections}</th>
                <th className="text-left px-3 py-1.5">{a.headers.lastSync}</th>
                <th className="text-left px-3 py-1.5">{a.headers.status}</th>
                <th className="text-right px-3 py-1.5">{a.setup}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.agentId} className="border-t border-[var(--border)] align-top">
                  <td className="px-3 py-1.5 font-mono text-[var(--text)]">
                    <span className="inline-flex items-center gap-1">
                      <Laptop className="w-3 h-3 text-[var(--accent)]" /> {row.agentId}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-[10px] text-[var(--text-muted)]">
                    {row.presence ? (
                      <>
                        <div className="font-mono">
                          {fill(a.seenAt, {
                            at: stamp(row.presence.lastSeenAt),
                            hostname: row.presence.hostname ?? '?',
                            platform: row.presence.platform ?? '?',
                            version: row.presence.version ?? '?',
                          })}
                        </div>
                        {row.presence.roots.length > 0 && (
                          <div className="font-mono text-[var(--text-faint)]" title={row.presence.roots.map((r) => r.path).join('\n')}>
                            {a.roots}
                            {': '}
                            {row.presence.roots.map((r) => r.path).join(', ')}
                          </div>
                        )}
                        {row.presence.databases.length > 0 && (
                          <div className="font-mono text-[var(--text-faint)]">
                            {a.databases}
                            {': '}
                            {row.presence.databases.join(', ')}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-[var(--warning)]">{a.seenNever}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-[var(--text-muted)]">
                    {row.connections.map((c) => (
                      <div key={c.id} className="text-[11px]">
                        {labelOf(c)}
                        <span className="text-[var(--text-faint)]">
                          {' · '}
                          <KindLabel family={familyOf(c)} connector={c.connector} t={t} />
                        </span>
                      </div>
                    ))}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
                    {row.lastSyncAt ? stamp(row.lastSyncAt) : a.never}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px]">
                    {row.lastSyncStatus ? (
                      <span className={syncTone(row.lastSyncStatus)}>{row.lastSyncStatus}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button type="button" onClick={() => setSetup(row.agentId)} className={mutedBtn}>
                      <KeyRound className="w-3 h-3" /> {a.issueKey}
                    </button>
                    <div className="mt-1 text-[10px] text-[var(--text-faint)] max-w-xs ml-auto">{a.installHint}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-[10px] text-[var(--text-faint)]">{a.setupHint}</p>
      {setup !== null && <AgentSetupModal initialAgentId={setup} t={t} onClose={() => setSetup(null)} />}
    </div>
  )
}
