'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { FileText, MessageSquare, Network } from 'lucide-react'
import { layoutDemoGraph } from '../../lib/demo-graph-layout'
import { demoCopy } from './demo-copy'

interface Entity {
  id: string
  type: string
  name: string
}
interface Fact {
  id: string
  entityId: string
  predicate: string
  object: string
  validFrom: string
  validUntil: string | null
  status: string
  sourceRef: string | null
}
interface Edge {
  from: string
  to: string
  kind: string
}
interface Source {
  ref: string
  kind: string
  title: string
  facts: number
}
interface Graph {
  entities: Entity[]
  facts: Fact[]
  edges: Edge[]
  sources: Source[]
}
interface Hit {
  entityId: string
  canonicalName: string
  facts: Array<{ factId: string; predicate: string; object: string }>
}
interface Turn {
  q: string
  hits: Hit[] | null
  error?: string
}

const W = 640
const H = 420

/** Ana's workspace: the demo tenant's graph, its sources, and a read-only chat over it. */
export function DemoWorkspace({ lang }: { lang: string }) {
  const c = demoCopy(lang).workspace
  const [graph, setGraph] = useState<Graph | null>(null)
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/app/demo/graph', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((g: Graph) => !cancelled && setGraph(g))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [])

  const placed = useMemo(
    () =>
      graph
        ? new Map(layoutDemoGraph(graph.entities, graph.edges, { width: W, height: H, pad: 48 }).map((p) => [p.id, p]))
        : new Map<string, { x: number; y: number }>(),
    [graph],
  )
  const sourceTitle = useMemo(
    () => new Map((graph?.sources ?? []).map((s) => [s.ref, s.title])),
    [graph],
  )
  const factSource = useMemo(
    () => new Map((graph?.facts ?? []).map((f) => [f.id, f.sourceRef])),
    [graph],
  )
  const label = (p: string) => (c.predicates as Record<string, string>)[p] ?? p.replace(/_/g, ' ')
  const edgeLabel = (k: string) => (c.edges as Record<string, string>)[k] ?? k.replace(/_/g, ' ')
  const typeLabel = (t: string) => (c.types as Record<string, string>)[t] ?? t
  const date = (iso: string) => new Date(iso).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB')

  async function ask(question: string) {
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setDraft('')
    try {
      const r = await fetch('/api/app/demo/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: q }),
      })
      if (r.status === 429) throw new Error(c.busy)
      if (!r.ok) throw new Error(c.failed)
      const body = (await r.json()) as { results?: Hit[] }
      setTurns((t) => [...t, { q, hits: (body.results ?? []).filter((h) => h.facts.length > 0) }])
    } catch (e) {
      setTurns((t) => [...t, { q, hits: null, error: (e as Error).message || c.failed }])
    } finally {
      setAsking(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void ask(draft)
  }

  if (failed) return <p className="text-sm text-[var(--text-muted)]">{c.failed}</p>
  if (!graph) return <p className="text-sm text-[var(--text-muted)]">{c.loading}</p>

  const sel = graph.entities.find((e) => e.id === selected) ?? null
  const selFacts = sel ? graph.facts.filter((f) => f.entityId === sel.id) : []

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wider text-[var(--text-faint)]">{c.org}</p>
        <h1 className="mt-1 text-2xl font-semibold text-[var(--text)]">{c.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-[var(--text-muted)]">{c.intro}</p>
        <p className="mt-2 text-xs font-mono text-[var(--text-faint)]">
          {c.entities.replace('{n}', String(graph.entities.length))} ·{' '}
          {c.facts.replace('{n}', String(graph.facts.length))} ·{' '}
          {c.links.replace('{n}', String(graph.edges.length))}
        </p>
      </header>

      {graph.entities.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{c.empty}</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4 min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
              <Network className="w-4 h-4" aria-hidden="true" />
              {c.graph}
            </h2>
            <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full h-auto" role="img" aria-label={c.graph}>
              {graph.edges.map((e, i) => {
                const a = placed.get(e.from)
                const b = placed.get(e.to)
                if (!a || !b) return null
                return (
                  <g key={i}>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth={1} />
                    <title>{edgeLabel(e.kind)}</title>
                  </g>
                )
              })}
              {graph.entities.map((n) => {
                const p = placed.get(n.id)
                if (!p) return null
                const on = n.id === selected
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x},${p.y})`}
                    onClick={() => setSelected(n.id)}
                    className="cursor-pointer"
                    role="button"
                    tabIndex={0}
                    aria-label={n.name}
                    onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && setSelected(n.id)}
                  >
                    <circle r={on ? 9 : 7} fill={on ? 'var(--accent)' : 'var(--data, var(--accent))'} />
                    <text y={-12} textAnchor="middle" fontSize={12} fill="var(--text)">
                      {n.name}
                    </text>
                  </g>
                )
              })}
            </svg>
            <div className="mt-3 border-t border-[var(--border)] pt-3 text-sm">
              {sel ? (
                <>
                  <p className="font-semibold text-[var(--text)]">
                    {sel.name} <span className="font-normal text-[var(--text-faint)]">· {typeLabel(sel.type)}</span>
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {selFacts.map((f) => (
                      <li key={f.id} className={f.validUntil ? 'text-[var(--text-faint)]' : 'text-[var(--text-muted)]'}>
                        <span className="text-[var(--text)]">{label(f.predicate)}:</span> {f.object}
                        {f.validUntil ? ` (${c.earlier}, ${c.until.replace('{date}', date(f.validUntil))})` : ''}
                        {f.sourceRef ? (
                          <span className="block text-xs text-[var(--text-faint)]">
                            {c.from} {sourceTitle.get(f.sourceRef) ?? f.sourceRef}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-[var(--text-muted)]">{c.pick}</p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4 min-w-0 flex flex-col">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
              <MessageSquare className="w-4 h-4" aria-hidden="true" />
              {c.chat}
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {(c.suggestions as string[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void ask(s)}
                  disabled={asking}
                  className="rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
            <ol className="mt-4 flex-1 space-y-4 text-sm" aria-live="polite">
              {turns.map((t, i) => (
                <li key={i}>
                  <p className="font-semibold text-[var(--text)]">{t.q}</p>
                  {t.error ? (
                    <p className="mt-1 text-[var(--text-muted)]">{t.error}</p>
                  ) : !t.hits || t.hits.length === 0 ? (
                    <p className="mt-1 text-[var(--text-muted)]">{c.nothing}</p>
                  ) : (
                    t.hits.map((h) => (
                      <div key={h.entityId} className="mt-2">
                        <p className="text-[var(--text)]">{h.canonicalName}</p>
                        <ul className="mt-1 space-y-1 text-[var(--text-muted)]">
                          {h.facts.map((f) => {
                            const ref = factSource.get(f.factId)
                            return (
                              <li key={f.factId}>
                                {label(f.predicate)}: {f.object}
                                {ref ? (
                                  <span className="block text-xs text-[var(--text-faint)]">
                                    {c.from} {sourceTitle.get(ref) ?? ref}
                                  </span>
                                ) : null}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    ))
                  )}
                </li>
              ))}
            </ol>
            <form onSubmit={onSubmit} className="mt-4 flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={500}
                placeholder={c.placeholder}
                aria-label={c.chat}
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]"
              />
              <button
                type="submit"
                disabled={asking || !draft.trim()}
                className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                {asking ? c.asking : c.ask}
              </button>
            </form>
          </section>
        </div>
      )}

      <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <FileText className="w-4 h-4" aria-hidden="true" />
          {c.sources}
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {graph.sources.map((s) => (
            <li key={s.ref} className="rounded-md border border-[var(--border)] px-3 py-2 text-sm">
              <p className="text-[var(--text)]">{s.title}</p>
              <p className="text-xs text-[var(--text-faint)]">{c.sourceFacts.replace('{n}', String(s.facts))}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
