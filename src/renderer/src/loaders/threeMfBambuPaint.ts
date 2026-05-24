import type JSZip from 'jszip'
import type { ThreeMfProcessHints } from '../mesh/types'
import { parseDisplayColorToLinearRgb } from './threeMfColors'

function normalizeArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

/** Bambu: `paint_color`; PrusaSlicer: `slic3rpe:mmu_segmentation` — same hex facet encoding. */
export function trianglePaintColorString(tri: Record<string, unknown>): string | undefined {
  const raw =
    tri['@_paint_color'] ??
    tri['@_Paint_color'] ??
    tri.paint_color ??
    tri['@_slic3rpe:mmu_segmentation'] ??
    tri['@_mmu_segmentation'] ??
    tri.mmu_segmentation
  if (raw !== undefined && raw !== null) {
    const s = String(raw).trim()
    if (s.length > 0) return s
  }
  for (const [k, v] of Object.entries(tri)) {
    if (v === undefined || v === null) continue
    const lk = k.toLowerCase()
    if (lk.includes('paint_color') || lk.includes('mmu_segmentation')) {
      const s = String(v).trim()
      if (s.length > 0) return s
    }
  }
  return undefined
}

/**
 * Hex nibbles (last char of string = first bits) → bool bitstream,
 * matching `FacetsAnnotation::set_triangle_from_string` in BambuStudio.
 */
export function paintColorHexToBits(str: string): boolean[] {
  const bits: boolean[] = []
  for (let i = str.length - 1; i >= 0; i--) {
    const ch = str[i]!
    let dec = -1
    if (ch >= '0' && ch <= '9') dec = ch.charCodeAt(0) - 48
    else if (ch >= 'A' && ch <= 'F') dec = 10 + ch.charCodeAt(0) - 65
    else if (ch >= 'a' && ch <= 'f') dec = 10 + ch.charCodeAt(0) - 97
    if (dec < 0) continue
    for (let b = 0; b < 4; b++) bits.push(((dec >> b) & 1) === 1)
  }
  return bits
}

/**
 * DFS walk of one triangle's facet bitstream (same stack idea as
 * `TriangleSelector::has_facets` in BambuStudio). Yields leaf `EnforcerBlockerType`
 * values (0 = NONE, 1 = first filament, 2 = second, …).
 */
export function collectLeafEnforcerStates(bits: boolean[]): number[] {
  const leaves: number[] = []
  let ibit = 0
  const nextNibble = (): number => {
    let n = 0
    for (let i = 0; i < 4; i++) {
      const bit = ibit < bits.length ? bits[ibit++]! : false
      if (bit) n |= 1 << i
    }
    return n & 0xf
  }
  const numChildrenOrState = (): number => {
    const code = nextNibble()
    const numSplit = code & 3
    if (numSplit === 0) {
      if ((code & 0xc) === 0xc) {
        let nextCode = nextNibble()
        let num = 0
        while (nextCode === 15) {
          num++
          nextCode = nextNibble()
        }
        return nextCode + 15 * num + 3
      }
      return code >> 2
    }
    return -numSplit - 1
  }

  const stack: number[] = []
  const first = numChildrenOrState()
  if (first >= 0) {
    leaves.push(first)
    return leaves
  }
  stack.push(-first)
  do {
    const v = --stack[stack.length - 1]!
    if (v >= 0) {
      const s = numChildrenOrState()
      if (s < 0) stack.push(-s)
      else leaves.push(s)
    } else {
      stack.pop()
    }
  } while (stack.length > 0)
  return leaves
}

