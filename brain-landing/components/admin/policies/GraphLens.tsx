'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { useMemo } from 'react'
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  type Node,
  type Edge,
} from 'reactflow'
import 'reactflow/dist/style.css'
import type { SimulateSearchResponse } from '../../../lib/contracts/admin-policies'

interface EntityVisibility {
  entityId: string
  name: string
  total: number
  visible: number
}

/**
 * Graph lens — a pure VIEW over the simulate/search payload (no extra
 * endpoint): entities from the result set, tinted by how much of them
 * the subject can see. Fully visible = accent, partially = warning
 * ring with a hidden-count label, fully hidden = dashed faint outline
 * with the name redacted.
 */
export function GraphLens({ result }: { result: SimulateSearchResponse }) {
  const entities = useMemo<EntityVisibility[]>(() => {
    const byId = new Map<string, EntityVisibility>()
    for (const row of result.rows) {
      const e = byId.get(row.entityId) ?? {
        entityId: row.entityId,
        name: row.canonicalName,
        total: 0,
        visible: 0,
      }
      e.total += 1
      if (row.decision === 'allow') e.visible += 1
      byId.set(row.entityId, e)
    }
    return [...byId.values()]
  }, [result.rows])

  const nodes = useMemo<Node[]>(() => {
    const n = entities.length
    const radius = Math.max(160, n * 34)
    return entities.map((e, i) => {
      const angle = (2 * Math.PI * i) / Math.max(n, 1)
      const fullyHidden = e.visible === 0
      const partial = !fullyHidden && e.visible < e.total
      return {
        id: e.entityId,
        position: {
          x: 300 + radius * Math.cos(angle),
          y: 220 + radius * Math.sin(angle) * 0.6,
        },
        data: {
          label: fullyHidden
            ? '▮▮▮▮▮▮'
            : partial
              ? `${e.name} · ${e.total - e.visible} of ${e.total} hidden`
              : e.name,
        },
        style: {
          fontSize: 11,
          fontFamily: 'var(--font-mono, monospace)',
          borderRadius: 8,
          padding: '6px 10px',
          color: fullyHidden ? 'var(--text-faint)' : 'var(--text)',
          background: fullyHidden
            ? 'transparent'
            : partial
              ? 'var(--bg-elevated)'
              : 'color-mix(in srgb, var(--accent) 12%, var(--bg-elevated))',
          border: fullyHidden
            ? '1.5px dashed var(--text-faint)'
            : partial
              ? '1.5px solid var(--warning)'
              : '1.5px solid var(--accent)',
        },
      }
    })
  }, [entities])

  const edges = useMemo<Edge[]>(() => [], [])

  if (entities.length === 0) {
    return (
      <p className="text-xs text-[var(--text-faint)]">
        Run a data-lens query first — the graph lens visualizes that result.
      </p>
    )
  }

  return (
    <div>
      <div className="h-[420px] rounded-lg border border-[var(--border)] bg-[var(--bg)]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} color="var(--border)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-[10px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-[var(--accent)] bg-[var(--accent)]/20" />
          fully visible
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-[var(--warning)]" />
          partially hidden
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-[var(--text-faint)]" />
          fully hidden
        </span>
      </div>
    </div>
  )
}
