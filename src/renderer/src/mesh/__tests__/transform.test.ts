import { describe, it, expect } from 'vitest'
import type { TriangleMesh } from '../types'
import {
  snapMeshToBed,
  translateMesh,
  scaleMesh,
  computeOverhangScore,
  autoOrientMesh,
  addMeshBeside,
} from '../transform'
import {
  rotateMeshQuarterTurnAroundX,
  rotateMeshQuarterTurnAroundY,
  rotateMeshQuarterTurnAroundZ,
  mirrorMesh,
  centerMeshOnBed,
} from '../rotateAroundY'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Axis-aligned box from (x0,y0,z0) to (x1,y1,z1) with outward CCW winding. */
function makeBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): TriangleMesh {
  const positions = new Float32Array([
    x0, y0, z0,  x1, y0, z0,  x1, y1, z0,  x0, y1, z0, // back  (z0): 0-3
    x0, y0, z1,  x1, y0, z1,  x1, y1, z1,  x0, y1, z1, // front (z1): 4-7
  ])
  const indices = new Uint32Array([
    0, 2, 1,  0, 3, 2, // -z
    4, 5, 6,  4, 6, 7, // +z
    0, 1, 5,  0, 5, 4, // -y (bottom)
    3, 7, 6,  3, 6, 2, // +y (top)
    0, 4, 7,  0, 7, 3, // -x
    1, 2, 6,  1, 6, 5, // +x
  ])
  return { positions, indices }
}

/** Signed volume via divergence theorem — positive for outward-wound closed meshes. */
function signedVolume(mesh: TriangleMesh): number {
  const p = mesh.positions
  const ix = mesh.indices
  let vol = 0
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i]! * 3, b = ix[i + 1]! * 3, c = ix[i + 2]! * 3
    const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!
    const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!
    const cx = p[c]!, cy = p[c + 1]!, cz = p[c + 2]!
    vol += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
  }
  return vol / 6
}

function bounds(mesh: TriangleMesh): { min: number[]; max: number[] } {
  const p = mesh.positions
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[i + k]!)
      max[k] = Math.max(max[k]!, p[i + k]!)
    }
  }
  return { min, max }
}

const EPS = 1e-4

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('makeBox sanity', () => {
  it('has positive signed volume (outward winding)', () => {
    const box = makeBox(0, 0, 0, 2, 3, 4)
    expect(signedVolume(box)).toBeCloseTo(24, 3)
  })
})

describe('snapMeshToBed', () => {
  it('moves the lowest vertex to Y = 0', () => {
    const box = makeBox(0, 5, 0, 2, 8, 2)
    const snapped = snapMeshToBed(box)
    expect(bounds(snapped).min[1]).toBeCloseTo(0, 4)
    expect(bounds(snapped).max[1]).toBeCloseTo(3, 4)
  })

  it('returns the same object when already on the bed', () => {
    const box = makeBox(0, 0, 0, 2, 2, 2)
    expect(snapMeshToBed(box)).toBe(box)
  })

  it('handles negative Y (model below bed)', () => {
    const box = makeBox(0, -10, 0, 2, -4, 2)
    expect(bounds(snapMeshToBed(box)).min[1]).toBeCloseTo(0, 4)
  })
})

describe('translateMesh', () => {
  it('shifts all vertices by the given delta', () => {
    const box = makeBox(0, 0, 0, 1, 1, 1)
    const moved = translateMesh(box, 5, -2, 3)
    const b = bounds(moved)
    expect(b.min).toEqual([5, -2, 3])
    expect(b.max).toEqual([6, -1, 4])
  })

  it('preserves volume', () => {
    const box = makeBox(0, 0, 0, 2, 2, 2)
    expect(signedVolume(translateMesh(box, 10, 20, 30))).toBeCloseTo(8, 3)
  })

  it('is a no-op for zero delta', () => {
    const box = makeBox(0, 0, 0, 1, 1, 1)
    expect(translateMesh(box, 0, 0, 0)).toBe(box)
  })
})

describe('scaleMesh', () => {
  it('scales bounds uniformly', () => {
    const box = makeBox(0, 0, 0, 2, 2, 2)
    const scaled = scaleMesh(box, 2.5)
    expect(bounds(scaled).max).toEqual([5, 5, 5])
    expect(signedVolume(scaled)).toBeCloseTo(8 * 2.5 ** 3, 2)
  })
})

