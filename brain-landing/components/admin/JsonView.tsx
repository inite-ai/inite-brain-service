'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

/**
 * Collapsible JSON viewer. Foldable per-key, depth-controlled initial
 * open state, monospace, no external deps. Replaces the
 * `<pre>{JSON.stringify(...)}</pre>` antipattern across the admin.
 */
export function JsonView({
  value,
  depth = 0,
  initiallyOpen = 1,
}: {
  value: unknown
  depth?: number
  initiallyOpen?: number
}) {
  return (
    <div className="font-mono text-[10px] leading-snug">
      <Node value={value} depth={depth} initiallyOpen={initiallyOpen} />
    </div>
  )
}

function Node({
  value,
  depth,
  initiallyOpen,
}: {
  value: unknown
  depth: number
  initiallyOpen: number
}) {
  if (value === null) return <Atom>null</Atom>
  if (value === undefined) return <Atom dim>undefined</Atom>
  if (typeof value === 'string')
    return (
      <span className="text-[var(--success)] break-words">
        &quot;{value}&quot;
      </span>
    )
  if (typeof value === 'number')
    return <span className="text-[var(--accent)]">{String(value)}</span>
  if (typeof value === 'boolean')
    return <span className="text-[var(--warning)]">{String(value)}</span>
  if (Array.isArray(value))
    return <Collection items={value} depth={depth} kind="array" initiallyOpen={initiallyOpen} />
  if (typeof value === 'object')
    return (
      <Collection
        items={Object.entries(value as Record<string, unknown>)}
        depth={depth}
        kind="object"
        initiallyOpen={initiallyOpen}
      />
    )
  return <Atom>{String(value)}</Atom>
}

function Collection({
  items,
  depth,
  kind,
  initiallyOpen,
}: {
  items: unknown[] | [string, unknown][]
  depth: number
  kind: 'array' | 'object'
  initiallyOpen: number
}) {
  const [open, setOpen] = useState(depth < initiallyOpen)
  const empty = items.length === 0
  const open_b = kind === 'array' ? '[' : '{'
  const close_b = kind === 'array' ? ']' : '}'
  if (empty) {
    return (
      <span className="text-[var(--text-faint)]">
        {open_b}
        {close_b}
      </span>
    )
  }
  return (
    <span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center text-[var(--text-faint)] hover:text-[var(--text)]"
      >
        {open ? (
          <ChevronDown className="w-2.5 h-2.5" />
        ) : (
          <ChevronRight className="w-2.5 h-2.5" />
        )}
        <span>{open_b}</span>
        {!open && (
          <span className="ml-1 text-[var(--text-faint)]">
            {items.length} {kind === 'array' ? 'items' : 'keys'}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-3 border-l border-[var(--border)] pl-2 my-0.5">
          {kind === 'array'
            ? (items as unknown[]).map((v, i) => (
                <div key={i}>
                  <span className="text-[var(--text-faint)]">{i}:</span>{' '}
                  <Node
                    value={v}
                    depth={depth + 1}
                    initiallyOpen={initiallyOpen}
                  />
                </div>
              ))
            : (items as [string, unknown][]).map(([k, v]) => (
                <div key={k}>
                  <span className="text-[var(--text-muted)]">{k}:</span>{' '}
                  <Node
                    value={v}
                    depth={depth + 1}
                    initiallyOpen={initiallyOpen}
                  />
                </div>
              ))}
        </div>
      )}
      <span className="text-[var(--text-faint)]">{close_b}</span>
    </span>
  )
}

function Atom({
  children,
  dim,
}: {
  children: React.ReactNode
  dim?: boolean
}) {
  return (
    <span className={dim ? 'text-[var(--text-faint)]' : 'text-[var(--text-muted)]'}>
      {children}
    </span>
  )
}