function dominantNonNoneState(states: number[]): number {
  const counts = new Map<number, number>()
  for (const s of states) {
    if (s <= 0) continue
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  if (counts.size === 0) return 0
  let bestS = 0
  let bestC = -1
  for (const [s, c] of counts) {
    if (c > bestC) {
      bestC = c
      bestS = s
    }
  }
  return bestS
}

/** Distinct fallback colours when no `filament_colour` line was found in the package. */
function syntheticFilamentLinearRgb(filamentIndex1Based: number): [number, number, number] {
  const i = Math.max(0, filamentIndex1Based - 1)
  const hue = (i * 0.618033988749895) % 1
  const c = 0.52
  const x = c * (1 - Math.abs(((hue * 6) % 2) - 1))
  const m = 0.22
  let r = 0
  let g = 0
  let b = 0
  const h6 = hue * 6
  if (h6 < 1) [r, g, b] = [c, x, 0]
  else if (h6 < 2) [r, g, b] = [x, c, 0]
  else if (h6 < 3) [r, g, b] = [0, c, x]
  else if (h6 < 4) [r, g, b] = [0, x, c]
  else if (h6 < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [r + m, g + m, b + m]
}

function rgbForEnforcerState(state: number, palette: Float32Array | null): [number, number, number] {
  if (state <= 0) return parseDisplayColorToLinearRgb(null)
  if (palette && palette.length >= state * 3) {
    const o = (state - 1) * 3
    return [palette[o]!, palette[o + 1]!, palette[o + 2]!]
  }
  return syntheticFilamentLinearRgb(state)
}

/**
 * Per-triangle linear RGB from `paint_color` / `mmu_segmentation` + optional
 * `filament_colour = #...;#...` palette from slicer config.
 */
export function readTrianglePaintRgbFromPalette(
  mesh: { triangles?: { triangle?: unknown } },
  paletteLinearRgb: Float32Array | null
): Float32Array | null {
  const tris = normalizeArray(mesh.triangles?.triangle)
  if (tris.length === 0) return null
  const out = new Float32Array(tris.length * 3)
  let anyPaint = false
  const neutral = parseDisplayColorToLinearRgb(null)
  for (let t = 0; t < tris.length; t++) {
    const tri = tris[t] as Record<string, unknown>
    const enc = trianglePaintColorString(tri)
    if (!enc) {
      // Unpainted triangle → base filament (slot 1) when a palette is present;
      // fall back to neutral grey only when there is no palette at all.
      const [r, g, b] = paletteLinearRgb ? rgbForEnforcerState(1, paletteLinearRgb) : neutral
      out[t * 3] = r
      out[t * 3 + 1] = g
      out[t * 3 + 2] = b
      continue
    }
    anyPaint = true
    const bits = paintColorHexToBits(enc)
    const leaves = collectLeafEnforcerStates(bits)
    const st = dominantNonNoneState(leaves)
    // state 0 (NONE / unassigned) means "inherit base material" = filament slot 1.
    // Only remap when a palette is present; without one, fall back to neutral grey.
    const effectiveSt = st === 0 && paletteLinearRgb ? 1 : st
    const [r, g, b] = rgbForEnforcerState(effectiveSt, paletteLinearRgb)
    out[t * 3] = r
    out[t * 3 + 1] = g
    out[t * 3 + 2] = b
  }
  return anyPaint ? out : null
}

function looksLikeDisplayHex(s: string): boolean {
  const t = s.trim()
  return /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(t)
}

function normalizeDisplayHex(s: string): string {
  const t = s.trim()
  if (t.startsWith('#')) {
    if (t.length === 7) return t                 // #RRGGBB — already correct
    if (t.length === 9) return `#${t.slice(3)}` // #AARRGGBB → #RRGGBB (Bambu/Orca format)
    return t.length > 7 ? `#${t.slice(-6)}` : t // other long forms — last 6
  }
  // No leading '#': 8-char AARRGGBB → strip AA; 6-char RRGGBB → pass through
  if (t.length >= 8) return `#${t.slice(2, 8)}`
  return `#${t.slice(0, 6)}`
}

/** `<metadata key="…" value="…"/>` pairs inside one XML fragment (filament block, etc.). */
export function collectMetadataPairsInBlock(block: string): { key: string; val: string }[] {
  const pairs: { key: string; val: string }[] = []
  const r1 = /<\s*metadata[^>]*\bkey\s*=\s*["']([^"']*)["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/gi
  let im: RegExpExecArray | null
  while ((im = r1.exec(block)) !== null) pairs.push({ key: im[1]!.toLowerCase(), val: im[2]!.trim() })
  const r2 = /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']([^"']*)["']/gi
  while ((im = r2.exec(block)) !== null) pairs.push({ key: im[2]!.toLowerCase(), val: im[1]!.trim() })
  return pairs
}

/** First matching `<metadata key="wantKey" value="…"/>` anywhere in a config document (case-insensitive key). */
export function extractFirstMetadataValue(xml: string, wantKey: string): string | null {
  const lk = wantKey.toLowerCase()
  const r1 = /<\s*metadata[^>]*\bkey\s*=\s*["']([^"']*)["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/gi
  let m: RegExpExecArray | null
  while ((m = r1.exec(xml)) !== null) {
    if (m[1]!.toLowerCase() === lk && m[2]!.trim().length > 0) return m[2]!.trim()
  }
  const r2 = /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']([^"']*)["']/gi
  while ((m = r2.exec(xml)) !== null) {
    if (m[2]!.toLowerCase() === lk && m[1]!.trim().length > 0) return m[1]!.trim()
  }
  return null
}

export type ThreeMfSliceHintsXml = {
  projectName?: string
  bedType?: string
  printerModelId?: string
  filamentTypes: string[]
}

function jsonScalarOrFirst(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') {
    const s = v.trim()
    return s.length > 0 ? s.slice(0, 240) : undefined
  }
  if (Array.isArray(v) && v.length > 0) {
    const s = String(v[0]).trim()
    return s.length > 0 ? s.slice(0, 240) : undefined
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function jsonNozzleDiameterDisplay(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (Array.isArray(v)) {
    const parts = v.map((x) => String(x).trim()).filter((s) => s.length > 0)
    if (parts.length === 0) return undefined
    return parts.join(' / ').slice(0, 160)
  }
  return jsonScalarOrFirst(v)
}

/** Bambu `project_settings.config` is JSON with the same logical keys as XML metadata. */
export function extractThreeMfSliceHintsFromJsonConfig(text: string): ThreeMfSliceHintsXml | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  let j: Record<string, unknown>
  try {
    j = JSON.parse(t) as Record<string, unknown>
  } catch {
    return null
  }
  const rawTitle =
    jsonScalarOrFirst(j.from_name) ??
    jsonScalarOrFirst(j.model_name) ??
    jsonScalarOrFirst(j.project_name) ??
    jsonScalarOrFirst(j.prj_name) ??
    jsonScalarOrFirst(j.dev_model_name)
  const projectName =
    rawTitle && rawTitle.toLowerCase() !== 'project_settings' ? rawTitle : undefined
  const bedType = jsonScalarOrFirst(j.curr_bed_type) ?? jsonScalarOrFirst(j.bed_type)
  const printerModelId =
    jsonScalarOrFirst(j.printer_model) ??
    jsonScalarOrFirst(j.printer_settings_id) ??
    jsonScalarOrFirst(j.printer_model_id) ??
    jsonScalarOrFirst(j.machine_setting_id)
  const ft = j.filament_type
  const filamentTypes = Array.isArray(ft)
    ? ft.map((x) => {
        const s = String(x).trim()
        return s.length > 0 && s.length <= 64 ? s : '—'
      })
    : []
  return {
    projectName,
    bedType,
    printerModelId,
    filamentTypes
  }
}

/** Process fields from Bambu JSON `project_settings.config`. */
export function extractThreeMfProcessHintsFromJsonConfig(text: string): ThreeMfProcessHints | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  let j: Record<string, unknown>
  try {
    j = JSON.parse(t) as Record<string, unknown>
  } catch {
    return null
  }
  const out: ThreeMfProcessHints = {
    layerHeightMm: jsonScalarOrFirst(j.layer_height),
    initialLayerHeightMm: jsonScalarOrFirst(j.initial_layer_print_height),
    lineWidthMm: jsonScalarOrFirst(j.line_width),
    nozzleDiameterMm: jsonNozzleDiameterDisplay(j.nozzle_diameter),
    printPresetId:
      jsonScalarOrFirst(j.print_settings_id) ??
      jsonScalarOrFirst(j.default_print_profile) ??
      jsonScalarOrFirst(j.process_setting_name) ??
      jsonScalarOrFirst(j.current_process_profile) ??
      jsonScalarOrFirst(j.print_profile),
    estimatedPrintTime: jsonScalarOrFirst(j.prediction) ?? jsonScalarOrFirst(j.slice_time),
    estimatedModelWeight: jsonScalarOrFirst(j.weight) ?? jsonScalarOrFirst(j.slice_weight),
    totalLayers: jsonScalarOrFirst(j.total_layer_number) ?? jsonScalarOrFirst(j.total_layers)
  }
  return Object.values(out).some((v) => v !== undefined && String(v).length > 0) ? out : null
}

/** Display hex per slot from JSON `filament_colour` / `filament_colours` (Bambu project_settings). */
export function extractFilamentHexesFromJsonRoot(text: string): string[] {
  const t = text.trim()
  if (!t.startsWith('{')) return []
  let j: Record<string, unknown>
  try {
    j = JSON.parse(t) as Record<string, unknown>
  } catch {
    return []
  }
  const raw = j.filament_colour ?? j.filament_colours ?? j.default_filament_colour
  const out: string[] = []
  if (typeof raw === 'string') {
    const parts = raw.split(/[;,]/).map((s) => s.trim()).filter((s) => s.length > 0)
    for (const p of parts) {
      out.push(looksLikeDisplayHex(p) ? normalizeDisplayHex(p) : '#B8BEC9')
    }
    return out
  }
  if (!Array.isArray(raw)) return []
  for (const x of raw) {
    const s = String(x).trim()
    if (!s) {
      out.push('#B8BEC9')
      continue
    }
    out.push(looksLikeDisplayHex(s) ? normalizeDisplayHex(s) : '#B8BEC9')
  }
  return out
}

/** Project / machine / filament-type hints from one Orca or Bambu `*.config` XML body. */
export function extractThreeMfSliceHintsFromConfigXml(xml: string): ThreeMfSliceHintsXml {
  const titleKeys = ['from_name', 'model_name', 'project_name', 'prj_name', 'dev_model_name', 'title']
  let projectName: string | undefined
  for (const k of titleKeys) {
    const v = extractFirstMetadataValue(xml, k)
    if (v && v.length < 240) {
      projectName = v
      break
    }
  }
  const bedType =
    extractFirstMetadataValue(xml, 'curr_bed_type') ?? extractFirstMetadataValue(xml, 'bed_type') ?? undefined
  const printerModelId =
    extractFirstMetadataValue(xml, 'printer_model_id') ??
    extractFirstMetadataValue(xml, 'printer_settings_id') ??
    extractFirstMetadataValue(xml, 'machine_setting_id') ??
    undefined
  return {
    projectName,
    bedType,
    printerModelId,
    filamentTypes: extractFilamentMaterialTypesFromXml(xml)
  }
}

function pickMetadataFirst(xml: string, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = extractFirstMetadataValue(xml, k)
    if (v && v.trim().length > 0) return v.trim().slice(0, 160)
  }
  return undefined
}

