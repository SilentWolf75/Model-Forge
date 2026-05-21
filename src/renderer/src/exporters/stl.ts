import type { TriangleMesh } from '../mesh/types'

function triangleNormal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: { x: number; y: number; z: number }
): void {
  const ux = bx - ax
  const uy = by - ay
  const uz = bz - az
  const vx = cx - ax
  const vy = cy - ay
  const vz = cz - az
  let nx = uy * vz - uz * vy
  let ny = uz * vx - ux * vz
  let nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  nx /= len
  ny /= len
  nz /= len
  out.x = nx
  out.y = ny
  out.z = nz
}

/**
 * Binary STL (little-endian).
 * Uses the in-memory `TriangleMesh` only — Babylon viewer-only tweaks (e.g. thin-part Y scale on the GPU mesh) are never applied here.
 */
export function encodeBinaryStl(mesh: TriangleMesh, header = 'ModelForge'): Uint8Array {
  const n = mesh.indices.length / 3
  const buf = new ArrayBuffer(84 + n * 50)
  const dv = new DataView(buf)
  const enc = new TextEncoder()
  const hdr = enc.encode(header.padEnd(80, ' ').slice(0, 80))
  for (let i = 0; i < 80; i++) dv.setUint8(i, hdr[i] ?? 32)
  dv.setUint32(80, n, true)
  const nrm = { x: 0, y: 0, z: 1 }
  let o = 84
  const p = mesh.positions
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const i0 = mesh.indices[t] * 3
    const i1 = mesh.indices[t + 1] * 3
    const i2 = mesh.indices[t + 2] * 3
    triangleNormal(
      p[i0],
      p[i0 + 1],
      p[i0 + 2],
      p[i1],
      p[i1 + 1],
      p[i1 + 2],
      p[i2],
      p[i2 + 1],
      p[i2 + 2],
      nrm
    )
    dv.setFloat32(o, nrm.x, true)
    dv.setFloat32(o + 4, nrm.y, true)
    dv.setFloat32(o + 8, nrm.z, true)
    for (let k = 0; k < 3; k++) {
      const j = mesh.indices[t + k] * 3
      dv.setFloat32(o + 12 + k * 12, p[j], true)
      dv.setFloat32(o + 16 + k * 12, p[j + 1], true)
      dv.setFloat32(o + 20 + k * 12, p[j + 2], true)
    }
    dv.setUint16(o + 48, 0, true)
    o += 50
  }
  return new Uint8Array(buf)
}
