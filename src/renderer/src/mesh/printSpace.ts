import type { TriangleMesh } from './types'

export function scalePositions(mesh: TriangleMesh, factor: number): TriangleMesh {
  if (factor === 1) {
    return {
      positions: new Float32Array(mesh.positions),
      indices: new Uint32Array(mesh.indices)
    }
  }
  const p = mesh.positions
  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i++) {
    out[i] = p[i] * factor
  }
  return { positions: out, indices: new Uint32Array(mesh.indices) }
}

/** 3MF `model@unit` values → millimeters */
export function threeMfUnitToMmScale(unit: string | undefined): number {
  const u = (unit ?? 'millimeter').toLowerCase().replace(/\s+/g, '')
  switch (u) {
    case 'micron':
    case 'micrometer':
      return 0.001
    case 'millimeter':
      return 1
    case 'centimeter':
      return 10
    case 'meter':
      return 1000
    case 'inch':
    case 'inches':
      return 25.4
    case 'foot':
    case 'feet':
      return 304.8
    default:
      return 1
  }
}