/** Layer / nozzle / preset / slice-estimate metadata (Orca / Bambu `*.config` XML). */
export function extractThreeMfProcessHintsFromConfigXml(xml: string): ThreeMfProcessHints {
  return {
    layerHeightMm: pickMetadataFirst(xml, ['layer_height', 'layerheight']),
    initialLayerHeightMm: pickMetadataFirst(xml, [
      'initial_layer_print_height',
      'initial_layer_height',
      'first_layer_height'
    ]),
    lineWidthMm: pickMetadataFirst(xml, ['line_width', 'initial_layer_line_width']),
    nozzleDiameterMm: pickMetadataFirst(xml, ['nozzle_diameter', 'printer_extruder_variant']),
    printPresetId: pickMetadataFirst(xml, [
      'print_settings_id',
      'process_setting_name',
      'current_process_profile',
      'print_profile'
    ]),
    estimatedPrintTime: pickMetadataFirst(xml, ['prediction', 'slice_time', 'estimated_time']),
    estimatedModelWeight: pickMetadataFirst(xml, ['weight', 'slice_weight', 'model_weight']),
    totalLayers: pickMetadataFirst(xml, ['total_layer_number', 'total_layers', 'layer_number'])
  }
}

/** Material label from `<filament>` inner metadata (`type`, `filament_type`, …). */
export function extractFilamentBlockMaterialType(block: string): string | null {
  const pairs = collectMetadataPairsInBlock(block)
  for (const pk of ['type', 'filament_type', 'material_type']) {
    for (const p of pairs) {
      if (p.key !== pk || !p.val) continue
      const t = p.val.trim()
      if (t.length === 0 || t.length > 64) continue
      if (looksLikeDisplayHex(t)) continue
      if (/^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(t)) continue
      return t
    }
  }
  return null
}

