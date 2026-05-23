'use client'

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from 'reactflow'

export interface KindEdgeData {
  kind: string
  weight?: number
  invalidated?: boolean
}

export function KindEdge(props: EdgeProps<KindEdgeData>) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    markerEnd,
  } = props

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })

  const strokeWidth = Math.max(
    1,
    Math.min(4, 1 + (data?.weight ?? 1) * 0.8),
  )
  const stroke = data?.invalidated
    ? 'var(--text-faint)'
    : 'var(--border-strong)'

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth,
          strokeDasharray: data?.invalidated ? '4 4' : undefined,
        }}
      />
      {data?.kind && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="px-1.5 py-0.5 rounded bg-[var(--bg)] border border-[var(--border)] text-[10px] font-mono text-[var(--text-muted)] uppercase tracking-wider"
          >
            {data.kind}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
