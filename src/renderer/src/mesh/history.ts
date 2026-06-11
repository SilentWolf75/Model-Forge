import type { TriangleMesh } from './types'
import {
  rotateMeshQuarterTurnAroundX,
  rotateMeshQuarterTurnAroundY,
  rotateMeshQuarterTurnAroundZ,
  mirrorMesh,
} from './rotateAroundY'
import { translateMesh, scaleMesh } from './transform'

/**
 * An invertible mesh operation.  The undo stack stores these descriptors
 * instead of full mesh clones, so undo memory is O(1) per step rather than
 * O(triangles) — a 1M-triangle model no longer pins ~36 MB per history entry.
 *
 * Non-invertible operations (repair, add-model) fall back to snapshot entries
 * at the App level; everything else goes through here.
 */
export type MeshOp =
  | { kind: 'rotateX' | 'rotateY' | 'rotateZ'; quarterTurns: 1 | 2 | 3 }
  | { kind: 'mirror'; axis: 'x' | 'y' | 'z' }
  | { kind: 'translate'; dx: number; dy: number; dz: number }
  | { kind: 'scale'; factor: number }
  | { kind: 'composite'; ops: MeshOp[] }

const ROTATORS = {
  rotateX: rotateMeshQuarterTurnAroundX,
  rotateY: rotateMeshQuarterTurnAroundY,
  rotateZ: rotateMeshQuarterTurnAroundZ,
} as const

/** Apply an operation descriptor to a mesh, returning the transformed mesh. */
export function applyMeshTransformOp(mesh: TriangleMesh, op: MeshOp): TriangleMesh {
  switch (op.kind) {
    case 'rotateX':
    case 'rotateY':
    case 'rotateZ': {
      const rotate = ROTATORS[op.kind]
      let m = mesh
      for (let i = 0; i < op.quarterTurns; i++) m = rotate(m)
      return m
    }
    case 'mirror':    return mirrorMesh(mesh, op.axis)
    case 'translate': return translateMesh(mesh, op.dx, op.dy, op.dz)
    case 'scale':     return scaleMesh(mesh, op.factor)
    case 'composite': return op.ops.reduce(applyMeshTransformOp, mesh)
  }
}

/**
 * Return the operation that exactly reverses `op`.
 *
 * 90°-step rotations and mirrors pivot on the bounding-box centre, which these
 * operations preserve, so the inverse rotation/mirror restores the original
 * coordinates bit-for-bit (modulo Float32 rounding).  Scale inversion uses
 * 1/factor and incurs ~1e-7 relative rounding — invisible at mm scale.
 */
export function invertOp(op: MeshOp): MeshOp {
  switch (op.kind) {
    case 'rotateX':
    case 'rotateY':
    case 'rotateZ':
      return { kind: op.kind, quarterTurns: (4 - op.quarterTurns) as 1 | 2 | 3 }
    case 'mirror':
      return op // self-inverse
    case 'translate':
      return { kind: 'translate', dx: -op.dx, dy: -op.dy, dz: -op.dz }
    case 'scale':
      return { kind: 'scale', factor: 1 / op.factor }
    case 'composite':
      return { kind: 'composite', ops: [...op.ops].reverse().map(invertOp) }
  }
}

/** Lowest Y coordinate of any vertex (Infinity for an empty mesh). */
export function meshMinY(mesh: TriangleMesh): number {
  const p = mesh.positions
  let minY = Infinity
  for (let i = 1; i < p.length; i += 3) if (p[i]! < minY) minY = p[i]!
  return minY
}

/** XZ bounding-box centre. */
export function meshCenterXZ(mesh: TriangleMesh): { cx: number; cz: number } {
  const p = mesh.positions
  if (p.length < 3) return { cx: 0, cz: 0 }
  let minX = p[0]!, maxX = p[0]!, minZ = p[2]!, maxZ = p[2]!
  for (let i = 3; i < p.length; i += 3) {
    const x = p[i]!, z = p[i + 2]!
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 }
}
