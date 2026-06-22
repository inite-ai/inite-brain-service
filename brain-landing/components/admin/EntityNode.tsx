'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { Handle, Position, type NodeProps } from 'reactflow'

export interface EntityNodeData {
  name: string
  type: string
  externalRefsCount?: number
  retracted?: boolean
  seed?: boolean
  /** Returned by /v1/entities/:id/connections — useful for tooltip. */
  brainId: string
}

const TYPE_COLOR: Record<string, string> = {
  customer: '#34d399',  // green
  staff: '#60a5fa',     // blue
  asset: '#fbbf24',     // amber
  project: '#a78bfa',   // violet (=accent)
  topic: '#f472b6',     // pink
  location: '#22d3ee',  // cyan
  other: '#9ca3af',     // grey
}

export function EntityNode({ data, selected }: NodeProps<EntityNodeData>) {
  const color = TYPE_COLOR[data.type] ?? TYPE_COLOR.other
  return (
    <div
      className={`rounded-md border bg-[var(--bg-elevated)] shadow-sm transition-colors ${
        selected
          ? 'border-[var(--accent)] ring-2 ring-[var(--accent-ring)]'
          : 'border-[var(--border)] hover:border-[var(--border-strong)]'
      }`}
      style={{ width: 220 }}
    >
      <div className="h-1 rounded-t-md" style={{ background: color }} />
      <div className="px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div
            className="text-[11px] uppercase tracking-wider text-[var(--text-faint)] font-mono"
            title={data.brainId}
          >
            {data.type}
          </div>
          {data.seed && (
            <span className="text-[9px] uppercase tracking-wider text-[var(--accent)]">
              seed
            </span>
          )}
        </div>
        <div
          className={`mt-0.5 text-sm font-medium leading-tight ${
            data.retracted
              ? 'text-[var(--text-faint)] line-through'
              : 'text-[var(--text)]'
          }`}
        >
          {data.name}
        </div>
        {data.externalRefsCount ? (
          <div className="mt-1 text-[10px] text-[var(--text-faint)]">
            {data.externalRefsCount} external ref
            {data.externalRefsCount > 1 ? 's' : ''}
          </div>
        ) : null}
      </div>
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-[var(--border-strong)] !border-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-[var(--border-strong)] !border-0"
      />
    </div>
  )
}
