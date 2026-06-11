/**
 * Promise-based client for the analysis worker.  Falls back to synchronous
 * main-thread computation if the Worker can't be constructed (should not
 * happen in Electron, but keeps the analyses working everywhere).
 */
import type { TriangleMesh } from '../mesh/types'
import { computeWallThicknessColors } from '../mesh/wallThickness'
import { findOpenEdges } from '../mesh/openEdges'
import type { AnalysisResponse } from './analysis.worker'

type Pending = { resolve: (value: AnalysisResponse) => void; reject: (err: Error) => void }

let worker: Worker | null = null
let workerBroken = false
let nextId = 1
const pending = new Map<number, Pending>()

function getWorker(): Worker | null {
  if (workerBroken) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<AnalysisResponse>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      p.resolve(e.data)
    }
    worker.onerror = () => {
      // Reject everything in flight and fall back to sync from now on
      workerBroken = true
      for (const p of pending.values()) p.reject(new Error('analysis worker crashed'))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  } catch {
    workerBroken = true
    worker = null
  }
  return worker
}

function request(msg: Record<string, unknown>): Promise<AnalysisResponse> {
  const w = getWorker()
  if (!w) return Promise.reject(new Error('worker unavailable'))
  const id = nextId++
  return new Promise<AnalysisResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ ...msg, id })
  })
}

/**
 * Wall thickness off the main thread.  `positions`/`indices` are copied via
 * structured clone — pass them as-is, they are not consumed.
 */
export async function wallThicknessAsync(
  positions: Float32Array,
  indices: Uint32Array,
  params?: { maxDistMm?: number; minOkMm?: number; thinMm?: number; okMm?: number }
): Promise<{ perTriColor: Float32Array; summary: { tooThin: number; borderline: number; ok: number } }> {
  try {
    const res = await request({ type: 'wallThickness', positions, indices, params })
    if (res.ok && res.type === 'wallThickness') return { perTriColor: res.perTriColor, summary: res.summary }
    throw new Error(res.ok ? 'unexpected response' : res.error)
  } catch {
    return computeWallThicknessColors({ positions, indices }, params)
  }
}

/** Open-edge detection off the main thread. */
export async function openEdgesAsync(
  mesh: TriangleMesh
): Promise<{ count: number; linePositions: Float32Array }> {
  try {
    const res = await request({ type: 'openEdges', positions: mesh.positions, indices: mesh.indices })
    if (res.ok && res.type === 'openEdges') return { count: res.count, linePositions: res.linePositions }
    throw new Error(res.ok ? 'unexpected response' : res.error)
  } catch {
    return findOpenEdges(mesh)
  }
}
