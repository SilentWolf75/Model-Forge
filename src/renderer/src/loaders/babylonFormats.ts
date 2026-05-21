import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import '@babylonjs/loaders/STL'
import '@babylonjs/loaders/OBJ'
import type { TriangleMesh } from '../mesh/types'
import { mergeMeshes } from '../mesh/merge'
import { sceneMeshesToParts } from '../mesh/fromBabylon'

async function loadWithBabylonPlugin(
  buffer: Uint8Array,
  extension: '.stl' | '.obj'
): Promise<TriangleMesh> {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const mime = extension === '.stl' ? 'model/stl' : 'model/obj'
  const blob = new Blob([buffer], { type: mime })
  const url = URL.createObjectURL(blob)
  try {
    const result = await SceneLoader.ImportMeshAsync('', '', url, scene, undefined, extension)
    const parts = sceneMeshesToParts(result.meshes as Mesh[])
    if (parts.length === 0) {
      throw new Error('No geometry found in file')
    }
    return mergeMeshes(parts)
  } finally {
    URL.revokeObjectURL(url)
    scene.dispose()
    engine.dispose()
  }
}

export function loadStl(buffer: Uint8Array): Promise<TriangleMesh> {
  return loadWithBabylonPlugin(buffer, '.stl')
}

export function loadObj(buffer: Uint8Array): Promise<TriangleMesh> {
  return loadWithBabylonPlugin(buffer, '.obj')
}
