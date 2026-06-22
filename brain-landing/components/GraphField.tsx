/**
 * GraphField — the ambient knowledge-graph motif behind the hero.
 *
 * Pure SVG + CSS (no client JS, no randomness) so it server-renders
 * identically and never trips a hydration mismatch. Nodes pulse, a few
 * edges carry a slow "data flow" dash. Cyan = entities/facts, amber =
 * the currently-"live" nodes — mirroring the signal/data palette.
 */

interface Node {
  x: number
  y: number
  /** larger = entity hub, smaller = fact */
  r: number
  /** highlighted (amber) nodes read as "active" */
  live?: boolean
}

// Deterministic layout — hand-placed to look like a real sparse graph.
const NODES: Node[] = [
  { x: 120, y: 96, r: 5, live: true },
  { x: 248, y: 168, r: 3 },
  { x: 196, y: 286, r: 4 },
  { x: 92, y: 244, r: 3 },
  { x: 340, y: 92, r: 3 },
  { x: 392, y: 232, r: 5 },
  { x: 300, y: 348, r: 3, live: true },
  { x: 470, y: 150, r: 3 },
  { x: 560, y: 244, r: 4 },
  { x: 512, y: 360, r: 3 },
  { x: 640, y: 120, r: 3, live: true },
  { x: 700, y: 270, r: 4 },
  { x: 628, y: 392, r: 3 },
  { x: 432, y: 416, r: 3 },
  { x: 168, y: 396, r: 3 },
]

// edge list as [from, to] index pairs; `flow` edges animate a dash.
const EDGES: { a: number; b: number; flow?: boolean }[] = [
  { a: 0, b: 1, flow: true },
  { a: 1, b: 2 },
  { a: 2, b: 3 },
  { a: 3, b: 0 },
  { a: 1, b: 4 },
  { a: 1, b: 5, flow: true },
  { a: 5, b: 6 },
  { a: 2, b: 6 },
  { a: 5, b: 7 },
  { a: 7, b: 8, flow: true },
  { a: 8, b: 9 },
  { a: 8, b: 11 },
  { a: 7, b: 10 },
  { a: 10, b: 11 },
  { a: 11, b: 12, flow: true },
  { a: 9, b: 12 },
  { a: 9, b: 13 },
  { a: 6, b: 13 },
  { a: 6, b: 14 },
  { a: 3, b: 14 },
]

export function GraphField({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 800 480"
      fill="none"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid slice"
    >
      <g stroke="var(--graph)" strokeWidth="1">
        {EDGES.map((e, i) => {
          const a = NODES[e.a]
          const b = NODES[e.b]
          if (e.flow) {
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="var(--data)"
                strokeOpacity="0.35"
                strokeDasharray="3 9"
                style={{
                  animation: `edge-flow ${3 + (i % 4) * 0.6}s linear infinite`,
                }}
              />
            )
          }
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        })}
      </g>
      <g>
        {NODES.map((n, i) => (
          <circle
            key={i}
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill={n.live ? 'var(--signal)' : 'var(--data)'}
            fillOpacity={n.live ? 0.9 : 0.5}
            style={{
              animation: `node-pulse ${4 + (i % 5) * 0.7}s ease-in-out ${
                (i % 6) * 0.4
              }s infinite`,
            }}
          />
        ))}
      </g>
    </svg>
  )
}
