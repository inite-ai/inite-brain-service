'use client'

import { useMemo, useState } from 'react'
import {
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronRight,
  Cog,
} from 'lucide-react'
import { TraceSpan } from './DemoTraceStrip'

export interface TraceArtifact {
  spanId?: string
  name: string
  ts: number
  value: unknown
}

export interface EngineTrace {
  requestId: string
  totalMs: number
  spans: TraceSpan[]
  artifacts?: TraceArtifact[]
}

interface TreeNode {
  span: TraceSpan
  children: TreeNode[]
  artifacts: TraceArtifact[]
}

function buildTree(
  spans: TraceSpan[],
  artifacts: TraceArtifact[],
): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  for (const s of spans) byId.set(s.id, { span: s, children: [], artifacts: [] })
  for (const a of artifacts) {
    const id = a.spanId ?? null
    if (id && byId.has(id)) byId.get(id)!.artifacts.push(a)
  }
  const roots: TreeNode[] = []
  for (const node of byId.values()) {
    const parent = node.span.parentId
      ? byId.get(node.span.parentId)
      : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/**
 * Engine-view trace renderer. Shows the request as a hierarchical
 * waterfall — every recorded span as a duration bar, click to expand
 * the captured artifacts (LLM prompts, retrieval hits with scores,
 * NLU extraction results). Designed for the talk: the audience can
 * follow how the chat-router decided "ask", how vector + lexical legs
 * pulled candidates, how the reranker reordered them, all the way to
 * the answer. Like watching the gears turn.
 */
export function DemoEngineView({ trace }: { trace?: EngineTrace }) {
  // Hooks must run unconditionally — compute defensively, then early-return
  // below (a bare `return null` before useMemo violates rules-of-hooks).
  const spans = trace?.spans ?? []
  const artifacts = trace?.artifacts ?? []
  const tree = useMemo(() => buildTree(spans, artifacts), [spans, artifacts])
  if (!trace || trace.spans.length === 0) {
    return null
  }
  const baseStart = Math.min(...spans.map((s) => s.startedAt))
  const orphanArtifacts = artifacts.filter(
    (a) => !a.spanId || !spans.some((s) => s.id === a.spanId),
  )

  return (
    <details className="mt-4 border border-[var(--border)] rounded-lg bg-[var(--bg)]" open>
      <summary className="cursor-pointer px-4 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-2">
        <Cog className="w-3.5 h-3.5" />
        <span className="uppercase tracking-[0.2em]">engine view</span>
        <span className="font-mono">{trace.totalMs}ms</span>
        <span className="text-[var(--text-faint)] font-mono">
          · {spans.length} spans · {artifacts.length} artifacts
        </span>
      </summary>
      <div className="px-3 pb-3 space-y-1">
        {orphanArtifacts.length > 0 && (
          <div className="border border-dashed border-[var(--border)] rounded p-2 mb-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] mb-1">
              top-level
            </div>
            {orphanArtifacts.map((a, i) => (
              <ArtifactBlock key={`o-${i}`} artifact={a} />
            ))}
          </div>
        )}
        {tree.map((n) => (
          <SpanNode
            key={n.span.id}
            node={n}
            depth={0}
            baseStart={baseStart}
            totalMs={trace.totalMs}
          />
        ))}
      </div>
    </details>
  )
}

function SpanNode({
  node,
  depth,
  baseStart,
  totalMs,
}: {
  node: TreeNode
  depth: number
  baseStart: number
  totalMs: number
}) {
  const [open, setOpen] = useState(depth < 2)
  const offset = node.span.startedAt - baseStart
  const width = node.span.durationMs ?? 0
  const pctLeft = totalMs > 0 ? (offset / totalMs) * 100 : 0
  const pctW = totalMs > 0 ? Math.max((width / totalMs) * 100, 0.3) : 0
  const hasDetail =
    node.children.length > 0 ||
    node.artifacts.length > 0 ||
    !!node.span.error

  return (
    <div
      className="border-l border-[var(--border)] pl-2"
      style={{ marginLeft: depth * 8 }}
    >
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        disabled={!hasDetail}
        className={`w-full text-left py-1 px-1 rounded text-xs hover:bg-[var(--bg-overlay)] ${
          !hasDetail ? 'cursor-default opacity-70' : ''
        }`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-1 min-w-0">
            {hasDetail &&
              (open ? (
                <ChevronDown className="w-3 h-3 inline mr-0.5 text-[var(--text-faint)]" />
              ) : (
                <ChevronRight className="w-3 h-3 inline mr-0.5 text-[var(--text-faint)]" />
              ))}
            <span
              className={`font-mono ${
                node.span.error
                  ? 'text-[var(--danger)]'
                  : 'text-[var(--text)]'
              }`}
            >
              {node.span.name}
            </span>
            {node.span.error && (
              <AlertCircle className="w-3 h-3 text-[var(--danger)]" />
            )}
            {node.artifacts.length > 0 && (
              <span className="text-[10px] text-[var(--text-faint)] ml-1">
                {node.artifacts.length} artifact{node.artifacts.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <span className="text-[var(--text-faint)] font-mono tabular-nums">
            {width}ms
          </span>
        </div>
        <div className="relative h-1 mt-0.5">
          <div className="absolute inset-0 bg-[var(--bg-overlay)] rounded" />
          <div
            className={`absolute top-0 bottom-0 rounded ${
              node.span.error ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]'
            }`}
            style={{ left: `${pctLeft}%`, width: `${pctW}%` }}
          />
        </div>
      </button>

      {open && hasDetail && (
        <div className="mt-1 ml-3 space-y-1">
          {node.span.error && (
            <div className="text-xs text-[var(--danger)] font-mono">
              error: {node.span.error}
            </div>
          )}
          {node.artifacts.map((a, i) => (
            <ArtifactBlock key={`a-${i}`} artifact={a} />
          ))}
          {node.children.map((c) => (
            <SpanNode
              key={c.span.id}
              node={c}
              depth={depth + 1}
              baseStart={baseStart}
              totalMs={totalMs}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Artifact renderers ─────────────────────────────────────────────────

function ArtifactBlock({ artifact }: { artifact: TraceArtifact }) {
  const renderer = pickRenderer(artifact)
  const [open, setOpen] = useState(renderer.openByDefault)

  return (
    <div className="border border-[var(--border)] rounded">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-2 py-1 text-[10px] flex items-center gap-2 hover:bg-[var(--bg-overlay)]"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-[var(--text-faint)]" />
        ) : (
          <ChevronRight className="w-3 h-3 text-[var(--text-faint)]" />
        )}
        <Brain className="w-3 h-3 text-[var(--accent)]" />
        <span className="font-mono text-[var(--text)]">{artifact.name}</span>
        <span className="text-[var(--text-faint)] ml-auto">
          {renderer.label}
        </span>
      </button>
      {open && (
        <div className="px-2 py-2 border-t border-[var(--border)] bg-[var(--bg)]">
          {renderer.render()}
        </div>
      )}
    </div>
  )
}

interface Renderer {
  label: string
  openByDefault: boolean
  render: () => React.ReactNode
}

function pickRenderer(a: TraceArtifact): Renderer {
  const v = a.value
  // Prompts (chat-router, NLU, synthesize generator/verifier)
  if (
    a.name.endsWith('.prompt') ||
    a.name.endsWith('.prompt.build') ||
    a.name === 'nlu.prompt' ||
    a.name === 'demo.chat.prompt' ||
    a.name === 'synthesize.generator_prompt' ||
    a.name === 'synthesize.verifier_prompt'
  ) {
    if (isObject(v)) return promptRenderer(v as Record<string, unknown>)
  }
  // Route LLM output
  if (a.name === 'demo.chat.route' && isObject(v)) {
    return routeRenderer(v as Record<string, unknown>)
  }
  // NLU extracted entities + facts
  if (a.name === 'ingest.nlu.extracted' && isObject(v)) {
    return nluRenderer(v as Record<string, unknown>)
  }
  // Search artefacts
  if (
    (a.name === 'search.vector_hits' || a.name === 'search.lexical_hits') &&
    Array.isArray(v)
  ) {
    return hitsRenderer(v as Array<Record<string, unknown>>)
  }
  if (a.name === 'search.router_classification' && isObject(v)) {
    return classificationRenderer(v as Record<string, unknown>)
  }
  // Synthesize answer
  if (
    (a.name === 'synthesize.generator_output' ||
      a.name === 'synthesize.verifier_output') &&
    isObject(v)
  ) {
    return synthesizeRenderer(v as Record<string, unknown>)
  }
  // Truncated / unserialisable fallback
  if (isObject(v) && (v as { __truncated?: boolean }).__truncated) {
    const o = v as { preview: string; originalSize: number }
    return {
      label: `truncated · ${o.originalSize}B`,
      openByDefault: false,
      render: () => <pre className="text-[10px] whitespace-pre-wrap">{o.preview}</pre>,
    }
  }
  // Generic JSON
  return jsonRenderer(v)
}

function isObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null
}

function promptRenderer(v: Record<string, unknown>): Renderer {
  return {
    label: 'llm prompt',
    openByDefault: false,
    render: () => (
      <div className="space-y-2 text-[10px]">
        {(['system', 'user'] as const).map(
          (k) =>
            typeof v[k] === 'string' && (
              <div key={k}>
                <div className="uppercase tracking-[0.2em] text-[var(--text-faint)] mb-0.5">
                  {k}
                </div>
                <pre className="font-mono whitespace-pre-wrap text-[var(--text)] bg-[var(--bg-elevated)] p-2 rounded border border-[var(--border)] max-h-48 overflow-auto">
                  {String(v[k])}
                </pre>
              </div>
            ),
        )}
        {typeof v.model === 'string' && (
          <div className="text-[var(--text-faint)] font-mono">
            model: {v.model as string}
          </div>
        )}
      </div>
    ),
  }
}

function routeRenderer(v: Record<string, unknown>): Renderer {
  return {
    label: 'router output',
    openByDefault: true,
    render: () => (
      <div className="space-y-1 text-xs font-mono">
        <Row label="intent" value={String(v.intent ?? '?')} highlight />
        {!!v.cleanedQuery && (
          <Row label="cleanedQuery" value={String(v.cleanedQuery)} />
        )}
        {!!v.asOf && <Row label="asOf" value={String(v.asOf)} />}
        {!!v.reason && (
          <Row
            label="reason"
            value={String(v.reason)}
            wrap
          />
        )}
      </div>
    ),
  }
}

function nluRenderer(v: Record<string, unknown>): Renderer {
  const entities = Array.isArray(v.entities) ? v.entities : []
  const facts = Array.isArray(v.facts) ? v.facts : []
  return {
    label: `${entities.length} entities · ${facts.length} facts`,
    openByDefault: true,
    render: () => (
      <div className="space-y-2 text-[10px]">
        {entities.length > 0 && (
          <div>
            <div className="uppercase tracking-[0.2em] text-[var(--text-faint)] mb-1">
              entities
            </div>
            <ul className="space-y-0.5 font-mono">
              {entities.map((e: any, i: number) => (
                <li key={i}>
                  <span className="text-[var(--text)]">
                    {e.canonical ?? e.name}
                  </span>
                  <span className="text-[var(--text-faint)] ml-2">
                    [{e.type}]
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {facts.length > 0 && (
          <div>
            <div className="uppercase tracking-[0.2em] text-[var(--text-faint)] mb-1">
              facts
            </div>
            <table className="w-full font-mono text-[10px]">
              <thead>
                <tr className="text-[var(--text-faint)]">
                  <th className="text-left pb-0.5">subject</th>
                  <th className="text-left pb-0.5">predicate</th>
                  <th className="text-left pb-0.5">object</th>
                  <th className="text-right pb-0.5">conf</th>
                </tr>
              </thead>
              <tbody>
                {facts.map((f: any, i: number) => {
                  const ent = entities[f.entityIndex]
                  return (
                    <tr key={i} className="border-t border-[var(--border)]">
                      <td className="py-0.5 text-[var(--text-muted)] truncate max-w-[8rem]">
                        {ent?.canonical ?? ent?.name ?? '?'}
                      </td>
                      <td className="py-0.5 text-[var(--text-faint)]">
                        {f.predicate}
                      </td>
                      <td className="py-0.5 text-[var(--text)] truncate">
                        {f.object}
                      </td>
                      <td className="py-0.5 text-right text-[var(--text-faint)]">
                        {typeof f.confidence === 'number'
                          ? f.confidence.toFixed(2)
                          : '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    ),
  }
}

function hitsRenderer(hits: Array<Record<string, unknown>>): Renderer {
  const max = hits.reduce((m, h) => {
    const s = typeof h.simScore === 'number'
      ? h.simScore
      : typeof h.bm25Score === 'number'
        ? h.bm25Score
        : 0
    return Math.max(m, s)
  }, 0)
  return {
    label: `${hits.length} hits`,
    openByDefault: false,
    render: () => (
      <ul className="space-y-0.5 text-[10px]">
        {hits.slice(0, 15).map((h, i) => {
          const score =
            typeof h.simScore === 'number'
              ? h.simScore
              : typeof h.bm25Score === 'number'
                ? h.bm25Score
                : 0
          const pct = max > 0 ? (score / max) * 100 : 0
          return (
            <li key={i} className="space-y-0.5">
              <div className="flex items-baseline justify-between gap-2 font-mono">
                <span className="text-[var(--text-muted)] truncate">
                  <span className="text-[var(--text-faint)]">
                    {h.predicate as string}
                  </span>
                  : <span className="text-[var(--text)]">{h.object as string}</span>
                </span>
                <span className="text-[var(--accent)]">
                  {score.toFixed(3)}
                </span>
              </div>
              <div className="h-1 bg-[var(--bg-overlay)] rounded">
                <div
                  className="h-1 bg-[var(--accent)] rounded"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    ),
  }
}

function classificationRenderer(v: Record<string, unknown>): Renderer {
  const preds = (v.predicates as { weights?: Record<string, number> } | undefined)
    ?.weights
  const types = (v.types as { weights?: Record<string, number> } | undefined)
    ?.weights
  return {
    label: 'router weights',
    openByDefault: false,
    render: () => (
      <div className="space-y-2 text-[10px]">
        {preds && Object.keys(preds).length > 0 && (
          <BarBlock title="predicate intent" weights={preds} />
        )}
        {types && Object.keys(types).length > 0 && (
          <BarBlock title="target entity type" weights={types} />
        )}
      </div>
    ),
  }
}

function BarBlock({
  title,
  weights,
}: {
  title: string
  weights: Record<string, number>
}) {
  const entries = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
  const max = Math.max(...entries.map(([, w]) => w))
  return (
    <div>
      <div className="uppercase tracking-[0.2em] text-[var(--text-faint)] mb-1">
        {title}
      </div>
      <ul className="space-y-0.5">
        {entries.map(([k, w]) => (
          <li key={k} className="space-y-0.5">
            <div className="flex items-baseline justify-between font-mono">
              <span className="text-[var(--text-muted)]">{k}</span>
              <span className="text-[var(--text-faint)]">{w.toFixed(2)}</span>
            </div>
            <div className="h-1 bg-[var(--bg-overlay)] rounded">
              <div
                className="h-1 bg-[var(--accent)] rounded"
                style={{ width: `${(w / (max || 1)) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function synthesizeRenderer(v: Record<string, unknown>): Renderer {
  return {
    label:
      'verdict' in v ? `verdict: ${String(v.verdict)}` : 'synthesizer answer',
    openByDefault: true,
    render: () => (
      <div className="space-y-2 text-xs">
        {typeof v.answer === 'string' && (
          <div className="text-[var(--text)] whitespace-pre-wrap font-mono">
            {v.answer}
          </div>
        )}
        {Array.isArray(v.citedFactIds) && v.citedFactIds.length > 0 && (
          <div className="text-[10px] font-mono text-[var(--text-faint)]">
            citations: {(v.citedFactIds as string[]).join(', ')}
          </div>
        )}
        {Array.isArray(v.unsupportedClaims) &&
          v.unsupportedClaims.length > 0 && (
            <div className="text-[10px] text-[var(--danger)]">
              unsupported:
              <ul className="list-disc list-inside">
                {(v.unsupportedClaims as string[]).map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
      </div>
    ),
  }
}

function jsonRenderer(v: unknown): Renderer {
  return {
    label: 'json',
    openByDefault: false,
    render: () => (
      <pre className="text-[10px] font-mono whitespace-pre-wrap text-[var(--text)] max-h-40 overflow-auto">
        {safeStringify(v)}
      </pre>
    ),
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function Row({
  label,
  value,
  highlight,
  wrap,
}: {
  label: string
  value: string
  highlight?: boolean
  wrap?: boolean
}) {
  return (
    <div
      className={`flex ${wrap ? 'flex-col gap-0.5' : 'items-baseline gap-2'}`}
    >
      <span className="text-[var(--text-faint)] uppercase tracking-wider text-[10px] w-24 shrink-0">
        {label}
      </span>
      <span
        className={`${
          highlight ? 'text-[var(--accent)]' : 'text-[var(--text)]'
        } ${wrap ? 'whitespace-pre-wrap text-[10px]' : 'truncate'}`}
      >
        {value}
      </span>
    </div>
  )
}
