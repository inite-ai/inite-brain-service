'use client'

import { FormEvent, useState } from 'react'
import {
  ArrowRight,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { DemoFrame } from './DemoFrame'
import { DemoTraceStrip, TracePayload as BaseTracePayload } from './DemoTraceStrip'

interface TraceArtifact {
  spanId?: string
  name: string
  ts: number
  value: unknown
}
interface TracePayload extends BaseTracePayload {
  artifacts?: TraceArtifact[]
}

interface IngestResult {
  skipped?: boolean
  reason?: string
  extractedEntityIds?: string[]
  extractedFactIds?: string[]
}

interface SearchHit {
  entityId: string
  canonicalName: string
  entityType: string
  score: number
  externalRefs?: Record<string, string>
  facts: Array<{
    factId: string
    predicate: string
    object: string
    confidence: number
    status: string
    validFrom: string
    validUntil?: string
  }>
}

interface ChatResp {
  route: {
    intent: 'tell' | 'ask'
    cleanedQuery?: string
    asOf?: string
    reason?: string
  }
  ingest?: IngestResult
  /** Lazy fast-path dedup result that ran inline right after ingest.
   *  Mirrors how a brain works in production — cheap merge in the moment,
   *  deep semantic resolve at night. */
  autoDedup?: { identityLinksCreated?: number }
  search?: { results: SearchHit[] }
  trace?: TracePayload
}

interface DreamsResp {
  dedup?: { identityLinksCreated?: number; pairsConsidered?: number }
  resolve?: { resolutionsApplied?: number }
  trace?: TracePayload
}

interface Turn {
  id: string
  prompt: string
  pending: boolean
  error?: string
  chat?: ChatResp
  dreams?: DreamsResp
  /** Kind drives the renderer. 'chat' for user messages, 'dreams' for the
   *  identity-resolve sweep. */
  kind: 'chat' | 'dreams'
}

const STARTERS = [
  'Maria Petrov is our new CTO at Acme. She moved from Berlin and prefers vegan lunch.',
  'who runs engineering at Acme',
  'Maria switched to keto last month.',
  'what does Maria eat',
  'what did Maria eat in February',
]

export function LiveIngestSlide() {
  const [message, setMessage] = useState(STARTERS[0])
  const [includePii, setIncludePii] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!message.trim() || busy) return
    const id = crypto.randomUUID()
    const prompt = message
    setTurns((t) => [...t, { id, prompt, pending: true, kind: 'chat' }])
    setBusy(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/demo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt, includePii }),
      })
      const data = await res.json()
      setTurns((t) =>
        t.map((x) =>
          x.id === id
            ? {
                ...x,
                pending: false,
                chat: res.ok ? data : undefined,
                error: res.ok ? undefined : data?.error ?? `${res.status}`,
              }
            : x,
        ),
      )
    } catch (err) {
      setTurns((t) =>
        t.map((x) =>
          x.id === id
            ? { ...x, pending: false, error: (err as Error).message }
            : x,
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  const runDreams = async () => {
    if (busy) return
    const id = crypto.randomUUID()
    setTurns((t) => [
      ...t,
      { id, prompt: 'dreams · dedup + identity-resolve', pending: true, kind: 'dreams' },
    ])
    setBusy(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/demo/dreams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: ['dedup', 'resolve'] }),
      })
      const data = await res.json()
      setTurns((t) =>
        t.map((x) =>
          x.id === id
            ? {
                ...x,
                pending: false,
                dreams: res.ok ? data : undefined,
                error: res.ok ? undefined : data?.error ?? `${res.status}`,
              }
            : x,
        ),
      )
    } catch (err) {
      setTurns((t) =>
        t.map((x) =>
          x.id === id
            ? { ...x, pending: false, error: (err as Error).message }
            : x,
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    if (busy) return
    setBusy(true)
    try {
      await fetch('/api/admin/proxy/v1/admin/demo/reset', { method: 'POST' })
      setTurns([])
    } finally {
      setBusy(false)
    }
  }

  return (
    <DemoFrame
      slideNumber="01a"
      eyebrow="ingest · chat"
      title="Скажите brain. Спросите brain. Без переключения режимов."
      subtitle="Один чат сбоку у LLM. Brain сам решает: утверждение — извлекаю факты, вопрос — ищу. «Вчера / yesterday / в марте» автоматом превращаются в asOf. Lazy identity-резолвинг происходит в моменте по сильному сигналу — как у человека. Deep resolve остаётся на фон/ночь, вот он рядом кнопкой."
    >
      <div className="flex items-center gap-4 mb-6">
        <span className="text-xs font-mono text-[var(--text-faint)]">
          tenant: demo_live
        </span>
        <label className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 select-none">
          <input
            type="checkbox"
            checked={includePii}
            onChange={(e) => setIncludePii(e.target.checked)}
          />
          read_pii
        </label>
        <button
          type="button"
          onClick={runDreams}
          disabled={busy || turns.length === 0}
          title="deep dedup + identity-resolve — ночной фон, здесь руками для наглядности"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] disabled:opacity-40"
        >
          <Sparkles className="w-3.5 h-3.5" />
          deep resolve (nightly)
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={busy || turns.length === 0}
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-40 ml-auto"
        >
          <Trash2 className="w-3.5 h-3.5" />
          reset tenant
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.2fr] gap-6">
        {/* Compose column */}
        <div className="space-y-4">
          <form
            onSubmit={submit}
            className="border border-[var(--border)] rounded-lg p-4 bg-[var(--bg-elevated)]"
          >
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] mb-2 flex items-center gap-2">
              <MessageSquare className="w-3 h-3" />
              say to brain
            </div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="w-full bg-transparent text-base text-[var(--text)] outline-none resize-none placeholder:text-[var(--text-faint)]"
              placeholder="just type — brain figures out tell-vs-ask"
            />
            <div className="mt-3 flex justify-end">
              <button
                type="submit"
                disabled={busy || !message.trim()}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-[var(--accent)] text-white text-sm disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                send
              </button>
            </div>
          </form>

          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] mt-4 mb-1">
            stage recipe
          </div>
          <ol className="text-xs text-[var(--text-muted)] space-y-1 list-decimal list-inside">
            {STARTERS.map((s, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => setMessage(s)}
                  className="text-left hover:text-[var(--text)] transition-colors"
                >
                  “{s}”
                </button>
              </li>
            ))}
          </ol>
          <div className="text-[10px] text-[var(--text-faint)] mt-2 leading-relaxed">
            <strong className="text-[var(--text)]">lazy resolve</strong>{' '}
            (опечатка ~ опечатка) идёт автоматом после каждого tell — это
            быстрый «связал в моменте» уровень.{' '}
            <strong className="text-[var(--text)]">deep resolve</strong> —
            ночной/фоновый sweep на embeddings и identity-cluster’ы; здесь
            это кнопка наверху для наглядности.
          </div>
        </div>

        {/* Timeline column */}
        <div className="space-y-3">
          {turns.length === 0 && (
            <div className="border border-dashed border-[var(--border)] rounded-lg p-8 text-center text-sm text-[var(--text-muted)]">
              напечатайте слева и нажмите send.
            </div>
          )}
          {turns
            .slice()
            .reverse()
            .map((t) => (
              <TurnCard key={t.id} turn={t} />
            ))}
        </div>
      </div>
    </DemoFrame>
  )
}