function iterFilamentInnerBlocks(xml: string): string[] {
  const blocks: string[] = []
  const filamentRe = /<(?:[\w-]+:)?filament\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?filament\s*>/gi
  let fm: RegExpExecArray | null
  while ((fm = filamentRe.exec(xml)) !== null) blocks.push(fm[1] ?? '')
  return blocks
}

/** One entry per `<filament>` in document order; `'—'` when no type metadata. */
export function extractFilamentMaterialTypesFromXml(xml: string): string[] {
  const out: string[] = []
  for (const block of iterFilamentInnerBlocks(xml)) {
    out.push(extractFilamentBlockMaterialType(block) ?? '—')
  }
  return out
}

/** Pull display hex from one `<filament>…</filament>` block (Orca / Bambu `Metadata/*.config`). */
export function extractFilamentBlockDisplayHex(block: string): string | null {
  const pairs = collectMetadataPairsInBlock(block)

  const prefer = ['default_filament_colour', 'filament_colour', 'filament_color']
  for (const pk of prefer) {
    for (const p of pairs) {
      if (p.key === pk && looksLikeDisplayHex(p.val)) return normalizeDisplayHex(p.val)
    }
  }
  for (const p of pairs) {
    if (
      (p.key.includes('filament') && p.key.includes('colour')) ||
      (p.key.includes('filament') && p.key.endsWith('color'))
    ) {
      if (looksLikeDisplayHex(p.val)) return normalizeDisplayHex(p.val)
    }
  }
  return null
}

