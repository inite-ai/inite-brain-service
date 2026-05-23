import dagre from '@dagrejs/dagre'
import { Position, type Node, type Edge } from 'reactflow'

/**
 * Pure dagre-based auto-layout. Receives react-flow node/edge arrays,
 * mutates positions and returns the same array shape. Keep this
 * file dep-free of React; the GraphExplorer calls it after every
 * neighbour expansion.
 *
 * `direction='LR'` (left-to-right) reads like a timeline / lineage.
 * `'TB'` (top-bottom) is denser; the toolbar exposes both.
 *
 * The third mode — `'force'` — is NOT computed here. Force-directed
 * physics lives in `hooks/useForceLayout.ts` because it ticks over
 * time and must integrate with reactflow's setNodes.
 */
export type LayoutMode = 'force' | 'LR' | 'TB'
export type LayoutDirection = 'LR' | 'TB'

const NODE_WIDTH = 220
const NODE_HEIGHT = 80

export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: LayoutDirection = 'LR',
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 90 })

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  const laidOut: Node[] = nodes.map((node) => {
    const pos = g.node(node.id)
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      targetPosition: direction === 'LR' ? Position.Left : Position.Top,
      sourcePosition: direction === 'LR' ? Position.Right : Position.Bottom,
    }
  })

  return { nodes: laidOut, edges }
}
