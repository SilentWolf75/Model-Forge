/**
 * PLY loader — supports binary and ASCII PLY with optional vertex colours.
 * PLY RGB values are typically in sRGB [0-255] or [0-1]; both are converted
 * to linear [0-1] for consistency with the rest of the pipeline.
 */
import { PLYLoader } from 'three-stdlib'
import type { TriangleMesh } from '../mesh/types'

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function loadPly(data: Uint8Array): TriangleMesh {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  const loader = new PLYLoader()
  const geo = loader.parse(copy.buffer as ArrayBuffer)

  const posAttr = geo.getAttribute('position')
  if (!posAttr || posAttr.count === 0) {
    return { positions: new Float32Array(0), indices: new Uint32Array(0) }
  }

  const nVerts    = posAttr.count
  const positions = new Float32Array(nVerts * 3)
  for (let i = 0; i < nVerts; i++) {
    positions[i * 3]     = posAttr.getX(i)
    positions[i * 3 + 1] = posAttr.getY(i)
    positions[i * 3 + 2] = posAttr.getZ(i)
  }

  let indices: Uint32Array
  if (geo.index) {
    const n = geo.index.count
    indices  = new Uint32Array(n)
    for (let i = 0; i < n; i++) indices[i] = geo.index.getX(i)
  } else {
    // Non-indexed — every three vertices is a triangle
    indices = new Uint32Array(nVerts)
    for (let i = 0; i < nVerts; i++) indices[i] = i
  }

  // Vertex colours: PLYLoader normalises uint8 to [0,1] but keeps display-sRGB encoding.
  const colAttr = geo.getAttribute('color')
  let vertexColors: Float32Array | undefined
  if (colAttr && colAttr.count === nVerts) {
    vertexColors = new Float32Array(nVerts * 3)
    for (let i = 0; i < nVerts; i++) {
      vertexColors[i * 3]     = srgbToLinear(colAttr.getX(i))
      vertexColors[i * 3 + 1] = srgbToLinear(colAttr.getY(i))
      vertexColors[i * 3 + 2] = srgbToLinear(colAttr.getZ(i))
    }
  }

  return { positions, indices, ...(vertexColors ? { vertexColors } : {}) }
}
