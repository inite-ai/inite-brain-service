'use client'

import { useMemo, useState } from 'react'
import {
  AlertCircle,
  ChevronRight,
  Copy,
  Download,
  Network,
  Timer as TimerIcon,
  TreePine,
  Zap,
} from 'lucide-react'
import { JsonView } from '../admin/JsonView'

interface DebugSpan {
  id: string
  parentId?: string
  name: string
  startedAt: number
  durationMs?: number
  attributes?: Record<string, unknown>
  error?: string
}

export interface DebugArtifact {
  spanId?: string
  name: string
  ts: number
  value: unknown
}

export interface DebugTracePayload {
  requestId: string
  totalMs: number
  spans: DebugSpan[]
  artifacts: DebugArtifact[]
}

interface Props {
  trace: DebugTracePayload | null | undefined
}

interface TreeNode {
  span: DebugSpan
  children: TreeNode[]
}

function buildTree(spans: DebugSpan[]): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  for (const s of spans) byId.set(s.id, { span: s, children: [] })
  const roots: TreeNode[] = []
  for (const node of byId.values()) {
    const p = node.span.parentId ? byId.get(node.span.parentId) : undefined
    if (p) p.children.push(node)
    else roots.push(node)
  }
  return roots
}

type ViewMode = 'tree' | 'timeline' | 'lattice'

interface TokenRollup {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  cacheHits: number
  llmCalls: number
}

function rollupTokens(spans: DebugSpan[]): TokenRollup {
  const out: TokenRollup = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheHits: 0,
    llmCalls: 0,
  }
  for (const s of spans) {
    const attrs = s.attributes ?? {}
    const prompt =
      (attrs['gen_ai.usage.prompt_tokens'] as number | undefined) ??
      (attrs['gen_ai.usage.input_tokens'] as number | undefined) ??
      (attrs['llm.usage.prompt_tokens'] as number | undefined) ??
      0
    const completion =
      (attrs['gen_ai.usage.completion_tokens'] as number | undefined) ??
      (attrs['gen_ai.usage.output_tokens'] as number | undefined) ??
      (attrs['llm.usage.completion_tokens'] as number | undefined) ??
      0
    const cached =
      (attrs['gen_ai.usage.cached_tokens'] as number | undefined) ??
      (attrs['llm.usage.cached_tokens'] as number | undefined) ??
      0
    const cacheHit = attrs['cache.hit'] === true || attrs['cache_hit'] === true
    const isLlm =
      typeof attrs['gen_ai.system'] === 'string' ||
      typeof attrs['gen_ai.request.model'] === 'string' ||
      typeof attrs['llm.model'] === 'string'
    if (typeof prompt === 'number') out.promptTokens += prompt
    if (typeof completion === 'number') out.completionTokens += completion
    if (typeof cached === 'number') out.cachedTokens += cached
    if (cacheHit) out.cacheHits += 1
    if (isLlm) out.llmCalls += 1
  }
  out.totalTokens = out.promptTokens + out.completionTokens
  return out
}

