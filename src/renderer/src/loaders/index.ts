import type { TriangleMesh } from '../mesh/types'
import { loadStl, loadObj } from './babylonFormats'
import { loadThreeMf } from './threeMf'
import { loadStep, type StepOcctParams } from './stepOcct'
import type { LoadProgressCallback } from './loadTypes'

export type { LoadProgressCallback } from './loadTypes'

export function extensionOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i >= 0 ? path.slice(i + 1).toLowerCase() : ''
}

/**
 * STL/OBJ/STEP: vertices kept as stored (same axes, no auto-rotation).
 * 3MF: remapped in its loader from slicer space (bed XY, +Z up) to viewer (bed XZ, +Y up).
 */
export async function loadModelFromBuffer(
  path: string,
  data: Uint8Array,
  onProgress?: LoadProgressCallback,
  stepTessellation: StepOcctParams = null
): Promise<TriangleMesh> {
  const ext = extensionOf(path)
  if (ext === 'stl') {
    onProgress?.('Loading STL…')
    return loadStl(data)
  }
  if (ext === 'obj') {
    onProgress?.('Loading OBJ…')
    return loadObj(data)
  }
  if (ext === '3mf') {
    onProgress?.('Loading 3MF…')
    return loadThreeMf(data)
  }
  if (ext === 'step' || ext === 'stp') return loadStep(data, onProgress, stepTessellation)
  throw new Error(`Unsupported format: .${ext}`)
}

export { loadStl, loadObj, loadThreeMf, loadStep }
