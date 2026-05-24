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
