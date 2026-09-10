'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from 'd3-force'
import { useReactFlow, type Edge, type Node } from 'reactflow'
import {
  graphStructureKey,
  reconcileSimNodes,
  type SimLink,
  type SimNode,
} from '../lib/force-layout'

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
 * - The simulation is (re)built only when the node/edge *set* changes, so
 *   freshly-expanded neighbours settle in alongside the existing network
 *   instead of teleporting — and the per-tick position writes that flow
 *   back through `nodes` never restart it, so it cools down and stops.
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
  const { enabled, linkDistance = 180, charge = -500, collide = 70 } = opts
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null)
  // Body per node id; only touched from effects and drag handlers.
  const poolRef = useRef<Map<string, SimNode>>(new Map())
  // Latest props for the structure-keyed effect below, which must not
  // re-run on position-only updates.
  const latestRef = useRef({ nodes, edges })
  useEffect(() => {
    latestRef.current = { nodes, edges }
  })

  const structureKey = useMemo(
    () => graphStructureKey(nodes, edges),
    [nodes, edges],
  )
  const empty = nodes.length === 0

  useEffect(() => {
    if (!enabled || empty) {
      simRef.current?.stop()
      simRef.current = null
      return
    }

    const { nodes: currentNodes, edges: currentEdges } = latestRef.current
    const bodies = reconcileSimNodes(poolRef.current, currentNodes)
    const links: SimLink[] = currentEdges.map((e) => ({
      source: e.source,
      target: e.target,
    }))

    const sim = forceSimulation<SimNode, SimLink>(bodies)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
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
      const pool = poolRef.current
      setNodes((prev) =>
        prev.map((node) => {
          const body = pool.get(node.id)
          if (!body || body.x === undefined || body.y === undefined) return node
          // A pinned (dragged) body has fx/fy, which d3 copies into x/y.
          return { ...node, position: { x: body.x, y: body.y } }
        }),
      )
    })

    simRef.current = sim
    return () => {
      sim.stop()
    }
  }, [structureKey, empty, enabled, setNodes, linkDistance, charge, collide])

  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    const body = poolRef.current.get(node.id)
    if (body) {
      body.fx = node.position.x
      body.fy = node.position.y
    }
    simRef.current?.alphaTarget(0.3).restart()
  }, [])
  const onNodeDrag = useCallback((_: unknown, node: Node) => {
    const body = poolRef.current.get(node.id)
    if (body) {
      body.fx = node.position.x
      body.fy = node.position.y
    }
  }, [])
  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    const body = poolRef.current.get(node.id)
    if (body) {
      body.fx = null
      body.fy = null
    }
    simRef.current?.alphaTarget(0)
  }, [])
  const reheat = useCallback(() => {
    simRef.current?.alpha(0.7).restart()
  }, [])

  return useMemo(
    () => ({ onNodeDragStart, onNodeDrag, onNodeDragStop, reheat }),
    [onNodeDragStart, onNodeDrag, onNodeDragStop, reheat],
  )
}
