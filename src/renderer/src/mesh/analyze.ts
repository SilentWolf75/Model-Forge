import type { TriangleMesh } from './types'
import { repairMesh } from '../repair/meshRepair'

export type MeshBounds = {
  min: [number, number, number]
  max: [number, number, number]
  /** Extents along world X, Y, Z (mm). */
  size: [number, number, number]
  /** Corner-to-corner diagonal of the axis-aligned box (mm). */
  diagonalMm: number
}

export type MeshAnalysis = {
  bounds: MeshBounds
  /** Sum of triangle areas (mm²). */
  surfaceAreaMm2: number
  /**
   * Signed sum of tetrahedron volumes from the origin (mm³).
   * For a closed, consistently oriented mesh this equals enclosed volume; otherwise treat as indicative only.
   */
  signedVolumeMm3: number
  triangleCount: number
  vertexCount: number
  /**
   * Number of disconnected vertex-connected components (shells).
   * 1 = single solid body.  >1 = multiple bodies or stray geometry.
   */
  shellCount: number
  /**
   * Number of triangles whose face normal points more than 45° below the build plane
   * (face normal Y component < –cos45°). Rough indicator of unsupported overhangs.
   */
  overhangTriangleCount: number
}

/** Common desktop FDM build plate upper bound for “fits typical bed” hints (mm). */
const COMMON_BED_MAX_MM = 310

// ─── Shell count (union-find on vertex indices) ───────────────────────────────

function countShells(nVerts: number, indices: Uint32Array): number {
  const parent = new Int32Array(nVerts)
  for (let i = 0; i < nVerts; i++) parent[i] = i

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!   // path halving
      x = parent[x]!
    }
    return x
  }

  for (let t = 0; t < indices.length; t += 3) {
    const ra = find(indices[t]!)
    const rb = find(indices[t + 1]!)
    const rc = find(indices[t + 2]!)
    if (ra !== rb) parent[ra] = rb
    const rb2 = find(rb)
    if (rb2 !== rc) parent[rb2] = rc
  }

  let roots = 0
  for (let i = 0; i < nVerts; i++) if (find(i) === i) roots++
  return roots
}

// ─── Overhang triangle count ──────────────────────────────────────────────────

/** face-normal Y < -cos(45°) ≈ -0.7071 — faces pointing more than 45° below horizontal */
const OVERHANG_COS = Math.cos(45 * Math.PI / 180)

function countOverhangTriangles(p: Float32Array, indices: Uint32Array): number {
  let count = 0
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t]! * 3
    const i1 = indices[t + 1]! * 3
    const i2 = indices[t + 2]! * 3
    const ux = p[i1]! - p[i0]!, uy = p[i1 + 1]! - p[i0 + 1]!, uz = p[i1 + 2]! - p[i0 + 2]!
    const vx = p[i2]! - p[i0]!, vy = p[i2 + 1]! - p[i0 + 1]!, vz = p[i2 + 2]! - p[i0 + 2]!
    // cross product Y component: uz*vx - ux*vz
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-10) continue
    if (ny / len < -OVERHANG_COS) count++
  }
  return count
}

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number] {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]
}

function dot(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz
}

/** Bounds, surface area, and signed volume (mm / mm² / mm³). */
export function analyzeMesh(mesh: TriangleMesh): MeshAnalysis {
  const p = mesh.positions
  const ix = mesh.indices
  let minx = Infinity,
    miny = Infinity,
    minz = Infinity
  let maxx = -Infinity,
    maxy = -Infinity,
    maxz = -Infinity

  for (let i = 0; i < p.length; i += 3) {
    const x = p[i],
      y = p[i + 1],
      z = p[i + 2]
    minx = Math.min(minx, x)
    miny = Math.min(miny, y)
    minz = Math.min(minz, z)
    maxx = Math.max(maxx, x)
    maxy = Math.max(maxy, y)
    maxz = Math.max(maxz, z)
  }

  const dx = maxx - minx
  const dy = maxy - miny
  const dz = maxz - minz
  const diagonalMm = Math.hypot(dx, dy, dz)

  let surfaceAreaMm2 = 0
  let signedVolumeMm3 = 0

  for (let t = 0; t < ix.length; t += 3) {
    const i0 = ix[t] * 3
    const i1 = ix[t + 1] * 3
    const i2 = ix[t + 2] * 3
    const ax = p[i0],
      ay = p[i0 + 1],
      az = p[i0 + 2]
    const bx = p[i1],
      by = p[i1 + 1],
      bz = p[i1 + 2]
    const cx = p[i2],
      cy = p[i2 + 1],
      cz = p[i2 + 2]
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az
    const vx = cx - ax,
      vy = cy - ay,
      vz = cz - az
    const [nx, ny, nz] = cross(ux, uy, uz, vx, vy, vz)
    const a = Math.hypot(nx, ny, nz)
    surfaceAreaMm2 += a * 0.5
    signedVolumeMm3 += dot(ax, ay, az, nx, ny, nz) / 6
  }

  const nVerts = p.length / 3
  const shellCount         = nVerts > 0 ? countShells(nVerts, ix) : 0
  const overhangTriangleCount = ix.length > 0 ? countOverhangTriangles(p, ix) : 0

  return {
    bounds: {
      min: [minx, miny, minz],
      max: [maxx, maxy, maxz],
      size: [dx, dy, dz],
      diagonalMm
    },
    surfaceAreaMm2,
    signedVolumeMm3,
    triangleCount: ix.length / 3,
    vertexCount: nVerts,
    shellCount,
    overhangTriangleCount,
  }
}