/**
 * Orca / Bambu store filament slots as `<filament>` elements with `<metadata key="…" value="#RRGGBB"/>`.
 * This complements INI-style `filament_colour = #…;#…` lines inside the same files.
 */
export function mergeFilamentPaletteFromBambuFilamentXml(
  xml: string,
  best: { count: number; flat: Float32Array | null }
): void {
  const blocks = iterFilamentInnerBlocks(xml)
  if (blocks.length === 0) return

  const rgb: number[] = []
  for (const block of blocks) {
    const hex = extractFilamentBlockDisplayHex(block)
    const [r, g, b] = parseDisplayColorToLinearRgb(hex ?? undefined)
    rgb.push(r, g, b)
  }
  const n = rgb.length / 3
  if (n >= best.count) {
    best.count = n
    best.flat = new Float32Array(rgb)
  }
}

/** Ordered display hex per `<filament>` block (fallback swatch when a slot has no colour metadata). */
export function extractFilamentDisplayHexesFromXml(xml: string): string[] {
  const blocks = iterFilamentInnerBlocks(xml)
  const out: string[] = []
  for (const block of blocks) {
    const h = extractFilamentBlockDisplayHex(block)
    out.push(h ?? '#B8BEC9')
  }
  return out
}

/** Parse `filament_colour = #a;#b;#c` lines from Orca/Bambu/Prusa INI-style config bodies. */
export function mergeFilamentPaletteFromConfigText(text: string, best: { count: number; flat: Float32Array | null }): void {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const m = /^\s*filament_colour\s*=\s*(.+)$/i.exec(line)
    if (!m) continue
    const raw = m[1].trim()
    const parts = raw.split(/[;,]/).map((s) => s.trim()).filter((s) => s.length > 0)
    if (parts.length === 0 || parts.length < best.count) continue
    const rgb: number[] = []
    for (const p of parts) {
      const [r, g, b] = parseDisplayColorToLinearRgb(p)
      rgb.push(r, g, b)
    }
    best.count = parts.length
    best.flat = new Float32Array(rgb)
  }
}

