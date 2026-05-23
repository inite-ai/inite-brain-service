'use client'

import { useEffect, useMemo, useRef } from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import { useReactFlow, type Edge, type Node } from 'reactflow'

interface SimNode extends SimulationNodeDatum {
  id: string
}
type SimEdge = SimulationLinkDatum<SimNode>

interface Options {
  /** When false, the simulation stops and positions are frozen. */
  enabled: boolean
  /** Link distance — bigger value spreads the graph wider. */
  linkDistance?: number
  /** ManyBody strength — more negative = stronger repulsion. */
  charge?: number
  /** Node radius for collision. Should be close to the visual node size. */
  collide?: number
}

/**
 * Obsidian-style force-directed layout layered on top of reactflow.
 *
 * - d3-force owns the physics: link tension, repulsion, collision, centring.
 * - reactflow owns rendering + user drag. When the user drags a node we
 *   pin it via `fx`/`fy` so the simulation respects the manual override;
 *   on drag-stop we release it back to the physics.
 * - The simulation auto-restarts whenever the node/edge set changes
 *   so freshly-expanded neighbours settle in alongside the existing
 *   network instead of teleporting.
 *
 * Returns drag callbacks the caller should wire to ReactFlow's
 * `onNodeDragStart` / `onNodeDrag` / `onNodeDragStop`.
 */
export function useForceLayout(
  nodes: Node[],
  edges: Edge[],
  opts: Options,
) {
  const { setNodes } = useReactFlow()
  const simRef = useRef<Simulation<SimNode, SimEdge> | null>(null)
  // Stable per-id ref so simulation node objects survive across renders.
  const simNodesRef = useRef<Map<string, SimNode>>(new Map())

  const { linkDistance = 180, charge = -500, collide = 70 } = opts

  // Sync sim node set with the React node set. Preserve x/y/vx/vy for
  // existing ids so neighbours that already settled don't jump.
  const simNodes = useMemo<SimNode[]>(() => {
    const next: SimNode[] = []
    const seen = new Set<string>()
    for (const n of nodes) {
      const prev = simNodesRef.current.get(n.id)
      const sn: SimNode = prev ?? {
        id: n.id,
        x: n.position?.x,
        y: n.position?.y,
      }
      next.push(sn)
      seen.add(n.id)
    }
    // Drop sim nodes for removed reactflow nodes
    for (const id of simNodesRef.current.keys()) {
      if (!seen.has(id)) simNodesRef.current.delete(id)
    }
    for (const sn of next) simNodesRef.current.set(sn.id, sn)
    return next
  }, [nodes])

  const simEdges = useMemo<SimEdge[]>(
    () => edges.map((e) => ({ source: e.source, target: e.target })),
    [edges],
  )

  useEffect(() => {
    if (!opts.enabled || simNodes.length === 0) {
      simRef.current?.stop()
      simRef.current = null
      return
    }

    const sim = forceSimulation<SimNode, SimEdge>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimEdge>(simEdges)
          .id((d) => d.id)
          .distance(linkDistance)
          .strength(0.3),
      )
      .force('charge', forceManyBody<SimNode>().strength(charge))
      .force('collide', forceCollide<SimNode>(collide))
      .force('center', forceCenter(0, 0))
      .alpha(0.8)
      .alphaDecay(0.025)

    sim.on('tick', () => {
      setNodes((prev) =>
        prev.map((node) => {
          const sn = simNodesRef.current.get(node.id)
          if (!sn || sn.x === undefined || sn.y === undefined) return node
          // Pinned drag: caller set fx/fy — skip overwriting x/y from sim.
          return {
            ...node,
            position: { x: sn.x, y: sn.y },
          }
        }),
      )
    })

    simRef.current = sim
    return () => {
      sim.stop()
    }
  }, [
    simNodes,
    simEdges,
    opts.enabled,
    setNodes,
    linkDistance,
    charge,
    collide,
  ])

  return {
    onNodeDragStart: (_: unknown, node: Node) => {
      const sn = simNodesRef.current.get(node.id)
      if (sn) {
        sn.fx = node.position.x
        sn.fy = node.position.y
      }
      simRef.current?.alphaTarget(0.3).restart()
    },
    onNodeDrag: (_: unknown, node: Node) => {
      const sn = simNodesRef.current.get(node.id)
      if (sn) {
        sn.fx = node.position.x
        sn.fy = node.position.y
      }
    },
    onNodeDragStop: (_: unknown, node: Node) => {
      const sn = simNodesRef.current.get(node.id)
      if (sn) {
        sn.fx = null
        sn.fy = null
      }
      simRef.current?.alphaTarget(0)
    },
    reheat: () => {
      simRef.current?.alpha(0.7).restart()
    },
  }
}
