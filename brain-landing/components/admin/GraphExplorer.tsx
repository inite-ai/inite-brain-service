'use client'

import { useCallback, useMemo, useState } from 'react'
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { EntityNode, type EntityNodeData } from './EntityNode'
import { KindEdge, type KindEdgeData } from './KindEdge'
import { EntitySearch, type SearchHit } from './EntitySearch'
import { EntityPanel } from './EntityPanel'
import { PredicateFilter } from './PredicateFilter'
import { AsOfSlider } from './AsOfSlider'
import { applyDagreLayout, type LayoutDirection } from '../../lib/graph-layout'

const NODE_TYPES = { entity: EntityNode }
const EDGE_TYPES = { kind: KindEdge }

interface ConnectionsResponse {
  entityId: string
  edges: Array<{
    edgeId: string
    from: string
    to: string
    kind: string
    weight?: number
    direction: 'inbound' | 'outbound'
    neighbour?: {
      id: string
      type: string
      canonicalName?: string
    }
  }>
}

/**
 * Interactive entity-graph explorer. Seeds from EntitySearch hit,
 * grows by recursive /v1/entities/:id/connections calls. Layout via
 * dagre after every change so the graph never looks like spaghetti.
 */
export function GraphExplorer() {
  const [nodes, setNodes] = useState<Node<EntityNodeData>[]>([])
  const [edges, setEdges] = useState<Edge<KindEdgeData>[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [layout, setLayout] = useState<LayoutDirection>('LR')
  const [predicateFilter, setPredicateFilter] = useState<Set<string>>(new Set())
  const [asOf, setAsOf] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanding, setExpanding] = useState(false)

  const kinds = useMemo(() => {
    const set = new Set<string>()
    for (const e of edges) {
      const k = e.data?.kind
      if (k) set.add(k)
    }
    return [...set].sort()
  }, [edges])

  const visibleEdges = useMemo(() => {
    if (predicateFilter.size === 0) return edges
    return edges.filter((e) => predicateFilter.has(e.data?.kind ?? ''))
  }, [edges, predicateFilter])

  const relayout = useCallback(
    (
      nextNodes: Node<EntityNodeData>[],
      nextEdges: Edge<KindEdgeData>[],
      direction = layout,
    ) => {
      const { nodes: laidOut } = applyDagreLayout(
        nextNodes as Node[],
        nextEdges as Edge[],
        direction,
      )
      setNodes(laidOut as Node<EntityNodeData>[])
      setEdges(nextEdges)
    },
    [layout],
  )

  const addSeed = useCallback(
    (hit: SearchHit) => {
      if (nodes.some((n) => n.id === hit.entityId)) {
        setSelectedId(hit.entityId)
        return
      }
      const seedNode: Node<EntityNodeData> = {
        id: hit.entityId,
        type: 'entity',
        position: { x: 0, y: 0 },
        data: {
          brainId: hit.entityId,
          name: hit.name,
          type: hit.type,
          seed: true,
        },
      }
      const next = [...nodes, seedNode]
      relayout(next, edges)
      setSelectedId(hit.entityId)
    },
    [nodes, edges, relayout],
  )

  const expand = useCallback(
    async (entityId: string) => {
      setExpanding(true)
      setError(null)
      try {
        const qs = asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''
        const res = await fetch(
          `/api/admin/proxy/v1/entities/${encodeURIComponent(entityId)}/connections${qs}`,
        )
        const data = (await res.json()) as ConnectionsResponse | { error?: string }
        if (!res.ok) {
          setError((data as { error?: string })?.error ?? `Expand failed (${res.status})`)
          return
        }
        const conn = data as ConnectionsResponse
        const nextNodesMap = new Map(nodes.map((n) => [n.id, n]))
        const nextEdgeIds = new Set(edges.map((e) => e.id))
        const nextNodes = [...nodes]
        const nextEdges = [...edges]
        for (const e of conn.edges ?? []) {
          if (e.neighbour && !nextNodesMap.has(e.neighbour.id)) {
            nextNodes.push({
              id: e.neighbour.id,
              type: 'entity',
              position: { x: 0, y: 0 },
              data: {
                brainId: e.neighbour.id,
                name: e.neighbour.canonicalName ?? e.neighbour.id,
                type: e.neighbour.type,
              },
            })
            nextNodesMap.set(e.neighbour.id, nextNodes[nextNodes.length - 1])
          }
          if (!nextEdgeIds.has(e.edgeId)) {
            nextEdges.push({
              id: e.edgeId,
              type: 'kind',
              source: e.from,
              target: e.to,
              data: { kind: e.kind, weight: e.weight },
            })
            nextEdgeIds.add(e.edgeId)
          }
        }
        relayout(nextNodes, nextEdges)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setExpanding(false)
      }
    },
    [nodes, edges, relayout, asOf],
  )

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    setSelectedId(node.id)
  }, [])

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_, node) => {
      void expand(node.id)
    },
    [expand],
  )

  const togglePredicate = useCallback((kind: string) => {
    setPredicateFilter((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }, [])

  const reset = useCallback(() => {
    setNodes([])
    setEdges([])
    setSelectedId(null)
    setError(null)
    setPredicateFilter(new Set())
  }, [])

  return (
    <div className="relative h-full w-full border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] overflow-hidden">
      {/* Top toolbar */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center gap-3 p-2 border-b border-[var(--border)] bg-[var(--bg-elevated)]/95 backdrop-blur">
        <div className="w-64 max-w-[40vw] shrink-0">
          <EntitySearch onSelect={addSeed} />
        </div>
        <AsOfSlider asOf={asOf} onChange={setAsOf} />
        <div className="flex-1 min-w-0 overflow-x-auto">
          <PredicateFilter
            kinds={kinds}
            selected={predicateFilter}
            onToggle={togglePredicate}
            onClear={() => setPredicateFilter(new Set())}
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => {
              const next: LayoutDirection = layout === 'LR' ? 'TB' : 'LR'
              setLayout(next)
              relayout(nodes, edges, next)
            }}
            className="px-2 h-8 rounded border border-[var(--border)] text-[11px] font-mono text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-overlay)]"
            title="Switch layout"
          >
            layout: {layout}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={nodes.length === 0}
            className="px-2 h-8 rounded border border-[var(--border)] text-[11px] font-mono text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-overlay)] disabled:opacity-40"
          >
            reset
          </button>
        </div>
      </div>

      {/* Error toast */}
      {error && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-30 px-3 py-1.5 rounded bg-[var(--danger)] text-white text-xs font-mono">
          {error}
        </div>
      )}

      {/* Empty state */}
      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center text-[var(--text-muted)] max-w-md px-4">
            <div className="text-sm">Start with a search above.</div>
            <div className="mt-1 text-xs text-[var(--text-faint)]">
              Click a hit to seed the graph. Then click a node for its profile,
              double-click to expand neighbours.
            </div>
          </div>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={visibleEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--border)"
        />
        <Controls className="!bg-[var(--bg)] !border !border-[var(--border)]" />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(8,9,10,0.6)"
          nodeColor={() => 'var(--accent)'}
          className="!bg-[var(--bg-elevated)] !border !border-[var(--border)]"
        />
      </ReactFlow>

      {expanding && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded bg-[var(--bg-overlay)] text-[11px] text-[var(--text-muted)] font-mono">
          expanding…
        </div>
      )}

      <EntityPanel
        entityId={selectedId}
        asOf={asOf}
        onClose={() => setSelectedId(null)}
        onExpand={(id) => void expand(id)}
      />
    </div>
  )
}