function TurnCard({ turn }: { turn: Turn }) {
  const intent = turn.chat?.route?.intent
  const asOf = turn.chat?.route?.asOf
  return (
    <div className="border border-[var(--border)] rounded-lg p-4 bg-[var(--bg-elevated)]">
      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)]">
          you
        </span>
        {intent && (
          <span
            className={`text-[10px] uppercase tracking-[0.2em] ${
              intent === 'tell'
                ? 'text-[var(--accent)]'
                : 'text-[var(--warning)]'
            }`}
          >
            <ArrowRight className="w-3 h-3 inline mr-0.5" />
            {intent === 'tell' ? 'tell · ingest' : 'ask · search'}
          </span>
        )}
        {asOf && (
          <span className="text-[10px] font-mono text-[var(--text-faint)]">
            asOf {asOf.slice(0, 16)}
          </span>
        )}
        {turn.chat?.route?.cleanedQuery &&
          turn.chat.route.cleanedQuery !== turn.prompt && (
            <span
              className="text-[10px] font-mono text-[var(--text-faint)] truncate max-w-xs"
              title={turn.chat.route.cleanedQuery}
            >
              q: “{turn.chat.route.cleanedQuery}”
            </span>
          )}
        {turn.pending && (
          <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)] ml-auto" />
        )}
      </div>
      <div className="text-sm text-[var(--text-muted)] font-mono mb-3">
        “{turn.prompt}”
      </div>

      {turn.error && (
        <div className="text-xs text-[var(--danger)] font-mono">
          {turn.error}
        </div>
      )}

      {turn.kind === 'chat' && turn.chat?.ingest && (
        <IngestBody
          data={turn.chat.ingest}
          autoDedup={turn.chat.autoDedup}
          trace={turn.chat.trace}
        />
      )}
      {turn.kind === 'chat' && turn.chat?.search && (
        <SearchBody results={turn.chat.search.results} trace={turn.chat.trace} />
      )}
      {turn.kind === 'dreams' && turn.dreams && <DreamsBody data={turn.dreams} />}
    </div>
  )
}

