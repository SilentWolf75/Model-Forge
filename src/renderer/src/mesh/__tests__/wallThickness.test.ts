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

  it('measures perpendicular thickness even when opposing centroids are offset (ray cast)', () => {
    // Bottom plate: one big quad. Top plate 1 mm above: finely subdivided so its
    // centroids do NOT align with the bottom plate's. A centroid-distance
    // heuristic would overestimate; an inward ray still measures exactly 1 mm.
    const s = 20, gap = 1.0, n = 5
    const pos: number[] = []
    const idx: number[] = []
    // bottom (2 tris, faces down)
    pos.push(0,0,0,  s,0,0,  s,0,s,  0,0,s)
    idx.push(0,1,2,  0,2,3)
    // top: n×n grid of quads, faces up
    const base = 4
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++)
        pos.push((i*s)/n, gap, (j*s)/n)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const a = base + i*(n+1)+j, b = base + (i+1)*(n+1)+j
        const c = base + (i+1)*(n+1)+j+1, d = base + i*(n+1)+j+1
        idx.push(a,c,b,  a,d,c)
      }
    const mesh: TriangleMesh = { positions: new Float32Array(pos), indices: new Uint32Array(idx) }
    const { summary } = computeWallThicknessColors(mesh)
    // Every face should measure ~1 mm → borderline; none misclassified as ok
    expect(summary.ok).toBe(0)
    expect(summary.tooThin).toBe(0)
    expect(summary.borderline).toBe(mesh.indices.length / 3)
  })

  it('stays fast on a large mesh (200k triangles)', () => {
    // Tube of quads — closed-ish shell with 1.2 mm wall
    const segs = 100_000
    const pos = new Float32Array(segs * 2 * 3 * 2)
    const idx = new Uint32Array(segs * 6)
    // Build two long parallel ribbons 1.2 mm apart (degenerate "wall")
    let vi = 0
    for (let i = 0; i < segs * 2; i++) {
      const x = (i % segs) * 0.1, y = i < segs ? 0 : 1.2
      pos[vi++] = x; pos[vi++] = y; pos[vi++] = 0
      pos[vi++] = x; pos[vi++] = y; pos[vi++] = 1
    }
    let ti = 0
    for (let i = 0; i < segs - 1; i++) {
      const a = i*2, b = i*2+2, c = i*2+3, d = i*2+1
      idx[ti++] = a; idx[ti++] = b; idx[ti++] = c
      idx[ti++] = a; idx[ti++] = c; idx[ti++] = d
    }
    const mesh: TriangleMesh = { positions: pos, indices: idx }
    const t0 = performance.now()
    computeWallThicknessColors(mesh)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(3000)
  })
})
