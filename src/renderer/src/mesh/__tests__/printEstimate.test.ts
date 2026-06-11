import { describe, it, expect } from 'vitest'
import { estimatePrint, formatPrintTime } from '../printEstimate'

describe('estimatePrint', () => {
  // 20 mm calibration cube: 8000 mm³ volume, 2400 mm² surface, 20 mm tall
  const cube = () => estimatePrint(8000, 2400, 20, 1.24)

  it('estimates a 20 mm cube in a plausible range', () => {
    const e = cube()
    // Slicers put a 20 mm cube at 15% infill around 30-45 min, ~5 g
    expect(e.timeMin).toBeGreaterThan(10)
    expect(e.timeMin).toBeLessThan(90)
    expect(e.weightG).toBeGreaterThan(2)
    expect(e.weightG).toBeLessThan(10)
    expect(e.layers).toBe(100)
  })

  it('weight scales with density', () => {
    const pla = estimatePrint(8000, 2400, 20, 1.24)
    const petg = estimatePrint(8000, 2400, 20, 1.27)
    expect(petg.weightG).toBeGreaterThan(pla.weightG)
  })

  it('higher infill increases time and weight', () => {
    const low = estimatePrint(8000, 2400, 20, 1.24, { infillFraction: 0.1 })
    const high = estimatePrint(8000, 2400, 20, 1.24, { infillFraction: 0.8 })
    expect(high.timeMin).toBeGreaterThan(low.timeMin)
    expect(high.weightG).toBeGreaterThan(low.weightG)
  })

  it('shell volume never exceeds solid volume (thin shapes)', () => {
    // Tiny sliver: 10 mm³ volume but big surface area
    const e = estimatePrint(10, 5000, 1, 1.24)
    expect(e.extrudedCm3).toBeLessThanOrEqual(10 / 1000 + 1e-9)
  })

  it('handles zero/degenerate input', () => {
    const e = estimatePrint(0, 0, 0, 1.24)
    expect(e.weightG).toBe(0)
    expect(e.layers).toBe(1)
    expect(Number.isFinite(e.timeMin)).toBe(true)
  })
})

describe('formatPrintTime', () => {
  it('formats minutes and hours', () => {
    expect(formatPrintTime(0.4)).toBe('<1m')
    expect(formatPrintTime(45)).toBe('45m')
    expect(formatPrintTime(60)).toBe('1h')
    expect(formatPrintTime(155)).toBe('2h 35m')
  })

  it('rolls 59.6 minutes up cleanly', () => {
    expect(formatPrintTime(119.7)).toBe('2h')
  })
})
