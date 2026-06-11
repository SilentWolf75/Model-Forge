import type { TriangleMesh } from './types'
import { rotateMeshQuarterTurnAroundX, rotateMeshQuarterTurnAroundZ } from './rotateAroundY'

/** Translate the mesh so its lowest vertex sits exactly at Y = 0 (on the bed). */
export function snapMeshToBed(mesh: TriangleMesh): TriangleMesh {
  const p = mesh.positions
  let minY = Infinity
  for (let i = 1; i < p.length; i += 3) minY = Math.min(minY, p[i]!)
  if (!Number.isFinite(minY) || Math.abs(minY) < 0.001) return mesh
  const positions = p.slice()
  for (let i = 1; i < positions.length; i += 3) (positions[i] as number) -= minY
  const plateParts = mesh.plateParts?.map((pp) => ({
    ...pp,
    mesh: snapMeshToBed(pp.mesh),
  }))
  return { ...mesh, positions, ...(plateParts ? { plateParts } : {}) }
}

/** Translate every vertex by (dx, dy, dz); preserves plateParts, indices shared. */
export function translateMesh(mesh: TriangleMesh, dx: number, dy: number, dz: number): TriangleMesh {
  if (dx === 0 && dy === 0 && dz === 0) return mesh
  const positions = mesh.positions.slice()
  for (let i = 0; i < positions.length; i += 3) {
    positions[i]     = positions[i]!     + dx
    positions[i + 1] = positions[i + 1]! + dy
    positions[i + 2] = positions[i + 2]! + dz
  }
  const plateParts = mesh.plateParts?.map((pp) => ({
    ...pp,
    mesh: translateMesh(pp.mesh, dx, dy, dz),
  }))
  return { ...mesh, positions, ...(plateParts ? { plateParts } : {}) }
}

/** Scale every position in a TriangleMesh by a uniform factor; preserves plateParts. */
export function scaleMesh(mesh: TriangleMesh, factor: number): TriangleMesh {
  const positions = mesh.positions.slice()
  for (let i = 0; i < positions.length; i++) positions[i] *= factor
  const plateParts = mesh.plateParts?.map((p) => ({
    ...p,
    mesh: scaleMesh(p.mesh, factor),
  }))
  return { ...mesh, positions, ...(plateParts ? { plateParts } : {}) }
}

/** Return the mesh of a single plate, or null when the plate has no geometry. */
export function extractPlateMesh(mesh: TriangleMesh, plateId: number): TriangleMesh | null {
  const part = mesh.plateParts?.find((p) => p.plateId === plateId)
  return part?.mesh ?? null
}

/**
 * Merge `extra` into `base` as an additional shell, auto-placed to the right of
 * the base model with `gapMm` clearance and aligned to the bed (minY = 0, Z
 * centres matched).  Vertex colours are preserved when either mesh has them —
 * the uncoloured mesh is filled with a neutral grey so painted models keep
 * their paint.  The result has no plateParts; analysis/export/repair treat it
 * as one multi-shell model.
 */
