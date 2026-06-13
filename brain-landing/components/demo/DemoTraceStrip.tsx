'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

export interface TraceSpan {
  id: string
  parentId?: string
  name: string
  startedAt: number
  durationMs?: number
  error?: string
}

export interface TracePayload {
  requestId: string
  totalMs: number
  spans: TraceSpan[]
}

/**
 * Compact stage waterfall for the demo deck. Shows only top-level spans
 * (parentId === undefined OR parent is search.*) as proportional bars
 * so the presenter can point at "this is vector retrieval, this is
 * reranker" without zooming in.
 *
 * Expanded mode shows nested spans for debug.
 */
export function DemoTraceStrip({ trace }: { trace: TracePayload | undefined }) {
  const [open, setOpen] = useState(false)
  if (!trace || trace.spans.length === 0) {
    return (
      <div className="mt-4 text-xs text-[var(--text-faint)] font-mono">
        no trace captured
      </div>
    )
  }

  const baseStart = Math.min(...trace.spans.map((s) => s.startedAt))
  // Top-level spans are the visible stage bars. Children of search.* live
  // one level deeper and we expose them only when the speaker drills in.
  const topLevel = trace.spans.filter((s) => !s.parentId)

  // If everything is parented (no roots), fall back to depth-1 spans.
  const visible = topLevel.length > 0 ? topLevel : trace.spans.slice(0, 6)

  return (
    <div className="mt-4 border border-[var(--border)] rounded-lg p-3 md:p-4 bg-[var(--bg)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        <div className="flex items-baseline gap-3">
          <span className="uppercase tracking-[0.2em] text-[var(--text-faint)]">
            trace
          </span>
          <span className="font-mono">{trace.totalMs}ms</span>
          <span className="font-mono text-[var(--text-faint)]">
            · {trace.spans.length} spans
          </span>
        </div>
        <ChevronDown
          className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <ul className="mt-3 space-y-2">
        {visible.map((s) => (
          <StageBar
            key={s.id}
            span={s}
            baseStart={baseStart}
            totalMs={trace.totalMs}
          />
        ))}
      </ul>

      {open && trace.spans.length > visible.length && (
        <details className="mt-3" open>
          <summary className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] cursor-pointer">
            all spans
          </summary>
          <ul className="mt-2 space-y-1 max-h-64 overflow-auto">
            {trace.spans
              .filter((s) => !visible.includes(s))
              .map((s) => (
                <StageBar
                  key={s.id}
                  span={s}
                  baseStart={baseStart}
                  totalMs={trace.totalMs}
                  compact
                />
              ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function StageBar({
  span,
  baseStart,
  totalMs,
  compact,
}: {
  span: TraceSpan
  baseStart: number
  totalMs: number
  compact?: boolean
}) {
  const offset = span.startedAt - baseStart
  const width = span.durationMs ?? 0
  const pctLeft = totalMs > 0 ? (offset / totalMs) * 100 : 0
  const pctW = totalMs > 0 ? Math.max((width / totalMs) * 100, 0.5) : 0

  return (
    <li className={compact ? 'text-[10px]' : 'text-xs'}>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span
          className={`font-mono ${
            span.error ? 'text-[var(--danger)]' : 'text-[var(--text)]'
          } truncate`}
        >
          {span.name}
        </span>
        <span className="text-[var(--text-faint)] tabular-nums">
          {width}ms
        </span>
      </div>
      <div className={`relative ${compact ? 'h-1' : 'h-1.5'}`}>
        <div className="absolute inset-0 bg-[var(--bg-overlay)] rounded" />
        <div
          className={`absolute top-0 bottom-0 rounded ${
            span.error ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]'
          }`}
          style={{ left: `${pctLeft}%`, width: `${pctW}%` }}
        />
      </div>
    </li>
  )
}
