'use client'

import { useCallback, useMemo, useState } from 'react'
import { Clapperboard, Lightbulb, RefreshCw } from 'lucide-react'
import { useProxyBase } from '../../../../components/playground/usePlaygroundCall'
import { useLoader } from '../../../../hooks/useLoader'

interface StateDelta {
  subject: string
  field: string
  from?: string
  to?: string
}

interface Scene {
  sceneId: string
  sceneLabel: string
  gist: string
  enrichedGist?: string
  occurredFrom: string
  occurredTo: string
  conversationIds: string[]
  episodeIds: string[]
  entityIds: string[]
  factIds: string[]
  unexpectedDetails: string[]
  stateDeltas: StateDelta[]
  memoryValue?: { explicitness?: number; stateChange?: number; novelty?: number }
  enriched: boolean
}

interface Belief {
  beliefId: string
  subject: string
  field: string
  value: string
  priorValue?: string
  statement: string
  confidence: number
  revision: number
  status: string
  validFrom: string
  sourceSceneIds: string[]
  corroborationCount: number
}

/** `2026-07-01 10:00–10:01` within a day; both dates across days. */
function span(from: string, to: string): string {
  const f = from.slice(0, 16).replace('T', ' ')
  const t = to.slice(0, 16).replace('T', ' ')
  if (!f) return '—'
  return f.slice(0, 10) === t.slice(0, 10) ? `${f}–${t.slice(11)}` : `${f} → ${t}`
}

const tail = (id: string) => id.slice(id.indexOf(':') + 1)

/**
 * Memory — the episodic and semantic planes side by side: scenes (what
 * happened, together, when — composed from your conversations a few
 * minutes after they go quiet) and the beliefs promoted from their state
 * changes (what the brain currently holds). Backed by GET /v1/scenes and
 * GET /v1/beliefs through the reduced-scope app BFF; both fence by the
 * signed-in user on the brain side.
 */
