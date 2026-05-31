import type { TriangleMesh } from './types'

function bboxCenter(p: Float32Array): { cx: number; cy: number; cz: number } {
  let minX = p[0]
  let minY = p[1]
  let minZ = p[2]
  let maxX = p[0]
  let maxY = p[1]
  let maxZ = p[2]
  for (let i = 3; i < p.length; i += 3) {
    const x = p[i]
    const y = p[i + 1]
    const z = p[i + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  return {
    cx: (minX + maxX) * 0.5,
    cy: (minY + maxY) * 0.5,
    cz: (minZ + maxZ) * 0.5
  }
}

function cloneLike(mesh: TriangleMesh, positions: Float32Array): TriangleMesh {
  return {
    positions,
    indices: new Uint32Array(mesh.indices),
    ...(mesh.vertexColors ? { vertexColors: new Float32Array(mesh.vertexColors) } : {}),
    ...(mesh.packageMeta ? { packageMeta: mesh.packageMeta } : {})
  }
}

/** Mirror (reflect) the mesh through the bbox-centre plane perpendicular to `axis`.
 *  Triangle winding is reversed so face normals stay outward-facing after the flip. */
export function mirrorMesh(mesh: TriangleMesh, axis: 'x' | 'y' | 'z'): TriangleMesh {
  const p = mesh.positions
  const { cx, cy, cz } = p.length >= 3 ? bboxCenter(p) : { cx: 0, cy: 0, cz: 0 }
  const positions = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    positions[i]     = axis === 'x' ? 2 * cx - p[i]!     : p[i]!
    positions[i + 1] = axis === 'y' ? 2 * cy - p[i + 1]! : p[i + 1]!
    positions[i + 2] = axis === 'z' ? 2 * cz - p[i + 2]! : p[i + 2]!
  }
  // Swap vertex 1 & 2 of every triangle to reverse winding
  const indices = new Uint32Array(mesh.indices)
  for (let i = 0; i < indices.length; i += 3) {
    const tmp = indices[i + 1]!; indices[i + 1] = indices[i + 2]!; indices[i + 2] = tmp
  }
  const base: TriangleMesh = {
    positions, indices,
    ...(mesh.vertexColors ? { vertexColors: new Float32Array(mesh.vertexColors) } : {}),
    ...(mesh.packageMeta  ? { packageMeta:  mesh.packageMeta  } : {}),
  }
  if (!mesh.plateParts?.length) return base
  return { ...base, plateParts: mesh.plateParts.map((pp) => ({ ...pp, mesh: mirrorMesh(pp.mesh, axis) })) }
}

/** Translate the mesh so its XZ bounding-box centre sits at (0, 0) — bed centre. */
export function centerMeshOnBed(mesh: TriangleMesh): TriangleMesh {
  const p = mesh.positions
  const { cx, cz } = p.length >= 3 ? bboxCenter(p) : { cx: 0, cy: 0, cz: 0 }
  if (Math.abs(cx) < 0.001 && Math.abs(cz) < 0.001) return mesh
  const positions = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    positions[i]     = p[i]!     - cx
    positions[i + 1] = p[i + 1]!
    positions[i + 2] = p[i + 2]! - cz
  }
  const base: TriangleMesh = {
    positions,
    indices: new Uint32Array(mesh.indices),
    ...(mesh.vertexColors ? { vertexColors: new Float32Array(mesh.vertexColors) } : {}),
    ...(mesh.packageMeta  ? { packageMeta:  mesh.packageMeta  } : {}),
  }
  if (!mesh.plateParts?.length) return base
  return { ...base, plateParts: mesh.plateParts.map((pp) => ({ ...pp, mesh: centerMeshOnBed(pp.mesh) })) }
}

/** +90° right-handed rotation about world Y through the mesh bounding-box center. */
export function rotateMeshQuarterTurnAroundY(mesh: TriangleMesh): TriangleMesh {
  const p = mesh.positions
  if (p.length < 3) {
    const base = cloneLike(mesh, new Float32Array(p))
    if (!mesh.plateParts?.length) return base
    return {
      ...base,
      plateParts: mesh.plateParts.map((pp) => ({
        ...pp,
        mesh: rotateMeshQuarterTurnAroundY(pp.mesh)
      }))
    }
  }
  const { cx, cy, cz } = bboxCenter(p)

  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] - cx
    const y = p[i + 1] - cy
    const z = p[i + 2] - cz
    // θ = π/2 about +Y: x' = z, z' = -x
    out[i] = z + cx
    out[i + 1] = y + cy
    out[i + 2] = -x + cz
  }
  const rotated = cloneLike(mesh, out)
  if (!mesh.plateParts?.length) return rotated
  return {
    ...rotated,
    plateParts: mesh.plateParts.map((pp) => ({
      ...pp,
      mesh: rotateMeshQuarterTurnAroundY(pp.mesh)
    }))
  }
}

/** +90° right-handed rotation about world X through the mesh bounding-box center. */
export function rotateMeshQuarterTurnAroundX(mesh: TriangleMesh): TriangleMesh {
  const p = mesh.positions
  if (p.length < 3) {
    const base = cloneLike(mesh, new Float32Array(p))
    if (!mesh.plateParts?.length) return base
    return {
      ...base,
      plateParts: mesh.plateParts.map((pp) => ({
        ...pp,
        mesh: rotateMeshQuarterTurnAroundX(pp.mesh)
      }))
    }
  }
  const { cx, cy, cz } = bboxCenter(p)
  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] - cx
    const y = p[i + 1] - cy
    const z = p[i + 2] - cz
    // θ = π/2 about +X: y' = z, z' = -y
    out[i] = x + cx
    out[i + 1] = z + cy
    out[i + 2] = -y + cz
  }
  const rotated = cloneLike(mesh, out)
  if (!mesh.plateParts?.length) return rotated
  return {
    ...rotated,
    plateParts: mesh.plateParts.map((pp) => ({
      ...pp,
      mesh: rotateMeshQuarterTurnAroundX(pp.mesh)
    }))
  }
}

/** +90° right-handed rotation about world Z through the mesh bounding-box center. */
export function rotateMeshQuarterTurnAroundZ(mesh: TriangleMesh): TriangleMesh {
  const p = mesh.positions
  if (p.length < 3) {
    const base = cloneLike(mesh, new Float32Array(p))
    if (!mesh.plateParts?.length) return base
    return {
      ...base,
      plateParts: mesh.plateParts.map((pp) => ({
        ...pp,
        mesh: rotateMeshQuarterTurnAroundZ(pp.mesh)
      }))
    }
  }
  const { cx, cy, cz } = bboxCenter(p)
  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] - cx
    const y = p[i + 1] - cy
    const z = p[i + 2] - cz
    // θ = π/2 about +Z: x' = -y, y' = x
    out[i] = -y + cx
    out[i + 1] = x + cy
    out[i + 2] = z + cz
  }
  const rotated = cloneLike(mesh, out)
  if (!mesh.plateParts?.length) return rotated
  return {
    ...rotated,
    plateParts: mesh.plateParts.map((pp) => ({
      ...pp,
      mesh: rotateMeshQuarterTurnAroundZ(pp.mesh)
    }))
  }
}
