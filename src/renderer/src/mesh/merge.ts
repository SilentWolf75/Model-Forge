import type { TriangleMesh } from './types'

export function mergeMeshes(parts: TriangleMesh[]): TriangleMesh {
  if (parts.length === 0) {
    return { positions: new Float32Array(0), indices: new Uint32Array(0) }
  }
  if (parts.length === 1) {
    const p = parts[0]
    return {
      positions: new Float32Array(p.positions),
      indices: new Uint32Array(p.indices)
    }
  }
  let vCount = 0
  let tCount = 0
  for (const p of parts) {
    vCount += p.positions.length / 3
    tCount += p.indices.length / 3
  }
  const positions = new Float32Array(vCount * 3)
  const indices = new Uint32Array(tCount * 3)
  let vo = 0
  let io = 0
  let base = 0
  for (const p of parts) {
    const n = p.positions.length / 3
    positions.set(p.positions, vo)
    for (let i = 0; i < p.indices.length; i++) {
      indices[io + i] = p.indices[i] + base
    }
    vo += p.positions.length
    io += p.indices.length
    base += n
  }
  return { positions, indices }
}