describe('rotations', () => {
  it('rotate X four times returns to start', () => {
    const box = makeBox(1, 2, 3, 4, 6, 8)
    let m = box
    for (let i = 0; i < 4; i++) m = rotateMeshQuarterTurnAroundX(m)
    for (let i = 0; i < m.positions.length; i++) {
      expect(m.positions[i]).toBeCloseTo(box.positions[i]!, 3)
    }
  })

  it('rotate Y four times returns to start', () => {
    const box = makeBox(1, 2, 3, 4, 6, 8)
    let m = box
    for (let i = 0; i < 4; i++) m = rotateMeshQuarterTurnAroundY(m)
    for (let i = 0; i < m.positions.length; i++) {
      expect(m.positions[i]).toBeCloseTo(box.positions[i]!, 3)
    }
  })

  it('rotate Z four times returns to start', () => {
    const box = makeBox(1, 2, 3, 4, 6, 8)
    let m = box
    for (let i = 0; i < 4; i++) m = rotateMeshQuarterTurnAroundZ(m)
    for (let i = 0; i < m.positions.length; i++) {
      expect(m.positions[i]).toBeCloseTo(box.positions[i]!, 3)
    }
  })

  it('rotation preserves signed volume (winding intact)', () => {
    const box = makeBox(0, 0, 0, 2, 3, 4)
    expect(signedVolume(rotateMeshQuarterTurnAroundX(box))).toBeCloseTo(24, 2)
    expect(signedVolume(rotateMeshQuarterTurnAroundY(box))).toBeCloseTo(24, 2)
    expect(signedVolume(rotateMeshQuarterTurnAroundZ(box))).toBeCloseTo(24, 2)
  })

  it('rotation swaps the expected bounding-box extents', () => {
    const box = makeBox(0, 0, 0, 2, 4, 6)         // W=2 H=4 D=6
    const rx = rotateMeshQuarterTurnAroundX(box)  // X rotation swaps H and D
    const b = bounds(rx)
    expect(b.max[0]! - b.min[0]!).toBeCloseTo(2, 3)
    expect(b.max[1]! - b.min[1]!).toBeCloseTo(6, 3)
    expect(b.max[2]! - b.min[2]!).toBeCloseTo(4, 3)
  })
})

describe('mirrorMesh', () => {
  it('keeps signed volume positive (winding reversed with reflection)', () => {
    const box = makeBox(0, 0, 0, 2, 3, 4)
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(signedVolume(mirrorMesh(box, axis))).toBeCloseTo(24, 2)
    }
  })

  it('mirror is its own inverse', () => {
    const box = makeBox(1, 2, 3, 4, 6, 8)
    const twice = mirrorMesh(mirrorMesh(box, 'x'), 'x')
    for (let i = 0; i < twice.positions.length; i++) {
      expect(twice.positions[i]).toBeCloseTo(box.positions[i]!, 3)
    }
  })

  it('reflects an asymmetric point through the bbox centre', () => {
    // Box from x=0..4: vertex at x=0 maps to x=4 and vice versa
    const box = makeBox(0, 0, 0, 4, 1, 1)
    const m = mirrorMesh(box, 'x')
    const b = bounds(m)
    expect(b.min[0]).toBeCloseTo(0, 4)
    expect(b.max[0]).toBeCloseTo(4, 4)
  })
})

describe('centerMeshOnBed', () => {
  it('moves the XZ centre to the origin and leaves Y alone', () => {
    const box = makeBox(10, 5, 20, 14, 8, 26)
    const c = centerMeshOnBed(box)
    const b = bounds(c)
    expect((b.min[0]! + b.max[0]!) / 2).toBeCloseTo(0, 3)
    expect((b.min[2]! + b.max[2]!) / 2).toBeCloseTo(0, 3)
    expect(b.min[1]).toBeCloseTo(5, 3)
    expect(b.max[1]).toBeCloseTo(8, 3)
  })

  it('returns the same object when already centred', () => {
    const box = makeBox(-1, 0, -1, 1, 2, 1)
    expect(centerMeshOnBed(box)).toBe(box)
  })
})

