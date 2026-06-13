'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { DemoFrame } from './DemoFrame'
import { TracePayload as BaseTracePayload } from './DemoTraceStrip'
import { DemoEngineView } from './DemoEngineView'

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

type PiiClass = 'none' | 'identifier' | 'behavioral' | 'text' | 'sensitive'
type Semantics =
  | 'single_active'
  | 'append_only'
  | 'bitemporal'
  | 'singleton_per_kind'

interface FactPolicy {
  piiClass: PiiClass
  semantics: Semantics
  decayHalfLifeDays: number | null
  requiresScope: string | null
}

interface FactMatch {
  vector: number | null
  lexical: number | null
  backfill: boolean
}

interface BrainFact {
  factId: string
  predicate: string
  object: string
  confidence: number
  status: string
  validFrom: string
  validUntil?: string
  policy?: FactPolicy
  match?: FactMatch
}

interface SearchHit {
  entityId: string
  canonicalName: string
  entityType: string
  score: number
  externalRefs?: Record<string, string>
  facts: BrainFact[]
}

interface ChatResp {
  route: {
    intent: 'tell' | 'ask'
    normalizedMessage?: string
    cleanedQuery?: string
    asOf?: string
    reason?: string
  }
  mode?: 'vector' | 'graph'
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
  mode?: 'vector' | 'graph'
}

const STARTERS = [
  'Maria Petrov is our new CTO at Acme. She moved from Berlin and prefers vegan lunch.',
  'who runs engineering at Acme',
  'Maria switched to keto last month.',
  'what does Maria eat',
  'what did Maria eat in February',
]

interface TenantState {
  entities: number
  facts: number
  lastIngestAt: string | null
}

