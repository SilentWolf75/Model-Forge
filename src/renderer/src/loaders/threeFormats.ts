import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import type { TriangleMesh } from '../mesh/types'
import { mergeMeshes } from '../mesh/merge'

function geometryToTriangleMesh(geo: THREE.BufferGeometry): TriangleMesh | null {
  const posAttr = geo.getAttribute('position')
  if (!posAttr) return null
  const positions = new Float32Array(posAttr.array as Float32Array)

  let indices: Uint32Array
  if (geo.index) {
    const src = geo.index.array
    indices = src instanceof Uint32Array ? src.slice() : new Uint32Array(src)
  } else {
    const count = positions.length / 3
    indices = new Uint32Array(count)
    for (let i = 0; i < count; i++) indices[i] = i
  }

  if (indices.length === 0 || positions.length < 9) return null
  return { positions, indices }
}

export function loadStl(buffer: Uint8Array): Promise<TriangleMesh> {
  const loader = new STLLoader()
  const geo = loader.parse(buffer.buffer as ArrayBuffer)
  const mesh = geometryToTriangleMesh(geo)
  geo.dispose()
  if (!mesh) throw new Error('No geometry found in STL file')
  return Promise.resolve(mesh)
}

export function loadObj(buffer: Uint8Array): Promise<TriangleMesh> {
  const text = new TextDecoder('utf-8').decode(buffer)
  const loader = new OBJLoader()
  const group = loader.parse(text)

  const parts: TriangleMesh[] = []
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const geo = child.geometry as THREE.BufferGeometry
    const part = geometryToTriangleMesh(geo)
    if (part) parts.push(part)
    geo.dispose()
  })

  if (parts.length === 0) throw new Error('No geometry found in OBJ file')
  return Promise.resolve(mergeMeshes(parts))
}