export type PrintReadinessLine = { level: 'ok' | 'info' | 'warn'; text: string }

/** Heuristic checklist for FDM-oriented workflows (not a substitute for a slicer). */
export function printReadinessLines(analysis: MeshAnalysis, repairRemovedDegenerate: number): PrintReadinessLine[] {
  const lines: PrintReadinessLine[] = []
  const { bounds, triangleCount, vertexCount, signedVolumeMm3, shellCount, overhangTriangleCount } = analysis
  const [dx, dy, dz] = bounds.size
  const footprint = Math.max(dx, dz)
  const volAbs = Math.abs(signedVolumeMm3)

  if (triangleCount === 0) {
    lines.push({ level: 'warn', text: 'Mesh has no triangles.' })
    return lines
  }

  if (repairRemovedDegenerate > 0) {
    lines.push({
      level: 'warn',
      text: `Repair would remove ${repairRemovedDegenerate.toLocaleString()} degenerate triangle(s) (Run Repair to apply).`
    })
  } else {
    lines.push({ level: 'ok', text: 'No zero-area triangles detected at the repair tolerance.' })
  }

  if (Math.max(dx, dy, dz) < 1e-6) {
    lines.push({ level: 'warn', text: 'Bounding box is effectively flat — check units or corrupt geometry.' })
  }

  if (footprint > COMMON_BED_MAX_MM) {
    lines.push({
      level: 'warn',
      text: `XY footprint about ${footprint.toFixed(0)} mm exceeds a typical ~${COMMON_BED_MAX_MM} mm bed (largest of ΔX, ΔZ).`
    })
  } else {
    lines.push({
      level: 'ok',
      text: `XY footprint about ${footprint.toFixed(0)} mm should fit many common beds (ΔX / ΔZ).`
    })
  }

  if (dy < 0.05) {
    lines.push({ level: 'info', text: 'Model is very thin in Y (height); confirm orientation vs. the print bed.' })
  }

  if (triangleCount > 1_500_000) {
    lines.push({
      level: 'warn',
      text: `${triangleCount.toLocaleString()} triangles — slicers may be slow; consider decimating CAD exports.`
    })
  } else if (triangleCount > 600_000) {
    lines.push({
      level: 'info',
      text: `${triangleCount.toLocaleString()} triangles — fine for most PCs; STEP/CAD meshes can be heavier.`
    })
  } else {
    lines.push({ level: 'ok', text: `${triangleCount.toLocaleString()} triangles — reasonable preview size.` })
  }

  const bboxVol = dx * dy * dz
  if (bboxVol > 1e-9 && volAbs < bboxVol * 1e-5) {
    lines.push({
      level: 'info',
      text: 'Enclosed volume (signed) is tiny vs. the bounding box — mesh may be open or inconsistently wound; volume below is indicative only.'
    })
  }

  lines.push({
    level: 'info',
    text: `${vertexCount.toLocaleString()} raw vertex positions (OBJ/STL may repeat vertices per face).`
  })

  if (shellCount > 1) {
    lines.push({
      level: 'info',
      text: `${shellCount} disconnected shells — may be intentional (multi-body) or stray geometry; check in your slicer.`
    })
  } else if (shellCount === 1) {
    lines.push({ level: 'ok', text: 'Single connected shell.' })
  }

  const overhangPct = triangleCount > 0 ? (overhangTriangleCount / triangleCount) * 100 : 0
  if (overhangPct > 30) {
    lines.push({
      level: 'warn',
      text: `${overhangPct.toFixed(1)}% of triangles are likely overhangs (>45° below horizontal) — supports may be needed.`
    })
  } else if (overhangPct > 5) {
    lines.push({
      level: 'info',
      text: `${overhangPct.toFixed(1)}% of triangles are potential overhangs — review support needs in your slicer.`
    })
  } else {
    lines.push({ level: 'ok', text: `${overhangPct.toFixed(1)}% overhang triangles — low overhang fraction.` })
  }

  return lines
}

/** Runs repair to count degenerates; discards the repaired mesh (used for reporting only). */
export function repairImpactReport(mesh: TriangleMesh): { removedDegenerate: number } {
  return { removedDegenerate: repairMesh(mesh).report.removedDegenerate }
}
