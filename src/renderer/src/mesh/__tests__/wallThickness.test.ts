import { describe, it, expect } from 'vitest'
import type { TriangleMesh } from '../types'
import { computeWallThicknessColors } from '../wallThickness'

/**
 * Two parallel square plates facing each other `gap` mm apart:
 * bottom plate at y=0 with downward normals, top plate at y=gap with upward
 * normals.  Triangles share the same XZ layout so opposing centroids align
 * exactly and the measured thickness equals `gap`.
 */
function makeSlabShell(gap: number, size = 20): TriangleMesh {
  const s = size
  const positions = new Float32Array([
    // bottom plate (y=0)
    0, 0, 0,   s, 0, 0,   s, 0, s,   0, 0, s,
    // top plate (y=gap)
    0, gap, 0, s, gap, 0, s, gap, s, 0, gap, s,
  ])
  const indices = new Uint32Array([
    // bottom, wound to face DOWN (-y)
    0, 1, 2,  0, 2, 3,
    // top, wound to face UP (+y)
    4, 6, 5,  4, 7, 6,
  ])
  return { positions, indices }
}

describe('computeWallThicknessColors', () => {
  it('classifies a 1 mm wall as borderline', () => {
    const { summary } = computeWallThicknessColors(makeSlabShell(1.0))
    expect(summary.borderline).toBe(4)
    expect(summary.tooThin).toBe(0)
    expect(summary.ok).toBe(0)
  })

  it('classifies a 0.4 mm wall as too thin', () => {
    const { summary } = computeWallThicknessColors(makeSlabShell(0.4))
    expect(summary.tooThin).toBe(4)
  })

  it('classifies a 5 mm wall as ok', () => {
    const { summary } = computeWallThicknessColors(makeSlabShell(5))
    expect(summary.ok).toBe(4)
  })

  it('returns one RGB triple per triangle', () => {
    const mesh = makeSlabShell(1.0)
    const { perTriColor } = computeWallThicknessColors(mesh)
    expect(perTriColor.length).toBe((mesh.indices.length / 3) * 3)
  })

  it('handles an empty mesh', () => {
    const empty: TriangleMesh = { positions: new Float32Array(0), indices: new Uint32Array(0) }
    const { perTriColor, summary } = computeWallThicknessColors(empty)
    expect(perTriColor.length).toBe(0)
    expect(summary).toEqual({ tooThin: 0, borderline: 0, ok: 0 })
  })
})
