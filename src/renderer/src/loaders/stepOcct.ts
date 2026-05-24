import type { TriangleMesh } from '../mesh/types'
import type { LoadProgressCallback } from './loadTypes'
import { mergeMeshes } from '../mesh/merge'
import occtImportJsFactory from 'occt-import-js'
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url'

interface OcctVec3 {
  array: number[][]
}

interface OcctIndex {
  array: number[][]
}

/** Current occt-import-js uses `attributes.position`; older builds used top-level `position`. */
interface OcctMeshJson {
  name?: string
  position?: OcctVec3
  attributes?: { position?: OcctVec3 }
  index: OcctIndex
}

interface OcctNode {
  name?: string
  meshes?: number[]
  children?: OcctNode[]
}

interface OcctResult {
  success: boolean
  meshes: OcctMeshJson[]
  root: OcctNode
}

type OcctModule = {
  ReadStepFile: (data: Uint8Array, params: null | Record<string, unknown>) => OcctResult
}

export type StepOcctParams = Record<string, unknown> | null

function collectMeshIndices(node: OcctNode, out: number[]): void {
  if (node.meshes) out.push(...node.meshes)
  if (node.children) {
    for (const c of node.children) collectMeshIndices(c, out)
  }
}

function flattenOcctArray(arr: unknown): number[] {
  if (arr == null) return []
  if (ArrayBuffer.isView(arr)) {
    return Array.from(arr as unknown as ArrayLike<number>)
  }
  if (!Array.isArray(arr) || arr.length === 0) return []
  if (typeof (arr as number[])[0] === 'number') return arr as number[]
  return (arr as number[][]).flat()
}

function occtMeshHasGeometry(m: OcctMeshJson): boolean {
  const pos = m.attributes?.position ?? m.position
  return !!(pos?.array && m.index?.array)
}

function occtMeshToPart(m: OcctMeshJson): TriangleMesh {
  const posWrap = m.attributes?.position ?? m.position
  if (!posWrap?.array) {
    throw new Error('STEP mesh has no vertex positions (unexpected occt-import-js payload)')
  }
  if (!m.index?.array) {
    throw new Error('STEP mesh has no triangle indices')
  }
  const posArr = flattenOcctArray(posWrap.array)
  const idxArr = flattenOcctArray(m.index.array)
  if (posArr.length === 0 || idxArr.length === 0) {
    throw new Error('STEP mesh has empty position or index data')
  }
  return {
    positions: new Float32Array(posArr),
    indices: new Uint32Array(idxArr)
  }
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

export async function loadStep(
  buffer: Uint8Array,
  onProgress?: LoadProgressCallback,
  tessellationParams: StepOcctParams = null
): Promise<TriangleMesh> {
  await yieldToMain()
  onProgress?.('Starting CAD engine (first STEP load downloads WASM)…')

  const init = occtImportJsFactory as unknown as (opts?: {
    locateFile?: (path: string, scriptDirectory: string) => string
  }) => Promise<OcctModule>

  const occt = await init({
    locateFile: (path: string) => (path.endsWith('.wasm') ? occtWasmUrl : path)
  })

  await yieldToMain()
  onProgress?.('Tessellating STEP geometry (this can take a while)…')
  const result = occt.ReadStepFile(buffer, tessellationParams ?? null)
  if (!result.success) {
    throw new Error('STEP import failed (file may be corrupt or unsupported)')
  }

  await yieldToMain()
  onProgress?.('Assembling mesh…')

  const used: number[] = []
  collectMeshIndices(result.root, used)
  const parts: TriangleMesh[] = []
  const seen = new Set<number>()
  for (const i of used) {
    if (seen.has(i)) continue
    seen.add(i)
    const mj = result.meshes[i]
    if (!mj || !occtMeshHasGeometry(mj)) continue
    parts.push(occtMeshToPart(mj))
  }
  if (parts.length === 0) {
    for (const mj of result.meshes) {
      if (mj && occtMeshHasGeometry(mj)) parts.push(occtMeshToPart(mj))
    }
  }
  if (parts.length === 0) throw new Error('No triangulated geometry in STEP file')
  return mergeMeshes(parts)
}
