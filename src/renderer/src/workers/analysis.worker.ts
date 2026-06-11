/// <reference lib="webworker" />
/**
 * Analysis worker — heavy mesh computations run here so the UI thread never
 * blocks.  Pure functions only; the TriangleMesh arrays arrive via structured
 * clone and results are transferred back zero-copy.
 */
import { computeWallThicknessColors } from '../mesh/wallThickness'
import { findOpenEdges } from '../mesh/openEdges'

export type AnalysisRequest =
  | {
      id: number
      type: 'wallThickness'
      positions: Float32Array
      indices: Uint32Array
      params?: { maxDistMm?: number; minOkMm?: number; thinMm?: number; okMm?: number }
    }
  | { id: number; type: 'openEdges'; positions: Float32Array; indices: Uint32Array }

export type AnalysisResponse =
  | { id: number; ok: true; type: 'wallThickness'; perTriColor: Float32Array; summary: { tooThin: number; borderline: number; ok: number } }
  | { id: number; ok: true; type: 'openEdges'; count: number; linePositions: Float32Array }
  | { id: number; ok: false; error: string }

const ctx = self as unknown as Worker

ctx.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'wallThickness') {
      const { perTriColor, summary } = computeWallThicknessColors(
        { positions: msg.positions, indices: msg.indices },
        msg.params
      )
      const res: AnalysisResponse = { id: msg.id, ok: true, type: 'wallThickness', perTriColor, summary }
      ctx.postMessage(res, [perTriColor.buffer])
    } else {
      const { count, linePositions } = findOpenEdges({ positions: msg.positions, indices: msg.indices })
      const res: AnalysisResponse = { id: msg.id, ok: true, type: 'openEdges', count, linePositions }
      ctx.postMessage(res, [linePositions.buffer])
    }
  } catch (err) {
    const res: AnalysisResponse = { id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }
    ctx.postMessage(res)
  }
}
