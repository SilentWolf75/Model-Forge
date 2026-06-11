import { describe, it, expect } from 'vitest'
import type { TriangleMesh } from '../types'
import { applyMeshTransformOp, invertOp, type MeshOp } from '../history'

function makeBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): TriangleMesh {
  const positions = new Float32Array([
    x0, y0, z0,  x1, y0, z0,  x1, y1, z0,  x0, y1, z0,
    x0, y0, z1,  x1, y0, z1,  x1, y1, z1,  x0, y1, z1,
  ])
  const indices = new Uint32Array([
    0, 2, 1,  0, 3, 2,   4, 5, 6,  4, 6, 7,
    0, 1, 5,  0, 5, 4,   3, 7, 6,  3, 6, 2,
    0, 4, 7,  0, 7, 3,   1, 2, 6,  1, 6, 5,
  ])
  return { positions, indices }
}

function expectMeshesClose(a: TriangleMesh, b: TriangleMesh, digits = 3): void {
  expect(a.positions.length).toBe(b.positions.length)
  for (let i = 0; i < a.positions.length; i++) {
    expect(a.positions[i]).toBeCloseTo(b.positions[i]!, digits)
  }
}

const OPS: MeshOp[] = [
  { kind: 'rotateX', quarterTurns: 1 },
  { kind: 'rotateX', quarterTurns: 2 },
  { kind: 'rotateX', quarterTurns: 3 },
  { kind: 'rotateY', quarterTurns: 1 },
  { kind: 'rotateZ', quarterTurns: 3 },
  { kind: 'mirror', axis: 'x' },
  { kind: 'mirror', axis: 'y' },
  { kind: 'mirror', axis: 'z' },
  { kind: 'translate', dx: 5, dy: -3, dz: 12.5 },
  { kind: 'scale', factor: 2.5 },
  {
    kind: 'composite',
    ops: [
      { kind: 'rotateX', quarterTurns: 1 },
      { kind: 'translate', dx: 0, dy: -4, dz: 0 },
    ],
  },
]

describe('invertOp round-trips', () => {
  for (const op of OPS) {
    it(`apply(invert(op)) restores original — ${JSON.stringify(op).slice(0, 60)}`, () => {
      const box = makeBox(1, 2, 3, 5, 8, 13)
      const forward = applyMeshTransformOp(box, op)
      const back = applyMeshTransformOp(forward, invertOp(op))
      expectMeshesClose(back, box)
    })
  }
})

describe('composite ops', () => {
  it('applies in sequence', () => {
    const box = makeBox(0, 0, 0, 2, 2, 2)
    const op: MeshOp = {
      kind: 'composite',
      ops: [
        { kind: 'translate', dx: 10, dy: 0, dz: 0 },
        { kind: 'scale', factor: 2 },
      ],
    }
    const out = applyMeshTransformOp(box, op)
    // translate first (x: 10..12), then scale (x: 20..24)
    let minX = Infinity, maxX = -Infinity
    for (let i = 0; i < out.positions.length; i += 3) {
      minX = Math.min(minX, out.positions[i]!)
      maxX = Math.max(maxX, out.positions[i]!)
    }
    expect(minX).toBeCloseTo(20, 3)
    expect(maxX).toBeCloseTo(24, 3)
  })
})
