import type { TriangleMesh, TriangleMeshPlatePart } from '../mesh/types'

export interface RepairReport {
  removedDegenerate: number
  verticesBefore: number
  verticesAfter: number
  triangleCount: number
}

function area2(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number
): number {
  const ux = bx - ax
  const uy = by - ay
  const uz = bz - az
  const vx = cx - ax
  const vy = cy - ay
  const vz = cz - az
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  return Math.hypot(nx, ny, nz)
}

function quantize(v: number, eps: number): number {
  return Math.round(v / eps) * eps
}

function mergeTwoTriangleMeshesForRepair(a: TriangleMesh, b: TriangleMesh): TriangleMesh {
  const av = a.positions.length / 3
  const positions = new Float32Array(a.positions.length + b.positions.length)
  positions.set(a.positions, 0)
  positions.set(b.positions, a.positions.length)
  const indices = new Uint32Array(a.indices.length + b.indices.length)
  indices.set(a.indices, 0)
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i]! + av
  }
  const aC = a.vertexColors
  const bC = b.vertexColors
  if (!aC && !bC) {
    return { positions, indices }
  }
  const neutral: [number, number, number] = [0.78, 0.82, 0.91]
  const fillNeutral = (vertCount: number): Float32Array => {
    const o = new Float32Array(vertCount * 3)
    for (let j = 0; j < vertCount * 3; j += 3) {
      o[j] = neutral[0]
      o[j + 1] = neutral[1]
      o[j + 2] = neutral[2]
    }
    return o
  }
  const ac = aC ?? fillNeutral(av)
  const bc = bC ?? fillNeutral(b.positions.length / 3)
  const vertexColors = new Float32Array(ac.length + bc.length)
  vertexColors.set(ac, 0)
  vertexColors.set(bc, ac.length)
  return { positions, indices, vertexColors }
}

function mergeTriangleMeshListForRepair(parts: TriangleMesh[]): TriangleMesh {
  if (parts.length === 0) return { positions: new Float32Array(0), indices: new Uint32Array(0) }
  if (parts.length === 1) return parts[0]!
  let acc = parts[0]!
  for (let i = 1; i < parts.length; i++) {
    acc = mergeTwoTriangleMeshesForRepair(acc, parts[i]!)
  }
  return acc
}

/** Welds coincident vertices and drops degenerate triangles (quick print-oriented cleanup). */
export function repairMesh(mesh: TriangleMesh, eps = 1e-4): { mesh: TriangleMesh; report: RepairReport } {
  if (mesh.plateParts && mesh.plateParts.length > 1) {
    const repairedParts: TriangleMeshPlatePart[] = []
    let removedDegenerate = 0
    let verticesBefore = 0
    let verticesAfter = 0
    let triangleCount = 0
    for (const pp of mesh.plateParts) {
      const vb = pp.mesh.positions.length / 3
      verticesBefore += vb
      const { mesh: sub, report } = repairMesh(pp.mesh, eps)
      removedDegenerate += report.removedDegenerate
      verticesAfter += sub.positions.length / 3
      triangleCount += sub.indices.length / 3
      repairedParts.push({ ...pp, mesh: sub })
    }
    const merged = mergeTriangleMeshListForRepair(repairedParts.map((p) => p.mesh))
    const out: TriangleMesh = {
      ...merged,
      plateParts: repairedParts,
      ...(mesh.packageMeta ? { packageMeta: mesh.packageMeta } : {})
    }
    return {
      mesh: out,
      report: {
        removedDegenerate,
        verticesBefore,
        verticesAfter,
        triangleCount
      }
    }
  }

  const p = mesh.positions
  const ix = mesh.indices
  const keyToNew = new Map<string, number>()
  const newPos: number[] = []

  const mapVertex = (vi: number): number => {
    const o = vi * 3
    const x = quantize(p[o], eps)
    const y = quantize(p[o + 1], eps)
    const z = quantize(p[o + 2], eps)
    const k = `${x},${y},${z}`
    const ex = keyToNew.get(k)
    if (ex !== undefined) return ex
    const id = newPos.length / 3
    keyToNew.set(k, id)
    newPos.push(p[o], p[o + 1], p[o + 2])
    return id
  }

  const outIdx: number[] = []
  let removedDegenerate = 0
  for (let t = 0; t < ix.length; t += 3) {
    const i0 = mapVertex(ix[t])
    const i1 = mapVertex(ix[t + 1])
    const i2 = mapVertex(ix[t + 2])
    if (i0 === i1 || i1 === i2 || i0 === i2) {
      removedDegenerate++
      continue
    }
    const o0 = i0 * 3
    const o1 = i1 * 3
    const o2 = i2 * 3
    const a = area2(
      newPos[o0],
      newPos[o0 + 1],
      newPos[o0 + 2],
      newPos[o1],
      newPos[o1 + 1],
      newPos[o1 + 2],
      newPos[o2],
      newPos[o2 + 1],
      newPos[o2 + 2]
    )
    if (a < eps * eps) {
      removedDegenerate++
      continue
    }
    outIdx.push(i0, i1, i2)
  }

  const vb = p.length / 3
  const va = newPos.length / 3
  const out: TriangleMesh = {
    positions: new Float32Array(newPos),
    indices: new Uint32Array(outIdx),
    ...(mesh.packageMeta ? { packageMeta: mesh.packageMeta } : {})
  }
  return {
    mesh: out,
    report: {
      removedDegenerate,
      verticesBefore: vb,
      verticesAfter: va,
      triangleCount: out.indices.length / 3
    }
  }
}
