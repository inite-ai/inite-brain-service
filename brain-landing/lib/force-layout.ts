import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'

/** One d3-force body. Survives across renders so x/y/vx/vy carry over. */
export interface SimNode extends SimulationNodeDatum {
  id: string
}
export type SimLink = SimulationLinkDatum<SimNode>

export interface PositionedNode {
  id: string
  position?: { x: number; y: number }
}
export interface LinkedEdge {
  source: string
  target: string
}

/**
 * Identity of the graph's *structure* — which nodes and which links exist,
 * in order. Position-only updates (every simulation tick writes new node
 * positions) produce the same key, so a simulation keyed on it is rebuilt
 * only when a node or edge is added or removed.
 */
export function graphStructureKey(
  nodes: readonly { id: string }[],
  edges: readonly LinkedEdge[],
): string {
  return JSON.stringify([
    nodes.map((n) => n.id),
    edges.map((e) => [e.source, e.target]),
  ])
}

/**
 * Bring the simulation body pool in line with the rendered node set.
 * Existing bodies are kept as-is (position and velocity intact, so nodes
 * that already settled do not jump); new ids are seeded from the node's
 * rendered position; bodies whose node is gone are evicted. Returns the
 * bodies in node order, ready for `forceSimulation(...)`.
 */
export function reconcileSimNodes(
  pool: Map<string, SimNode>,
  nodes: readonly PositionedNode[],
): SimNode[] {
  const next: SimNode[] = []
  const seen = new Set<string>()
  for (const n of nodes) {
    let body = pool.get(n.id)
    if (!body) {
      body = { id: n.id, x: n.position?.x, y: n.position?.y }
      pool.set(n.id, body)
    }
    next.push(body)
    seen.add(n.id)
  }
  for (const id of [...pool.keys()]) {
    if (!seen.has(id)) pool.delete(id)
  }
  return next
}
