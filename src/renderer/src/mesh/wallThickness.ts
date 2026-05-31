import type { TriangleMesh } from './types'

/**
 * Compute an approximate wall-thickness heat-map color for every triangle.
 *
 * Algorithm:
 *   For each triangle centroid C with outward normal N, find the nearest centroid
 *   of an *opposing* face (dot(N, Nj) < -0.3) within `maxDistMm`.  The Euclidean
 *   distance between the two centroids is the thickness estimate for that face.
 *
 *   Faces are indexed into a spatial grid (cell size = maxDistMm) so typical
 *   complexity is O(n * k) where k is the average number of faces in a 3×3×3
 *   neighbourhood — fast even for meshes with hundreds of thousands of triangles.
 *
 * Returns a Float32Array of length triCount * 3 containing linear-sRGB (R, G, B)
 * per-triangle colours:
 *   red    < minOkMm          — too thin, will likely fail to print
 *   orange  minOkMm … thinMm — borderline
 *   yellow  thinMm … okMm   — marginal
 *   green  > okMm            — fine
 *
 * Colours are written three times per triangle so each vertex of the triangle
 * gets the face colour (assumes non-indexed / flat-shaded mapping, so callers
 * must expand the indexed mesh with `expandToFlatMesh` before applying).
 */
export function computeWallThicknessColors(
  mesh: TriangleMesh,
  {
    maxDistMm = 10,
    minOkMm   = 0.8,
    thinMm    = 1.6,
    okMm      = 3.0,
  }: { maxDistMm?: number; minOkMm?: number; thinMm?: number; okMm?: number } = {}
): { perTriColor: Float32Array; summary: { tooThin: number; borderline: number; ok: number } } {
  const p  = mesh.positions
  const ix = mesh.indices
  const triCount = ix.length / 3

  // ── 1. Compute centroids and normals ──────────────────────────────────────
  const cx = new Float32Array(triCount)
  const cy = new Float32Array(triCount)
  const cz = new Float32Array(triCount)
  const nx = new Float32Array(triCount)
  const ny = new Float32Array(triCount)
  const nz = new Float32Array(triCount)

  for (let t = 0; t < triCount; t++) {
    const i0 = ix[t * 3]! * 3, i1 = ix[t * 3 + 1]! * 3, i2 = ix[t * 3 + 2]! * 3
    const ax = p[i0]!, ay = p[i0 + 1]!, az = p[i0 + 2]!
    const bx = p[i1]!, by = p[i1 + 1]!, bz = p[i1 + 2]!
    const ccx = p[i2]!, ccy = p[i2 + 1]!, ccz = p[i2 + 2]!
    cx[t] = (ax + bx + ccx) / 3
    cy[t] = (ay + by + ccy) / 3
    cz[t] = (az + bz + ccz) / 3
    let nnx = (by - ay) * (ccz - az) - (bz - az) * (ccy - ay)
    let nny = (bz - az) * (ccx - ax) - (bx - ax) * (ccz - az)
    let nnz = (bx - ax) * (ccy - ay) - (by - ay) * (ccx - ax)
    const l = Math.sqrt(nnx * nnx + nny * nny + nnz * nnz)
    if (l > 1e-10) { nnx /= l; nny /= l; nnz /= l }
    nx[t] = nnx; ny[t] = nny; nz[t] = nnz
  }

  // ── 2. Build spatial grid ─────────────────────────────────────────────────
  const cs = maxDistMm   // cell size
  const grid = new Map<number, number[]>()

  // Pack three ints into a single number key (sufficient for models < 10000mm)
  const key = (gx: number, gy: number, gz: number): number =>
    (gx & 0x7ff) | ((gy & 0x7ff) << 11) | ((gz & 0x7ff) << 22)

  for (let t = 0; t < triCount; t++) {
    const k = key(Math.floor(cx[t]! / cs), Math.floor(cy[t]! / cs), Math.floor(cz[t]! / cs))
    const cell = grid.get(k)
    if (cell) cell.push(t); else grid.set(k, [t])
  }

  // ── 3. For each triangle, find nearest opposing face ──────────────────────
  const thickness = new Float32Array(triCount).fill(maxDistMm)

  for (let t = 0; t < triCount; t++) {
    const tcx = cx[t]!, tcy = cy[t]!, tcz = cz[t]!
    const tnx = nx[t]!, tny = ny[t]!, tnz = nz[t]!
    const gx = Math.floor(tcx / cs), gy = Math.floor(tcy / cs), gz = Math.floor(tcz / cs)
    let minD = maxDistMm

    for (let ddx = -1; ddx <= 1; ddx++) {
      for (let ddy = -1; ddy <= 1; ddy++) {
        for (let ddz = -1; ddz <= 1; ddz++) {
          const cell = grid.get(key(gx + ddx, gy + ddy, gz + ddz))
          if (!cell) continue
          for (const j of cell) {
            if (j === t) continue
            if (tnx * nx[j]! + tny * ny[j]! + tnz * nz[j]! > -0.3) continue  // not opposing
            const dx = cx[j]! - tcx, dy = cy[j]! - tcy, dz = cz[j]! - tcz
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
            if (d < minD) minD = d
          }
        }
      }
    }
    thickness[t] = minD
  }

  // ── 4. Map thickness → RGB heat-map colour ────────────────────────────────
  // Thresholds: red < minOkMm < orange < thinMm < yellow < okMm < green
  const perTriColor = new Float32Array(triCount * 3)
  let tooThin = 0, borderline = 0, ok = 0

  for (let t = 0; t < triCount; t++) {
    const th = thickness[t]!
    let r = 0, g = 0, b = 0

    if (th < minOkMm) {
      // red
      r = 1; g = 0.1; b = 0.05
      tooThin++
    } else if (th < thinMm) {
      // red → orange → yellow lerp
      const frac = (th - minOkMm) / (thinMm - minOkMm)
      r = 1; g = frac * 0.65; b = 0.02
      borderline++
    } else if (th < okMm) {
      // yellow → green lerp
      const frac = (th - thinMm) / (okMm - thinMm)
      r = 1 - frac * 0.9; g = 0.65 + frac * 0.35; b = 0.02
      ok++
    } else {
      // green
      r = 0.05; g = 0.88; b = 0.25
      ok++
    }

    perTriColor[t * 3]     = r
    perTriColor[t * 3 + 1] = g
    perTriColor[t * 3 + 2] = b
  }

  return { perTriColor, summary: { tooThin, borderline, ok } }
}

/**
 * Expand an indexed mesh to a flat (non-indexed) vertex array, producing one
 * copy of each vertex per triangle.  Required so per-triangle colours can be
 * applied as per-vertex colours without bleeding across shared vertices.
 */
export function expandToFlatPositions(mesh: TriangleMesh): Float32Array {
  const p  = mesh.positions
  const ix = mesh.indices
  const triCount = ix.length / 3
  const flat = new Float32Array(triCount * 9)  // 3 verts × 3 components per triangle
  for (let t = 0; t < triCount; t++) {
    for (let v = 0; v < 3; v++) {
      const vi = ix[t * 3 + v]! * 3
      flat[t * 9 + v * 3]     = p[vi]!
      flat[t * 9 + v * 3 + 1] = p[vi + 1]!
      flat[t * 9 + v * 3 + 2] = p[vi + 2]!
    }
  }
  return flat
}
