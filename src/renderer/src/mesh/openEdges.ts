import type { TriangleMesh } from './types'

/**
 * Find edges shared by exactly one triangle (open / boundary edges).
 * Uses a numeric key `lo * nVerts + hi` which is safe for meshes with < ~94M vertices.
 *
 * Returns:
 *  - count: total number of open edges (may exceed maxLines)
 *  - linePositions: flat Float32Array [x0,y0,z0, x1,y1,z1, ...], capped at maxLines edges
 */
export function findOpenEdges(
  mesh: TriangleMesh,
  maxLines = 100_000
): { count: number; linePositions: Float32Array } {
  const idx = mesh.indices
  const pos = mesh.positions
  const nVerts = pos.length / 3

  type EdgeEntry = { v0: number; v1: number; count: number }
  const edgeMap = new Map<number, EdgeEntry>()

  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!
    const b = idx[t + 1]!
    const c = idx[t + 2]!
    const pairs: [number, number][] = [
      [a, b],
      [b, c],
      [c, a]
    ]
    for (const [p, q] of pairs) {
      const lo = p < q ? p : q
      const hi = p < q ? q : p
      const key = lo * nVerts + hi
      const e = edgeMap.get(key)
      if (e) {
        e.count++
      } else {
        edgeMap.set(key, { v0: lo, v1: hi, count: 1 })
      }
    }
  }

  let count = 0
  const linePos: number[] = []

  for (const { v0, v1, count: c } of edgeMap.values()) {
    if (c === 1) {
      count++
      if (linePos.length / 6 < maxLines) {
        const b0 = v0 * 3
        const b1 = v1 * 3
        linePos.push(pos[b0]!, pos[b0 + 1]!, pos[b0 + 2]!, pos[b1]!, pos[b1 + 1]!, pos[b1 + 2]!)
      }
    }
  }

  return { count, linePositions: new Float32Array(linePos) }
}

/** Quick count only — cheaper than findOpenEdges when you don't need the positions. */
export function countOpenEdges(mesh: TriangleMesh): number {
  const idx = mesh.indices
  const nVerts = mesh.positions.length / 3
  const edgeCounts = new Map<number, number>()

  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!
    const b = idx[t + 1]!
    const c = idx[t + 2]!
    const pairs: [number, number][] = [
      [a, b],
      [b, c],
      [c, a]
    ]
    for (const [p, q] of pairs) {
      const lo = p < q ? p : q
      const hi = p < q ? q : p
      const key = lo * nVerts + hi
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1)
    }
  }

  let count = 0
  for (const c of edgeCounts.values()) {
    if (c === 1) count++
  }
  return count
}