function tryMergePaletteFromJsonText(text: string, best: { count: number; flat: Float32Array | null }): void {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return
  try {
    const j = JSON.parse(text) as unknown
    const visit = (node: unknown): void => {
      if (node === null || node === undefined) return
      if (Array.isArray(node)) {
        for (const x of node) visit(x)
        return
      }
      if (typeof node !== 'object') return
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const lk = k.toLowerCase()
        if (lk === 'filament_colour' || lk === 'filament_colours') {
          if (typeof v === 'string') mergeFilamentPaletteFromConfigText(`filament_colour = ${v}`, best)
          else if (Array.isArray(v)) {
            const parts = v.map((x) => String(x).trim()).filter((s) => s.length > 0)
            if (parts.length >= best.count) {
              const rgb: number[] = []
              for (const p of parts) {
                const [r, g, b] = parseDisplayColorToLinearRgb(p)
                rgb.push(r, g, b)
              }
              best.count = parts.length
              best.flat = new Float32Array(rgb)
            }
          }
        }
        visit(v)
      }
    }
    visit(j)
  } catch {
    /* not JSON */
  }
}

/** Longest filament colour list from any `Metadata/*.config` (Orca / Bambu XML `<filament>` or JSON `filament_colour`). */
export async function collectBestFilamentHexesFromZip(zip: JSZip): Promise<string[]> {
  let best: string[] = []
  for (const key of Object.keys(zip.files).sort()) {
    const e = zip.files[key]
    if (!e || e.dir) continue
    const n = key.replace(/\\/g, '/').toLowerCase()
    if (!n.endsWith('.config') && !n.endsWith('.cfg')) continue
    let text = await e.async('string')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    let hexes: string[] = []
    if (/<[\w:-]*\bfilament\b/i.test(text)) hexes = extractFilamentDisplayHexesFromXml(text)
    if (text.trim().startsWith('{')) {
      const jh = extractFilamentHexesFromJsonRoot(text)
      if (jh.length > hexes.length) hexes = jh
    }
    if (hexes.length === 0) continue
    if (hexes.length > best.length) best = hexes
  }
  return best
}

/** Longest `filament_colour` list found in config / JSON parts of the 3MF. */
export async function loadFilamentPaletteFromZip(zip: JSZip): Promise<Float32Array | null> {
  const best = { count: 0, flat: null as Float32Array | null }
  const keys = Object.keys(zip.files).sort()
  for (const key of keys) {
    const e = zip.files[key]
    if (!e || e.dir) continue
    const n = key.replace(/\\/g, '/').toLowerCase()
    const isConfig = n.endsWith('.config') || n.endsWith('.cfg')
    const isMetaJson = n.endsWith('.json') && /(^|\/)metadata\//.test(n)
    if (!isConfig && !isMetaJson) continue
    try {
      let text = await e.async('string')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      if (isConfig) {
        mergeFilamentPaletteFromConfigText(text, best)
        mergeFilamentPaletteFromBambuFilamentXml(text, best)
        if (text.trim().startsWith('{')) tryMergePaletteFromJsonText(text, best)
      } else tryMergePaletteFromJsonText(text, best)
    } catch {
      /* skip unreadable */
    }
  }
  return best.flat
}