function IngestBody({
  data,
  autoDedup,
  trace,
}: {
  data: IngestResult
  autoDedup?: { identityLinksCreated?: number }
  trace?: TracePayload
}) {
  const nluArt = trace?.artifacts?.find(
    (a) => a.name === 'ingest.nlu.extracted',
  )
  const extracted =
    nluArt && typeof nluArt.value === 'object'
      ? (nluArt.value as {
          entities: Array<{ name: string; type: string; canonical?: string }>
          facts: Array<{
            entityIndex: number
            predicate: string
            object: string
            confidence: number
          }>
        })
      : null

  if (data.skipped) {
    return (
      <div className="text-sm text-[var(--warning)] italic">
        skipped: {data.reason}
      </div>
    )
  }

  const merged = autoDedup?.identityLinksCreated ?? 0
  return (
    <div className="space-y-3">
      <div className="text-xs text-[var(--text-muted)] flex items-center gap-2 flex-wrap">
        <span>
          {data.extractedEntityIds?.length ?? 0} entities ·{' '}
          {data.extractedFactIds?.length ?? 0} facts
        </span>
        {merged > 0 && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] text-[10px] uppercase tracking-wider">
            <Sparkles className="w-3 h-3" />
            lazy merge · {merged} identity_of
          </span>
        )}
      </div>

      {extracted && extracted.facts.length > 0 && (
        <ul className="space-y-1">
          {extracted.facts.map((f, i) => {
            const ent = extracted.entities[f.entityIndex]
            return (
              <li
                key={i}
                className="flex items-baseline gap-2 text-sm font-mono"
              >
                <span className="text-[var(--text-muted)] truncate max-w-[10rem]">
                  {ent?.canonical ?? ent?.name ?? '?'}
                </span>
                <span className="text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
                  {f.predicate}
                </span>
                <span className="text-[var(--text)] truncate flex-1">
                  {f.object}
                </span>
                <span className="text-[10px] text-[var(--text-faint)]">
                  {f.confidence.toFixed(2)}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <DemoTraceStrip trace={trace} />
    </div>
  )
}

function SearchBody({
  results,
  trace,
}: {
  results: SearchHit[]
  trace?: TracePayload
}) {
  if (results.length === 0) {
    return (
      <div className="text-sm text-[var(--text-muted)] italic">
        ∅ brain returned no hits
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {results.map((r, i) => (
          <li key={r.entityId}>
            <div className="flex items-baseline gap-2 text-sm">
              <span className="font-mono text-[var(--text-faint)] w-5">
                #{i + 1}
              </span>
              <span className="font-medium text-[var(--text)]">
                {r.canonicalName}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                {r.entityType}
              </span>
              <span className="ml-auto font-mono text-[10px] text-[var(--accent)]">
                {r.score.toFixed(3)}
              </span>
            </div>
            <ul className="mt-1 ml-7 space-y-0.5">
              {r.facts.slice(0, 5).map((f) => (
                <li
                  key={f.factId}
                  className="flex items-baseline gap-2 text-xs font-mono"
                >
                  <span className="text-[var(--text-faint)] uppercase tracking-wider text-[10px] w-16">
                    {f.predicate}
                  </span>
                  <span className="text-[var(--text)] flex-1 truncate">
                    {f.object}
                  </span>
                  {f.status !== 'active' && (
                    <span
                      className={`text-[10px] uppercase tracking-wider ${
                        f.status === 'retracted'
                          ? 'text-[var(--danger)]'
                          : 'text-[var(--text-faint)]'
                      }`}
                    >
                      {f.status}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <DemoTraceStrip trace={trace} />
    </div>
  )
}

function DreamsBody({ data }: { data: DreamsResp }) {
  const dedupLinks = data.dedup?.identityLinksCreated ?? 0
  const resolveApplied = data.resolve?.resolutionsApplied ?? 0
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)]">
            dedup
          </div>
          <div className="font-mono text-[var(--text)]">
            {dedupLinks} identity_of links
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)]">
            resolve
          </div>
          <div className="font-mono text-[var(--text)]">
            {resolveApplied} resolutions
          </div>
        </div>
      </div>
      {dedupLinks === 0 && resolveApplied === 0 && (
        <div className="text-xs text-[var(--text-faint)] italic">
          ничего не нашли — отдельные сущности или порог сходства не пройден
        </div>
      )}
      <DemoTraceStrip trace={data.trace} />
    </div>
  )
}
