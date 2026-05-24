import type { TriangleMesh } from '../mesh/types'

/** Linear [0,1] → sRGB [0,1]. OBJ/MeshLab vertex colours expect sRGB. */
function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c * 12.92
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

function clamp01(c: number): number {
  return Math.max(0, Math.min(1, c))
}

/**
 * Wavefront OBJ from `TriangleMesh`.
 * When `mesh.vertexColors` is present the de-facto `v x y z r g b` extension is
 * used (linear→sRGB conversion applied). This is understood by MeshLab, Blender
 * (with "Vertex Colour" import option on), CloudCompare, and most other tools.
 */
export function encodeObj(mesh: TriangleMesh, objectName = 'mesh'): string {
  const lines: string[] = [`# ModelForge export`, `o ${objectName}`]
  const p  = mesh.positions
  const vc = mesh.vertexColors
  const vCount = p.length / 3

  for (let i = 0; i < vCount; i++) {
    const o = i * 3
    if (vc && vc.length >= o + 3) {
      const r = clamp01(linearToSrgb(vc[o]!)).toFixed(6)
      const g = clamp01(linearToSrgb(vc[o + 1]!)).toFixed(6)
      const b = clamp01(linearToSrgb(vc[o + 2]!)).toFixed(6)
      lines.push(`v ${p[o]} ${p[o + 1]} ${p[o + 2]} ${r} ${g} ${b}`)
    } else {
      lines.push(`v ${p[o]} ${p[o + 1]} ${p[o + 2]}`)
    }
  }

  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]! + 1
    const b = mesh.indices[t + 1]! + 1
    const c = mesh.indices[t + 2]! + 1
    lines.push(`f ${a} ${b} ${c}`)
  }
  return lines.join('\n') + '\n'
}
