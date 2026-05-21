import * as THREE from 'three'
import type { TriangleMesh } from './types'

export type MeshToGeometryOpts = {
  /** When false, skip vertex colors so a uniform material tint applies. */
  useVertexColors?: boolean
}

export function triangleMeshToGeometry(
  data: TriangleMesh,
  opts?: MeshToGeometryOpts
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(data.positions.slice(), 3))
  geo.setIndex(new THREE.BufferAttribute(data.indices.slice(), 1))

  const vc = data.vertexColors
  const allowVc = opts?.useVertexColors !== false
  if (allowVc && vc && vc.length === data.positions.length) {
    geo.setAttribute('color', new THREE.BufferAttribute(vc.slice(), 3))
  }

  geo.computeVertexNormals()
  return geo
}
