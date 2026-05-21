import type { TriangleMesh } from '../mesh/types'

/** Wavefront OBJ from `TriangleMesh` only (no Babylon-only display scaling). */
export function encodeObj(mesh: TriangleMesh, objectName = 'mesh'): string {
  const lines: string[] = [`# ModelForge export`, `o ${objectName}`]
  const p = mesh.positions
  const vCount = p.length / 3
  for (let i = 0; i < vCount; i++) {
    const o = i * 3
    lines.push(`v ${p[o]} ${p[o + 1]} ${p[o + 2]}`)
  }
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t] + 1
    const b = mesh.indices[t + 1] + 1
    const c = mesh.indices[t + 2] + 1
    lines.push(`f ${a} ${b} ${c}`)
  }
  return lines.join('\n') + '\n'
}