export function TraceWaterfall({ trace }: Props) {
  const [view, setView] = useState<ViewMode>('tree')
  // Hooks MUST run unconditionally — keep them above any early return.
  // Empty-trace fallbacks below operate on the safe defaults.
  const spans = trace?.spans ?? []
  const artifacts = trace?.artifacts ?? []
  const tree = useMemo(() => buildTree(spans), [spans])
  const artifactsBySpan = useMemo(() => {
    const m = new Map<string, DebugArtifact[]>()
    for (const a of artifacts) {
      const key = a.spanId ?? '__top'
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(a)
    }
    return m
  }, [artifacts])
  const tokens = useMemo(() => rollupTokens(spans), [spans])

  if (!trace) {
    return (
      <div className="text-xs text-[var(--text-faint)] italic px-2 py-3">
        No trace captured. Ensure the request was sent with ?debug=1.
      </div>
    )
  }

  const baseStart = spans.length
    ? Math.min(...spans.map((s) => s.startedAt))
    : 0

  const copyLink = () => {
    if (typeof window === 'undefined') return
    void navigator.clipboard.writeText(window.location.href)
  }
  const downloadTrace = () => {
    if (typeof window === 'undefined') return
    const blob = new Blob([JSON.stringify(trace, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `trace-${trace.requestId.slice(0, 12)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="text-xs font-mono">
      <div className="mb-2 flex items-baseline gap-3 flex-wrap">
        <div className="text-[var(--text-muted)]">
          request{' '}
          <span className="text-[var(--text)]">{trace.requestId.slice(0, 8)}</span>
          {' · '}
          total <span className="text-[var(--text)]">{trace.totalMs}ms</span>
          {' · '}
          spans <span className="text-[var(--text)]">{trace.spans.length}</span>
          {' · '}
          artifacts{' '}
          <span className="text-[var(--text)]">{trace.artifacts.length}</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={copyLink}
            className="px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
            title="Copy share link"
          >
            <Copy className="w-3 h-3" /> link
          </button>
          <button
            type="button"
            onClick={downloadTrace}
            className="px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
            title="Download trace as JSON"
          >
            <Download className="w-3 h-3" /> export
          </button>
        </div>
      </div>

      {(tokens.llmCalls > 0 || tokens.totalTokens > 0) && (
        <div className="mb-2 grid grid-cols-2 md:grid-cols-5 gap-2 text-[10px]">
          <TokenStat label="prompt" value={tokens.promptTokens} />
          <TokenStat label="completion" value={tokens.completionTokens} />
          <TokenStat label="total" value={tokens.totalTokens} accent />
          <TokenStat
            label="cached"
            value={tokens.cachedTokens}
            hint={`${tokens.cacheHits} hits`}
          />
          <TokenStat
            label="llm calls"
            value={tokens.llmCalls}
            icon={<Zap className="w-2.5 h-2.5" />}
          />
        </div>
      )}

      <div className="mb-2 flex border border-[var(--border)] rounded-md overflow-hidden text-[10px] w-fit">
        <ViewTab
          active={view === 'tree'}
          icon={TreePine}
          label="tree"
          onClick={() => setView('tree')}
        />
        <ViewTab
          active={view === 'timeline'}
          icon={TimerIcon}
          label="timeline"
          onClick={() => setView('timeline')}
        />
        <ViewTab
          active={view === 'lattice'}
          icon={Network}
          label="lattice"
          onClick={() => setView('lattice')}
        />
      </div>

      {tree.length === 0 && (
        <div className="text-[var(--text-faint)] italic">
          No spans recorded. Wider instrumentation needed.
        </div>
      )}
      {view === 'tree' &&
        tree.map((node) => (
          <SpanNode
            key={node.span.id}
            node={node}
            depth={0}
            baseStart={baseStart}
            totalMs={trace.totalMs}
            artifactsBySpan={artifactsBySpan}
          />
        ))}
      {view === 'timeline' && (
        <TimelineView
          spans={spans}
          baseStart={baseStart}
          totalMs={trace.totalMs}
        />
      )}
      {view === 'lattice' && (
        <LatticeView spans={spans} baseStart={baseStart} />
      )}
    </div>
  )
}

function ViewTab({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean
  icon: typeof TreePine
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-1 border-r border-[var(--border)] last:border-r-0 flex items-center gap-1 ${
        active
          ? 'bg-[var(--bg-overlay)] text-[var(--text)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text)]'
      }`}
    >
      <Icon className="w-3 h-3" />
      {label}
    </button>
  )
}

function TokenStat({
  label,
  value,
  accent,
  hint,
  icon,
}: {
  label: string
  value: number
  accent?: boolean
  hint?: string
  icon?: React.ReactNode
}) {
  return (
    <div className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg-elevated)] font-mono">
      <div className="text-[10px] text-[var(--text-faint)] flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div
        className={`tabular-nums ${accent ? 'text-[var(--accent)]' : 'text-[var(--text)]'}`}
      >
        {value.toLocaleString()}
      </div>
      {hint && (
        <div className="text-[10px] text-[var(--text-faint)]">{hint}</div>
      )}
    </div>
  )
}