describe('computeOverhangScore', () => {
  it('rewards bed contact and penalises elevated downward faces', () => {
    // Down-facing tri at y=0 (bed contact), down-facing tri at y=50 (overhang),
    // up-facing tri at y=100 (sets height, ignored by scoring).
    const positions = new Float32Array([
      0, 0, 0,    1, 0, 0,    1, 0, 1,    // tri 0 (down, on bed)
      0, 50, 0,   1, 50, 0,   1, 50, 1,   // tri 1 (down, overhang)
      0, 100, 0,  1, 100, 1,  1, 100, 0,  // tri 2 (up, ignored)
    ])
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const score = computeOverhangScore({ positions, indices })
    expect(score).toBeCloseTo(1 - 0.5, 4)
  })

  it('scores a flat box at zero overhangs minus base bonus', () => {
    const box = makeBox(0, 0, 0, 10, 10, 10)
    // 2 bottom triangles are bed contact, no overhangs → score = -1
    expect(computeOverhangScore(box)).toBeCloseTo(-1, 4)
  })
})

describe('addMeshBeside', () => {
  it('places the extra mesh to the right with the gap, on the bed, Z-centred', () => {
    const base = makeBox(-10, 0, -10, 10, 20, 10)
    const extra = makeBox(100, 5, 100, 104, 9, 108)   // arbitrary placement
    const merged = addMeshBeside(base, extra, 10)
    const b = bounds(merged)
    // Base unchanged on the left; extra starts at base.maxX (10) + gap (10) = 20
    expect(b.min[0]).toBeCloseTo(-10, 3)
    expect(b.max[0]).toBeCloseTo(10 + 10 + 4, 3)      // base maxX + gap + extra width
    // Extra dropped to the bed
    expect(b.min[1]).toBeCloseTo(0, 3)
    // Z extent symmetric around base centre (0): extra depth 8 centred → ±10 still dominates
    expect(b.min[2]).toBeCloseTo(-10, 3)
    expect(b.max[2]).toBeCloseTo(10, 3)
  })

  it('preserves both volumes and triangle counts', () => {
    const base = makeBox(0, 0, 0, 2, 2, 2)
    const extra = makeBox(0, 0, 0, 3, 3, 3)
    const merged = addMeshBeside(base, extra)
    expect(merged.indices.length).toBe(base.indices.length + extra.indices.length)
    expect(signedVolume(merged)).toBeCloseTo(8 + 27, 2)
  })

  it('fills missing vertex colors with grey when one side is painted', () => {
    const base = makeBox(0, 0, 0, 2, 2, 2)
    const painted: TriangleMesh = {
      ...makeBox(0, 0, 0, 1, 1, 1),
      vertexColors: new Float32Array(8 * 3).fill(1), // all white
    }
    const merged = addMeshBeside(base, painted)
    expect(merged.vertexColors).toBeDefined()
    expect(merged.vertexColors!.length).toBe(merged.positions.length)
    // base section grey, painted section white
    expect(merged.vertexColors![0]).toBeCloseTo(0.78, 2)
    expect(merged.vertexColors![base.positions.length]).toBeCloseTo(1, 3)
  })

  it('returns the other mesh when one side is empty', () => {
    const box = makeBox(0, 0, 0, 1, 1, 1)
    const empty: TriangleMesh = { positions: new Float32Array(0), indices: new Uint32Array(0) }
    expect(addMeshBeside(box, empty)).toBe(box)
    expect(addMeshBeside(empty, box)).toBe(box)
  })
})

describe('autoOrientMesh', () => {
  it('keeps an already-flat box unchanged (bestIdx 0)', () => {
    const box = makeBox(0, 0, 0, 10, 10, 10)
    expect(autoOrientMesh(box).bestIdx).toBe(0)
  })

  it('never returns a worse orientation than the input', () => {
    const box = makeBox(0, 0, 0, 10, 4, 6)
    const tipped = rotateMeshQuarterTurnAroundZ(box)
    const { mesh: oriented } = autoOrientMesh(tipped)
    expect(computeOverhangScore(oriented)).toBeLessThanOrEqual(computeOverhangScore(tipped) + EPS)
  })
})
