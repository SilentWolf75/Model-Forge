import type { TriangleMesh } from './types'

/**
 * Wall-thickness heat-map colours, slicer-style: for each sampled face, cast a
 * ray from the face centroid INWARD (opposite the face normal) and measure the
 * distance to the first triangle it hits.  That distance is the local wall
 * thickness — the same definition slicers use, accurate on curved shells where
 * the old opposing-centroid heuristic over-reported.
 *
 * Performance shape (bounded regardless of mesh size):
 *   Phase 0 — centroids + normals for all triangles, one pass.
 *   Phase 1 — triangles binned into a voxel grid; rays from up to MAX_SAMPLE
 *             stride-sampled faces walk the grid with 3D-DDA (Amanatides–Woo)
 *             and Möller–Trumbore per candidate triangle, stopping at the
 *             first hit or maxDistMm.
 *   Phase 2 — every triangle inherits the thickness of its nearest sample via
 *             a single 3×3×3 lookup in a coarse sample grid.
 *
 * Returns one linear-sRGB (R, G, B) triple per triangle:
 *   red    < minOkMm          — too thin, likely to fail
 *   orange  minOkMm … thinMm
 *   yellow  thinMm  … okMm
 *   green  > okMm             — fine
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
  if (triCount === 0) return { perTriColor: new Float32Array(0), summary: { tooThin: 0, borderline: 0, ok: 0 } }

  // ── Phase 0: centroids + normals ───────────────────────────────────────────
  const tcx = new Float32Array(triCount)
  const tcy = new Float32Array(triCount)
  const tcz = new Float32Array(triCount)
  const tnx = new Float32Array(triCount)
  const tny = new Float32Array(triCount)
  const tnz = new Float32Array(triCount)
  let minX = Infinity, minY = Infinity, minZ = Infinity

  for (let t = 0; t < triCount; t++) {
    const i0 = ix[t * 3]! * 3, i1 = ix[t * 3 + 1]! * 3, i2 = ix[t * 3 + 2]! * 3
    const ax = p[i0]!, ay = p[i0+1]!, az = p[i0+2]!
    const bx = p[i1]!, by = p[i1+1]!, bz = p[i1+2]!
    const cx = p[i2]!, cy = p[i2+1]!, cz = p[i2+2]!
    tcx[t] = (ax+bx+cx)/3; tcy[t] = (ay+by+cy)/3; tcz[t] = (az+bz+cz)/3
    let nx = (by-ay)*(cz-az)-(bz-az)*(cy-ay)
    let ny = (bz-az)*(cx-ax)-(bx-ax)*(cz-az)
    let nz = (bx-ax)*(cy-ay)-(by-ay)*(cx-ax)
    const l = Math.sqrt(nx*nx+ny*ny+nz*nz)
    if (l > 1e-10) { nx/=l; ny/=l; nz/=l }
    tnx[t]=nx; tny[t]=ny; tnz[t]=nz
    minX = Math.min(minX, ax, bx, cx)
    minY = Math.min(minY, ay, by, cy)
    minZ = Math.min(minZ, az, bz, cz)
  }

  // ── Phase 1a: bin all triangles into a voxel grid ──────────────────────────
  // Cell size = half the search distance keeps candidate lists short while the
  // DDA only visits a handful of cells per ray.
  const cell = Math.max(0.25, maxDistMm / 2)
  const gKey = (gx: number, gy: number, gz: number): number =>
    ((gx & 0x3ff)) | ((gy & 0x3ff) << 10) | ((gz & 0x3ff) << 20)
  const grid = new Map<number, number[]>()
  /** Triangles spanning too many cells (rare giant faces) — tested on every ray. */
  const bigTris: number[] = []
  const MAX_SPAN = 16

  for (let t = 0; t < triCount; t++) {
    const i0 = ix[t * 3]! * 3, i1 = ix[t * 3 + 1]! * 3, i2 = ix[t * 3 + 2]! * 3
    const x0 = Math.min(p[i0]!, p[i1]!, p[i2]!),    x1 = Math.max(p[i0]!, p[i1]!, p[i2]!)
    const y0 = Math.min(p[i0+1]!, p[i1+1]!, p[i2+1]!), y1 = Math.max(p[i0+1]!, p[i1+1]!, p[i2+1]!)
    const z0 = Math.min(p[i0+2]!, p[i1+2]!, p[i2+2]!), z1 = Math.max(p[i0+2]!, p[i1+2]!, p[i2+2]!)
    const gx0 = Math.floor((x0 - minX) / cell), gx1 = Math.floor((x1 - minX) / cell)
    const gy0 = Math.floor((y0 - minY) / cell), gy1 = Math.floor((y1 - minY) / cell)
    const gz0 = Math.floor((z0 - minZ) / cell), gz1 = Math.floor((z1 - minZ) / cell)
    if (gx1 - gx0 > MAX_SPAN || gy1 - gy0 > MAX_SPAN || gz1 - gz0 > MAX_SPAN) {
      bigTris.push(t)
      continue
    }
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++)
        for (let gz = gz0; gz <= gz1; gz++) {
          const k = gKey(gx, gy, gz)
          const c = grid.get(k)
          if (c) c.push(t); else grid.set(k, [t])
        }
  }

  /** Möller–Trumbore: distance along the ray to triangle `t`, or Infinity. */
  const rayTri = (t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number => {
    const i0 = ix[t * 3]! * 3, i1 = ix[t * 3 + 1]! * 3, i2 = ix[t * 3 + 2]! * 3
    const ax = p[i0]!, ay = p[i0+1]!, az = p[i0+2]!
    const e1x = p[i1]! - ax, e1y = p[i1+1]! - ay, e1z = p[i1+2]! - az
    const e2x = p[i2]! - ax, e2y = p[i2+1]! - ay, e2z = p[i2+2]! - az
    const px = dy * e2z - dz * e2y
    const py = dz * e2x - dx * e2z
    const pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-12) return Infinity
    const inv = 1 / det
    const tx = ox - ax, ty = oy - ay, tz = oz - az
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < -1e-6 || u > 1 + 1e-6) return Infinity
    const qx = ty * e1z - tz * e1y
    const qy = tz * e1x - tx * e1z
    const qz = tx * e1y - ty * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < -1e-6 || u + v > 1 + 1e-6) return Infinity
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv
    return dist > 1e-3 ? dist : Infinity   // skip self / coplanar neighbours
  }

  // ── Phase 1b: cast inward rays from stride-sampled faces ──────────────────
  const MAX_SAMPLE = 30_000
  const stride = Math.max(1, Math.floor(triCount / MAX_SAMPLE))
  const sampleThickness = new Float32Array(triCount).fill(-1)  // -1 = not a sample
  const visited = new Int32Array(triCount).fill(-1)            // dedupe stamp per ray

  for (let t = 0; t < triCount; t += stride) {
    const ox = tcx[t]!, oy = tcy[t]!, oz = tcz[t]!
    const dx = -tnx[t]!, dy = -tny[t]!, dz = -tnz[t]!   // inward
    let best = maxDistMm

    // Giant triangles are always candidates
    for (const j of bigTris) {
      if (j === t) continue
      const d = rayTri(j, ox, oy, oz, dx, dy, dz)
      if (d < best) best = d
    }

    // 3D-DDA through the voxel grid
    let gx = Math.floor((ox - minX) / cell)
    let gy = Math.floor((oy - minY) / cell)
    let gz = Math.floor((oz - minZ) / cell)
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1
    const tDeltaX = Math.abs(dx) > 1e-12 ? cell / Math.abs(dx) : Infinity
    const tDeltaY = Math.abs(dy) > 1e-12 ? cell / Math.abs(dy) : Infinity
    const tDeltaZ = Math.abs(dz) > 1e-12 ? cell / Math.abs(dz) : Infinity
    const fracX = (ox - minX) / cell - gx
    const fracY = (oy - minY) / cell - gy
    const fracZ = (oz - minZ) / cell - gz
    let tMaxX = tDeltaX === Infinity ? Infinity : tDeltaX * (dx > 0 ? 1 - fracX : fracX)
    let tMaxY = tDeltaY === Infinity ? Infinity : tDeltaY * (dy > 0 ? 1 - fracY : fracY)
    let tMaxZ = tDeltaZ === Infinity ? Infinity : tDeltaZ * (dz > 0 ? 1 - fracZ : fracZ)
    let travelled = 0

    while (travelled <= best) {
      const cellTris = grid.get(gKey(gx, gy, gz))
      if (cellTris) {
        for (const j of cellTris) {
          if (j === t || visited[j] === t) continue
          visited[j] = t
          const d = rayTri(j, ox, oy, oz, dx, dy, dz)
          if (d < best) best = d
        }
      }
      // step to next cell
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ)      { travelled = tMaxX; tMaxX += tDeltaX; gx += stepX }
      else if (tMaxY <= tMaxZ)                   { travelled = tMaxY; tMaxY += tDeltaY; gy += stepY }
      else                                       { travelled = tMaxZ; tMaxZ += tDeltaZ; gz += stepZ }
    }

    sampleThickness[t] = best
  }

  // ── Phase 1c: coarse sample grid for phase-2 inheritance ──────────────────
  const sCell = maxDistMm
  const sGrid = new Map<number, number[]>()
  for (let t = 0; t < triCount; t += stride) {
    const k = gKey(Math.floor((tcx[t]! - minX) / sCell), Math.floor((tcy[t]! - minY) / sCell), Math.floor((tcz[t]! - minZ) / sCell))
    const c = sGrid.get(k)
    if (c) c.push(t); else sGrid.set(k, [t])
  }

  // ── Phase 2: per-triangle colour from own or nearest sample thickness ──────
  const perTriColor = new Float32Array(triCount * 3)
  let tooThin = 0, borderline = 0, ok = 0

  for (let t = 0; t < triCount; t++) {
    let th = sampleThickness[t]!
    if (th < 0) {
      // Not a sample — inherit from the nearest sample in the 3×3×3 neighbourhood
      const gx = Math.floor((tcx[t]! - minX) / sCell)
      const gy = Math.floor((tcy[t]! - minY) / sCell)
      const gz = Math.floor((tcz[t]! - minZ) / sCell)
      let bestD = Infinity
      th = maxDistMm
      for (let ddx = -1; ddx <= 1; ddx++)
        for (let ddy = -1; ddy <= 1; ddy++)
          for (let ddz = -1; ddz <= 1; ddz++) {
            const c = sGrid.get(gKey(gx + ddx, gy + ddy, gz + ddz))
            if (!c) continue
            for (const s of c) {
              const ex = tcx[s]! - tcx[t]!, ey = tcy[s]! - tcy[t]!, ez = tcz[s]! - tcz[t]!
              const d = ex * ex + ey * ey + ez * ez
              if (d < bestD) { bestD = d; th = sampleThickness[s]! }
            }
          }
    }

    let r = 0, g = 0, b = 0
    if (th < minOkMm) {
      r = 1; g = 0.1; b = 0.05; tooThin++
    } else if (th < thinMm) {
      const f = (th - minOkMm) / (thinMm - minOkMm)
      r = 1; g = f * 0.65; b = 0.02; borderline++
    } else if (th < okMm) {
      const f = (th - thinMm) / (okMm - thinMm)
      r = 1 - f * 0.9; g = 0.65 + f * 0.35; b = 0.02; ok++
    } else {
      r = 0.05; g = 0.88; b = 0.25; ok++
    }
    perTriColor[t*3] = r; perTriColor[t*3+1] = g; perTriColor[t*3+2] = b
  }

  return { perTriColor, summary: { tooThin, borderline, ok } }
}