function TimelineView({
  spans,
  baseStart,
  totalMs,
}: {
  spans: DebugSpan[]
  baseStart: number
  totalMs: number
}) {
  const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt)
  return (
    <div className="space-y-0.5">
      {sorted.map((s) => {
        const offset = s.startedAt - baseStart
        const widthMs = s.durationMs ?? 0
        const pctLeft = totalMs > 0 ? (offset / totalMs) * 100 : 0
        const pctW = totalMs > 0 ? Math.max((widthMs / totalMs) * 100, 0.5) : 0
        const llm =
          typeof s.attributes?.['gen_ai.request.model'] === 'string' ||
          typeof s.attributes?.['llm.model'] === 'string'
        const cached =
          s.attributes?.['cache.hit'] === true ||
          s.attributes?.['cache_hit'] === true
        const color = s.error
          ? 'bg-[var(--danger)]'
          : llm
            ? 'bg-[var(--warning)]'
            : 'bg-[var(--accent)]'
        return (
          <div key={s.id} className="grid grid-cols-[12rem_1fr_4rem] gap-2 items-center">
            <div className="truncate text-[var(--text-muted)]">
              {s.name}
              {cached && (
                <span className="ml-1 text-[10px] text-[var(--success)]">
                  ●cache
                </span>
              )}
            </div>
            <div className="relative h-2 bg-[var(--bg-overlay)] rounded">
              <div
                className={`absolute top-0 bottom-0 rounded ${color}`}
                style={{ left: `${pctLeft}%`, width: `${pctW}%` }}
              />
            </div>
            <div className="text-right tabular-nums text-[var(--text-faint)]">
              {widthMs}ms
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LatticeView({
  spans,
  baseStart,
}: {
  spans: DebugSpan[]
  baseStart: number
}) {
  // Bucket by short logical stage inferred from span name prefix.
  // Inite pipeline emits names like `mention.extract`, `extract.canonicalize`,
  // `resolve_fact.embed`, etc — split on the first `.` to surface the
  // retrieve→augment→generate-style lattice.
  const stages = new Map<
    string,
    { name: string; count: number; totalMs: number; spans: DebugSpan[] }
  >()
  for (const s of spans) {
    const stage = (s.name.split('.')[0] ?? 'other').toLowerCase()
    const bucket =
      stages.get(stage) ?? { name: stage, count: 0, totalMs: 0, spans: [] }
    bucket.count += 1
    bucket.totalMs += s.durationMs ?? 0
    bucket.spans.push(s)
    stages.set(stage, bucket)
  }
  const ordered = [...stages.values()].sort(
    (a, b) =>
      Math.min(...a.spans.map((s) => s.startedAt)) -
      Math.min(...b.spans.map((s) => s.startedAt)),
  )
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-[var(--text-faint)]">
        Aggregated by stage name (prefix before first &quot;.&quot;)
      </div>
      <div className="flex flex-wrap gap-2">
        {ordered.map((s, i) => (
          <div
            key={s.name}
            className="flex items-center gap-1.5 text-[10px]"
          >
            <div className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg-elevated)]">
              <div className="font-mono text-[var(--text)]">{s.name}</div>
              <div className="text-[var(--text-muted)]">
                {s.count} spans · {s.totalMs}ms
              </div>
            </div>
            {i < ordered.length - 1 && (
              <ChevronRight className="w-3 h-3 text-[var(--text-faint)]" />
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
        {ordered.map((s) => (
          <div
            key={`detail-${s.name}`}
            className="border border-[var(--border)] rounded-md p-2"
          >
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
              {s.name} ({s.count})
            </div>
            <ul className="space-y-0.5 text-[10px] font-mono">
              {s.spans.slice(0, 8).map((sp) => (
                <li key={sp.id} className="flex items-baseline gap-2">
                  <span className="text-[var(--text-faint)]">
                    +{(sp.startedAt - baseStart).toString().padStart(4)}
                  </span>
                  <span className="text-[var(--text)] flex-1 truncate">
                    {sp.name}
                  </span>
                  <span className="text-[var(--text-muted)]">
                    {sp.durationMs ?? 0}ms
                  </span>
                </li>
              ))}
              {s.spans.length > 8 && (
                <li className="text-[var(--text-faint)] italic">
                  +{s.spans.length - 8} more
                </li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

function SpanNode({
  node,
  depth,
  baseStart,
  totalMs,
  artifactsBySpan,
}: {
  node: TreeNode
  depth: number
  baseStart: number
  totalMs: number
  artifactsBySpan: Map<string, DebugArtifact[]>
}) {
  const [open, setOpen] = useState(depth < 1)
  const offset = node.span.startedAt - baseStart
  const widthMs = node.span.durationMs ?? 0
  const pctLeft = totalMs > 0 ? (offset / totalMs) * 100 : 0
  const pctW = totalMs > 0 ? Math.max((widthMs / totalMs) * 100, 0.5) : 0
  const artifacts = artifactsBySpan.get(node.span.id) ?? []

  return (
    <div className="border-l border-[var(--border)] pl-1 my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 w-full text-left hover:bg-[var(--bg-overlay)] py-0.5 px-1 rounded"
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        <ChevronRight
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-[var(--text)] truncate">{node.span.name}</span>
        {node.span.error && (
          <AlertCircle className="w-3 h-3 text-[var(--danger)]" />
        )}
        <span className="ml-2 text-[var(--text-faint)] tabular-nums">
          {widthMs}ms
        </span>
      </button>

      <div className="relative h-1 mt-0.5 ml-2 mb-1">
        <div className="absolute inset-0 bg-[var(--bg-overlay)] rounded" />
        <div
          className={`absolute top-0 bottom-0 rounded ${
            node.span.error ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]'
          }`}
          style={{ left: `${pctLeft}%`, width: `${pctW}%` }}
        />
      </div>

      {open && (
        <div className="ml-4 mt-1 space-y-1">
          {node.span.attributes &&
            Object.keys(node.span.attributes).length > 0 && (
              <div className="text-[var(--text-faint)]">
                attrs:{' '}
                {Object.entries(node.span.attributes).map(([k, v]) => (
                  <span key={k} className="mr-2">
                    <span className="text-[var(--text-muted)]">{k}=</span>
                    {String(v)}
                  </span>
                ))}
              </div>
            )}
          {node.span.error && (
            <div className="text-[var(--danger)]">error: {node.span.error}</div>
          )}
          {artifacts.map((a, i) => (
            <ArtifactBlock key={`${a.name}-${i}`} artifact={a} />
          ))}
          {node.children.map((c) => (
            <SpanNode
              key={c.span.id}
              node={c}
              depth={depth + 1}
              baseStart={baseStart}
              totalMs={totalMs}
              artifactsBySpan={artifactsBySpan}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ArtifactBlock({ artifact }: { artifact: DebugArtifact }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-[var(--border)] rounded">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-2 py-1 text-[var(--text-muted)] hover:bg-[var(--bg-overlay)] flex items-center gap-1"
      >
        <ChevronRight
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        artifact: <span className="text-[var(--text)]">{artifact.name}</span>
      </button>
      {open && (
        <div className="px-2 py-1 max-h-72 overflow-auto bg-[var(--bg)]">
          <JsonView value={artifact.value} />
        </div>
      )}
    </div>
  )
}
