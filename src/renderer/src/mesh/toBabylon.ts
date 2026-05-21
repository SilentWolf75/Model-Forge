import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Material } from '@babylonjs/core/Materials/material'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import type { Scene } from '@babylonjs/core/scene'
import type { TriangleMesh } from './types'

export type TriangleMeshToBabylonOpts = {
  /** When false, skip baked `vertexColors` so a uniform `material` tint applies (e.g. extruder slot). */
  useVertexColors?: boolean
}

export function triangleMeshToBabylon(
  name: string,
  scene: Scene,
  data: TriangleMesh,
  material: StandardMaterial,
  opts?: TriangleMeshToBabylonOpts
): Mesh {
  const mesh = new Mesh(name, scene)
  const vd = new VertexData()
  vd.positions = Array.from(data.positions)
  vd.indices = Array.from(data.indices)
  vd.normals = []
  VertexData.ComputeNormals(vd.positions, vd.indices, vd.normals)
  const vc = data.vertexColors
  const allowVc = opts?.useVertexColors !== false
  if (allowVc && vc && vc.length === data.positions.length) {
    const n = data.positions.length / 3
    const colors: number[] = new Array(n * 4)
    for (let i = 0; i < n; i++) {
      const o = i * 4
      colors[o] = vc[i * 3]
      colors[o + 1] = vc[i * 3 + 1]
      colors[o + 2] = vc[i * 3 + 2]
      colors[o + 3] = 1
    }
    vd.colors = colors
    mesh.useVertexColors = true
    material.diffuseColor = new Color3(1, 1, 1)
    material.specularColor = new Color3(0.08, 0.08, 0.09)
  } else {
    mesh.useVertexColors = false
  }
  vd.applyToMesh(mesh, true)
  mesh.material = material
  mesh.receiveShadows = true
  return mesh
}

export function createModelMaterial(scene: Scene, color: Color3): StandardMaterial {
  const mat = new StandardMaterial('modelMat', scene)
  mat.diffuseColor = color
  // Exact Orca Slicer values: LIGHT_TOP_SPECULAR = 0.125 * 0.6 = 0.075, shininess = 20
  mat.specularColor = new Color3(0.075, 0.075, 0.075)
  mat.specularPower = 20
  mat.backFaceCulling = false   // many print meshes have mixed winding
  mat.alpha = 1
  mat.transparencyMode = Material.MATERIAL_OPAQUE
  mat.forceDepthWrite = true
  return mat
}
