import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'

interface Body extends SimulationNodeDatum {
  id: string
}

export interface Placed {
  id: string
  x: number
  y: number
}

/**
 * A still layout for the demo graph: a few dozen nodes, so the simulation
 * runs to rest once, in memory, and the page draws the result. Seeded on a
 * circle in node order, so the same graph lands the same way every time.
 * Positions are fitted into a `width` × `height` box with `pad` margins.
 */
export function layoutDemoGraph(
  nodes: readonly { id: string }[],
  edges: readonly { from: string; to: string }[],
  box: { width: number; height: number; pad: number },
): Placed[] {
  if (nodes.length === 0) return []
  const bodies: Body[] = nodes.map((n, i) => {
    const a = (2 * Math.PI * i) / nodes.length
    return { id: n.id, x: Math.cos(a) * 200, y: Math.sin(a) * 200 }
  })
  const ids = new Set(bodies.map((b) => b.id))
  const links: SimulationLinkDatum<Body>[] = edges
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .map((e) => ({ source: e.from, target: e.to }))
  const sim = forceSimulation(bodies)
    .force('link', forceLink<Body, SimulationLinkDatum<Body>>(links).id((b) => b.id).distance(90))
    .force('charge', forceManyBody().strength(-260))
    .force('collide', forceCollide(34))
    .force('center', forceCenter(0, 0))
    .stop()
  for (let i = 0; i < 300; i++) sim.tick()

  const xs = bodies.map((b) => b.x ?? 0)
  const ys = bodies.map((b) => b.y ?? 0)
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const sx = (box.width - 2 * box.pad) / Math.max(1, maxX - minX)
  const sy = (box.height - 2 * box.pad) / Math.max(1, maxY - minY)
  const s = Math.min(sx, sy)
  const offX = (box.width - s * (maxX - minX)) / 2
  const offY = (box.height - s * (maxY - minY)) / 2
  return bodies.map((b) => ({
    id: b.id,
    x: offX + s * ((b.x ?? 0) - minX),
    y: offY + s * ((b.y ?? 0) - minY),
  }))
}
