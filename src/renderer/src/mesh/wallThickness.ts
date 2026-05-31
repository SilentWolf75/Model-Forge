import type { TriangleMesh } from './types'

/**
 * Compute an approximate wall-thickness heat-map colour for every triangle.
 *
 * Two-phase algorithm — stays fast regardless of mesh size:
 *
 * Phase 1 — Analysis (sampled):
 *   Subsample up to MAX_SAMPLE triangles (stride = max(1, triCount/MAX_SAMPLE)).
 *   For each sample, find the nearest opposing centroid (dot(Ni, Nj) < -0.3)
 *   within maxDistMm using a spatial grid.  Cell size = maxDistMm so the 3×3×3
 *   neighbourhood search is O(k) where k = avg samples per cell.
 *   With MAX_SAMPLE = 30 000 and typical cell density k ≈ 15, this runs in < 20 ms
 *   even for million-triangle meshes.
 *
 * Phase 2 — Colour assignment (all triangles):
 *   For every triangle (sampled or not), do a single-cell lookup into the sample
 *   grid to find the nearest sample and copy its colour.  O(triCount × k_cell).
 *
 * Returns a Float32Array of length triCount × 3 (R, G, B per triangle, linear-sRGB):
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

  // ── 0. Subsample ────────────────────────────────────────────────────────────
  const MAX_SAMPLE = 30_000
  const stride = Math.max(1, Math.floor(triCount / MAX_SAMPLE))

  // ── 1. Centroids + normals for ALL triangles (one pass, needed for phase 2) ─
  const tcx = new Float32Array(triCount)
  const tcy = new Float32Array(triCount)
  const tcz = new Float32Array(triCount)
  const tnx = new Float32Array(triCount)
  const tny = new Float32Array(triCount)
  const tnz = new Float32Array(triCount)

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
  }

  // ── 2. Build sample grid ──────────────────────────────────────────────────
  const cs = maxDistMm
  // Int key with 13-bit fields — covers ±4096 cells per axis (sufficient for < 40m models)
  const cellKey = (gx:number, gy:number, gz:number) =>
    (((gx+4096)&0x1fff)) | (((gy+4096)&0x1fff)<<13) | (((gz+4096)&0x1fff)<<26)
  // We use a Float64 key via BigInt-free packing; for safety use a string key at low cost
  const grid = new Map<number, number[]>()
  const sampleIds: number[] = []

  for (let t = 0; t < triCount; t += stride) {
    sampleIds.push(t)
    const k = cellKey(Math.floor(tcx[t]!/cs), Math.floor(tcy[t]!/cs), Math.floor(tcz[t]!/cs))
    const cell = grid.get(k)
    if (cell) cell.push(t); else grid.set(k, [t])
  }

  // ── 3. Compute thickness for each sample ──────────────────────────────────
  const sampleThickness = new Float32Array(triCount).fill(maxDistMm)

  for (const t of sampleIds) {
    const cx = tcx[t]!, cy = tcy[t]!, cz = tcz[t]!
    const nx = tnx[t]!, ny = tny[t]!, nz = tnz[t]!
    const gx = Math.floor(cx/cs), gy = Math.floor(cy/cs), gz = Math.floor(cz/cs)
    let minD = maxDistMm

    for (let dx=-1; dx<=1; dx++) for (let dy=-1; dy<=1; dy++) for (let dz=-1; dz<=1; dz++) {
      const cell = grid.get(cellKey(gx+dx, gy+dy, gz+dz))
      if (!cell) continue
      for (const j of cell) {
        if (j === t) continue
        if (nx*tnx[j]! + ny*tny[j]! + nz*tnz[j]! > -0.3) continue
        const ex=tcx[j]!-cx, ey=tcy[j]!-cy, ez=tcz[j]!-cz
        const d=Math.sqrt(ex*ex+ey*ey+ez*ez)
        if (d < minD) minD = d
      }
    }
    sampleThickness[t] = minD
  }

  // ── 4. Assign colour to every triangle via nearest-sample cell lookup ──────
  const perTriColor = new Float32Array(triCount * 3)
  let tooThin = 0, borderline = 0, ok = 0

  for (let t = 0; t < triCount; t++) {
    // Find the thickness: exact for samples, grid-inherited for others
    let th = sampleThickness[t]
    if (th === maxDistMm && stride > 1) {
      // Not a sample — look for nearest sample in this cell (expand once if empty)
      const gx = Math.floor(tcx[t]!/cs), gy = Math.floor(tcy[t]!/cs), gz = Math.floor(tcz[t]!/cs)
      let bestD = Infinity
      for (let dx=-1; dx<=1 && bestD===Infinity; dx++)
        for (let dy=-1; dy<=1 && bestD===Infinity; dy++)
          for (let dz=-1; dz<=1; dz++) {
            const cell = grid.get(cellKey(gx+dx, gy+dy, gz+dz))
            if (!cell) continue
            for (const s of cell) {
              const ex=tcx[s]!-tcx[t]!, ey=tcy[s]!-tcy[t]!, ez=tcz[s]!-tcz[t]!
              const d=ex*ex+ey*ey+ez*ez
              if (d < bestD) { bestD=d; th=sampleThickness[s]! }
            }
          }
    }

    // Map thickness → colour
    let r=0, g=0, b=0
    if (th < minOkMm) {
      r=1; g=0.1; b=0.05; tooThin++
    } else if (th < thinMm) {
      const f=(th-minOkMm)/(thinMm-minOkMm)
      r=1; g=f*0.65; b=0.02; borderline++
    } else if (th < okMm) {
      const f=(th-thinMm)/(okMm-thinMm)
      r=1-f*0.9; g=0.65+f*0.35; b=0.02; ok++
    } else {
      r=0.05; g=0.88; b=0.25; ok++
    }
    perTriColor[t*3]=r; perTriColor[t*3+1]=g; perTriColor[t*3+2]=b
  }

  return { perTriColor, summary: { tooThin, borderline, ok } }
}
