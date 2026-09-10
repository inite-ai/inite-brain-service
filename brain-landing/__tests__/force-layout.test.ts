import { describe, expect, it } from 'vitest'
import {
  graphStructureKey,
  reconcileSimNodes,
  type SimNode,
} from '../lib/force-layout'

const node = (id: string, x = 0, y = 0) => ({ id, position: { x, y } })

describe('graphStructureKey', () => {
  it('is stable across position-only updates (one simulation tick)', () => {
    const before = graphStructureKey(
      [node('a', 0, 0), node('b', 10, 10)],
      [{ source: 'a', target: 'b' }],
    )
    const after = graphStructureKey(
      [node('a', 3.2, -1.7), node('b', 12.4, 9.1)],
      [{ source: 'a', target: 'b' }],
    )
    expect(after).toBe(before)
  })

  it('changes when a node is added or removed', () => {
    const base = graphStructureKey([node('a'), node('b')], [])
    expect(graphStructureKey([node('a'), node('b'), node('c')], [])).not.toBe(
      base,
    )
    expect(graphStructureKey([node('a')], [])).not.toBe(base)
  })

  it('changes when the visible edge set changes', () => {
    const nodes = [node('a'), node('b')]
    const linked = graphStructureKey(nodes, [{ source: 'a', target: 'b' }])
    const filtered = graphStructureKey(nodes, [])
    expect(filtered).not.toBe(linked)
  })
})

describe('reconcileSimNodes', () => {
  it('keeps the body (position and velocity) of nodes that already exist', () => {
    const pool = new Map<string, SimNode>()
    const [a] = reconcileSimNodes(pool, [node('a', 0, 0)])
    a!.x = 42
    a!.y = -7
    a!.vx = 1.5
    a!.vy = -0.5

    const next = reconcileSimNodes(pool, [node('a', 999, 999)])
    expect(next[0]).toBe(a)
    expect(next[0]).toMatchObject({ x: 42, y: -7, vx: 1.5, vy: -0.5 })
  })

  it('seeds new ids from their rendered position and returns bodies in node order', () => {
    const pool = new Map<string, SimNode>()
    reconcileSimNodes(pool, [node('a', 1, 2)])
    const next = reconcileSimNodes(pool, [node('b', 5, 6), node('a', 1, 2)])
    expect(next.map((n) => n.id)).toEqual(['b', 'a'])
    expect(next[0]).toMatchObject({ id: 'b', x: 5, y: 6 })
    expect(pool.get('b')).toBe(next[0])
  })

  it('leaves x/y undefined for nodes without a position so d3 can place them', () => {
    const pool = new Map<string, SimNode>()
    const [c] = reconcileSimNodes(pool, [{ id: 'c' }])
    expect(c!.x).toBeUndefined()
    expect(c!.y).toBeUndefined()
  })

  it('evicts bodies whose node was removed', () => {
    const pool = new Map<string, SimNode>()
    reconcileSimNodes(pool, [node('a'), node('b'), node('c')])
    const next = reconcileSimNodes(pool, [node('b')])
    expect(next.map((n) => n.id)).toEqual(['b'])
    expect([...pool.keys()]).toEqual(['b'])
  })
})
