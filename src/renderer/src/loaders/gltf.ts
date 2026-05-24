/**
 * GLB / GLTF loader — returns a flat TriangleMesh from all meshes in the scene.
 * Uses three-stdlib's GLTFLoader (same underlying three.js implementation).
 * Coordinate system: GLTF is Y-up (matches Three.js / viewer) — no remapping needed.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three-stdlib'
import type { TriangleMesh } from '../mesh/types'

// ─── GLTF parse wrapper ───────────────────────────────────────────────────────

function parseGltfScene(buffer: ArrayBuffer): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader()
    loader.parse(
      buffer,
      '',
      (gltf) => resolve(gltf.scene),
      (err) => reject(new Error(String(err)))
    )
  })
}

// ─── Scene → TriangleMesh ─────────────────────────────────────────────────────

/**
 * Traverses every THREE.Mesh in `scene`, applies the world transform to positions,
 * and merges all geometry into a single TriangleMesh.
 * Vertex colors (attribute "color") are preserved when present on any mesh.
 */
function sceneToTriangleMesh(scene: THREE.Group): TriangleMesh {
  scene.updateMatrixWorld(true)

  const posArrays:   Float32Array[] = []
  const idxArrays:   Uint32Array[]  = []
  const colArrays:   Float32Array[] = []   // parallel to posArrays (zero-filled when no color)
  let   hasColors    = false
  let   vertexOffset = 0

  const tmpV = new THREE.Vector3()

  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const geo = obj.geometry as THREE.BufferGeometry

    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!posAttr || posAttr.count === 0) return

    const nVerts = posAttr.count
    const mat    = obj.matrixWorld

    // Transform positions into world space
    const worldPos = new Float32Array(nVerts * 3)
    for (let i = 0; i < nVerts; i++) {
      tmpV.fromBufferAttribute(posAttr, i).applyMatrix4(mat)
      worldPos[i * 3]     = tmpV.x
      worldPos[i * 3 + 1] = tmpV.y
      worldPos[i * 3 + 2] = tmpV.z
    }
    posArrays.push(worldPos)

    // Indices (indexed or synthesised for non-indexed geometry)
    const idxAttr = geo.index
    if (idxAttr) {
      const n    = idxAttr.count
      const idxs = new Uint32Array(n)
      for (let i = 0; i < n; i++) idxs[i] = idxAttr.getX(i) + vertexOffset
      idxArrays.push(idxs)
    } else {
      // Non-indexed: each trio of vertices is a triangle
      const idxs = new Uint32Array(nVerts)
      for (let i = 0; i < nVerts; i++) idxs[i] = i + vertexOffset
      idxArrays.push(idxs)
    }

    // Vertex colours — GLTF stores them as LINEAR in [0,1] with possible RGBA
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
      // Material base colour as a flat fill (fallback for untextured meshes)
      let r = 0.52, g = 0.78, b = 1.0
      const mat3 = obj.material
      if (!Array.isArray(mat3) && mat3 instanceof THREE.MeshStandardMaterial && mat3.color) {
        r = mat3.color.r; g = mat3.color.g; b = mat3.color.b
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

  // Merge
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

export async function loadGlb(data: Uint8Array): Promise<TriangleMesh> {
  // GLTFLoader.parse needs a plain ArrayBuffer — copy to ensure it is never a SharedArrayBuffer
  const copy  = new Uint8Array(data.byteLength)
  copy.set(data)
  const buf   = copy.buffer as ArrayBuffer
  const scene = await parseGltfScene(buf)
  return sceneToTriangleMesh(scene)
}
