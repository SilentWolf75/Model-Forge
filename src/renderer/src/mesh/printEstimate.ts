/**
 * First-order FDM print estimates from mesh analysis.
 *
 * The model is deliberately simple and transparent (documented in the UI):
 *   • Extruded volume = shell volume + infill volume
 *       shell  = surface area × shell thickness (walls + top/bottom ≈ 1.2 mm),
 *                clamped to the solid volume
 *       infill = remaining interior volume × infill percentage
 *   • Time = extruded volume ÷ volumetric flow + per-layer overhead
 *       flow ≈ 12 mm³/s — a typical 0.4 mm nozzle moving at normal speeds
 *       overhead ≈ 3 s/layer for travel, retraction, and acceleration losses
 *   • Weight = extruded volume × material density
 *
 * Real slicer times vary with speed profiles, supports, and cooling, but this
 * lands in the right ballpark (±30 %) for typical models and is honest about
 * being an estimate.
 */
export type PrintEstimateOptions = {
  layerHeightMm?: number
  infillFraction?: number
  shellThicknessMm?: number
  volumetricFlowMm3s?: number
  perLayerOverheadS?: number
}

export type PrintEstimate = {
  /** Estimated print time in minutes. */
  timeMin: number
  /** Estimated filament weight in grams at the given infill. */
  weightG: number
  /** Extruded volume in cm³ (shell + infill). */
  extrudedCm3: number
  layers: number
}

export function estimatePrint(
  solidVolumeMm3: number,
  surfaceAreaMm2: number,
  heightMm: number,
  densityGcm3: number,
  {
    layerHeightMm = 0.2,
    infillFraction = 0.15,
    shellThicknessMm = 1.2,
    volumetricFlowMm3s = 12,
    perLayerOverheadS = 3,
  }: PrintEstimateOptions = {}
): PrintEstimate {
  const vol = Math.max(0, Math.abs(solidVolumeMm3))
  const shellVol = Math.min(vol, Math.max(0, surfaceAreaMm2) * shellThicknessMm)
  const infillVol = Math.max(0, vol - shellVol) * infillFraction
  const extruded = shellVol + infillVol

  const layers = Math.max(1, Math.ceil(Math.max(0, heightMm) / layerHeightMm))
  const extrusionS = extruded / volumetricFlowMm3s
  const overheadS = layers * perLayerOverheadS

  return {
    timeMin: (extrusionS + overheadS) / 60,
    weightG: (extruded / 1000) * densityGcm3,
    extrudedCm3: extruded / 1000,
    layers,
  }
}

/** "2h 35m" / "45m" / "<1m" formatting for estimate display. */
export function formatPrintTime(timeMin: number): string {
  if (timeMin < 1) return '<1m'
  const total = Math.round(timeMin)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}
