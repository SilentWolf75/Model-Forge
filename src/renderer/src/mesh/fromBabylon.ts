import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { TriangleMesh } from './types'

export function meshToTriangleMesh(mesh: Mesh): TriangleMesh | null {
  const geometry = mesh.geometry
  if (!geometry) return null
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind, true)
  if (!pos) return null
  let idx = mesh.getIndices()
  if (!idx) {
    const vc = pos.length / 3
    const indices = new Uint32Array(vc)
    for (let i = 0; i < vc; i++) indices[i] = i
    idx = indices
  } else if (!(idx instanceof Uint32Array)) {
    idx = Uint32Array.from(idx)
  }
  return {
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx)
  }
}

export function sceneMeshesToParts(meshes: Mesh[]): TriangleMesh[] {
  const out: TriangleMesh[] = []
  for (const m of meshes) {
    if (!m.isVisible || m.getTotalVertices() === 0) continue
    const g = meshToTriangleMesh(m)
    if (g && g.indices.length > 0) out.push(g)
  }
  return out
}