export function LiveIngestSlide() {
  const [message, setMessage] = useState(STARTERS[0])
  const [includePii, setIncludePii] = useState(false)
  const [mode, setMode] = useState<'vector' | 'graph'>('vector')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [tenantState, setTenantState] = useState<TenantState | null>(null)

  const refreshState = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/demo/state')
      if (!res.ok) return
      const data = (await res.json()) as TenantState
      setTenantState(data)
    } catch {
      // Best-effort — state guard is helpful, not load-bearing.
    }
  }, [])

  useEffect(() => {
    refreshState()
  }, [refreshState])

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!message.trim() || busy) return
    const id = crypto.randomUUID()
    const prompt = message
    setTurns((t) => [
      ...t,
      { id, prompt, pending: true, kind: 'chat', mode },
    ])
    setBusy(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/demo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt, includePii, mode }),
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
      refreshState()
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
      await refreshState()
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
      {tenantState && tenantState.facts > 0 && turns.length === 0 && (
        <div className="mb-6 border border-[var(--warning)]/40 bg-[var(--warning)]/5 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-[var(--warning)] shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm text-[var(--text)] font-medium">
              tenant carries {tenantState.entities} entities ·{' '}
              {tenantState.facts} facts from a previous session
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">
              {tenantState.lastIngestAt &&
                `last ingest ${tenantState.lastIngestAt.slice(0, 16)}. `}
              demo поверх старых данных запутает search и LLM-контекст —
              почисти перед началом доклада.
            </div>
          </div>
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-[var(--warning)] text-white text-sm disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            start clean
          </button>
        </div>
      )}

      <div className="flex items-center gap-4 mb-6">
        <span className="text-xs font-mono text-[var(--text-faint)]">
          tenant: demo_live
          {tenantState && (
            <span className="ml-2 text-[var(--text-muted)]">
              · {tenantState.entities} ent · {tenantState.facts} facts
            </span>
          )}
        </span>
        <label className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 select-none">
          <input
            type="checkbox"
            checked={includePii}
            onChange={(e) => setIncludePii(e.target.checked)}
          />
          read_pii
        </label>
        <div className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
          mode
          <div className="inline-flex rounded-md border border-[var(--border)] overflow-hidden">
            <button
              type="button"
              onClick={() => setMode('vector')}
              className={`px-2 py-0.5 text-xs ${
                mode === 'vector'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              vector
            </button>
            <button
              type="button"
              onClick={() => setMode('graph')}
              className={`px-2 py-0.5 text-xs ${
                mode === 'graph'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              graph
            </button>
          </div>
        </div>
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
            {intent === 'tell'
              ? 'tell · ingest'
              : turn.mode === 'graph'
                ? 'ask · graph'
                : 'ask · vector'}
          </span>
        )}
        {asOf && (
          <span className="text-[10px] font-mono text-[var(--text-faint)]">
            asOf {asOf.slice(0, 16)}
          </span>
        )}
        {turn.chat?.route?.normalizedMessage &&
          turn.chat.route.normalizedMessage !== turn.prompt && (
            <span
              className="text-[10px] font-mono text-[var(--accent)] truncate max-w-xs"
              title={turn.chat.route.normalizedMessage}
            >
              → “{turn.chat.route.normalizedMessage}”
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

      <DemoEngineView trace={trace} />
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
    <div className="space-y-3">
      <ul className="space-y-3">
        {results.map((r, i) => (
          <li
            key={r.entityId}
            className="border border-[var(--border)] rounded p-2"
          >
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
            <HitWhy facts={r.facts} />
            <ul className="mt-2 space-y-1.5">
              {r.facts.slice(0, 5).map((f) => (
                <FactRow key={f.factId} fact={f} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <DemoEngineView trace={trace} />
    </div>
  )
}

function FactRow({ fact }: { fact: BrainFact }) {
  const status = fact.status ?? 'active'
  return (
    <li className="text-xs">
      <div className="flex items-baseline gap-2 font-mono">
        <span className="text-[var(--text-faint)] uppercase tracking-wider text-[10px] min-w-[6rem]">
          {fact.predicate}
        </span>
        <span className="text-[var(--text)] flex-1 break-words">
          {fact.object}
        </span>
        {fact.match && <MatchBadge match={fact.match} />}
        {fact.policy && <PiiBadge piiClass={fact.policy.piiClass} />}
        <StatusBadge status={status} />
      </div>
      <div className="flex items-baseline gap-2 mt-0.5 ml-[6rem] text-[10px] font-mono text-[var(--text-faint)] flex-wrap">
        <span>
          valid {ymd(fact.validFrom)}
          {' → '}
          {fact.validUntil ? ymd(fact.validUntil) : 'now'}
        </span>
        {fact.policy && (
          <span title="how brain treats updates to this predicate">
            · {fact.policy.semantics}
          </span>
        )}
        {fact.policy?.decayHalfLifeDays != null && (
          <span title="half-life: how fast confidence decays over time">
            · ½‑life {fact.policy.decayHalfLifeDays}d
          </span>
        )}
        <span title="brain's confidence in this fact">
          · conf {fact.confidence.toFixed(2)}
        </span>
      </div>
    </li>
  )
}

function MatchBadge({ match }: { match: FactMatch }) {
  if (match.backfill) {
    return (
      <span
        className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--bg-overlay)] text-[var(--text-faint)]"
        title="brought in by bitemporal closure on the matched entity — did not hit any retrieval leg directly"
      >
        backfill
      </span>
    )
  }
  const parts: string[] = []
  if (match.vector !== null) parts.push(`vec ${match.vector.toFixed(2)}`)
  if (match.lexical !== null) parts.push(`lex ${match.lexical.toFixed(2)}`)
  return (
    <span
      className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)]"
      title="retrieval signal: vector = query-embedding cosine on the fact's embedding; lexical = BM25 on predicate + object haystack"
    >
      {parts.join(' · ')}
    </span>
  )
}

function HitWhy({ facts }: { facts: BrainFact[] }) {
  // Summarise which facts (predicate=object) carried the entity into
  // the result set vs which rode along as backfill. This is the
  // 'why is Vasya here when I asked about Maria' answer.
  const matched = facts.filter((f) => f.match && !f.match.backfill)
  if (matched.length === 0) {
    return (
      <div className="ml-7 mt-0.5 text-[10px] font-mono text-[var(--text-faint)]">
        no direct match — entity came back via neighbour graph / rerank
      </div>
    )
  }
  const top = matched
    .slice()
    .sort((a, b) => {
      const av = a.match!.vector ?? a.match!.lexical ?? 0
      const bv = b.match!.vector ?? b.match!.lexical ?? 0
      return bv - av
    })[0]
  const sig =
    top.match!.vector !== null
      ? `vector cosine ${top.match!.vector.toFixed(2)}`
      : `BM25 ${top.match!.lexical!.toFixed(2)}`
  return (
    <div className="ml-7 mt-0.5 text-[10px] font-mono text-[var(--text-faint)]">
      matched on{' '}
      <span className="text-[var(--accent)]">
        {top.predicate}={top.object}
      </span>{' '}
      via {sig}
      {matched.length > 1 && (
        <span className="text-[var(--text-faint)]">
          {' '}
          (+{matched.length - 1} other matched fact{matched.length > 2 ? 's' : ''})
        </span>
      )}
    </div>
  )
}

function PiiBadge({ piiClass }: { piiClass: PiiClass }) {
  const tone: Record<PiiClass, string> = {
    none: 'bg-[var(--bg-overlay)] text-[var(--text-faint)]',
    identifier: 'bg-[var(--warning)]/15 text-[var(--warning)]',
    behavioral: 'bg-[var(--accent)]/15 text-[var(--accent)]',
    text: 'bg-[var(--bg-overlay)] text-[var(--text-muted)]',
    sensitive: 'bg-[var(--danger)]/15 text-[var(--danger)]',
  }
  return (
    <span
      title={`piiClass · ${piiClass}`}
      className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${tone[piiClass]}`}
    >
      {piiClass}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span
        className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)]"
        title="status · active"
      >
        active
      </span>
    )
  }
  const tone =
    status === 'retracted'
      ? 'bg-[var(--danger)]/15 text-[var(--danger)] line-through'
      : status === 'competing'
        ? 'bg-[var(--warning)]/15 text-[var(--warning)]'
        : 'bg-[var(--bg-overlay)] text-[var(--text-faint)]'
  return (
    <span
      className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${tone}`}
      title={`status · ${status}`}
    >
      {status}
    </span>
  )
}

function ymd(iso: string): string {
  return iso.slice(0, 10)
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
      <DemoEngineView trace={data.trace} />
    </div>
  )
}