export function addMeshBeside(base: TriangleMesh, extra: TriangleMesh, gapMm = 10): TriangleMesh {
  if (extra.positions.length === 0) return base
  if (base.positions.length === 0) return extra

  const bounds = (p: Float32Array): { minX: number; maxX: number; minY: number; cz: number } => {
    let minX = p[0]!, maxX = p[0]!, minY = p[1]!, minZ = p[2]!, maxZ = p[2]!
    for (let i = 3; i < p.length; i += 3) {
      if (p[i]! < minX) minX = p[i]!
      if (p[i]! > maxX) maxX = p[i]!
      if (p[i + 1]! < minY) minY = p[i + 1]!
      if (p[i + 2]! < minZ) minZ = p[i + 2]!
      if (p[i + 2]! > maxZ) maxZ = p[i + 2]!
    }
    return { minX, maxX, minY, cz: (minZ + maxZ) / 2 }
  }

  const b = bounds(base.positions)
  const e = bounds(extra.positions)
  const dx = b.maxX + gapMm - e.minX   // extra's left edge sits gap right of base
  const dy = -e.minY                    // extra lands on the bed
  const dz = b.cz - e.cz                // Z centres aligned

  const nBaseVerts = base.positions.length / 3
  const positions = new Float32Array(base.positions.length + extra.positions.length)
  positions.set(base.positions, 0)
  for (let i = 0; i < extra.positions.length; i += 3) {
    positions[base.positions.length + i]     = extra.positions[i]!     + dx
    positions[base.positions.length + i + 1] = extra.positions[i + 1]! + dy
    positions[base.positions.length + i + 2] = extra.positions[i + 2]! + dz
  }

  const indices = new Uint32Array(base.indices.length + extra.indices.length)
  indices.set(base.indices, 0)
  for (let i = 0; i < extra.indices.length; i++) {
    indices[base.indices.length + i] = extra.indices[i]! + nBaseVerts
  }

  let vertexColors: Float32Array | undefined
  if (base.vertexColors?.length || extra.vertexColors?.length) {
    vertexColors = new Float32Array(positions.length)
    const fill = (dst: number, src: Float32Array | undefined, len: number): void => {
      if (src && src.length === len) {
        vertexColors!.set(src, dst)
      } else {
        for (let i = 0; i < len; i += 3) {
          vertexColors![dst + i] = 0.78; vertexColors![dst + i + 1] = 0.78; vertexColors![dst + i + 2] = 0.80
        }
      }
    }
    fill(0, base.vertexColors, base.positions.length)
    fill(base.positions.length, extra.vertexColors, extra.positions.length)
  }

  return {
    positions,
    indices,
    ...(vertexColors ? { vertexColors } : {}),
    ...(base.packageMeta ? { packageMeta: base.packageMeta } : {}),
  }
}

/**
 * Score an orientation for print quality.  Lower = better.
 *
 * The key insight: a large flat base sitting ON the bed has many triangles
 * with downward normals at Y_min — those are NOT overhangs; the bed supports them.
 * We therefore split downward-facing triangles into two buckets:
 *   • bed-contact (centroid ≤ Y_min + bedZone) → reward these (subtract from score)
 *   • true overhangs (centroid above bedZone)   → penalise these (add to score)
 *
 * Result: a flat-base-down orientation wins because the huge flat base becomes a
 * large bonus instead of a large penalty.
 */
export function computeOverhangScore(mesh: TriangleMesh): number {
  const p = mesh.positions
  const ix = mesh.indices
  // Find Y extents to set the bed-contact zone height.
  let minY = Infinity, maxY = -Infinity
  for (let i = 1; i < p.length; i += 3) {
    const y = p[i]!
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const height = maxY - minY
  // Anything whose centroid is within this distance of Y_min is "on the bed".
  // 1 % of height, clamped to [0.5 mm, 5 mm].
  const bedZone = Math.max(0.5, Math.min(5, height * 0.01))

  let overhangs = 0   // penalised
  let bedContact = 0  // rewarded
  for (let i = 0; i < ix.length; i += 3) {
    const i0 = ix[i]! * 3, i1 = ix[i + 1]! * 3, i2 = ix[i + 2]! * 3
    const ax = p[i1]! - p[i0]!,   ay = p[i1 + 1]! - p[i0 + 1]!, az = p[i1 + 2]! - p[i0 + 2]!
    const bx = p[i2]! - p[i0]!,   by = p[i2 + 1]! - p[i0 + 1]!, bz = p[i2 + 2]! - p[i0 + 2]!
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (len < 1e-10) continue
    if (-ny / len > 0.707) {
      const cy = (p[i0 + 1]! + p[i1 + 1]! + p[i2 + 1]!) / 3
      if (cy <= minY + bedZone) bedContact++
      else                      overhangs++
    }
  }
  // Small weight on bedContact so it acts as a tiebreaker without swamping overhangs.
  return overhangs - bedContact * 0.5
}

/** Try 6 canonical face-down orientations; return the one with the fewest overhang triangles. */
export function autoOrientMesh(mesh: TriangleMesh): { mesh: TriangleMesh; bestIdx: number } {
  const rx = rotateMeshQuarterTurnAroundX
  const rz = rotateMeshQuarterTurnAroundZ
  const candidates: TriangleMesh[] = [
    mesh,
    rx(mesh),
    rx(rx(mesh)),
    rx(rx(rx(mesh))),
    rz(mesh),
    rz(rz(rz(mesh))),
  ]
  const scores = candidates.map(computeOverhangScore)
  const best = scores.indexOf(Math.min(...scores))
  return { mesh: candidates[best]!, bestIdx: best }
}
