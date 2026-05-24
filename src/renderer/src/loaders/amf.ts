/**
 * AMF (Additive Manufacturing Format) loader — returns a TriangleMesh.
 * Uses three-stdlib's AMFLoader, then flattens the resulting scene graph.
 * AMF coordinates are in mm (same as our viewer) so no unit conversion is needed.
 */
import * as THREE from 'three'
import { AMFLoader } from 'three-stdlib'
import type { TriangleMesh } from '../mesh/types'

// ─── Scene → TriangleMesh (shared logic, mirrors gltf.ts) ────────────────────

function amfSceneToTriangleMesh(root: THREE.Object3D): TriangleMesh {
  root.updateMatrixWorld(true)

  const posArrays:   Float32Array[] = []
  const idxArrays:   Uint32Array[]  = []
  const colArrays:   Float32Array[] = []
  let   hasColors    = false
  let   vertexOffset = 0

  const tmpV = new THREE.Vector3()

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const geo = obj.geometry as THREE.BufferGeometry

    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!posAttr || posAttr.count === 0) return

    const nVerts = posAttr.count
    const mat    = obj.matrixWorld

    const worldPos = new Float32Array(nVerts * 3)
    for (let i = 0; i < nVerts; i++) {
      tmpV.fromBufferAttribute(posAttr, i).applyMatrix4(mat)
      worldPos[i * 3]     = tmpV.x
      worldPos[i * 3 + 1] = tmpV.y
      worldPos[i * 3 + 2] = tmpV.z
    }
    posArrays.push(worldPos)

    const idxAttr = geo.index
    if (idxAttr) {
      const n    = idxAttr.count
      const idxs = new Uint32Array(n)
      for (let i = 0; i < n; i++) idxs[i] = idxAttr.getX(i) + vertexOffset
      idxArrays.push(idxs)
    } else {
      const idxs = new Uint32Array(nVerts)
      for (let i = 0; i < nVerts; i++) idxs[i] = i + vertexOffset
      idxArrays.push(idxs)
    }

    // AMFLoader may supply vertex colours via a color attribute
    const colAttr = geo.getAttribute('color') as THREE.BufferAttribute | undefined
    if (colAttr && colAttr.count === nVerts) {
      hasColors = true
      const cols = new Float32Array(nVerts * 3)
      for (let i = 0; i < nVerts; i++) {
        cols[i * 3]     = colAttr.getX(i)
        cols[i * 3 + 1] = colAttr.getY(i)
        cols[i * 3 + 2] = colAttr.getZ(i)
      }
      colArrays.push(cols)
    } else {
      // Flat material colour fallback
      let r = 0.52, g = 0.78, b = 1.0
      const m3 = Array.isArray(obj.material) ? obj.material[0] : obj.material
      if (m3 instanceof THREE.MeshStandardMaterial && m3.color) {
        r = m3.color.r; g = m3.color.g; b = m3.color.b
      }
      const cols = new Float32Array(nVerts * 3)
      for (let i = 0; i < nVerts; i++) {
        cols[i * 3] = r; cols[i * 3 + 1] = g; cols[i * 3 + 2] = b
      }
      colArrays.push(cols)
    }

    vertexOffset += nVerts
  })

  if (posArrays.length === 0) {
    return { positions: new Float32Array(0), indices: new Uint32Array(0) }
  }

  const totalVerts = posArrays.reduce((s, a) => s + a.length / 3, 0)
  const totalIdxs  = idxArrays.reduce((s, a) => s + a.length, 0)

  const positions    = new Float32Array(totalVerts * 3)
  const indices      = new Uint32Array(totalIdxs)
  const vertexColors = hasColors ? new Float32Array(totalVerts * 3) : undefined

  let vOff = 0, iOff = 0
  for (let k = 0; k < posArrays.length; k++) {
    positions.set(posArrays[k]!, vOff)
    if (vertexColors) vertexColors.set(colArrays[k]!, vOff)
    vOff += posArrays[k]!.length
    indices.set(idxArrays[k]!, iOff)
    iOff += idxArrays[k]!.length
  }

  return { positions, indices, ...(vertexColors ? { vertexColors } : {}) }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function loadAmf(data: Uint8Array): TriangleMesh {
  const loader = new AMFLoader()
  // AMFLoader.parse is synchronous and returns a THREE.Group
  // AMFLoader.parse expects a plain ArrayBuffer — copy to ensure it is never a SharedArrayBuffer
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  const result = loader.parse(copy.buffer as ArrayBuffer) as THREE.Object3D
  return amfSceneToTriangleMesh(result)
}