export default function MemoryPage() {
  const proxyBase = useProxyBase()
  const [scenes, setScenes] = useState<Scene[]>([])
  const [beliefs, setBeliefs] = useState<Belief[]>([])
  const [focus, setFocus] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([
        fetch(`${proxyBase}/v1/scenes?limit=50`),
        fetch(`${proxyBase}/v1/beliefs?limit=100`),
      ])
      const sd = await s.json()
      const bd = await b.json()
      if (!s.ok) throw new Error(sd?.error ?? `Scenes failed (${s.status})`)
      if (!b.ok) throw new Error(bd?.error ?? `Beliefs failed (${b.status})`)
      setScenes((sd?.scenes ?? []) as Scene[])
      setBeliefs((bd?.beliefs ?? []) as Belief[])
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
      setScenes([])
      setBeliefs([])
    }
  }, [proxyBase])
  const { loading, reload } = useLoader(load)

  // Beliefs grouped under the scene that promoted them (a belief may cite
  // several scenes; it lands under each).
  const beliefsByScene = useMemo(() => {
    const m = new Map<string, Belief[]>()
    for (const b of beliefs) {
      for (const sid of b.sourceSceneIds) {
        const list = m.get(sid) ?? []
        list.push(b)
        m.set(sid, list)
      }
    }
    return m
  }, [beliefs])

  const focusedBeliefs = focus ? beliefs.filter((b) => b.sourceSceneIds.includes(focus)) : beliefs

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text)]">Memory</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Scenes are what happened, together, when — composed from your conversations a few
            minutes after they go quiet. Beliefs are what the brain currently holds, promoted from
            the state changes those scenes carry.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 h-9 rounded-md border border-[var(--border)] text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {err && <div className="text-xs text-[var(--danger)] font-mono">{err}</div>}

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <section className="space-y-2 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] flex items-center gap-1">
            <Clapperboard className="w-3 h-3" /> scenes ({scenes.length})
          </div>
          {!loading && scenes.length === 0 && !err && (
            <Empty
              icon={<Clapperboard className="w-6 h-6 text-[var(--text-faint)]" />}
              title="No scenes yet."
              hint="Write a few turns through the playground or a connected agent; the scene pass runs every ten minutes over conversations that have been quiet for ten."
            />
          )}
          {scenes.map((s) => {
            const promoted = beliefsByScene.get(s.sceneId) ?? []
            const selected = focus === s.sceneId
            return (
              <button
                type="button"
                key={s.sceneId}
                onClick={() => setFocus(selected ? null : s.sceneId)}
                className={`w-full text-left border rounded-md p-3 transition-colors ${
                  selected
                    ? 'border-[var(--accent)] bg-[var(--bg-elevated)]'
                    : 'border-[var(--border)] hover:bg-[var(--bg-elevated)]'
                }`}
              >
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="font-medium text-[var(--text)] truncate">
                    {s.sceneLabel || 'Untitled scene'}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] font-mono text-[var(--text-faint)]">
                    {span(s.occurredFrom, s.occurredTo)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[var(--text-muted)]">{s.enrichedGist ?? s.gist}</p>
                {s.stateDeltas.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1">
                    {s.stateDeltas.map((d, i) => (
                      <li
                        key={`${d.subject}.${d.field}.${i}`}
                        className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--bg-overlay)] text-[var(--text)]"
                      >
                        <span className="text-[var(--text-muted)]">
                          {d.subject} · {d.field}:
                        </span>{' '}
                        {d.from ? <s className="text-[var(--text-faint)]">{d.from}</s> : null}
                        {d.from ? ' → ' : ''}
                        {d.to ?? '∅'}
                      </li>
                    ))}
                  </ul>
                )}
                {s.unexpectedDetails.length > 0 && (
                  <div className="mt-2 text-xs text-[var(--text-muted)]">
                    <span className="text-[var(--text-faint)]">notable: </span>
                    {s.unexpectedDetails.join('; ')}
                  </div>
                )}
                <div className="mt-2 text-[10px] font-mono text-[var(--text-faint)] flex flex-wrap gap-x-3">
                  <span>{s.episodeIds.length} turns</span>
                  {s.entityIds.length > 0 && <span>{s.entityIds.length} entities</span>}
                  {s.factIds.length > 0 && <span>{s.factIds.length} facts</span>}
                  {promoted.length > 0 && (
                    <span className="text-[var(--accent)]">
                      {promoted.length} belief{promoted.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {!s.enriched && <span>not yet enriched</span>}
                </div>
              </button>
            )
          })}
        </section>

        <section className="space-y-2 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] flex items-center gap-1">
            <Lightbulb className="w-3 h-3" /> beliefs ({focusedBeliefs.length})
            {focus && (
              <button
                type="button"
                onClick={() => setFocus(null)}
                className="ml-auto normal-case tracking-normal text-[var(--accent)]"
              >
                show all
              </button>
            )}
          </div>
          {!loading && focusedBeliefs.length === 0 && !err && (
            <Empty
              icon={<Lightbulb className="w-6 h-6 text-[var(--text-faint)]" />}
              title={focus ? 'This scene promoted no belief.' : 'No beliefs yet.'}
              hint={
                focus
                  ? 'Only scenes carrying a state change (a value that went from one thing to another) promote a belief.'
                  : 'Beliefs appear once a scene has been enriched and carries a state change.'
              }
            />
          )}
          {focusedBeliefs.map((b) => (
            <div key={b.beliefId} className="border border-[var(--border)] rounded-md p-3">
              <div className="text-sm text-[var(--text)]">{b.statement}</div>
              <div className="mt-1 text-[11px] font-mono text-[var(--text-muted)]">
                <span className="text-[var(--text-faint)]">
                  {b.subject} · {b.field}:
                </span>{' '}
                {b.priorValue ? <s className="text-[var(--text-faint)]">{b.priorValue}</s> : null}
                {b.priorValue ? ' → ' : ''}
                {b.value}
              </div>
              <div className="mt-1.5 text-[10px] font-mono text-[var(--text-faint)] flex flex-wrap gap-x-3">
                <span>confidence {b.confidence.toFixed(2)}</span>
                <span>rev {b.revision}</span>
                {b.corroborationCount > 1 && <span>×{b.corroborationCount}</span>}
                <span>since {b.validFrom.slice(0, 10)}</span>
                {b.sourceSceneIds.map((sid) => (
                  <button
                    type="button"
                    key={sid}
                    onClick={() => setFocus(sid)}
                    className="text-[var(--accent)] hover:underline"
                  >
                    scene {tail(sid).slice(0, 8)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}

function Empty({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="border border-[var(--border)] rounded-md p-8 flex flex-col items-center text-center gap-2 text-[var(--text-muted)]">
      {icon}
      <div className="text-sm">{title}</div>
      <div className="text-xs text-[var(--text-faint)] max-w-sm">{hint}</div>
    </div>
  )
}
