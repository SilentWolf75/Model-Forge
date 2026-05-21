/**
 * 3MF production / materials: basematerials + colorgroup → linear RGB tables,
 * triangle pid / p1–p3 → per-triangle color for multicolor (e.g. Bambu) previews.
 */

function srgbByteToLinear(u255: number): number {
  const u = Math.max(0, Math.min(255, u255)) / 255
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4)
}

function linearToSrgbByte(lin: number): number {
  const u = Math.max(0, Math.min(1, lin))
  const s = u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(s * 255)))
}

/** Encode a linear-RGB filament palette as #RRGGBB for UI (e.g. sidebar swatches). */
export function linearRgbPaletteToHexList(pal: Float32Array | null): string[] {
  if (!pal || pal.length < 3) return []
  const n = pal.length / 3
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const o = i * 3
    const r = linearToSrgbByte(pal[o]!)
    const g = linearToSrgbByte(pal[o + 1]!)
    const b = linearToSrgbByte(pal[o + 2]!)
    out.push(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`)
  }
  return out
}

/** Parse #RRGGBB, #RRGGBBAA, or #AARRGGBB (last 6 hex used as RGB). Returns linear RGB 0–1. */
export function parseDisplayColorToLinearRgb(hex: string | undefined | null): [number, number, number] {
  if (!hex) return [0.78, 0.82, 0.91]
  const s = String(hex).trim()
  let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s)
  if (m) {
    return [srgbByteToLinear(parseInt(m[1], 16)), srgbByteToLinear(parseInt(m[2], 16)), srgbByteToLinear(parseInt(m[3], 16))]
  }
  m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s)
  if (m) {
    // Treat as #AARRGGBB (common); if alpha-looking first byte, still use last 6 as RGB.
    return [srgbByteToLinear(parseInt(m[2], 16)), srgbByteToLinear(parseInt(m[3], 16)), srgbByteToLinear(parseInt(m[4], 16))]
  }
  return [0.78, 0.82, 0.91]
}

function normalizeArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

/** Match fast-xml-parser / namespaced keys (`@_pid`, `@_p:pid`, `{…}p1`). */
function xmlAttrLocalName(attrKey: string): string {
  let k = attrKey.startsWith('@_') ? attrKey.slice(2) : attrKey
  const brace = k.lastIndexOf('}')
  if (brace !== -1) k = k.slice(brace + 1)
  const colon = k.lastIndexOf(':')
  if (colon > 0) {
    const before = k.slice(0, colon)
    if (!before.includes('//')) k = k.slice(colon + 1)
  }
  return k.toLowerCase()
}

function readXmlAttrFirstMatch(row: Record<string, unknown>, wantedLocals: readonly string[]): string | undefined {
  const want = new Set(wantedLocals.map((w) => w.toLowerCase()))
  for (const [key, val] of Object.entries(row)) {
    if (val === undefined || val === null) continue
    if (want.has(xmlAttrLocalName(key))) return String(val).trim()
  }
  return undefined
}

function colorsFromBasematerialsBlock(block: Record<string, unknown>): Float32Array | null {
  const bases = normalizeArray(block.base)
  if (bases.length === 0) return null
  const rgb: number[] = []
  for (const b of bases) {
    const row = b as Record<string, unknown>
    const hex =
      row['@_displaycolor'] ??
      row['@_Displaycolor'] ??
      row['@_displayColor'] ??
      row['@_color'] ??
      row['@_Color'] ??
      row.displaycolor ??
      row.color
    const [r, g, bl] = parseDisplayColorToLinearRgb(hex != null ? String(hex) : undefined)
    rgb.push(r, g, bl)
  }
  return rgb.length ? new Float32Array(rgb) : null
}

function colorsFromColorgroupBlock(block: Record<string, unknown>): Float32Array | null {
  const cols = normalizeArray(block.color)
  if (cols.length === 0) return null
  const rgb: number[] = []
  for (const c of cols) {
    const row = c as Record<string, unknown>
    const hex = row['@_color'] ?? row['@_Color'] ?? row['@_displaycolor'] ?? row.color
    const [r, g, bl] = parseDisplayColorToLinearRgb(hex != null ? String(hex) : undefined)
    rgb.push(r, g, bl)
  }
  return rgb.length ? new Float32Array(rgb) : null
}

/** Flat rgb triplets per material index for each resource `id` (basematerials / colorgroup). */
export function collectMaterialColorTables(resources: Record<string, unknown>): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  for (const [key, val] of Object.entries(resources)) {
    if (val === null || val === undefined) continue
    const lk = key.toLowerCase()
    if (!lk.includes('basematerial') && !lk.includes('colorgroup')) continue
    const blocks = normalizeArray(val as unknown)
    for (const block of blocks) {
      const b = block as Record<string, unknown>
      const idRaw = b['@_id'] ?? b['@_Id'] ?? b.id
      if (idRaw === undefined || idRaw === null) continue
      const id = String(idRaw)
      let tab: Float32Array | null = null
      if (lk.includes('basematerial')) {
        tab = colorsFromBasematerialsBlock(b)
      }
      if (!tab || tab.length === 0) {
        tab = colorsFromColorgroupBlock(b)
      }
      if (tab && tab.length > 0) out.set(id, tab)
    }
  }
  return out
}

function resolveMaterialIndex(p: number, numMaterials: number): number {
  if (!Number.isFinite(p) || numMaterials <= 0) return 0
  let i = Math.round(p)
  if (i >= 0 && i < numMaterials) return i
  if (i >= 1 && i <= numMaterials) return i - 1
  if (i >= numMaterials) return numMaterials - 1
  return 0
}

function tableRgb(tables: Map<string, Float32Array>, pid: string | undefined, pindex: number): [number, number, number] {
  if (!pid) return [0.78, 0.82, 0.91]
  const tab = tables.get(pid)
  if (!tab || tab.length < 3) return [0.78, 0.82, 0.91]
  const n = tab.length / 3
  const i = resolveMaterialIndex(pindex, n)
  const o = i * 3
  return [tab[o], tab[o + 1], tab[o + 2]]
}

function readTriPid(tri: Record<string, unknown>, defaultPid?: string): string | undefined {
  const s = readXmlAttrFirstMatch(tri, ['pid'])
  if (s !== undefined && s !== '') return s
  if (defaultPid !== undefined && defaultPid !== '') return String(defaultPid)
  const legacy = tri['@_pid'] ?? tri.pid
  if (legacy !== undefined && legacy !== null && String(legacy).trim() !== '') return String(legacy).trim()
  return undefined
}

function readTriPindex(tri: Record<string, unknown>, name: 'p1' | 'p2' | 'p3', fallback: number): number {
  const s = readXmlAttrFirstMatch(tri, [name])
  if (s !== undefined && s !== '') {
    const n = Number(s)
    if (Number.isFinite(n)) return n
  }
  const legacy = tri[`@_${name}`] ?? tri[name]
  if (legacy !== undefined && legacy !== null && String(legacy).trim() !== '') {
    const n = Number(legacy)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

/**
 * Per-triangle material: `triangle@pid` overrides object default; `p1`–`p3` index into that group
 * (multicolor). Returns linear RGB **per corner** (length `triangleCount * 9`: c0,c1,c2 for each tri).
 */
export function readTriangleFaceRgbs(
  mesh: { triangles?: { triangle?: unknown } },
  tables: Map<string, Float32Array>,
  defaultPid?: string,
  defaultPindex?: number
): Float32Array | null {
  if (tables.size === 0) return null
  const tris = normalizeArray(mesh.triangles?.triangle)
  if (tris.length === 0) return null
  const out = new Float32Array(tris.length * 9)
  let anyResolved = false
  if (defaultPid !== undefined && defaultPid !== '' && tables.has(String(defaultPid))) {
    anyResolved = true
  }
  const defIx = defaultPindex ?? 0
  for (let t = 0; t < tris.length; t++) {
    const tri = tris[t] as Record<string, unknown>
    const pid = readTriPid(tri, defaultPid)
    const rawP1 = readTriPindex(tri, 'p1', defIx)
    const rawP2 = readTriPindex(tri, 'p2', rawP1)
    const rawP3 = readTriPindex(tri, 'p3', rawP1)
    const p1 = Number.isFinite(rawP1) ? rawP1 : 0
    const p2 = Number.isFinite(rawP2) ? rawP2 : p1
    const p3 = Number.isFinite(rawP3) ? rawP3 : p1
    const c1 = tableRgb(tables, pid, p1)
    const c2 = tableRgb(tables, pid, p2)
    const c3 = tableRgb(tables, pid, p3)
    if (pid && tables.has(pid)) anyResolved = true
    const o = t * 9
    out[o] = c1[0]
    out[o + 1] = c1[1]
    out[o + 2] = c1[2]
    out[o + 3] = c2[0]
    out[o + 4] = c2[1]
    out[o + 5] = c2[2]
    out[o + 6] = c3[0]
    out[o + 7] = c3[1]
    out[o + 8] = c3[2]
  }
  return anyResolved ? out : null
}

/**
 * Duplicate corners so each triangle owns 3 vertices.
 * `triRgb`: either one linear RGB per triangle (length `triCount * 3`) or per-corner (length `triCount * 9`,
 * layout `r0,g0,b0,r1,g1,b1,r2,g2,b2` per triangle — from `readTriangleFaceRgbs`).
 */
export function expandIndexedMeshWithTriColors(
  positions: Float32Array,
  indices: Uint32Array,
  triRgb: Float32Array
): { positions: Float32Array; indices: Uint32Array; vertexColors: Float32Array } {
  const nT = indices.length / 3
  const nv = nT * 3
  const v2 = new Float32Array(nv * 3)
  const i2 = new Uint32Array(nv)
  const rgb = new Float32Array(nv * 3)
  const cornerMode = triRgb.length === nT * 9
  const flatMode = triRgb.length === nT * 3
  let w = 0
  for (let t = 0; t < nT; t++) {
    let r0: number,
      g0: number,
      b0: number,
      r1: number,
      g1: number,
      b1: number,
      r2: number,
      g2: number,
      b2: number
    if (cornerMode) {
      const o = t * 9
      r0 = triRgb[o]!
      g0 = triRgb[o + 1]!
      b0 = triRgb[o + 2]!
      r1 = triRgb[o + 3]!
      g1 = triRgb[o + 4]!
      b1 = triRgb[o + 5]!
      r2 = triRgb[o + 6]!
      g2 = triRgb[o + 7]!
      b2 = triRgb[o + 8]!
    } else if (flatMode) {
      const o = t * 3
      r0 = r1 = r2 = triRgb[o]!
      g0 = g1 = g2 = triRgb[o + 1]!
      b0 = b1 = b2 = triRgb[o + 2]!
    } else {
      const o = Math.min(t * 3, Math.max(0, triRgb.length - 3))
      r0 = r1 = r2 = triRgb[o] ?? 0.78
      g0 = g1 = g2 = triRgb[o + 1] ?? 0.82
      b0 = b1 = b2 = triRgb[o + 2] ?? 0.91
    }
    const rs = [r0, r1, r2]
    const gs = [g0, g1, g2]
    const bs = [b0, b1, b2]
    for (let k = 0; k < 3; k++) {
      const vid = indices[t * 3 + k]
      v2[w * 3] = positions[vid * 3]
      v2[w * 3 + 1] = positions[vid * 3 + 1]
      v2[w * 3 + 2] = positions[vid * 3 + 2]
      rgb[w * 3] = rs[k]!
      rgb[w * 3 + 1] = gs[k]!
      rgb[w * 3 + 2] = bs[k]!
      i2[w] = w
      w++
    }
  }
  return { positions: v2, indices: i2, vertexColors: rgb }
}
