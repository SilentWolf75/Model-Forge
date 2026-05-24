import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import type {
  ThreeMfBuildObjectSummary,
  ThreeMfPackageMeta,
  ThreeMfProcessHints,
  TriangleMesh,
  TriangleMeshPlatePart,
  TriangleMeshPlateSubObject
} from '../mesh/types'
import { threeMfUnitToMmScale } from '../mesh/printSpace'
import {
  collectMaterialColorTables,
  expandIndexedMeshWithTriColors,
  linearRgbPaletteToHexList,
  readTriangleFaceRgbs
} from './threeMfColors'
import {
  collectBestFilamentHexesFromZip,
  extractFirstMetadataValue,
  extractThreeMfProcessHintsFromConfigXml,
  extractThreeMfProcessHintsFromJsonConfig,
  extractThreeMfSliceHintsFromConfigXml,
  extractThreeMfSliceHintsFromJsonConfig,
  loadFilamentPaletteFromZip,
  readTrianglePaintRgbFromPalette
} from './threeMfBambuPaint'

function normalizePath(name: string): string {
  return name.replace(/\\/g, '/').toLowerCase()
}

function normalizePartPath(part: string): string {
  return part.replace(/^[/\\]+/, '').replace(/\\/g, '/')
}

/**
 * Pure-numeric `<object id>` / `object_id` values may differ by leading zeros between slicer
 * metadata and OPC (`"02"` vs `"2"`). Canonical form keeps plate / extruder / name maps aligned.
 */
function canonical3mfObjectIdForKey(raw: string | number): string {
  const s = String(raw).trim()
  if (s.length === 0) return s
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10)
    return Number.isFinite(n) ? String(n) : s
  }
  return s
}

function oidInstMapKey(oid: string | number, inst: number): string {
  const i = Number.isFinite(inst) ? Math.floor(inst) : 0
  return `${canonical3mfObjectIdForKey(oid)}:${i}`
}

/** Re-key `objectId:instance → value` maps so `"02:0"` and `"2:0"` collapse. */
function normalizeOidInstMapKeys(m: Map<string, number> | null): Map<string, number> | null {
  if (!m || m.size === 0) return m
  const out = new Map<string, number>()
  for (const [k, v] of m) {
    const colon = k.lastIndexOf(':')
    const rawOid = colon >= 0 ? k.slice(0, colon).trim() : k.trim()
    const instRaw = colon >= 0 ? k.slice(colon + 1).trim() : '0'
    const inst = Number(instRaw)
    out.set(oidInstMapKey(rawOid, Number.isFinite(inst) ? inst : 0), v)
  }
  return out
}

/** Match a ZIP member path case-insensitively (OPC uses `/3D/...`; some zips differ in case). */
function findZipEntry(zip: JSZip, logicalPath: string): JSZip.JSZipObject | null {
  const norm = normalizePartPath(logicalPath)
  const direct = zip.files[norm]
  if (direct && !direct.dir) return direct
  const lower = norm.toLowerCase()
  for (const key of Object.keys(zip.files)) {
    if (zip.files[key].dir) continue
    if (normalizePartPath(key).toLowerCase() === lower) return zip.files[key]
  }
  return null
}

/** All model part paths from OPC `[Content_Types].xml` overrides (some packages list several). */
async function modelPartPathsFromContentTypesAll(zip: JSZip): Promise<string[]> {
  const ctKey = Object.keys(zip.files).find((n) => /^\[Content_Types\]\.xml$/i.test(n))
  if (!ctKey) return []
  let xml = await zip.files[ctKey].async('string')
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    trimValues: true
  })
  let doc: Record<string, unknown>
  try {
    doc = parser.parse(xml) as Record<string, unknown>
  } catch {
    return []
  }
  const types = (doc.Types ?? doc.types) as Record<string, unknown> | undefined
  if (!types) return []
  const overrides = normalizeArray(types.Override)
  const out: string[] = []
  for (const o of overrides) {
    const row = o as { '@_PartName'?: string; '@_ContentType'?: string }
    const part = row['@_PartName']
    const ct = (row['@_ContentType'] ?? '').toLowerCase()
    if (!part) continue
    const pn = normalizePartPath(part).toLowerCase()
    const isModelCt =
      ct.includes('3dmanufacturing-3dmodel') ||
      (ct.includes('3dmanufacturing') && ct.includes('model') && ct.includes('xml'))
    if (isModelCt) {
      out.push(normalizePartPath(part))
      continue
    }
    /** Some slicers mislabel CT but still ship a mesh under `3D/*.model`. */
    if (pn.endsWith('.model') && /(^|\/)3d\//.test(pn)) out.push(normalizePartPath(part))
  }
  return out
}

/** Default model relationship targets from package root `_rels/.rels`. */
async function modelPartPathsFromOpcRels(zip: JSZip): Promise<string[]> {
  const relEntry = findZipEntry(zip, '_rels/.rels')
  if (!relEntry) return []
  let xml = await relEntry.async('string')
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    trimValues: true
  })
  let doc: Record<string, unknown>
  try {
    doc = parser.parse(xml) as Record<string, unknown>
  } catch {
    return []
  }
  const relRoot = (doc.Relationships ?? doc.relationships) as Record<string, unknown> | undefined
  const rels = normalizeArray(relRoot?.Relationship ?? relRoot?.relationship)
  const out: string[] = []
  for (const r of rels) {
    const row = r as { '@_Target'?: string; '@_Type'?: string }
    const type = (row['@_Type'] ?? '').toLowerCase()
    const target = row['@_Target']
    if (!target) continue
    if (type.includes('3dmanufacturing') && type.includes('3dmodel')) {
      out.push(normalizePartPath(target))
    }
  }
  return out
}

function uniqPartPaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const n = normalizePartPath(p)
    if (!n) continue
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(n)
  }
  return out
}

/** Ordered ZIP members to try as the main 3MF model document. */
async function listModelZipCandidates(zip: JSZip): Promise<JSZip.JSZipObject[]> {
  const pathHints: string[] = []
  pathHints.push(...(await modelPartPathsFromOpcRels(zip)))
  pathHints.push(...(await modelPartPathsFromContentTypesAll(zip)))
  const entries = Object.values(zip.files).filter((e) => !e.dir)
  const fb = pickModelEntry(entries)
  if (fb) pathHints.push(fb.name)
  const models = entries.filter((f) => normalizePath(f.name).endsWith('.model'))
  models.sort((a, b) => {
    const pa = normalizePath(a.name).includes('/3d/') ? 0 : 1
    const pb = normalizePath(b.name).includes('/3d/') ? 0 : 1
    return pa - pb || a.name.localeCompare(b.name)
  })
  for (const m of models) pathHints.push(m.name)

  const objs: JSZip.JSZipObject[] = []
  for (const p of uniqPartPaths(pathHints)) {
    const z = findZipEntry(zip, p)
    if (z) objs.push(z)
  }
  /** Bambu split / Liene-style packages may ship extra `.model` parts not listed in `[Content_Types].xml`. */
  const seenLower = new Set(objs.map((o) => normalizePath(o.name)))
  for (const e of entries) {
    if (e.dir) continue
    const n = normalizePath(e.name)
    if (!n.endsWith('.model')) continue
    if (seenLower.has(n)) continue
    seenLower.add(n)
    objs.push(e)
  }
  return objs
}

function pickModelEntry(files: JSZip.JSZipObject[]): JSZip.JSZipObject | null {
  const list = files.filter((f) => !f.dir)
  const byPath = (pred: (n: string) => boolean) => list.find((f) => pred(normalizePath(f.name)))

  const preferred =
    byPath((n) => n.endsWith('/3d/3dmodel.model') || n.endsWith('3d/3dmodel.model')) ??
    byPath((n) => n.endsWith('/3d/3dmodel.xml') || n.endsWith('3d/3dmodel.xml')) ??
    byPath((n) => n.endsWith('3dmodel.model') || n.endsWith('/3dmodel.model')) ??
    byPath((n) => n.endsWith('3dmodel.xml')) ??
    list.find((f) => /(^|\/)3dmodel\.model$/i.test(f.name)) ??
    list.find((f) => /(^|\/)3dmodel\.xml$/i.test(f.name)) ??
    list.find((f) => f.name.endsWith('3Dmodel.model'))

  if (preferred) return preferred
  /** Some slicers use `3D/Model.model`, nested folders, or localized names — any `.model` under `3d/`. */
  const any3dModel = list.find((f) => {
    const n = normalizePath(f.name)
    return /(^|\/)3d\//.test(n) && n.endsWith('.model')
  })
  if (any3dModel) return any3dModel
  return list.find((f) => f.name.toLowerCase().endsWith('.model')) ?? null
}

function normalizeArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

/** fast-xml-parser sometimes returns `[node]` for a single root or child element. */
function unwrapXmlRecord(v: unknown): Record<string, unknown> | null {
  if (v === undefined || v === null) return null
  if (Array.isArray(v)) {
    const first = v[0]
    return first && typeof first === 'object' ? (first as Record<string, unknown>) : null
  }
  return typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function findModelRoot(doc: Record<string, unknown>): Record<string, unknown> | null {
  const rawModel =
    (doc as { model?: unknown }).model ??
    (doc as { Model?: unknown }).Model ??
    (doc as { '3dmodel'?: unknown })['3dmodel']
  const model = unwrapXmlRecord(rawModel)
  if (model) return model
  for (const v of Object.values(doc)) {
    if (v && typeof v === 'object' && 'resources' in (v as object)) {
      return v as Record<string, unknown>
    }
  }
  return null
}

/** Walk nested maps (namespaces / wrappers) to find the `{ resources: { object: … } }` model tree. */
function deepFindModelWithResources(doc: Record<string, unknown>): Record<string, unknown> | null {
  const seen = new Set<unknown>()
  const stack: unknown[] = [doc]
  while (stack.length) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue
    seen.add(cur)
    const o = cur as Record<string, unknown>
    const res = o.resources ?? o.Resources
    if (res && typeof res === 'object') {
      const ro = res as { object?: unknown; Object?: unknown }
      if (ro.object !== undefined || ro.Object !== undefined) return o
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') stack.push(v)
    }
  }
  return null
}

/** 3MF ST_Matrix3D: M00 M01 M02 M10 M11 M12 M20 M21 M22 M30 M31 M32 (12 numbers). */
function parseTransform12(raw: string | undefined): Float64Array | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const parts = String(raw)
    .trim()
    .split(/\s+/)
    .map((s) => Number(s))
  if (parts.length !== 12 || parts.some((n) => Number.isNaN(n))) return null
  return new Float64Array(parts)
}

/** Column-major 4×4 from 3MF 12-tuple (maps column vector [x,y,z,1]). */
function mat4From3mf12(a: Float64Array): Float64Array {
  const [M00, M01, M02, M10, M11, M12, M20, M21, M22, M30, M31, M32] = a
  return new Float64Array([
    M00,
    M01,
    M02,
    0,
    M10,
    M11,
    M12,
    0,
    M20,
    M21,
    M22,
    0,
    M30,
    M31,
    M32,
    1
  ])
}

function identityMat4(): Float64Array {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

/** Column-major: out = a * b */
function multiplyMat4(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) {
        s += a[k * 4 + r] * b[c * 4 + k]
      }
      out[c * 4 + r] = s
    }
  }
  return out
}

/** Column-major 4×4 translation (mm). */
function translationMat4(tx: number, ty: number, tz: number): Float64Array {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1])
}

/**
 * Bambu Studio stores per-instance “assembly” placement (multi-plate layout) in
 * `Metadata/model_settings.config` as `<assemble_item transform="…" offset="…"/>`.
 * Map: resource object id (string) → instance index → matrix to left-multiply the build `<item>` transform.
 */
type BambuAssembleComposeMap = Map<string, Map<number, Float64Array>>

function parseTripleSpace(raw: string | undefined): [number, number, number] {
  if (raw === undefined || String(raw).trim() === '') return [0, 0, 0]
  const parts = String(raw)
    .trim()
    .split(/\s+/)
    .map((s) => Number(s))
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return [0, 0, 0]
  return [parts[0]!, parts[1]!, parts[2]!]
}

function walkXmlForAssembleItems(
  node: unknown,
  acc: { oid: string; iid: number; t12: Float64Array | null; off: string | undefined }[]
): void {
  if (node === undefined || node === null) return
  if (Array.isArray(node)) {
    for (const x of node) walkXmlForAssembleItems(x, acc)
    return
  }
  if (typeof node !== 'object') return
  const o = node as Record<string, unknown>
  for (const [k, v] of Object.entries(o)) {
    const base = k.includes(':') ? k.slice(k.lastIndexOf(':') + 1) : k
    if (base.toLowerCase() === 'assemble_item') {
      const rows = Array.isArray(v) ? v : [v]
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const r = row as Record<string, unknown>
        /** Bambu/Orca use `object_id` / `instance_id`; core 3MF `<item>` uses `objectid` / `instanceid`. */
        const oidRaw =
          r['@_object_id'] ??
          r['@_Object_id'] ??
          r['@_objectid'] ??
          r['@_Objectid'] ??
          r.object_id ??
          r.objectid ??
          r.Objectid
        if (oidRaw === undefined || oidRaw === null) continue
        const iidRaw =
          r['@_instance_id'] ??
          r['@_Instance_id'] ??
          r['@_instanceid'] ??
          r['@_Instanceid'] ??
          r.instance_id ??
          r.instanceid ??
          r.Instanceid ??
          0
        const iid = Number(iidRaw)
        const tr = r['@_transform'] ?? r.transform
        const t12 = typeof tr === 'string' || typeof tr === 'number' ? parseTransform12(String(tr)) : null
        const off = r['@_offset'] ?? r.offset
        acc.push({ oid: String(oidRaw), iid: Number.isFinite(iid) ? iid : 0, t12, off: off !== undefined && off !== null ? String(off) : undefined })
      }
      continue
    }
    walkXmlForAssembleItems(v, acc)
  }
}

type GeomBucket = {
  posChunks: Float32Array[]
  idxChunks: Uint32Array[]
  colChunks: (Float32Array | null)[]
  vertexOffset: { value: number }
  /** Per-build-item sub-buckets. Each entry is one `<build><item>` instance (including repeated
   *  instances of the same objectid). Populated during collection to produce `subObjects` on the
   *  finished `TriangleMeshPlatePart` so the viewer can render each object as a separate mesh.
   *  Capped at MAX_ITEM_BUCKETS_PER_PLATE to avoid excessive draw-call counts for large plates. */
  itemBuckets?: Array<{ extruderSlot: number; bucket: GeomBucket }>
}

const MAX_ITEM_BUCKETS_PER_PLATE = 50

/**
 * Bambu `Metadata/slice_info.config`: per-sliced `<plate>` with `<metadata key="index" value="…"/>`
 * and `<object identify_id="…"/>`. `identify_id` links to `<model_instance>` metadata in `model_settings`.
 */
function mergeIdentifyToOidInstanceFromModelSettingsXml(xml: string, identToOi: Map<number, string>): void {
  const instFragRe =
    /<(?:[\w-]+:)?model_instance\b[^>]*(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?model_instance\s*>)/gi
  let im: RegExpExecArray | null
  while ((im = instFragRe.exec(xml)) !== null) {
    const inner = im[1] ?? ''
    const whole = im[0]
    const idfM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']identify_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']identify_id["']/i.exec(inner) ??
      /\bidentify_id\s*=\s*["']([^"']*)["']/i.exec(whole)
    if (!idfM || String(idfM[1]).trim() === '') continue
    const ident = Number(String(idfM[1]).trim())
    if (!Number.isFinite(ident)) continue
    const oidM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']object_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']object_id["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bkey\s*=\s*["']objectid["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']objectid["']/i.exec(inner) ??
      /\bobject_id\s*=\s*["']([^"']*)["']/i.exec(whole) ??
      /\bobjectid\s*=\s*["']([^"']*)["']/i.exec(whole)
    const iidM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']instance_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']instance_id["']/i.exec(inner) ??
      /\binstance_id\s*=\s*["']([^"']*)["']/i.exec(whole) ??
      /\binstanceid\s*=\s*["']([^"']*)["']/i.exec(whole)
    if (!oidM || String(oidM[1]).trim() === '') continue
    const oid = String(oidM[1]).trim()
    const iid = iidM && String(iidM[1]).trim() !== '' ? Number(iidM[1]) : 0
    identToOi.set(ident, oidInstMapKey(oid, Number.isFinite(iid) ? iid : 0))
  }
}

function extractPlatesArrayFromJsonSettings(root: Record<string, unknown>): unknown[] | null {
  const tryArr = (v: unknown): unknown[] | null =>
    Array.isArray(v) && v.length > 0 ? (v as unknown[]) : null
  const keys = ['plates', 'plate_list', 'PLATES', 'PlateList', 'plateList'] as const
  for (const k of keys) {
    const a = tryArr(root[k])
    if (a) return a
  }
  const cfg = root.config
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    const co = cfg as Record<string, unknown>
    for (const k of keys) {
      const a = tryArr(co[k])
      if (a) return a
    }
  }
  return null
}

function normalizeJsonPlateInstances(plate: Record<string, unknown>): unknown[] {
  const raw =
    plate.model_instance ??
    plate.model_instances ??
    plate.modelInstance ??
    plate.instances ??
    plate.Models
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return [raw]
  return []
}

function readJsonModelInstanceOidIidIdent(inst: Record<string, unknown>): {
  oid: string
  iid: number
  ident: number | undefined
  /** 1-based extruder / filament slot when present in JSON metadata. */
  extruder?: number
  /** Display name from JSON metadata (`name`, `object_name`, …). */
  name?: string
} | null {
  let oid: string | undefined
  let iid = 0
  let ident: number | undefined
  let extruder: number | undefined
  let displayName: string | undefined
  const metaArr = inst.metadata ?? inst.Metadata
  if (Array.isArray(metaArr)) {
    const kv = new Map<string, string>()
    for (const row of metaArr) {
      if (!row || typeof row !== 'object') continue
      const m = row as Record<string, unknown>
      const k = String(m.key ?? m['@_key'] ?? m.name ?? '').toLowerCase()
      const v = m.value ?? m['@_value'] ?? m.content
      if (k.length > 0 && v !== undefined && v !== null) kv.set(k, String(v).trim())
    }
    const pick = (...names: string[]): string | undefined => {
      for (const n of names) {
        const t = kv.get(n.toLowerCase())
        if (t !== undefined && t !== '') return t
      }
      return undefined
    }
    oid = pick('object_id', 'objectid')
    const is = pick('instance_id', 'instanceid')
    if (is !== undefined) {
      const n = Number(is)
      if (Number.isFinite(n)) iid = n
    }
    const idf = pick('identify_id', 'identifyid')
    if (idf !== undefined) {
      const n = Number(idf)
      if (Number.isFinite(n)) ident = n
    }
    const exs = pick('extruder', 'nozzle', 'tool', 'ams', 'filament_id')
    if (exs !== undefined && exs !== '') {
      const n = Number(exs)
      if (Number.isFinite(n) && n >= 1) extruder = Math.floor(n)
    }
    const nm = pick('name', 'object_name', 'title', 'part_name', 'model_name')
    if (nm !== undefined && nm.length > 0) displayName = nm
  }
  if (oid === undefined || oid === '') {
    const r =
      inst.object_id ?? inst.objectId ?? inst.objectid ?? inst['@_object_id'] ?? inst['@_objectid']
    oid = r !== undefined && r !== null ? String(r).trim() : undefined
  }
  if (oid === undefined || oid === '') return null
  if (iid === 0) {
    const ii = inst.instance_id ?? inst.instanceId ?? inst.instanceid ?? inst['@_instance_id']
    if (ii !== undefined && ii !== null && String(ii).trim() !== '') {
      const n = Number(ii)
      if (Number.isFinite(n)) iid = n
    }
  }
  if (ident === undefined) {
    const idf = inst.identify_id ?? inst.identifyId ?? inst['@_identify_id']
    if (idf !== undefined && idf !== null && String(idf).trim() !== '') {
      const n = Number(idf)
      if (Number.isFinite(n)) ident = n
    }
  }
  if (extruder === undefined) {
    const er = inst.extruder ?? inst.filament_index ?? inst.filamentIndex ?? inst.nozzle ?? inst.tool
    if (er !== undefined && er !== null) {
      const n = Number(er)
      if (Number.isFinite(n) && n >= 1) extruder = Math.floor(n)
    }
  }
  if (displayName === undefined || displayName.trim() === '') {
    const nt = inst.name ?? inst.object_name ?? inst.objectName ?? inst.title
    if (nt !== undefined && nt !== null) {
      const s = String(nt).trim()
      if (s.length > 0) displayName = s
    }
  }
  return {
    oid,
    iid,
    ident,
    ...(extruder !== undefined ? { extruder } : {}),
    ...(displayName !== undefined && displayName.trim() !== '' ? { name: displayName.trim() } : {})
  }
}

/**
 * Some Bambu / Orca zips store `Metadata/model_settings.config` or `model_settings.json` as JSON
 * (no `<plate>` XML). Same plate / instance keys as the XML path.
 */
function tryMergePlateFromModelSettingsJson(
  text: string,
  merged: Map<string, number>,
  identToOi: Map<number, string>
): boolean {
  const t = text.trim()
  if (!t.startsWith('{')) return false
  let root: Record<string, unknown>
  try {
    root = JSON.parse(t) as Record<string, unknown>
  } catch {
    return false
  }
  const plates = extractPlatesArrayFromJsonSettings(root)
  if (!plates || plates.length === 0) return false
  let ordinal = 0
  let wrote = false
  for (const pr of plates) {
    ordinal++
    if (!pr || typeof pr !== 'object') continue
    const plate = pr as Record<string, unknown>
    const pidRaw =
      plate.plater_id ??
      plate.platerId ??
      plate.plate_index ??
      plate.plateIndex ??
      plate.index ??
      plate.Index
    let plateId = ordinal
    if (pidRaw !== undefined && pidRaw !== null && String(pidRaw).trim() !== '') {
      const n = Number(String(pidRaw).trim())
      if (Number.isFinite(n) && n >= 0) plateId = n
    }
    for (const inst of normalizeJsonPlateInstances(plate)) {
      if (!inst || typeof inst !== 'object') continue
      const row = readJsonModelInstanceOidIidIdent(inst as Record<string, unknown>)
      if (!row) continue
      const key = oidInstMapKey(row.oid, Number.isFinite(row.iid) ? row.iid : 0)
      merged.set(key, plateId)
      wrote = true
      if (row.ident !== undefined) identToOi.set(row.ident, key)
    }
  }
  return wrote
}

/**
 * Some Bambu JSON nests `model_instance` outside `plates[]`. Walk the tree and merge any
 * `metadata` block that has both `object_id` and `extruder`.
 */
function deepCollectJsonExtruderSlots(node: unknown, into: Map<string, number>): void {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const x of node) deepCollectJsonExtruderSlots(x, into)
    return
  }
  if (typeof node !== 'object') return
  const o = node as Record<string, unknown>
  const metaArr = o.metadata ?? o.Metadata
  if (Array.isArray(metaArr) && metaArr.length > 0) {
    const kv = new Map<string, string>()
    for (const row of metaArr) {
      if (!row || typeof row !== 'object') continue
      const m = row as Record<string, unknown>
      const k = String(m.key ?? m['@_key'] ?? m.name ?? '').toLowerCase()
      if (!k) continue
      const v = m.value ?? m['@_value'] ?? m.content
      if (v === undefined || v === null) continue
      const vs = String(v).trim()
      if (vs.length > 0) kv.set(k, vs)
    }
    const pick = (...names: string[]): string | undefined => {
      for (const n of names) {
        const t = kv.get(n.toLowerCase())
        if (t !== undefined && t !== '') return t
      }
      return undefined
    }
    const oid = pick('object_id', 'objectid')
    const exs = pick('extruder', 'nozzle', 'tool', 'ams', 'filament_id')
    if (oid && exs) {
      const slot = Number(exs)
      if (Number.isFinite(slot) && slot >= 1) {
        const iis = pick('instance_id', 'instanceid')
        const iid = iis !== undefined && iis !== '' ? Number(iis) : 0
        into.set(oidInstMapKey(oid, Number.isFinite(iid) ? iid : 0), Math.floor(slot))
      }
    }
  }
  for (const v of Object.values(o)) deepCollectJsonExtruderSlots(v, into)
}

/** Bambu JSON `model_settings`: `extruder` on each `model_instance` (XML path already covered). */
function tryMergeExtruderSlotsFromModelSettingsJson(text: string, into: Map<string, number>): boolean {
  const t = text.trim()
  if (!t.startsWith('{')) return false
  let root: Record<string, unknown>
  try {
    root = JSON.parse(t) as Record<string, unknown>
  } catch {
    return false
  }
  const plates = extractPlatesArrayFromJsonSettings(root)
  let wrote = false
  if (plates && plates.length > 0) {
    for (const pr of plates) {
      if (!pr || typeof pr !== 'object') continue
      const plate = pr as Record<string, unknown>
      for (const inst of normalizeJsonPlateInstances(plate)) {
        if (!inst || typeof inst !== 'object') continue
        const row = readJsonModelInstanceOidIidIdent(inst as Record<string, unknown>)
        if (!row || row.extruder === undefined) continue
        const key = oidInstMapKey(row.oid, Number.isFinite(row.iid) ? row.iid : 0)
        into.set(key, row.extruder)
        wrote = true
      }
    }
  }
  deepCollectJsonExtruderSlots(root, into)
  return wrote
}

function deepCollectJsonDisplayNames(node: unknown, into: Map<string, string>): void {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const x of node) deepCollectJsonDisplayNames(x, into)
    return
  }
  if (typeof node !== 'object') return
  const o = node as Record<string, unknown>
  const metaArr = o.metadata ?? o.Metadata
  if (Array.isArray(metaArr) && metaArr.length > 0) {
    const kv = new Map<string, string>()
    for (const row of metaArr) {
      if (!row || typeof row !== 'object') continue
      const m = row as Record<string, unknown>
      const k = String(m.key ?? m['@_key'] ?? m.name ?? '').toLowerCase()
      if (!k) continue
      const v = m.value ?? m['@_value'] ?? m.content
      if (v === undefined || v === null) continue
      const vs = String(v).trim()
      if (vs.length > 0) kv.set(k, vs)
    }
    const pick = (...names: string[]): string | undefined => {
      for (const n of names) {
        const t = kv.get(n.toLowerCase())
        if (t !== undefined && t !== '') return t
      }
      return undefined
    }
    const oid = pick('object_id', 'objectid')
    const label = pick('name', 'object_name', 'title', 'part_name', 'model_name')
    if (oid && label) {
      const iis = pick('instance_id', 'instanceid')
      const iid = iis !== undefined && iis !== '' ? Number(iis) : 0
      const instN = Number.isFinite(iid) ? iid : 0
      into.set(canonical3mfObjectIdForKey(oid), label)
      into.set(oidInstMapKey(oid, instN), label)
    }
  }
  for (const v of Object.values(o)) deepCollectJsonDisplayNames(v, into)
}

/** Bambu JSON `model_settings`: human names on `model_instance` metadata (OPC `<object name>` often empty). */
function tryMergeDisplayNamesFromModelSettingsJson(text: string, into: Map<string, string>): boolean {
  const t = text.trim()
  if (!t.startsWith('{')) return false
  let root: Record<string, unknown>
  try {
    root = JSON.parse(t) as Record<string, unknown>
  } catch {
    return false
  }
  const plates = extractPlatesArrayFromJsonSettings(root)
  let wrote = false
  if (plates && plates.length > 0) {
    for (const pr of plates) {
      if (!pr || typeof pr !== 'object') continue
      const plate = pr as Record<string, unknown>
      for (const inst of normalizeJsonPlateInstances(plate)) {
        if (!inst || typeof inst !== 'object') continue
        const row = readJsonModelInstanceOidIidIdent(inst as Record<string, unknown>)
        if (!row?.name || row.name.trim() === '') continue
        const label = row.name.trim()
        const instN = Number.isFinite(row.iid) ? row.iid : 0
        into.set(canonical3mfObjectIdForKey(row.oid), label)
        into.set(oidInstMapKey(row.oid, instN), label)
        wrote = true
      }
    }
  }
  deepCollectJsonDisplayNames(root, into)
  return wrote
}

/** Per-sliced `<plate>` block: `<metadata key="index"|"Index" value="…"/>`. */
function readSlicePlateIndexFromPlateBlock(block: string): number | undefined {
  const metaRe = /<\s*metadata\b([^>]*)\/?>/gi
  let m: RegExpExecArray | null
  while ((m = metaRe.exec(block)) !== null) {
    const attrs = m[1] ?? ''
    const km = /\bkey\s*=\s*["']([^"']+)["']/i.exec(attrs)
    const vm = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(attrs)
    if (!km || !vm) continue
    if (km[1].trim().toLowerCase() !== 'index') continue
    const plateId = Number(String(vm[1]).trim())
    if (Number.isFinite(plateId) && plateId >= 0) return plateId
  }
  return undefined
}

function mergePlateAssignmentsFromSliceInfoXml(
  xml: string,
  into: Map<string, number>,
  identToOi: Map<number, string>
): void {
  const plateRe = /<(?:[\w-]+:)?plate\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?plate\s*>/gi
  let plateMatch: RegExpExecArray | null
  while ((plateMatch = plateRe.exec(xml)) !== null) {
    const block = plateMatch[1] ?? ''
    const plateId = readSlicePlateIndexFromPlateBlock(block)
    if (plateId === undefined) continue
    const objRe = /<(?:[\w-]+:)?object\b[^>]*\bidentify_id\s*=\s*["']([^"']*)["']/gi
    let om: RegExpExecArray | null
    while ((om = objRe.exec(block)) !== null) {
      const ident = Number(String(om[1]).trim())
      if (!Number.isFinite(ident)) continue
      const oi = identToOi.get(ident)
      if (!oi) continue
      into.set(oi, plateId)
    }
  }
}

async function readSliceInfoConfigXml(zip: JSZip): Promise<string | null> {
  const entry = findZipEntry(zip, 'Metadata/slice_info.config')
  if (!entry) return null
  let xml = await entry.async('string')
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
  return xml
}

/**
 * Bambu / Orca `<model_instance>` uses `object_id` that may differ from OPC `<object id="…">` in
 * `3D/*.model`. Both are linked via `identify_id` on the resource `<object>`. Without this bridge,
 * `resolvePlateIdFromAssignment` never hits and all geometry lands on plate 0.
 */
async function enrichPlateAssignmentFromOpcObjectIdentifyId(
  zip: JSZip,
  merged: Map<string, number>,
  identToOi: Map<number, string>
): Promise<void> {
  if (identToOi.size === 0 || merged.size === 0) return
  const objectOpenRe = /<(?:[\w-]+:)?object\b([^>]*)\/?>/gi
  for (const key of Object.keys(zip.files)) {
    if (zip.files[key].dir) continue
    const n = normalizePath(key)
    if (!n.endsWith('.model') || !/(^|\/)3d\//.test(n)) continue
    let xml: string
    try {
      xml = await zip.files[key].async('string')
    } catch {
      continue
    }
    if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
    let m: RegExpExecArray | null
    objectOpenRe.lastIndex = 0
    while ((m = objectOpenRe.exec(xml)) !== null) {
      const attrs = m[1] ?? ''
      const idAttr =
        /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs) ?? /\bId\s*=\s*["']([^"']+)["']/i.exec(attrs)
      const identAttr = /\bidentify_id\s*=\s*["']([^"']+)["']/i.exec(attrs)
      if (!idAttr || !identAttr) continue
      const opcId = String(idAttr[1]).trim()
      if (!opcId) continue
      const ident = Number(String(identAttr[1]).trim())
      if (!Number.isFinite(ident)) continue
      const oiKey = identToOi.get(ident)
      if (!oiKey) continue
      const colon = oiKey.lastIndexOf(':')
      if (colon <= 0) continue
      const metaOid = oiKey.slice(0, colon).trim()
      const metaIid = Number(oiKey.slice(colon + 1))
      if (!metaOid) continue
      const plate = lookupPlateForOidInst(merged, metaOid, Number.isFinite(metaIid) ? metaIid : 0)
      if (plate === undefined) continue
      for (let ins = 0; ins <= 12; ins++) {
        const k = oidInstMapKey(opcId, ins)
        if (!merged.has(k)) merged.set(k, plate)
      }
    }
  }
}

/** `objectId:instanceIndex` → slicer plate id (as stored, often 1-based). */
async function loadBambuPlateObjectInstanceMap(zip: JSZip): Promise<Map<string, number> | null> {
  /**
   * Bambu / Orca store `<plate>` + `<model_instance>` under `Metadata/model_settings.config`
   * (same document as `<assemble>`). Some forks ship extra `metadata/*.config` files only.
   * Sliced Bambu projects also ship `Metadata/slice_info.config` with `identify_id` → plate `index`.
   */
  const merged = new Map<string, number>()
  const identToOi = new Map<number, string>()
  const cfgParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: true,
    trimValues: true,
    ignoreDeclaration: true
  })
  const xmlChunks = await listMetadataConfigXmlForPlateScan(zip)
  for (const xml of xmlChunks) {
    const chunk = xml.trim()
    if (chunk.startsWith('{')) {
      tryMergePlateFromModelSettingsJson(xml, merged, identToOi)
      continue
    }
    mergePlateAssignmentsFromRawConfigXml(xml, merged)
    mergePlateAssignmentsFromOrphanModelInstances(xml, merged)
    // Bambu newer format: plater_id on top-level <object> elements (same as extruder).
    mergePlateAssignmentsFromTopLevelConfigObjects(xml, merged)
    mergeIdentifyToOidInstanceFromModelSettingsXml(xml, identToOi)
    let doc: Record<string, unknown>
    try {
      doc = cfgParser.parse(xml) as Record<string, unknown>
    } catch {
      continue
    }
    const part = collectPlateAssignmentsFromDoc(doc)
    for (const [k, v] of part) merged.set(k, v)
  }
  const sliceXml = await readSliceInfoConfigXml(zip)
  if (sliceXml && identToOi.size > 0) {
    mergePlateAssignmentsFromSliceInfoXml(sliceXml, merged, identToOi)
  }
  await enrichPlateAssignmentFromOpcObjectIdentifyId(zip, merged, identToOi)
  return merged.size > 0 ? merged : null
}

function deepFindMetadataValue(root: unknown, wantKey: string): string | undefined {
  const lk = wantKey.toLowerCase()
  const walk = (n: unknown): string | undefined => {
    if (n === undefined || n === null) return undefined
    if (Array.isArray(n)) {
      for (const x of n) {
        const r = walk(x)
        if (r !== undefined) return r
      }
      return undefined
    }
    if (typeof n !== 'object') return undefined
    const o = n as Record<string, unknown>
    for (const [k, v] of Object.entries(o)) {
      const base = k.includes(':') ? k.slice(k.lastIndexOf(':') + 1) : k
      if (base.toLowerCase() === 'metadata') {
        for (const item of normalizeArray(v)) {
          if (!item || typeof item !== 'object') continue
          const row = item as Record<string, unknown>
          const key = String(
            row['@_key'] ?? row['@_Key'] ?? row.key ?? row['@_name'] ?? row['@_Name'] ?? row.name ?? ''
          )
            .toLowerCase()
            .trim()
          const val = row['@_value'] ?? row['@_Value'] ?? row.value ?? row['@_content'] ?? row['@_Content']
          if (key === lk && val !== undefined && val !== null) return String(val).trim()
        }
      } else {
        const r = walk(v)
        if (r !== undefined) return r
      }
    }
    return undefined
  }
  return walk(root)
}

/** All `<metadata key=… value=…/>` nodes under a subtree (handles nested wrappers from fast-xml-parser). */
function collectAllMetadataKeyValues(root: unknown): Map<string, string> {
  const m = new Map<string, string>()
  const walk = (n: unknown): void => {
    if (n === undefined || n === null) return
    if (Array.isArray(n)) {
      for (const x of n) walk(x)
      return
    }
    if (typeof n !== 'object') return
    const o = n as Record<string, unknown>
    for (const [k, v] of Object.entries(o)) {
      const base = k.includes(':') ? k.slice(k.lastIndexOf(':') + 1) : k
      if (base.toLowerCase() === 'metadata') {
        for (const item of normalizeArray(v)) {
          if (!item || typeof item !== 'object') continue
          const row = item as Record<string, unknown>
          const key = String(
            row['@_key'] ?? row['@_Key'] ?? row.key ?? row['@_name'] ?? row['@_Name'] ?? row.name ?? ''
          )
            .toLowerCase()
            .trim()
          const val = row['@_value'] ?? row['@_Value'] ?? row.value ?? row['@_content'] ?? row['@_Content']
          if (key.length > 0 && val !== undefined && val !== null) m.set(key, String(val).trim())
        }
      } else if (typeof v === 'object') {
        walk(v)
      }
    }
  }
  walk(root)
  return m
}

function findPlateSubtrees(node: unknown, acc: Record<string, unknown>[]): void {
  if (node === undefined || node === null) return
  if (Array.isArray(node)) {
    for (const x of node) findPlateSubtrees(x, acc)
    return
  }
  if (typeof node !== 'object') return
  const o = node as Record<string, unknown>
  for (const [k, v] of Object.entries(o)) {
    const base = k.includes(':') ? k.slice(k.lastIndexOf(':') + 1) : k
    if (base.toLowerCase() === 'plate') {
      for (const p of normalizeArray(v)) {
        if (p && typeof p === 'object') acc.push(p as Record<string, unknown>)
      }
      continue
    }
    findPlateSubtrees(v, acc)
  }
}

/**
 * Bambu `model_settings.config` lists instances as `<plate>…<object id="…" instanceid="…">` (not only
 * `<model_instance>`). Those must map to the same `objectId:instanceId → plateId` keys as `<build>`.
 */
function mergePlateTabObjectRefsFromPlateBlock(block: string, plateId: number, into: Map<string, number>): void {
  const objTagRe = /<(?:[\w-]+:)?object\b([^>]*?)(?:\/>|>)/gi
  let om: RegExpExecArray | null
  objTagRe.lastIndex = 0
  while ((om = objTagRe.exec(block)) !== null) {
    const attrs = om[1] ?? ''
    const idM = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)
    if (!idM || String(idM[1]).trim() === '') continue
    const oid = String(idM[1]).trim()
    const instM =
      /\binstanceid\s*=\s*["']([^"']*)["']/i.exec(attrs) ?? /\binstance_id\s*=\s*["']([^"']*)["']/i.exec(attrs)
    const iid = instM && String(instM[1]).trim() !== '' ? Number(instM[1]) : 0
    const key = oidInstMapKey(oid, Number.isFinite(iid) ? iid : 0)
    into.set(key, plateId)
  }
}

function readOidInstanceFromPlateLayoutObject(ob: Record<string, unknown>): { oid: string; iid: number } | null {
  const meta = collectAllMetadataKeyValues(ob)
  let oid = meta.get('object_id') ?? meta.get('objectid')
  if (!oid || String(oid).trim() === '') {
    const idRaw = ob['@_id'] ?? ob['@_objectid'] ?? ob['@_Objectid'] ?? ob.id ?? ob.objectid
    oid = idRaw !== undefined && idRaw !== null ? String(idRaw).trim() : ''
  }
  if (!String(oid).trim()) return null
  let iid = 0
  const mi = meta.get('instance_id') ?? meta.get('instanceid')
  if (mi !== undefined && String(mi).trim() !== '') {
    const n = Number(mi)
    if (Number.isFinite(n)) iid = n
  } else {
    const legacy = ob['@_instanceid'] ?? ob['@_instance_id'] ?? ob['@_Instanceid'] ?? ob.instanceid
    if (legacy !== undefined && legacy !== null && String(legacy).trim() !== '') {
      const n = Number(legacy)
      if (Number.isFinite(n)) iid = n
    }
  }
  return { oid: String(oid).trim(), iid }
}

function collectPlateLayoutObjectNodes(plate: Record<string, unknown>): Record<string, unknown>[] {
  const raw = plate.object ?? plate.Object
  return normalizeArray(raw).filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object') as Record<
    string,
    unknown
  >[]
}

function findModelInstanceSubtreesInPlate(plate: Record<string, unknown>, acc: Record<string, unknown>[]): void {
  const walk = (node: unknown): void => {
    if (node === undefined || node === null) return
    if (Array.isArray(node)) {
      for (const x of node) walk(x)
      return
    }
    if (typeof node !== 'object') return
    const o = node as Record<string, unknown>
    for (const [k, v] of Object.entries(o)) {
      const base = k.includes(':') ? k.slice(k.lastIndexOf(':') + 1) : k
      if (base.toLowerCase() === 'model_instance') {
        for (const inst of normalizeArray(v)) {
          if (inst && typeof inst === 'object') acc.push(inst as Record<string, unknown>)
        }
      } else {
        walk(v)
      }
    }
  }
  walk(plate)
}

function readObjectIdInstanceIdFromModelInstance(inst: Record<string, unknown>): { oid: string; iid: number } | null {
  const meta = collectAllMetadataKeyValues(inst)
  const oidFromMeta = meta.get('object_id') ?? meta.get('objectid')
  const iisFromMeta = meta.get('instance_id') ?? meta.get('instanceid')
  const oidFromAttr =
    inst['@_object_id'] ??
    inst['@_objectid'] ??
    inst['@_Object_id'] ??
    inst['@_Objectid'] ??
    inst['@_ObjectID']
  const oidRaw =
    oidFromMeta !== undefined && String(oidFromMeta).trim() !== ''
      ? String(oidFromMeta).trim()
      : oidFromAttr !== undefined && oidFromAttr !== null
        ? String(oidFromAttr).trim()
        : ''
  if (!oidRaw) return null
  let iid = 0
  if (iisFromMeta !== undefined && String(iisFromMeta).trim() !== '') {
    const n = Number(iisFromMeta)
    iid = Number.isFinite(n) ? n : 0
  } else {
    const a =
      inst['@_instance_id'] ??
      inst['@_instanceid'] ??
      inst['@_Instance_id'] ??
      inst['@_Instanceid'] ??
      inst['@_InstanceID']
    if (a !== undefined && a !== null) {
      const n = Number(a)
      iid = Number.isFinite(n) ? n : 0
    }
  }
  return { oid: oidRaw, iid }
}

/**
 * When `plater_id` is missing, every plate used to default to id 1 and merged into one bucket.
 * Use document order as a stable fallback id (1-based).
 */
function collectPlateAssignmentsFromDoc(doc: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>()
  const plates: Record<string, unknown>[] = []
  findPlateSubtrees(doc, plates)
  let plateOrdinal = 0
  for (const plate of plates) {
    plateOrdinal++
    const pidRaw =
      deepFindMetadataValue(plate, 'plater_id') ??
      deepFindMetadataValue(plate, 'id') ??
      deepFindMetadataValue(plate, 'plate_index') ??
      deepFindMetadataValue(plate, 'index')
    let plateId: number
    if (pidRaw !== undefined && String(pidRaw).trim() !== '') {
      const n = Number(String(pidRaw).trim())
      plateId = Number.isFinite(n) && n >= 0 ? n : plateOrdinal
    } else {
      plateId = plateOrdinal
    }
    const instances: Record<string, unknown>[] = []
    findModelInstanceSubtreesInPlate(plate, instances)
    for (const inst of instances) {
      const idPair = readObjectIdInstanceIdFromModelInstance(inst)
      if (!idPair) continue
      const iid = Number.isFinite(idPair.iid) ? idPair.iid : 0
      out.set(oidInstMapKey(idPair.oid, iid), plateId)
    }
    for (const ob of collectPlateLayoutObjectNodes(plate)) {
      const ref = readOidInstanceFromPlateLayoutObject(ob)
      if (!ref) continue
      const iid = Number.isFinite(ref.iid) ? ref.iid : 0
      out.set(oidInstMapKey(ref.oid, iid), plateId)
    }
  }
  return out
}

/** Fill missing keys when DOM parsing drops plate metadata (malformed XML, odd namespaces). */
function mergePlateAssignmentsFromRawConfigXml(xml: string, into: Map<string, number>): void {
  const plateRe = /<(?:[\w-]+:)?plate\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?plate\s*>/gi
  let plateMatch: RegExpExecArray | null
  let plateOrdinal = 0
  while ((plateMatch = plateRe.exec(xml)) !== null) {
    plateOrdinal++
    const block = plateMatch[1] ?? ''
    const platerM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']plater_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(block) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']plater_id["']/i.exec(block)
    const plateTabIdM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(block) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']id["']/i.exec(block)
    let plateId: number
    if (platerM && String(platerM[1]).trim() !== '') {
      const n = Number(String(platerM[1]).trim())
      plateId = Number.isFinite(n) && n >= 0 ? n : plateOrdinal
    } else if (plateTabIdM && String(plateTabIdM[1]).trim() !== '') {
      const n = Number(String(plateTabIdM[1]).trim())
      plateId = Number.isFinite(n) && n >= 0 ? n : plateOrdinal
    } else {
      plateId = plateOrdinal
    }
    const instFragRe =
      /<(?:[\w-]+:)?model_instance\b[^>]*(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?model_instance\s*>)/gi
    let im: RegExpExecArray | null
    while ((im = instFragRe.exec(block)) !== null) {
      const inner = im[1] ?? ''
      const whole = im[0]
      const oidM =
        /<\s*metadata[^>]*\bkey\s*=\s*["']object_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
        /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']object_id["']/i.exec(inner) ??
        /<\s*metadata[^>]*\bkey\s*=\s*["']objectid["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
        /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']objectid["']/i.exec(inner) ??
        /\bobject_id\s*=\s*["']([^"']*)["']/i.exec(whole) ??
        /\bobjectid\s*=\s*["']([^"']*)["']/i.exec(whole)
      const iidM =
        /<\s*metadata[^>]*\bkey\s*=\s*["']instance_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
        /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']instance_id["']/i.exec(inner) ??
        /\binstance_id\s*=\s*["']([^"']*)["']/i.exec(whole) ??
        /\binstanceid\s*=\s*["']([^"']*)["']/i.exec(whole)
      if (!oidM || String(oidM[1]).trim() === '') continue
      const oid = String(oidM[1]).trim()
      const iid = iidM && String(iidM[1]).trim() !== '' ? Number(iidM[1]) : 0
      const key = oidInstMapKey(oid, Number.isFinite(iid) ? iid : 0)
      if (!into.has(key)) into.set(key, plateId)
    }
    mergePlateTabObjectRefsFromPlateBlock(block, plateId, into)
  }
}

/**
 * Some Bambu/MakerWorld exports list `<model_instance>` with `<metadata key="plater_id">` on each
 * instance without wrapping `<plate>` blocks — `mergePlateAssignmentsFromRawConfigXml` would miss them.
 */
function mergePlateAssignmentsFromOrphanModelInstances(xml: string, into: Map<string, number>): void {
  const instFragRe =
    /<(?:[\w-]+:)?model_instance\b[^>]*(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?model_instance\s*>)/gi
  let im: RegExpExecArray | null
  while ((im = instFragRe.exec(xml)) !== null) {
    const inner = im[1] ?? ''
    const whole = im[0]
    const platerM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']plater_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']plater_id["']/i.exec(inner)
    let plateId = 1
    if (platerM && String(platerM[1]).trim() !== '') {
      const n = Number(String(platerM[1]).trim())
      if (Number.isFinite(n) && n >= 0) plateId = n
    }
    const oidM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']object_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']object_id["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bkey\s*=\s*["']objectid["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']objectid["']/i.exec(inner) ??
      /\bobject_id\s*=\s*["']([^"']*)["']/i.exec(whole) ??
      /\bobjectid\s*=\s*["']([^"']*)["']/i.exec(whole)
    const iidM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']instance_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']instance_id["']/i.exec(inner) ??
      /\binstance_id\s*=\s*["']([^"']*)["']/i.exec(whole) ??
      /\binstanceid\s*=\s*["']([^"']*)["']/i.exec(whole)
    if (!oidM || String(oidM[1]).trim() === '') continue
    const oid = String(oidM[1]).trim()
    const iid = iidM && String(iidM[1]).trim() !== '' ? Number(iidM[1]) : 0
    const key = oidInstMapKey(oid, Number.isFinite(iid) ? iid : 0)
    if (!into.has(key)) into.set(key, plateId)
  }
}

function mergeExtrudersFromModelInstancesInPlateBlock(block: string, into: Map<string, number>): void {
  const instFragRe =
    /<(?:[\w-]+:)?model_instance\b[^>]*(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?model_instance\s*>)/gi
  let im: RegExpExecArray | null
  while ((im = instFragRe.exec(block)) !== null) {
    const inner = im[1] ?? ''
    const whole = im[0]
    const extM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']extruder["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']extruder["']/i.exec(inner)
    if (!extM || String(extM[1]).trim() === '') continue
    const slot = Number(String(extM[1]).trim())
    if (!Number.isFinite(slot) || slot < 1) continue
    const oidM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']object_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']object_id["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bkey\s*=\s*["']objectid["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']objectid["']/i.exec(inner) ??
      /\bobject_id\s*=\s*["']([^"']*)["']/i.exec(whole) ??
      /\bobjectid\s*=\s*["']([^"']*)["']/i.exec(whole)
    const iidM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']instance_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']instance_id["']/i.exec(inner) ??
      /\binstance_id\s*=\s*["']([^"']*)["']/i.exec(whole) ??
      /\binstanceid\s*=\s*["']([^"']*)["']/i.exec(whole)
    if (!oidM || String(oidM[1]).trim() === '') continue
    const oid = String(oidM[1]).trim()
    const iid = iidM && String(iidM[1]).trim() !== '' ? Number(iidM[1]) : 0
    into.set(oidInstMapKey(oid, Number.isFinite(iid) ? iid : 0), Math.floor(slot))
  }
}

function mergeExtrudersFromPlateObjectElementsInPlateBlock(block: string, into: Map<string, number>): void {
  const objFullRe = /<(?:[\w-]+:)?object\b([^>]*?)>([\s\S]*?)<\/(?:[\w-]+:)?object\s*>/gi
  let om: RegExpExecArray | null
  while ((om = objFullRe.exec(block)) !== null) {
    const attrs = om[1] ?? ''
    const inner = om[2] ?? ''
    const idM = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)
    if (!idM || String(idM[1]).trim() === '') continue
    const oid = String(idM[1]).trim()
    const instM =
      /\binstanceid\s*=\s*["']([^"']*)["']/i.exec(attrs) ?? /\binstance_id\s*=\s*["']([^"']*)["']/i.exec(attrs)
    const iid = instM && String(instM[1]).trim() !== '' ? Number(instM[1]) : 0
    const extM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']extruder["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']extruder["']/i.exec(inner)
    if (!extM || String(extM[1]).trim() === '') continue
    const slot = Number(String(extM[1]).trim())
    if (!Number.isFinite(slot) || slot < 1) continue
    into.set(oidInstMapKey(oid, Number.isFinite(iid) ? iid : 0), Math.floor(slot))
  }
}

/**
 * Bambu `model_settings.config` links slicer "config object IDs" to 3MF mesh object IDs via
 * `<object id="N"><part source_object_id="M"/>`. When `plateAssignment` / `extruderMap` are keyed
 * on config IDs but the model XML uses mesh IDs, nothing matches. This pass adds mesh-ID keys
 * (same plate/extruder value) so the geometry bucketing works for single-file Bambu 3MFs.
 */
async function expandMapsWithSourceObjectIds(
  zip: JSZip,
  plateAssignment: Map<string, number>,
  extruderMap: Map<string, number>
): Promise<void> {
  if (plateAssignment.size === 0 && extruderMap.size === 0) return
  const xmlChunks = await listMetadataConfigXmlForPlateScan(zip)
  for (const xml of xmlChunks) {
    if (xml.trim().startsWith('{')) continue
    const objRe = /<(?:[\w-]+:)?object\b([^>]*?)>([\s\S]*?)<\/(?:[\w-]+:)?object\s*>/gi
    let om: RegExpExecArray | null
    while ((om = objRe.exec(xml)) !== null) {
      const attrs = om[1] ?? ''
      const inner = om[2] ?? ''
      const idM = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)
      if (!idM) continue
      const configOid = String(idM[1]).trim()
      const configKey = oidInstMapKey(configOid, 0)
      const plateVal = plateAssignment.get(configKey)
      const extVal = extruderMap.get(configKey)
      if (plateVal === undefined && extVal === undefined) continue
      // Find every <part source_object_id="M"> inside this config object → M is the mesh ID
      const partRe = /<(?:[\w-]+:)?part\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?part\s*>/gi
      let pm: RegExpExecArray | null
      while ((pm = partRe.exec(inner)) !== null) {
        const partInner = pm[1] ?? ''
        const srcM =
          /<\s*metadata[^>]*\bkey\s*=\s*["']source_object_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(partInner) ??
          /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']source_object_id["']/i.exec(partInner)
        if (!srcM) continue
        const meshOid = String(srcM[1]).trim()
        if (!meshOid || meshOid === configOid) continue
        const meshKey = oidInstMapKey(meshOid, 0)
        if (plateVal !== undefined && !plateAssignment.has(meshKey)) plateAssignment.set(meshKey, plateVal)
        if (extVal !== undefined && !extruderMap.has(meshKey)) extruderMap.set(meshKey, extVal)
      }
    }
  }
}

/**
 * Bambu `model_settings.config` (newer format): extruder is a direct child metadata of
 * top-level `<object id="N">` elements, not nested inside `<plate>` blocks.
 *   <object id="10">
 *     <metadata key="extruder" value="2"/>
 *   </object>
 */
/**
 * Bambu newer format: `plater_id` lives on top-level `<object id="N">` elements in
 * model_settings.config, NOT inside `<plate>` blocks.  Fill any missing keys so
 * `expandMapsWithSourceObjectIds` has config-object IDs to follow.
 */
function mergePlateAssignmentsFromTopLevelConfigObjects(xml: string, into: Map<string, number>): void {
  const objRe = /<(?:[\w-]+:)?object\b([^>]*?)>([\s\S]*?)<\/(?:[\w-]+:)?object\s*>/gi
  let om: RegExpExecArray | null
  while ((om = objRe.exec(xml)) !== null) {
    const attrs = om[1] ?? ''
    const inner = om[2] ?? ''
    const idM = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)
    if (!idM || String(idM[1]).trim() === '') continue
    const oid = String(idM[1]).trim()
    const plateM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']plater_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']plater_id["']/i.exec(inner)
    if (!plateM || String(plateM[1]).trim() === '') continue
    const plateId = Number(String(plateM[1]).trim())
    if (!Number.isFinite(plateId) || plateId < 1) continue
    const key = oidInstMapKey(oid, 0)
    if (!into.has(key)) into.set(key, Math.floor(plateId))
  }
}

function mergeExtrudersFromTopLevelConfigObjects(xml: string, into: Map<string, number>): void {
  const objRe = /<(?:[\w-]+:)?object\b([^>]*?)>([\s\S]*?)<\/(?:[\w-]+:)?object\s*>/gi
  let om: RegExpExecArray | null
  while ((om = objRe.exec(xml)) !== null) {
    const attrs = om[1] ?? ''
    const inner = om[2] ?? ''
    const idM = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)
    if (!idM || String(idM[1]).trim() === '') continue
    const oid = String(idM[1]).trim()
    const extM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']extruder["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']extruder["']/i.exec(inner)
    if (!extM || String(extM[1]).trim() === '') continue
    const slot = Number(String(extM[1]).trim())
    if (!Number.isFinite(slot) || slot < 1) continue
    into.set(oidInstMapKey(oid, 0), Math.floor(slot))
  }
}

/**
 * Bambu `model_settings.config`: extruder assignments nested as
 *   `<object id="N"><part id="M"><metadata key="extruder" value="X"/></part></object>`
 * where `part id` corresponds to the resource objectid in the sub-model file.
 * Populates `into` with `"M:0" → X` so `collectDirectMeshes` extruder lookup resolves.
 */
function mergeExtrudersFromPartElementsInConfigObjects(xml: string, into: Map<string, number>): void {
  const objRe = /<(?:[\w-]+:)?object\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?object\s*>/gi
  let om: RegExpExecArray | null
  while ((om = objRe.exec(xml)) !== null) {
    const objInner = om[1] ?? ''
    const partRe = /<(?:[\w-]+:)?part\b([^>]*?)>([\s\S]*?)<\/(?:[\w-]+:)?part\s*>/gi
    let pm: RegExpExecArray | null
    while ((pm = partRe.exec(objInner)) !== null) {
      const partAttrs = pm[1] ?? ''
      const partInner = pm[2] ?? ''
      const idM = /\bid\s*=\s*["']([^"']+)["']/i.exec(partAttrs)
      if (!idM || String(idM[1]).trim() === '') continue
      const partId = String(idM[1]).trim()
      const extM =
        /<\s*metadata[^>]*\bkey\s*=\s*["']extruder["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(partInner) ??
        /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']extruder["']/i.exec(partInner)
      if (!extM || String(extM[1]).trim() === '') continue
      const slot = Number(String(extM[1]).trim())
      if (!Number.isFinite(slot) || slot < 1) continue
      const key = oidInstMapKey(partId, 0)
      if (!into.has(key)) into.set(key, Math.floor(slot))
    }
  }
}

function mergeExtruderSlotsFromModelSettingsXml(xml: string, into: Map<string, number>): void {
  // Bambu newer format: extruder on top-level <object> elements outside <plate>
  mergeExtrudersFromTopLevelConfigObjects(xml, into)
  // Bambu format: extruder on nested <part id="N"> elements inside <object> blocks
  mergeExtrudersFromPartElementsInConfigObjects(xml, into)
  // Bambu older format: extruder inside <model_instance> / <object> within <plate> blocks
  const plateRe = /<(?:[\w-]+:)?plate\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?plate\s*>/gi
  let plateMatch: RegExpExecArray | null
  while ((plateMatch = plateRe.exec(xml)) !== null) {
    const block = plateMatch[1] ?? ''
    mergeExtrudersFromModelInstancesInPlateBlock(block, into)
    mergeExtrudersFromPlateObjectElementsInPlateBlock(block, into)
  }
}

function resolvePlateIdFromAssignment(
  plateAssignment: Map<string, number> | null,
  oidStr: string,
  instIdx: number
): number {
  return lookupPlateForOidInst(plateAssignment, oidStr, instIdx) ?? 0
}

/** Pick plate bucket for this `<object id>` from slicer `object_id:instance_id` metadata. */
function resolveGeomBucketForObjectInBuildContext(
  objectId: string,
  plateBuckets: Map<number, GeomBucket>,
  plateAssignment: Map<string, number> | null,
  buildInstIdx: number,
  fallbackBucket: GeomBucket
): GeomBucket {
  if (!plateAssignment || plateAssignment.size === 0) return fallbackBucket
  let pid = resolvePlateIdFromAssignment(plateAssignment, objectId, buildInstIdx)
  if (pid === 0) pid = resolvePlateIdFromAssignment(plateAssignment, objectId, 0)
  /**
   * Do **not** fall back to the `<build>` root object’s plate: Bambu often lists different
   * `plater_id` per `<model_instance>` leaf; inheriting the root plate collapses every child into
   * one bucket (one bed) even when metadata distinguishes plates.
   */
  return ensureGeomBucket(plateBuckets, pid)
}

async function listMetadataConfigXmlForPlateScan(zip: JSZip): Promise<string[]> {
  const out: string[] = []
  const seenNorm = new Set<string>()
  const pushText = async (logicalPath: string): Promise<void> => {
    const entry = findZipEntry(zip, logicalPath)
    if (!entry) return
    let text = await entry.async('string')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const nk = normalizePartPath(logicalPath).toLowerCase()
    if (seenNorm.has(nk)) return
    seenNorm.add(nk)
    out.push(text)
  }
  await pushText('Metadata/model_settings.config')
  await pushText('Metadata/model_settings.json')
  await pushText('Metadata/project_settings.config')
  await pushText('Metadata/Slic3r_PE_model.config')
  for (const key of Object.keys(zip.files)) {
    if (zip.files[key].dir) continue
    const n = normalizePartPath(key).toLowerCase()
    if (!n.startsWith('metadata/') || !n.endsWith('.config')) continue
    if (seenNorm.has(n)) continue
    let xml = await zip.files[key].async('string')
    if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
    if (
      !/<[\w:-]*\bplate\b/i.test(xml) &&
      !/<[\w:-]*\bmodel_instance\b/i.test(xml) &&
      !/slic3r/i.test(n)
    )
      continue
    seenNorm.add(n)
    out.push(xml)
  }
  for (const key of Object.keys(zip.files)) {
    if (zip.files[key].dir) continue
    const n = normalizePartPath(key).toLowerCase()
    if (!n.startsWith('metadata/') || !n.endsWith('.json')) continue
    if (seenNorm.has(n)) continue
    let text = await zip.files[key].async('string')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const t = text.trim()
    if (!t.startsWith('{')) continue
    if (!/["']?(plates|plate_list|model_instance)["']?\s*:/i.test(t) && !/"model_instance"/i.test(t)) continue
    seenNorm.add(n)
    out.push(text)
  }
  return out
}

/** `objectId:instanceIndex` → 1-based extruder / filament slot from Bambu `model_settings.config`. */
async function loadBambuExtruderSlotByOidInst(zip: JSZip): Promise<Map<string, number>> {
  const merged = new Map<string, number>()
  const xmlChunks = await listMetadataConfigXmlForPlateScan(zip)
  for (const xml of xmlChunks) {
    const chunk = xml.trim()
    if (chunk.startsWith('{')) {
      tryMergeExtruderSlotsFromModelSettingsJson(chunk, merged)
      continue
    }
    mergeExtruderSlotsFromModelSettingsXml(chunk, merged)
  }
  return merged
}

function mergeBambuDisplayNamesFromModelInstanceBlock(block: string, into: Map<string, string>): void {
  const instFragRe =
    /<(?:[\w-]+:)?model_instance\b[^>]*(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?model_instance\s*>)/gi
  let im: RegExpExecArray | null
  while ((im = instFragRe.exec(block)) !== null) {
    const inner = im[1] ?? ''
    const whole = im[0]
    const oidM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']object_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']object_id["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bkey\s*=\s*["']objectid["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']objectid["']/i.exec(inner) ??
      /\bobject_id\s*=\s*["']([^"']*)["']/i.exec(whole) ??
      /\bobjectid\s*=\s*["']([^"']*)["']/i.exec(whole)
    const iidM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']instance_id["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']instance_id["']/i.exec(inner) ??
      /\binstance_id\s*=\s*["']([^"']*)["']/i.exec(whole) ??
      /\binstanceid\s*=\s*["']([^"']*)["']/i.exec(whole)
    if (!oidM || String(oidM[1]).trim() === '') continue
    const oid = String(oidM[1]).trim()
    const iid = iidM && String(iidM[1]).trim() !== '' ? Number(iidM[1]) : 0
    const nameM =
      /<\s*metadata[^>]*\bkey\s*=\s*["']name["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']name["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bkey\s*=\s*["']object_name["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner) ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']object_name["']/i.exec(inner)
    if (!nameM) continue
    const label = String(nameM[1]).trim()
    if (!label) continue
    const inst = Number.isFinite(iid) ? iid : 0
    into.set(canonical3mfObjectIdForKey(oid), label)
    into.set(oidInstMapKey(oid, inst), label)
  }
}

function mergeBambuDisplayNamesFromPlateObjectBlocks(block: string, into: Map<string, string>): void {
  const objFullRe = /<(?:[\w-]+:)?object\b([^>]*?)>([\s\S]*?)<\/(?:[\w-]+:)?object\s*>/gi
  let om: RegExpExecArray | null
  while ((om = objFullRe.exec(block)) !== null) {
    const attrs = om[1] ?? ''
    const inner = om[2] ?? ''
    const idM = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)
    if (!idM || String(idM[1]).trim() === '') continue
    const oid = String(idM[1]).trim()
    const instM =
      /\binstanceid\s*=\s*["']([^"']*)["']/i.exec(attrs) ?? /\binstance_id\s*=\s*["']([^"']*)["']/i.exec(attrs)
    const iid = instM && String(instM[1]).trim() !== '' ? Number(instM[1]) : 0
    const nameFromAttr = /\bname\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.trim() ?? ''
    const nameFromMeta =
      /<\s*metadata[^>]*\bkey\s*=\s*["']name["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(inner)?.[1]?.trim() ??
      /<\s*metadata[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bkey\s*=\s*["']name["']/i.exec(inner)?.[1]?.trim() ??
      ''
    const label = (nameFromMeta.length > 0 ? nameFromMeta : nameFromAttr).trim()
    if (!label) continue
    const inst = Number.isFinite(iid) ? iid : 0
    into.set(canonical3mfObjectIdForKey(oid), label)
    into.set(oidInstMapKey(oid, inst), label)
  }
}

/** `object_id` / OPC id → display name from Bambu `model_settings` metadata (when OPC `name=""` is empty). */
async function loadBambuObjectDisplayNamesFromModelSettings(zip: JSZip): Promise<Map<string, string>> {
  const merged = new Map<string, string>()
  const xmlChunks = await listMetadataConfigXmlForPlateScan(zip)
  for (const xml of xmlChunks) {
    const chunk = xml.trim()
    if (chunk.startsWith('{')) {
      tryMergeDisplayNamesFromModelSettingsJson(chunk, merged)
      continue
    }
    const plateRe = /<(?:[\w-]+:)?plate\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?plate\s*>/gi
    let plateMatch: RegExpExecArray | null
    while ((plateMatch = plateRe.exec(chunk)) !== null) {
      const block = plateMatch[1] ?? ''
      mergeBambuDisplayNamesFromModelInstanceBlock(block, merged)
      mergeBambuDisplayNamesFromPlateObjectBlocks(block, merged)
    }
    mergeBambuDisplayNamesFromModelInstanceBlock(chunk, merged)
    mergeBambuDisplayNamesFromPlateObjectBlocks(chunk, merged)
  }
  return merged
}

async function listMetadataConfigXmlForAssemble(zip: JSZip): Promise<string[]> {
  const out: string[] = []
  const seenNorm = new Set<string>()
  const push = async (logicalPath: string): Promise<void> => {
    const entry = findZipEntry(zip, logicalPath)
    if (!entry) return
    let xml = await entry.async('string')
    if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
    const nk = normalizePartPath(logicalPath).toLowerCase()
    if (seenNorm.has(nk)) return
    seenNorm.add(nk)
    if (!/<[\w:-]*\bassemble\b/i.test(xml)) return
    out.push(xml)
  }
  await push('Metadata/model_settings.config')
  await push('Metadata/project_settings.config')
  for (const key of Object.keys(zip.files)) {
    if (zip.files[key].dir) continue
    const n = normalizePartPath(key).toLowerCase()
    if (!n.startsWith('metadata/') || !n.endsWith('.config')) continue
    if (seenNorm.has(n)) continue
    let xml = await zip.files[key].async('string')
    if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
    if (!/<[\w:-]*\bassemble\b/i.test(xml)) continue
    seenNorm.add(n)
    out.push(xml)
  }
  return out
}

async function loadBambuAssembleComposeMapFromZip(zip: JSZip): Promise<BambuAssembleComposeMap | null> {
  const cfgParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: true,
    trimValues: true,
    ignoreDeclaration: true
  })
  const xmlChunks = await listMetadataConfigXmlForAssemble(zip)
  if (xmlChunks.length === 0) return null

  const out: BambuAssembleComposeMap = new Map()
  for (const xml of xmlChunks) {
    let doc: Record<string, unknown>
    try {
      doc = cfgParser.parse(xml) as Record<string, unknown>
    } catch {
      continue
    }
    const raw: { oid: string; iid: number; t12: Float64Array | null; off: string | undefined }[] = []
    walkXmlForAssembleItems(doc, raw)
    for (const it of raw) {
      const A = it.t12 ? mat4From3mf12(it.t12) : identityMat4()
      const [ox, oy, oz] = parseTripleSpace(it.off)
      const composed = multiplyMat4(A, translationMat4(ox, oy, oz))
      const oidKey = canonical3mfObjectIdForKey(it.oid)
      let inner = out.get(oidKey)
      if (!inner) {
        inner = new Map()
        out.set(oidKey, inner)
      }
      if (!inner.has(it.iid)) inner.set(it.iid, composed)
    }
  }
  return out.size > 0 ? out : null
}

type BuildItemPlacement = { plateKey: string; oidStr: string; instIdx: number; tx: number; ty: number; tz: number }

function getBuildItemsFromModel(model: Record<string, unknown>): Record<string, unknown>[] {
  const buildRaw = model.build ?? (model as { Build?: unknown }).Build
  const b = unwrapXmlRecord(buildRaw)
  if (!b) return []
  let items = normalizeArray(b.item ?? b.Item)
  if (items.length === 0) {
    const wrapped = (b.items ?? b.Items) as Record<string, unknown> | undefined
    if (wrapped) items = normalizeArray(wrapped.item ?? wrapped.Item)
  }
  return items as Record<string, unknown>[]
}

/**
 * Local attribute name from fast-xml-parser keys (`@_plateindex`, `@_p:plateindex`,
 * `{http://…/production/2015/06}plateindex`). Needed for production / Prusa multi-plate attrs.
 */
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

/** Core / production `<item plateindex="…">` (0-based in many slicers). */
function readBuildItemPlateIndex(item: Record<string, unknown>): number | undefined {
  const raw = readXmlAttrFirstMatch(item, ['plateindex', 'printplateindex', 'plate_index'])
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

function readPidPindexFromRow(row: Record<string, unknown>): { pid?: string; pindex?: number } {
  const pids = readXmlAttrFirstMatch(row, ['pid', 'paint_id'])
  const pixs = readXmlAttrFirstMatch(row, ['pindex', 'paint_index', 'p_index'])
  const pn = pixs !== undefined && pixs !== '' ? Number(pixs) : NaN
  return {
    pid: pids !== undefined && pids !== '' ? pids : undefined,
    pindex: Number.isFinite(pn) ? Math.floor(pn) : undefined
  }
}

/** Last writer wins: `<item plateindex>` overrides inferred / Bambu metadata for that build instance. */
function mergeBuildItemPlateIndexIntoAssignment(
  model: Record<string, unknown>,
  base: Map<string, number> | null
): Map<string, number> | null {
  const items = getBuildItemsFromModel(model)
  if (items.length === 0) return base
  const out = base ? new Map(base) : new Map<string, number>()
  const instanceCounter = new Map<string, number>()
  for (const it of items) {
    const row = it as Record<string, unknown>
    const oid = row['@_objectid'] ?? row['@_Objectid'] ?? row.objectid
    if (oid === undefined || oid === null) continue
    const oidStr = String(oid)
    const instIdx = instanceCounter.get(oidStr) ?? 0
    instanceCounter.set(oidStr, instIdx + 1)
    const plateIx = readBuildItemPlateIndex(row)
    if (plateIx === undefined) continue
    out.set(oidInstMapKey(oidStr, instIdx), plateIx)
  }
  return out.size > 0 ? out : base
}

/** Core `<object type="…">`: skip support / purge / non-part geometry (3MF Core §4). */
const SKIP_THREEMF_OBJECT_TYPES = new Set([
  'support',
  'solidsupport',
  'other',
  'void',
  'surface',
  'subtractive'
])

function isRenderableThreeMfObject(row: Record<string, unknown>): boolean {
  const t = readXmlAttrFirstMatch(row, ['type'])
  if (t === undefined || t.trim() === '') return true
  const low = t.trim().toLowerCase().replace(/\s+/g, '')
  if (low === 'model' || low === 'default') return true
  if (SKIP_THREEMF_OBJECT_TYPES.has(low)) return false
  return true
}

function readVertexCoord(vrec: Record<string, unknown>, axis: 'x' | 'y' | 'z'): number {
  const s = readXmlAttrFirstMatch(vrec, [axis])
  if (s !== undefined && s !== '') {
    const n = Number(s)
    if (Number.isFinite(n)) return n
  }
  const legacy = vrec[`@_${axis}`] ?? vrec[axis]
  if (legacy !== undefined && legacy !== null) {
    const n = Number(legacy)
    if (Number.isFinite(n)) return n
  }
  return 0
}

function readTriangleVi(tri: Record<string, unknown>, name: 'v1' | 'v2' | 'v3', fallback: number): number {
  const s = readXmlAttrFirstMatch(tri, [name])
  if (s !== undefined && s !== '') {
    const n = Number(s)
    if (Number.isFinite(n)) return n
  }
  const legacy = tri[`@_${name}`] ?? tri[name]
  if (legacy !== undefined && legacy !== null) {
    const n = Number(legacy)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function readVertices(mesh: { vertices?: { vertex?: unknown } }): Float32Array {
  const verts = normalizeArray(mesh.vertices?.vertex)
  if (verts.length === 0) return new Float32Array(0)
  const out = new Float32Array(verts.length * 3)
  let o = 0
  for (const vx of verts) {
    const vrec = vx as Record<string, unknown>
    out[o++] = readVertexCoord(vrec, 'x')
    out[o++] = readVertexCoord(vrec, 'y')
    out[o++] = readVertexCoord(vrec, 'z')
  }
  return out
}

function readTriangles(mesh: { triangles?: { triangle?: unknown } }): Uint32Array {
  const tris = normalizeArray(mesh.triangles?.triangle)
  if (tris.length === 0) return new Uint32Array(0)
  const out = new Uint32Array(tris.length * 3)
  let o = 0
  for (const t of tris) {
    const tri = t as Record<string, unknown>
    const a = readTriangleVi(tri, 'v1', 0)
    out[o++] = a
    out[o++] = readTriangleVi(tri, 'v2', a)
    out[o++] = readTriangleVi(tri, 'v3', a)
  }
  return out
}

function enumerateBuildItemWorldPlacements(
  model: Record<string, unknown>,
  bambuAssemble: BambuAssembleComposeMap | null,
  applyBambuAssembleToBuild: boolean
): BuildItemPlacement[] {
  const items = getBuildItemsFromModel(model)
  const instanceCounter = new Map<string, number>()
  const out: BuildItemPlacement[] = []
  for (const it of items) {
    const item = it as {
      '@_objectid'?: string | number
      '@_Objectid'?: string | number
      objectid?: string | number
      '@_transform'?: string
      transform?: string
    }
    const oid = item['@_objectid'] ?? item['@_Objectid'] ?? item.objectid
    if (oid === undefined || oid === null) continue
    const oidStr = String(oid)
    const instIdx = instanceCounter.get(oidStr) ?? 0
    instanceCounter.set(oidStr, instIdx + 1)

    const tr =
      readXmlAttrFirstMatch(item as Record<string, unknown>, ['transform']) ??
      (item as { '@_transform'?: string; transform?: string })['@_transform'] ??
      (item as { transform?: string }).transform
    const t12 = parseTransform12(tr)
    let world = t12 ? mat4From3mf12(t12) : identityMat4()
    if (bambuAssemble && applyBambuAssembleToBuild) {
      const canonOid = canonical3mfObjectIdForKey(oidStr)
      const row = bambuAssemble.get(oidStr)?.get(instIdx) ?? bambuAssemble.get(canonOid)?.get(instIdx)
      if (row) world = multiplyMat4(row, world)
    }
    out.push({
      plateKey: oidInstMapKey(oidStr, instIdx),
      oidStr,
      instIdx,
      tx: world[12]!,
      ty: world[13]!,
      tz: world[14]!
    })
  }
  return out
}

/** Largest axis-aligned span of build origins (mm, slicer frame from `<item>` transforms). */
function maxPlacementSpreadMm(placements: BuildItemPlacement[]): number {
  if (placements.length < 2) return 0
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity
  for (const p of placements) {
    minX = Math.min(minX, p.tx)
    maxX = Math.max(maxX, p.tx)
    minY = Math.min(minY, p.ty)
    maxY = Math.max(maxY, p.ty)
    minZ = Math.min(minZ, p.tz)
    maxZ = Math.max(maxZ, p.tz)
  }
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ)
}

/**
 * When plate metadata keys do not line up with `<build>` items, infer virtual plates from
 * multi-plate layout spacing (Bambu / Orca assemble translations are usually ~180–260 mm apart).
 */
function inferPlateAssignmentFromPlacements(
  placements: BuildItemPlacement[],
  gapMm: number,
  minTotalSpreadMm: number
): Map<string, number> | null {
  if (placements.length < 2) return null
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity
  for (const p of placements) {
    minX = Math.min(minX, p.tx)
    maxX = Math.max(maxX, p.tx)
    minY = Math.min(minY, p.ty)
    maxY = Math.max(maxY, p.ty)
    minZ = Math.min(minZ, p.tz)
    maxZ = Math.max(maxZ, p.tz)
  }
  const spreadX = maxX - minX
  const spreadY = maxY - minY
  const spreadZ = maxZ - minZ
  const maxSpread = Math.max(spreadX, spreadY, spreadZ)
  if (!Number.isFinite(maxSpread) || maxSpread < minTotalSpreadMm) return null

  const axis: 'x' | 'y' | 'z' =
    spreadX >= spreadY && spreadX >= spreadZ ? 'x' : spreadY >= spreadZ ? 'y' : 'z'
  const coordOf = (p: BuildItemPlacement): number => (axis === 'x' ? p.tx : axis === 'y' ? p.ty : p.tz)
  const sorted = placements
    .map((p) => ({ key: p.plateKey, c: coordOf(p) }))
    .sort((a, b) => a.c - b.c)

  let plateSeq = 1
  const map = new Map<string, number>()
  map.set(sorted[0]!.key, plateSeq)
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k]!.c - sorted[k - 1]!.c > gapMm) plateSeq++
    map.set(sorted[k]!.key, plateSeq)
  }
  if (plateSeq < 2) return null
  return map
}

/**
 * Bucket `<build>` items by coarse XY grid (slicer bed plane). Typical Bambu plate pitch ~256–280 mm;
 * when metadata is missing, instances on different virtual plates often sit in different grid cells.
 */
function inferPlateAssignmentByGridCells(
  placements: BuildItemPlacement[],
  cellMm: number
): Map<string, number> | null {
  if (placements.length < 2 || !Number.isFinite(cellMm) || cellMm < 80) return null
  const groups = new Map<string, string[]>()
  for (const p of placements) {
    const cx = Math.floor(p.tx / cellMm)
    const cy = Math.floor(p.ty / cellMm)
    const ck = `${cx},${cy}`
    if (!groups.has(ck)) groups.set(ck, [])
    groups.get(ck)!.push(p.plateKey)
  }
  if (groups.size < 2) return null
  const out = new Map<string, number>()
  let plateSeq = 1
  for (const ck of [...groups.keys()].sort()) {
    for (const pk of groups.get(ck)!) out.set(pk, plateSeq)
    plateSeq++
  }
  return out
}

function pickEffectivePlateAssignment(
  model: Record<string, unknown>,
  plateAssignment: Map<string, number> | null,
  bambuAssemble: BambuAssembleComposeMap | null,
  applyBambuAssembleToBuild: boolean
): Map<string, number> | null {
  const placements = enumerateBuildItemWorldPlacements(model, bambuAssemble, applyBambuAssembleToBuild)
  /** Assemble offsets often collapse multi-plate layout to one cluster — infer plates from raw `<build>` transforms. */
  const placementsRaw = enumerateBuildItemWorldPlacements(model, bambuAssemble, false)
  if (placements.length < 2) {
    return plateAssignment && plateAssignment.size > 0 ? plateAssignment : null
  }

  if (plateAssignment && plateAssignment.size > 0) {
    const resolved = new Set<number>()
    for (const p of placements) {
      resolved.add(resolvePlateIdFromAssignment(plateAssignment, p.oidStr, p.instIdx))
    }
    if (resolved.size >= 2) return plateAssignment
    /** Map exists but nothing matched build ids (all bucket 0) — ignore and infer from layout. */
    if (resolved.size === 1 && resolved.has(0)) {
      /* fall through */
    } else if (resolved.size === 1) {
      /**
       * Metadata can assign every `<item>` the same `plater_id` while `<item>` translations still
       * place bodies ~180–280 mm apart (what generic 3MF viewers show as one spaced scene).
       */
      const rawSpread = maxPlacementSpreadMm(placementsRaw)
      if (!(placementsRaw.length >= 2 && rawSpread >= 120)) {
        return plateAssignment
      }
      /* fall through */
    }
  }

  const gapMm = 130
  /** Tight layouts (small beds / dense plates) need lower spread and gap floors than large printers. */
  let inferred = inferPlateAssignmentFromPlacements(placements, 70, 95)
  if (!inferred || new Set(inferred.values()).size < 2) {
    inferred = inferPlateAssignmentFromPlacements(placementsRaw, 70, 95)
  }
  if (!inferred || new Set(inferred.values()).size < 2) {
    inferred = inferPlateAssignmentFromPlacements(placements, gapMm, gapMm * 1.2)
  }
  if (!inferred || new Set(inferred.values()).size < 2) {
    inferred = inferPlateAssignmentFromPlacements(placementsRaw, gapMm, gapMm * 1.2)
  }
  if (!inferred || new Set(inferred.values()).size < 2) {
    inferred = inferPlateAssignmentFromPlacements(placementsRaw, 90, 90)
  }
  if (!inferred || new Set(inferred.values()).size < 2) {
    for (const cell of [300, 280, 260, 240, 220, 200, 180, 350, 320]) {
      const g = inferPlateAssignmentByGridCells(placementsRaw, cell)
      if (g && new Set(g.values()).size >= 2) {
        inferred = g
        break
      }
    }
  }
  if (!inferred || new Set(inferred.values()).size < 2) {
    for (const cell of [300, 280, 260, 240, 220, 200]) {
      const g = inferPlateAssignmentByGridCells(placements, cell)
      if (g && new Set(g.values()).size >= 2) {
        inferred = g
        break
      }
    }
  }
  if (inferred && new Set(inferred.values()).size >= 2) return inferred

  return plateAssignment && plateAssignment.size > 0 ? plateAssignment : null
}

function getResourcesObjectMapFromModel(model: Record<string, unknown>): Map<string, ObjectNode> | null {
  const resourcesRaw = model.resources ?? (model as { Resources?: unknown }).Resources
  const resources = unwrapXmlRecord(resourcesRaw) as
    | { object?: unknown; Object?: unknown }
    | null
    | undefined
  const objects = normalizeArray(resources?.object ?? resources?.Object) as Record<string, unknown>[]
  if (objects.length === 0) return null
  return buildObjectMap(objects)
}

/**
 * Bambu often splits one project across several `.model` files with a single `<build><item>` each.
 * Geometry is then merged in one bucket per file (no `plateParts`), but slicer metadata still maps
 * each object to a plate — use that so `mergeMultiPartThreeMfMeshes` can group by plate.
 */
function inferDominantBuildPlateIdForModel(
  model: Record<string, unknown>,
  plateAssignment: Map<string, number> | null,
  bambuAssemble: BambuAssembleComposeMap | null,
  applyBambuAssembleToBuild: boolean
): number | undefined {
  const objectMap = getResourcesObjectMapFromModel(model)
  if (!objectMap) return undefined
  const expanded = expandOidInstMapOntoAncestorKeys(
    objectMap,
    expandPlateAssignmentWithAssemblyChildKeys(model, objectMap, plateAssignment)
  )
  const effective = pickEffectivePlateAssignment(model, expanded, bambuAssemble, applyBambuAssembleToBuild)
  if (!effective || effective.size === 0) return undefined
  const placements = enumerateBuildItemWorldPlacements(model, bambuAssemble, applyBambuAssembleToBuild)
  if (placements.length === 0) {
    // Resource-only split file (Bambu multi-model format): no <build> element (or empty build).
    // Infer the plate by scanning all resource object IDs directly against the plate assignment.
    const plateCounts = new Map<number, number>()
    for (const objId of objectMap.keys()) {
      const pid = lookupPlateForOidInst(effective, String(objId), 0)
      if (pid !== undefined && pid !== 0) {
        plateCounts.set(pid, (plateCounts.get(pid) ?? 0) + 1)
      }
    }
    if (plateCounts.size === 0) return undefined
    let bestPid: number | undefined
    let bestCount = -1
    for (const [pid, count] of plateCounts) {
      if (count > bestCount) {
        bestCount = count
        bestPid = pid
      }
    }
    return bestPid
  }
  const ids = new Set<number>()
  for (const p of placements) {
    ids.add(resolvePlateIdFromAssignment(effective, p.oidStr, p.instIdx))
  }
  if (ids.size > 1) return undefined
  const sole = [...ids][0]!
  if (sole === 0 && expanded !== null && expanded.size > 0) {
    const anyNonZeroPlate = [...expanded.values()].some((v) => v !== 0)
    if (anyNonZeroPlate) return undefined
  }
  return sole
}

function transformPositionsMat4(pos: Float32Array, m: Float64Array): Float32Array {
  const out = new Float32Array(pos.length)
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]
    const y = pos[i + 1]
    const z = pos[i + 2]
    const w = m[3] * x + m[7] * y + m[11] * z + m[15]
    const iw = w !== 0 ? 1 / w : 1
    out[i] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw
    out[i + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw
    out[i + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw
  }
  return out
}

/** Determinant of the upper-left 3x3 (rotation/scale) for handedness checks. */
function det3x3FromMat4(m: Float64Array): number {
  const a00 = m[0],
    a01 = m[4],
    a02 = m[8]
  const a10 = m[1],
    a11 = m[5],
    a12 = m[9]
  const a20 = m[2],
    a21 = m[6],
    a22 = m[10]
  return (
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20)
  )
}

function flipTriangleWinding(indices: Uint32Array): void {
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const b = indices[i + 1]
    indices[i + 1] = indices[i + 2]
    indices[i + 2] = b
  }
}

type ObjectNode = Record<string, unknown> & {
  mesh?: { vertices?: { vertex?: unknown }; triangles?: { triangle?: unknown } }
  components?: { component?: unknown }
}

function objectIdOf(obj: Record<string, unknown>): string | null {
  const id =
    (obj as { '@_id'?: string | number })['@_id'] ?? (obj as { id?: string | number; Id?: string | number }).id ??
    (obj as { Id?: string | number }).Id
  if (id === undefined || id === null) return null
  return String(id)
}

function buildObjectMap(objects: Record<string, unknown>[]): Map<string, ObjectNode> {
  const map = new Map<string, ObjectNode>()
  for (const o of objects) {
    const id = objectIdOf(o)
    if (id !== null) {
      const node = o as ObjectNode
      map.set(id, node)
      const ck = canonical3mfObjectIdForKey(id)
      if (ck !== id) map.set(ck, node)
    }
  }
  return map
}

function appendMesh(
  mesh: ObjectNode['mesh'],
  world: Float64Array,
  bucket: GeomBucket,
  colorTables: Map<string, Float32Array> | null,
  filamentPaletteRgb: Float32Array | null,
  triDefaults: { buildPid?: string; buildPindex?: number; objectPid?: string; objectPindex?: number }
): void {
  if (!mesh) return
  let v = readVertices(mesh as { vertices?: { vertex?: unknown } })
  let ix = readTriangles(mesh as { triangles?: { triangle?: unknown } })
  if (v.length === 0 || ix.length === 0) return

  let rgbPerVertex: Float32Array | null = null
  const meshForTri = mesh as { triangles?: { triangle?: unknown } }
  const triRgbPaint = readTrianglePaintRgbFromPalette(meshForTri, filamentPaletteRgb)
  if (triRgbPaint) {
    const ex = expandIndexedMeshWithTriColors(v, ix, triRgbPaint)
    v = ex.positions
    ix = ex.indices
    rgbPerVertex = ex.vertexColors
  } else if (colorTables && colorTables.size > 0) {
    const defPid = triDefaults.buildPid ?? triDefaults.objectPid
    const defPidx = triDefaults.buildPindex ?? triDefaults.objectPindex
    const triRgb = readTriangleFaceRgbs(meshForTri, colorTables, defPid, defPidx)
    if (triRgb) {
      const ex = expandIndexedMeshWithTriColors(v, ix, triRgb)
      v = ex.positions
      ix = ex.indices
      rgbPerVertex = ex.vertexColors
    }
  }

  const vT = transformPositionsMat4(v, world)
  if (det3x3FromMat4(world) < 0) {
    // Mirror / negative-scale transforms invert handedness; restore front-face winding.
    flipTriangleWinding(ix)
  }
  bucket.posChunks.push(vT)
  const remapped = new Uint32Array(ix.length)
  const base = bucket.vertexOffset.value
  for (let i = 0; i < ix.length; i++) remapped[i] = ix[i] + base
  bucket.idxChunks.push(remapped)
  bucket.vertexOffset.value += vT.length / 3

  if (rgbPerVertex) {
    bucket.colChunks.push(rgbPerVertex)
  } else {
    bucket.colChunks.push(null)
  }
}

function collectFromObjectId(
  idStr: string,
  world: Float64Array,
  objectMap: Map<string, ObjectNode>,
  bucket: GeomBucket,
  stack: Set<string>,
  colorTables: Map<string, Float32Array> | null,
  filamentPaletteRgb: Float32Array | null,
  buildItemPid?: string,
  buildItemPindex?: number,
  plateBucketsForRouting?: Map<number, GeomBucket>,
  plateAssignmentForRouting?: Map<string, number> | null,
  buildInstIdxForRouting?: number,
  /** When set, each leaf mesh node appends a new entry here so the viewer can render
   *  every component as a separate mesh (preserving piece separation from the slicer). */
  itemBucketsOut?: Array<{ extruderSlot: number; bucket: GeomBucket }>,
  extruderSlotForItem?: number
): void {
  if (stack.has(idStr)) return
  stack.add(idStr)
  let obj = objectMap.get(idStr)
  if (!obj) obj = objectMap.get(canonical3mfObjectIdForKey(idStr)) ?? undefined
  if (!obj) {
    stack.delete(idStr)
    return
  }

  const meshBucket =
    plateBucketsForRouting &&
    plateAssignmentForRouting &&
    plateAssignmentForRouting.size > 0 &&
    buildInstIdxForRouting !== undefined
      ? resolveGeomBucketForObjectInBuildContext(
          idStr,
          plateBucketsForRouting,
          plateAssignmentForRouting,
          buildInstIdxForRouting,
          bucket
        )
      : bucket

  const orec = obj as Record<string, unknown>
  const { pid: objectPid, pindex: objectPindex } = readPidPindexFromRow(orec)

  if (obj.mesh && isRenderableThreeMfObject(orec)) {
    appendMesh(obj.mesh, world, meshBucket, colorTables, filamentPaletteRgb, {
      buildPid: buildItemPid,
      buildPindex: buildItemPindex,
      objectPid,
      objectPindex
    })
    // Each leaf mesh becomes its own item bucket entry for per-piece rendering.
    if (itemBucketsOut !== undefined && extruderSlotForItem !== undefined
        && itemBucketsOut.length < MAX_ITEM_BUCKETS_PER_PLATE) {
      const ib: GeomBucket = { posChunks: [], idxChunks: [], colChunks: [], vertexOffset: { value: 0 } }
      itemBucketsOut.push({ extruderSlot: extruderSlotForItem, bucket: ib })
      appendMesh(obj.mesh, world, ib, colorTables, filamentPaletteRgb, {
        buildPid: buildItemPid,
        buildPindex: buildItemPindex,
        objectPid,
        objectPindex
      })
    }
  }

  const comps = obj.components ?? (obj as { Components?: unknown }).Components
  const components = normalizeArray(
    (comps as { component?: unknown; Component?: unknown } | undefined)?.component ??
      (comps as { Component?: unknown } | undefined)?.Component
  )
  for (const c of components) {
    const comp = c as {
      '@_objectid'?: string | number
      '@_transform'?: string
      objectid?: string | number
      transform?: string
    }
    const childId = comp['@_objectid'] ?? comp.objectid
    if (childId === undefined || childId === null) continue
    const ctr =
      readXmlAttrFirstMatch(comp as Record<string, unknown>, ['transform']) ??
      comp['@_transform'] ??
      comp.transform
    const t12 = parseTransform12(ctr)
    const local = t12 ? mat4From3mf12(t12) : identityMat4()
    const childWorld = multiplyMat4(world, local)
    collectFromObjectId(
      String(childId),
      childWorld,
      objectMap,
      bucket,
      stack,
      colorTables,
      filamentPaletteRgb,
      undefined,
      undefined,
      plateBucketsForRouting,
      plateAssignmentForRouting,
      buildInstIdxForRouting,
      itemBucketsOut,        // pass through so every leaf in this sub-tree is captured
      extruderSlotForItem
    )
  }
  stack.delete(idStr)
}

function getBuildItemRootObjectIds(model: Record<string, unknown>): string[] {
  const buildRaw = model.build ?? (model as { Build?: unknown }).Build
  const b = unwrapXmlRecord(buildRaw)
  if (!b) return []
  let items = normalizeArray(b.item ?? b.Item)
  if (items.length === 0) {
    const wrapped = (b.items ?? b.Items) as Record<string, unknown> | undefined
    if (wrapped) items = normalizeArray(wrapped.item ?? wrapped.Item)
  }
  const roots: string[] = []
  for (const it of items) {
    const item = it as {
      '@_objectid'?: string | number
      '@_Objectid'?: string | number
      objectid?: string | number
    }
    const oid = item['@_objectid'] ?? item['@_Objectid'] ?? item.objectid
    if (oid !== undefined && oid !== null) roots.push(String(oid))
  }
  return roots
}

/** Same `<build><item>` order as `collectFromBuildAndResources` (per-`objectid` instance counter). */
function enumerateBuildOidInstPairs(model: Record<string, unknown>): { oidStr: string; instIdx: number }[] {
  const buildRaw = model.build ?? (model as { Build?: unknown }).Build
  const b = unwrapXmlRecord(buildRaw)
  if (!b) return []
  let items = normalizeArray(b.item ?? b.Item)
  if (items.length === 0) {
    const wrapped = (b.items ?? b.Items) as Record<string, unknown> | undefined
    if (wrapped) items = normalizeArray(wrapped.item ?? wrapped.Item)
  }
  const instanceCounter = new Map<string, number>()
  const out: { oidStr: string; instIdx: number }[] = []
  for (const it of items) {
    const item = it as {
      '@_objectid'?: string | number
      '@_Objectid'?: string | number
      objectid?: string | number
    }
    const oid = item['@_objectid'] ?? item['@_Objectid'] ?? item.objectid
    if (oid === undefined || oid === null) continue
    const oidStr = String(oid)
    const instIdx = instanceCounter.get(oidStr) ?? 0
    instanceCounter.set(oidStr, instIdx + 1)
    out.push({ oidStr, instIdx })
  }
  return out
}

/** `<object id>` values reachable via `<component objectid>` from a build root (includes root). */
function collectDescendantObjectIds(objectMap: Map<string, ObjectNode>, rootId: string): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
    const obj = objectMap.get(id)
    if (!obj) continue
    const comps = obj.components ?? (obj as { Components?: unknown }).Components
    const components = normalizeArray(
      (comps as { component?: unknown; Component?: unknown } | undefined)?.component ??
        (comps as { Component?: unknown } | undefined)?.Component
    )
    for (const c of components) {
      const comp = c as { '@_objectid'?: string | number; objectid?: string | number }
      const cid = comp['@_objectid'] ?? comp.objectid
      if (cid === undefined || cid === null) continue
      stack.push(String(cid))
    }
  }
  return order
}

/** First matching `object_id:instance_id` in `m` (same key variants as `resolvePlateIdFromAssignment`). */
function lookupExtruderForOidInst(
  m: Map<string, number> | null,
  oid: string,
  instCenter: number
): number | undefined {
  if (!m || m.size === 0) return undefined
  const oidTrim = oid.trim()
  const oidParsed = parseInt(oidTrim, 10)
  const oidKeys = [oidTrim]
  if (Number.isFinite(oidParsed) && String(oidParsed) !== oidTrim) oidKeys.push(String(oidParsed))
  const instCandidates: number[] = []
  const pushInst = (n: number): void => {
    if (n >= 0 && !instCandidates.includes(n)) instCandidates.push(n)
  }
  for (let k = -2; k <= 8; k++) pushInst(instCenter + k)
  for (let k = 0; k <= 12; k++) pushInst(k)
  for (const o of oidKeys) {
    for (const ins of instCandidates) {
      const v = m.get(`${o}:${ins}`)
      if (v !== undefined) return v
    }
  }
  return undefined
}

function lookupPlateForOidInst(
  m: Map<string, number> | null,
  oid: string,
  instCenter: number
): number | undefined {
  if (!m || m.size === 0) return undefined
  const oidTrim = oid.trim()
  const oidParsed = parseInt(oidTrim, 10)
  const oidKeys = [oidTrim]
  if (Number.isFinite(oidParsed) && String(oidParsed) !== oidTrim) oidKeys.push(String(oidParsed))
  const instCandidates: number[] = []
  const pushInst = (n: number): void => {
    if (n >= 0 && !instCandidates.includes(n)) instCandidates.push(n)
  }
  for (let k = -2; k <= 8; k++) pushInst(instCenter + k)
  for (let k = 0; k <= 12; k++) pushInst(k)
  for (const o of oidKeys) {
    for (const ins of instCandidates) {
      const v = m.get(`${o}:${ins}`)
      if (v !== undefined) return v
    }
  }
  return undefined
}

/**
 * Bambu `model_settings` often keys `object_id` to the leaf mesh inside an assembly, while `<build>`
 * references the wrapper `<object id>`. Copy plate ids from any known descendant key onto the
 * build root key so `resolvePlateIdFromAssignment` succeeds.
 */
function expandPlateAssignmentWithAssemblyChildKeys(
  model: Record<string, unknown>,
  objectMap: Map<string, ObjectNode>,
  plateAssignment: Map<string, number> | null
): Map<string, number> | null {
  if (!plateAssignment || plateAssignment.size === 0) return plateAssignment
  const m = new Map(plateAssignment)
  const buildItems = enumerateBuildOidInstPairs(model)
  for (const { oidStr, instIdx } of buildItems) {
    if (lookupPlateForOidInst(m, oidStr, instIdx) !== undefined) continue
    const desc = collectDescendantObjectIds(objectMap, oidStr)
    outer: for (const d of desc) {
      if (d === oidStr) continue
      const pid = lookupPlateForOidInst(m, d, instIdx)
      if (pid !== undefined) {
        m.set(oidInstMapKey(oidStr, instIdx), pid)
        break outer
      }
    }
  }
  return m
}

function expandExtruderAssignmentWithAssemblyChildKeys(
  model: Record<string, unknown>,
  objectMap: Map<string, ObjectNode>,
  extruderMap: Map<string, number> | null
): Map<string, number> | null {
  if (!extruderMap || extruderMap.size === 0) return extruderMap
  const m = new Map(extruderMap)
  const buildItems = enumerateBuildOidInstPairs(model)
  for (const { oidStr, instIdx } of buildItems) {
    if (lookupExtruderForOidInst(m, oidStr, instIdx) !== undefined) continue
    const desc = collectDescendantObjectIds(objectMap, oidStr)
    for (const d of desc) {
      if (d === oidStr) continue
      const slot = lookupExtruderForOidInst(m, d, instIdx)
      if (slot !== undefined) {
        m.set(oidInstMapKey(oidStr, instIdx), slot)
        break
      }
    }
  }
  return m
}

/** `<component objectid>` → parent `<object id>` so slicer metadata on a leaf can propagate upward. */
function buildComponentChildToParentMap(objectMap: Map<string, ObjectNode>): Map<string, string> {
  const parentOf = new Map<string, string>()
  for (const [parentIdRaw, node] of objectMap) {
    const parentCanon = canonical3mfObjectIdForKey(String(parentIdRaw))
    const comps = node.components ?? (node as { Components?: unknown }).Components
    const components = normalizeArray(
      (comps as { component?: unknown; Component?: unknown } | undefined)?.component ??
        (comps as { Component?: unknown } | undefined)?.Component
    )
    for (const c of components) {
      const comp = c as { '@_objectid'?: string | number; objectid?: string | number }
      const childId = comp['@_objectid'] ?? comp.objectid
      if (childId === undefined || childId === null) continue
      parentOf.set(canonical3mfObjectIdForKey(String(childId)), parentCanon)
    }
  }
  return parentOf
}

/**
 * Copy plate/extruder entries from any keyed object onto ancestor `<object>` ids in the component tree
 * when those ancestors lack an entry (complements child→build-root expansion).
 */
function expandOidInstMapOntoAncestorKeys(
  objectMap: Map<string, ObjectNode>,
  m: Map<string, number> | null
): Map<string, number> | null {
  if (!m || m.size === 0) return m
  const parentOf = buildComponentChildToParentMap(objectMap)
  const out = new Map(m)
  let changed = true
  let guard = 0
  while (changed && guard++ < 96) {
    changed = false
    for (const [k, v] of [...out]) {
      const colon = k.lastIndexOf(':')
      const oidRaw = colon >= 0 ? k.slice(0, colon) : k
      const instRaw = colon >= 0 ? k.slice(colon + 1) : '0'
      const instN = Number(instRaw)
      const inst = Number.isFinite(instN) ? Math.floor(instN) : 0
      const canon = canonical3mfObjectIdForKey(oidRaw)
      const p = parentOf.get(canon)
      if (p === undefined) continue
      const pk = oidInstMapKey(p, inst)
      if (!out.has(pk)) {
        out.set(pk, v)
        changed = true
      }
    }
  }
  return out
}

/**
 * Propagate plate/extruder entries DOWNWARD from parent composite objects to their
 * component mesh children.  Complement to `expandOidInstMapOntoAncestorKeys`.
 * This is needed when config stores plate/extruder on the composite/wrapper object
 * (e.g. Bambu 3MF where build items are composite objects whose mesh children are
 * referenced via `<components>`), so each mesh component inherits the correct plate.
 * The guard `if (!out.has(childKey))` prevents overwriting already-known assignments.
 */
function expandOidInstMapOntoDescendantKeys(
  objectMap: Map<string, ObjectNode>,
  m: Map<string, number> | null
): Map<string, number> | null {
  if (!m || m.size === 0) return m
  // childrenOf: canonParentId → [canonChildId, ...]
  const childrenOf = new Map<string, string[]>()
  for (const [parentIdRaw, node] of objectMap) {
    const parentCanon = canonical3mfObjectIdForKey(String(parentIdRaw))
    const comps = node.components ?? (node as { Components?: unknown }).Components
    const components = normalizeArray(
      (comps as { component?: unknown; Component?: unknown } | undefined)?.component ??
        (comps as { Component?: unknown } | undefined)?.Component
    )
    for (const c of components) {
      const comp = c as { '@_objectid'?: string | number; objectid?: string | number }
      const childId = comp['@_objectid'] ?? comp.objectid
      if (childId === undefined || childId === null) continue
      const childCanon = canonical3mfObjectIdForKey(String(childId))
      const arr = childrenOf.get(parentCanon) ?? []
      arr.push(childCanon)
      childrenOf.set(parentCanon, arr)
    }
  }
  const out = new Map(m)
  let changed = true
  let guard = 0
  while (changed && guard++ < 96) {
    changed = false
    for (const [k, v] of [...out]) {
      const colon = k.lastIndexOf(':')
      const oidRaw = colon >= 0 ? k.slice(0, colon) : k
      const instRaw = colon >= 0 ? k.slice(colon + 1) : '0'
      const instN = Number(instRaw)
      const inst = Number.isFinite(instN) ? Math.floor(instN) : 0
      const canon = canonical3mfObjectIdForKey(oidRaw)
      const children = childrenOf.get(canon)
      if (!children) continue
      for (const child of children) {
        const childKey = oidInstMapKey(child, inst)
        if (!out.has(childKey)) {
          out.set(childKey, v)
          changed = true
        }
      }
    }
  }
  return out
}

/** DFS same as `collectFromObjectId`, but only records reachable `<object>` ids. */
function addReachableIdsFromObjectGraph(
  idStr: string,
  objectMap: Map<string, ObjectNode>,
  stack: Set<string>,
  out: Set<string>
): void {
  if (stack.has(idStr)) return
  const obj = objectMap.get(idStr)
  if (!obj) return
  stack.add(idStr)
  out.add(idStr)
  const comps = obj.components ?? (obj as { Components?: unknown }).Components
  const components = normalizeArray(
    (comps as { component?: unknown; Component?: unknown } | undefined)?.component ??
      (comps as { Component?: unknown } | undefined)?.Component
  )
  for (const c of components) {
    const comp = c as { '@_objectid'?: string | number; objectid?: string | number }
    const childId = comp['@_objectid'] ?? comp.objectid
    if (childId === undefined || childId === null) continue
    addReachableIdsFromObjectGraph(String(childId), objectMap, stack, out)
  }
  stack.delete(idStr)
}

/**
 * Some 3MFs list only one `<item>` in `<build>` but keep other bodies as sibling `<object>` entries
 * (multi-plate / multi-body exports). Those objects are not in the build graph but still carry
 * `object_id:instance` plate metadata — route them to the matching plate bucket (not always 0).
 */
function appendMeshesNotReachableFromBuild(
  model: Record<string, unknown>,
  objectMap: Map<string, ObjectNode>,
  plateBuckets: Map<number, GeomBucket>,
  plateAssignment: Map<string, number> | null,
  colorTables: Map<string, Float32Array> | null,
  filamentPaletteRgb: Float32Array | null
): void {
  const roots = getBuildItemRootObjectIds(model)
  if (roots.length === 0) return
  const reachable = new Set<string>()
  for (const root of roots) {
    addReachableIdsFromObjectGraph(root, objectMap, new Set(), reachable)
  }
  const world = identityMat4()
  for (const [idStr, node] of objectMap) {
    if (reachable.has(idStr)) continue
    if (!node.mesh) continue
    if (!isRenderableThreeMfObject(node as Record<string, unknown>)) continue
    const bucket =
      plateAssignment && plateAssignment.size > 0
        ? resolveGeomBucketForObjectInBuildContext(
            idStr,
            plateBuckets,
            plateAssignment,
            0,
            ensureGeomBucket(plateBuckets, 0)
          )
        : ensureGeomBucket(plateBuckets, 0)
    appendMesh(node.mesh, world, bucket, colorTables, filamentPaletteRgb, {})
  }
}

function ensureGeomBucket(map: Map<number, GeomBucket>, plateId: number): GeomBucket {
  let b = map.get(plateId)
  if (!b) {
    b = { posChunks: [], idxChunks: [], colChunks: [], vertexOffset: { value: 0 } }
    map.set(plateId, b)
  }
  return b
}

function collectFromBuildAndResources(
  model: Record<string, unknown>,
  objectMap: Map<string, ObjectNode>,
  plateBuckets: Map<number, GeomBucket>,
  plateAssignment: Map<string, number> | null,
  colorTables: Map<string, Float32Array> | null,
  filamentPaletteRgb: Float32Array | null,
  bambuAssemble: BambuAssembleComposeMap | null,
  applyBambuAssembleToBuild: boolean,
  extruderMap: Map<string, number> | null = null
): void {
  const buildRaw = model.build ?? (model as { Build?: unknown }).Build
  const b = unwrapXmlRecord(buildRaw)
  if (!b) return
  let items = normalizeArray(b.item ?? b.Item)
  if (items.length === 0) {
    const wrapped = (b.items ?? b.Items) as Record<string, unknown> | undefined
    if (wrapped) items = normalizeArray(wrapped.item ?? wrapped.Item)
  }
  const instanceCounter = new Map<string, number>()
  for (const it of items) {
    const item = it as {
      '@_objectid'?: string | number
      '@_Objectid'?: string | number
      '@_transform'?: string
      '@_pid'?: string | number
      '@_pindex'?: string | number
      objectid?: string | number
      transform?: string
      pid?: string | number
      pindex?: string | number
    }
    const oid = item['@_objectid'] ?? item['@_Objectid'] ?? item.objectid
    if (oid === undefined || oid === null) continue
    const oidStr = String(oid)
    const instIdx = instanceCounter.get(oidStr) ?? 0
    instanceCounter.set(oidStr, instIdx + 1)

    const plateId = resolvePlateIdFromAssignment(plateAssignment, oidStr, instIdx)
    const bucket = ensureGeomBucket(plateBuckets, plateId)

    const tr =
      readXmlAttrFirstMatch(item as Record<string, unknown>, ['transform']) ??
      item['@_transform'] ??
      item.transform
    const t12 = parseTransform12(tr)
    let world = t12 ? mat4From3mf12(t12) : identityMat4()
    if (bambuAssemble && applyBambuAssembleToBuild) {
      const canonOid = canonical3mfObjectIdForKey(oidStr)
      const row = bambuAssemble.get(oidStr)?.get(instIdx) ?? bambuAssemble.get(canonOid)?.get(instIdx)
      if (row) world = multiplyMat4(row, world)
    }
    const { pid: buildPid, pindex: buildPindex } = readPidPindexFromRow(item as Record<string, unknown>)
    // Resolve extruder slot for this build item upfront so it can be forwarded to every
    // leaf mesh node that is collected, enabling per-piece color rendering.
    if (!bucket.itemBuckets) bucket.itemBuckets = []
    const slot = extruderMap ? (lookupExtruderForOidInst(extruderMap, oidStr, instIdx) ?? 1) : 1
    collectFromObjectId(
      oidStr,
      world,
      objectMap,
      bucket,
      new Set(),
      colorTables,
      filamentPaletteRgb,
      buildPid,
      buildPindex,
      plateBuckets,
      plateAssignment,
      instIdx,
      bucket.itemBuckets,  // each leaf mesh appends its own entry here
      slot
    )
  }
}

/** Fallback: any resource object that carries a mesh (legacy / non-build files). */
function collectDirectMeshes(
  objects: Record<string, unknown>[],
  bucket: GeomBucket,
  colorTables: Map<string, Float32Array> | null,
  filamentPaletteRgb: Float32Array | null,
  extruderMap: Map<string, number> | null = null,
  objectWorldTransforms: Map<string, Float64Array> | null = null
): void {
  if (!bucket.itemBuckets) bucket.itemBuckets = []
  for (const o of objects) {
    const node = o as ObjectNode
    const orec = o as Record<string, unknown>
    if (!isRenderableThreeMfObject(orec)) continue
    const { pid: objectPid, pindex: objectPindex } = readPidPindexFromRow(orec)
    const oidStr = objectIdOf(orec)
    // When per-object world transforms exist (multiple components sharing one sub-model file),
    // apply the correct matrix for this object so each part lands at its slicer position.
    const canonOid = oidStr ? canonical3mfObjectIdForKey(oidStr) : undefined
    let world: Float64Array = identityMat4()
    if (objectWorldTransforms && oidStr) {
      const perObjTr =
        objectWorldTransforms.get(oidStr) ??
        (canonOid !== undefined && canonOid !== oidStr ? objectWorldTransforms.get(canonOid) : undefined)
      if (perObjTr) world = perObjTr
    }
    appendMesh(node.mesh, world, bucket, colorTables, filamentPaletteRgb, {
      objectPid,
      objectPindex
    })
    // Track each renderable object as a separate item bucket so the viewer can render
    // Bambu split-format sub-model files as distinct pieces per build object.
    if (bucket.itemBuckets.length < MAX_ITEM_BUCKETS_PER_PLATE) {
      const ib: GeomBucket = { posChunks: [], idxChunks: [], colChunks: [], vertexOffset: { value: 0 } }
      const slot = oidStr && extruderMap ? (lookupExtruderForOidInst(extruderMap, oidStr, 0) ?? 1) : 1
      bucket.itemBuckets.push({ extruderSlot: slot, bucket: ib })
      appendMesh(node.mesh, world, ib, colorTables, filamentPaletteRgb, { objectPid, objectPindex })
    }
  }
}

function mergeTriangleMeshList(parts: TriangleMesh[]): TriangleMesh {
  if (parts.length === 0) return { positions: new Float32Array(0), indices: new Uint32Array(0) }
  if (parts.length === 1) return parts[0]!
  let acc = parts[0]!
  for (let i = 1; i < parts.length; i++) {
    acc = mergeTwoTriangleMeshes(acc, parts[i]!)
  }
  return acc
}

function mergeTwoTriangleMeshes(a: TriangleMesh, b: TriangleMesh): TriangleMesh {
  const av = a.positions.length / 3
  const positions = new Float32Array(a.positions.length + b.positions.length)
  positions.set(a.positions, 0)
  positions.set(b.positions, a.positions.length)
  const indices = new Uint32Array(a.indices.length + b.indices.length)
  indices.set(a.indices, 0)
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i]! + av
  }
  const aC = a.vertexColors
  const bC = b.vertexColors
  if (!aC && !bC) {
    return { positions, indices }
  }
  const neutral: [number, number, number] = [0.78, 0.82, 0.91]
  const fillNeutral = (vertCount: number): Float32Array => {
    const o = new Float32Array(vertCount * 3)
    for (let j = 0; j < vertCount * 3; j += 3) {
      o[j] = neutral[0]
      o[j + 1] = neutral[1]
      o[j + 2] = neutral[2]
    }
    return o
  }
  const ac = aC ?? fillNeutral(av)
  const bc = bC ?? fillNeutral(b.positions.length / 3)
  const vertexColors = new Float32Array(ac.length + bc.length)
  vertexColors.set(ac, 0)
  vertexColors.set(bc, ac.length)
  return { positions, indices, vertexColors }
}

function mergeChunks(
  posChunks: Float32Array[],
  idxChunks: Uint32Array[],
  colChunks?: (Float32Array | null)[]
): TriangleMesh {
  const totalV = posChunks.reduce((s, c) => s + c.length, 0)
  const totalI = idxChunks.reduce((s, c) => s + c.length, 0)
  const positions = new Float32Array(totalV)
  const indices = new Uint32Array(totalI)
  let po = 0
  let io = 0
  for (const c of posChunks) {
    positions.set(c, po)
    po += c.length
  }
  for (const c of idxChunks) {
    indices.set(c, io)
    io += c.length
  }
  const hasColors = colChunks?.some((c) => c !== null && c !== undefined && c.length > 0)
  if (!hasColors || !colChunks || colChunks.length !== posChunks.length) {
    return { positions, indices }
  }
  const vertexColors = new Float32Array(totalV)
  const neutral: [number, number, number] = [0.78, 0.82, 0.91]
  po = 0
  for (let ci = 0; ci < posChunks.length; ci++) {
    const len = posChunks[ci].length
    const src = colChunks[ci]
    if (src && src.length === len) {
      vertexColors.set(src, po)
    } else {
      for (let j = 0; j < len; j += 3) {
        vertexColors[po + j] = neutral[0]
        vertexColors[po + j + 1] = neutral[1]
        vertexColors[po + j + 2] = neutral[2]
      }
    }
    po += len
  }
  return { positions, indices, vertexColors }
}

function fixOneBasedIndices(mesh: TriangleMesh): void {
  const { positions, indices } = mesh
  const vCount = positions.length / 3
  let maxIx = 0
  for (let i = 0; i < indices.length; i++) maxIx = Math.max(maxIx, indices[i])
  if (maxIx >= vCount) {
    for (let i = 0; i < indices.length; i++) indices[i] = Math.max(0, indices[i] - 1)
  }
}

function mergeMaterialColorMaps(
  a: Map<string, Float32Array>,
  b: Map<string, Float32Array>
): Map<string, Float32Array> {
  const out = new Map(a)
  for (const [k, v] of b) out.set(k, v)
  return out
}

function plateBucketsHaveGeometry(map: Map<number, GeomBucket>): boolean {
  for (const g of map.values()) {
    if (g.posChunks.length > 0) return true
  }
  return false
}

function finalizeGeomBucketsToMesh(plateBuckets: Map<number, GeomBucket>): TriangleMesh {
  // Bucket 0 is the catch-all for objects that couldn't be assigned to a named plate.
  // Merge its geometry into the first real plate so it doesn't appear as a phantom "plate 0".
  const zeroBucket = plateBuckets.get(0)
  if (zeroBucket && zeroBucket.posChunks.length > 0) {
    const realIds = [...plateBuckets.keys()].filter((k) => k !== 0).sort((a, b) => a - b)
    if (realIds.length > 0) {
      const target = plateBuckets.get(realIds[0]!)!
      target.posChunks.push(...zeroBucket.posChunks)
      target.idxChunks.push(...zeroBucket.idxChunks)
      target.colChunks.push(...zeroBucket.colChunks)
      plateBuckets.delete(0)
    }
  }

  const plateIds = [...plateBuckets.keys()].sort((a, b) => a - b)
  const submeshes: TriangleMesh[] = []
  const plateParts: TriangleMeshPlatePart[] = []
  for (const pid of plateIds) {
    const g = plateBuckets.get(pid)!
    if (g.posChunks.length === 0) continue
    const sub = mergeChunks(g.posChunks, g.idxChunks, g.colChunks)
    fixOneBasedIndices(sub)
    submeshes.push(sub)

    // Build per-object sub-meshes when this plate has multiple build-item instances.
    // Each item becomes a separate TriangleMeshPlateSubObject so the viewer renders them
    // as distinct THREE.Mesh objects (preserving piece positions from the slicer layout).
    let subObjects: TriangleMeshPlateSubObject[] | undefined
    if (g.itemBuckets && g.itemBuckets.length >= 2) {
      const candidates: TriangleMeshPlateSubObject[] = []
      for (const ib of g.itemBuckets) {
        if (ib.bucket.posChunks.length === 0) continue
        const soMesh = mergeChunks(ib.bucket.posChunks, ib.bucket.idxChunks, ib.bucket.colChunks)
        fixOneBasedIndices(soMesh)
        candidates.push({ mesh: soMesh, extruderSlot: ib.extruderSlot })
      }
      if (candidates.length >= 2) subObjects = candidates
    }

    plateParts.push({ plateId: pid, mesh: sub, ...(subObjects ? { subObjects } : {}) })
  }
  if (submeshes.length === 0) {
    return { positions: new Float32Array(0), indices: new Uint32Array(0) }
  }
  const merged = mergeTriangleMeshList(submeshes)
  fixOneBasedIndices(merged)
  if (plateParts.length > 1) {
    return { ...merged, plateParts }
  }
  // Single-plate: still attach plateParts when there are sub-objects so the viewer
  // can render each build-item instance as a separate mesh.
  if (plateParts.length === 1 && plateParts[0]?.subObjects) {
    return { ...merged, plateParts }
  }
  return merged
}

/** Triangle mesh from one parsed `<model>` tree (millimeter scale not applied). */
function extractTriangleMeshFromParsedModel(
  model: Record<string, unknown>,
  filamentPaletteRgb: Float32Array | null,
  bambuAssemble: BambuAssembleComposeMap | null,
  applyBambuAssembleToBuild: boolean,
  plateAssignment: Map<string, number> | null,
  extruderMap: Map<string, number> | null = null,
  objectWorldTransforms: Map<string, Float64Array> | null = null
): TriangleMesh {
  const resourcesRaw = model.resources ?? (model as { Resources?: unknown }).Resources
  const resources = unwrapXmlRecord(resourcesRaw) as
    | { object?: unknown; Object?: unknown }
    | null
    | undefined
  const colorTables = mergeMaterialColorMaps(
    collectMaterialColorTables(model as Record<string, unknown>),
    collectMaterialColorTables((resources ?? {}) as Record<string, unknown>)
  )
  const colorLookup = colorTables.size > 0 ? colorTables : null

  const objects = normalizeArray(resources?.object ?? resources?.Object) as Record<string, unknown>[]
  const objectMap = buildObjectMap(objects)

  const plateBuckets = new Map<number, GeomBucket>()
  const plateAssignmentExpanded = expandOidInstMapOntoAncestorKeys(
    objectMap,
    expandPlateAssignmentWithAssemblyChildKeys(model, objectMap, plateAssignment)
  )
  let effectivePlateAssignment = pickEffectivePlateAssignment(
    model,
    plateAssignmentExpanded,
    bambuAssemble,
    applyBambuAssembleToBuild
  )
  effectivePlateAssignment = mergeBuildItemPlateIndexIntoAssignment(model, effectivePlateAssignment)

  collectFromBuildAndResources(
    model,
    objectMap,
    plateBuckets,
    effectivePlateAssignment,
    colorLookup,
    filamentPaletteRgb,
    bambuAssemble,
    applyBambuAssembleToBuild,
    extruderMap
  )

  ensureGeomBucket(plateBuckets, 0)
  appendMeshesNotReachableFromBuild(model, objectMap, plateBuckets, effectivePlateAssignment, colorLookup, filamentPaletteRgb)

  if (!plateBucketsHaveGeometry(plateBuckets)) {
    plateBuckets.clear()
    const z = ensureGeomBucket(plateBuckets, 0)
    collectDirectMeshes(objects, z, colorLookup, filamentPaletteRgb, extruderMap, objectWorldTransforms)
  }

  if (!plateBucketsHaveGeometry(plateBuckets)) {
    return { positions: new Float32Array(0), indices: new Uint32Array(0) }
  }

  return finalizeGeomBucketsToMesh(plateBuckets)
}

type BuildItemMeshSlice = { plateKey: string; mesh: TriangleMesh }

function meshAabbCenterXYInSlicerSpace(positions: Float32Array): { x: number; y: number } {
  if (positions.length < 3) return { x: 0, y: 0 }
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!
    const y = positions[i + 1]!
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0 }
  return { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5 }
}

/** One cluster id per mesh; ids are 0..K-1 with at least two distinct values, or null. */
function clusterMeshesByCentroidGridSlicerXY(meshes: TriangleMesh[]): number[] | null {
  if (meshes.length < 2) return null
  for (const cellMm of [280, 260, 240, 220, 200, 180, 320, 300, 350, 160, 140, 120, 100, 85]) {
    const keyToId = new Map<string, number>()
    const ids: number[] = []
    let next = 0
    for (const m of meshes) {
      const c = meshAabbCenterXYInSlicerSpace(m.positions)
      const key = `${Math.floor(c.x / cellMm)},${Math.floor(c.y / cellMm)}`
      let id = keyToId.get(key)
      if (id === undefined) {
        id = next++
        keyToId.set(key, id)
      }
      ids.push(id)
    }
    if (new Set(ids).size < 2) continue
    return ids
  }
  return null
}

/**
 * When a sub-model file's geometry lands in a single catch-all plate but its sub-objects are
 * distinct pieces (from per-component world transforms), try to split them into separate plates.
 *
 * Strategy 1 (preferred): group by extruder slot — matches the "one color per plate" workflow
 * in Bambu Studio where the user assigns each color group to a separate plate.
 * Strategy 2 (fallback): spatial clustering in slicer XY — used when all slots are the same
 * but parts are clearly scattered across virtual plate positions.
 *
 * Called BEFORE viewer axis remapping so centroids are in slicer XY space.
 * `basePlateId` sets the first synthetic plate index (subsequent plates get basePlateId+1, +2, …).
 */
function splitPlatePartsBySubObjectClusters(
  mesh: TriangleMesh,
  basePlateId: number
): TriangleMesh {
  if (!mesh.plateParts || mesh.plateParts.length !== 1) return mesh
  const pp = mesh.plateParts[0]!
  if (!pp.subObjects || pp.subObjects.length < 2) return mesh

  // Strategy 1: group by extruder slot.  When the user assigns each color to its own plate
  // (Bambu "one color per plate" workflow), distinct extruder slots cleanly identify plates
  // even when the spatial positions span a single virtual build volume.
  const slotMap = new Map<number, TriangleMeshPlateSubObject[]>()
  for (const so of pp.subObjects) {
    if (!slotMap.has(so.extruderSlot)) slotMap.set(so.extruderSlot, [])
    slotMap.get(so.extruderSlot)!.push(so)
  }
  if (slotMap.size >= 2) {
    const newPlateParts: TriangleMeshPlatePart[] = []
    let plateCounter = basePlateId
    for (const [slot, subs] of [...slotMap.entries()].sort(([a], [b]) => a - b)) {
      const plateMesh = mergeTriangleMeshList(subs.map((so) => so.mesh))
      const subObjects = subs.length >= 2 ? subs : undefined
      newPlateParts.push({
        plateId: plateCounter++,
        mesh: plateMesh,
        filamentSlot: slot,
        ...(subObjects ? { subObjects } : {})
      })
    }
    if (newPlateParts.length >= 2) {
      const mergedAll = mergeTriangleMeshList(newPlateParts.map((p) => p.mesh))
      return { ...mergedAll, plateParts: newPlateParts }
    }
  }

  // Strategy 2: spatial clustering (fallback — all sub-objects share the same extruder slot).
  const clusterIds = clusterMeshesByCentroidGridSlicerXY(pp.subObjects.map((so) => so.mesh))
  if (!clusterIds) return mesh
  const numClusters = new Set(clusterIds).size
  if (numClusters < 2) return mesh

  const clusterMap = new Map<number, TriangleMeshPlateSubObject[]>()
  for (let i = 0; i < clusterIds.length; i++) {
    const cid = clusterIds[i]!
    if (!clusterMap.has(cid)) clusterMap.set(cid, [])
    clusterMap.get(cid)!.push(pp.subObjects[i]!)
  }

  const newPlateParts: TriangleMeshPlatePart[] = []
  let plateCounter = basePlateId
  for (const [, subs] of [...clusterMap.entries()].sort(([a], [b]) => a - b)) {
    const plateMesh = mergeTriangleMeshList(subs.map((so) => so.mesh))
    const subObjects = subs.length >= 2 ? subs : undefined
    newPlateParts.push({
      plateId: plateCounter++,
      mesh: plateMesh,
      ...(subObjects ? { subObjects } : {})
    })
  }

  if (newPlateParts.length <= 1) return mesh
  const mergedAll = mergeTriangleMeshList(newPlateParts.map((p) => p.mesh))
  return { ...mergedAll, plateParts: newPlateParts }
}

/**
 * One triangle mesh per `<build><item>` (slicer mm, no orphans). Used to infer plate separation when
 * metadata + placement heuristics still collapse to a single `plateParts` bucket in one `.model`.
 */
function extractPerBuildItemMeshesUnmerged(
  model: Record<string, unknown>,
  filamentPaletteRgb: Float32Array | null,
  bambuAssemble: BambuAssembleComposeMap | null,
  applyBambuAssembleToBuild: boolean
): BuildItemMeshSlice[] {
  const resourcesRaw = model.resources ?? (model as { Resources?: unknown }).Resources
  const resources = unwrapXmlRecord(resourcesRaw) as
    | { object?: unknown; Object?: unknown }
    | null
    | undefined
  const colorTables = mergeMaterialColorMaps(
    collectMaterialColorTables(model as Record<string, unknown>),
    collectMaterialColorTables((resources ?? {}) as Record<string, unknown>)
  )
  const colorLookup = colorTables.size > 0 ? colorTables : null
  const objects = normalizeArray(resources?.object ?? resources?.Object) as Record<string, unknown>[]
  const objectMap = buildObjectMap(objects)

  const buildRaw = model.build ?? (model as { Build?: unknown }).Build
  const b = unwrapXmlRecord(buildRaw)
  if (!b) return []
  let items = normalizeArray(b.item ?? b.Item)
  if (items.length === 0) {
    const wrapped = (b.items ?? b.Items) as Record<string, unknown> | undefined
    if (wrapped) items = normalizeArray(wrapped.item ?? wrapped.Item)
  }
  const out: BuildItemMeshSlice[] = []
  const instanceCounter = new Map<string, number>()
  for (const it of items) {
    const item = it as {
      '@_objectid'?: string | number
      '@_Objectid'?: string | number
      objectid?: string | number
      '@_transform'?: string
      transform?: string
      '@_pid'?: string | number
      '@_pindex'?: string | number
      pid?: string | number
      pindex?: string | number
    }
    const oid = item['@_objectid'] ?? item['@_Objectid'] ?? item.objectid
    if (oid === undefined || oid === null) continue
    const oidStr = String(oid)
    const instIdx = instanceCounter.get(oidStr) ?? 0
    instanceCounter.set(oidStr, instIdx + 1)

    const plateBuckets = new Map<number, GeomBucket>()
    const bucket = ensureGeomBucket(plateBuckets, 0)
    const tr =
      readXmlAttrFirstMatch(item as Record<string, unknown>, ['transform']) ??
      item['@_transform'] ??
      item.transform
    const t12 = parseTransform12(tr)
    let world = t12 ? mat4From3mf12(t12) : identityMat4()
    if (bambuAssemble && applyBambuAssembleToBuild) {
      const canonOid = canonical3mfObjectIdForKey(oidStr)
      const row = bambuAssemble.get(oidStr)?.get(instIdx) ?? bambuAssemble.get(canonOid)?.get(instIdx)
      if (row) world = multiplyMat4(row, world)
    }
    const { pid: buildPid, pindex: buildPindex } = readPidPindexFromRow(item as Record<string, unknown>)
    collectFromObjectId(
      oidStr,
      world,
      objectMap,
      bucket,
      new Set(),
      colorLookup,
      filamentPaletteRgb,
      buildPid,
      buildPindex
    )
    if (!plateBucketsHaveGeometry(plateBuckets)) continue
    const sub = finalizeGeomBucketsToMesh(plateBuckets)
    if (sub.positions.length === 0) continue
    out.push({ plateKey: oidInstMapKey(oidStr, instIdx), mesh: sub })
  }
  return out
}

/**
 * When a single `3dmodel.model` has several `<item>`s on different slicer plates but plate metadata
 * / placement inference still yields one bucket, cluster each item’s mesh in slicer XY and
 * re-extract with a synthetic `object_id:instance_id → plate` map.
 */
function trySpatialRebuildSingleModelMesh(
  model: Record<string, unknown>,
  filamentPaletteRgb: Float32Array | null,
  bambuAssemble: BambuAssembleComposeMap | null,
  applyBambuAssembleToBuild: boolean,
  basePlateAssignment: Map<string, number> | null,
  unitMmScale: number
): TriangleMesh | null {
  const slices = extractPerBuildItemMeshesUnmerged(
    model,
    filamentPaletteRgb,
    bambuAssemble,
    applyBambuAssembleToBuild
  )
  if (slices.length < 2) return null
  const meshes = slices.map((s) => s.mesh)
  if (unitMmScale !== 1) {
    for (const m of meshes) {
      for (let i = 0; i < m.positions.length; i++) m.positions[i] *= unitMmScale
    }
  }
  const clusterIds = clusterMeshesByCentroidGridSlicerXY(meshes)
  if (!clusterIds || new Set(clusterIds).size < 2) return null

  const synthetic = new Map<string, number>()
  for (let i = 0; i < slices.length; i++) {
    synthetic.set(slices[i]!.plateKey, clusterIds[i]! + 1)
  }
  const mergedAssign = new Map<string, number>()
  if (basePlateAssignment) {
    for (const [k, v] of basePlateAssignment) mergedAssign.set(k, v)
  }
  for (const [k, v] of synthetic) mergedAssign.set(k, v)

  const mesh = extractTriangleMeshFromParsedModel(
    model,
    filamentPaletteRgb,
    bambuAssemble,
    applyBambuAssembleToBuild,
    mergedAssign
  )
  if (mesh.positions.length === 0) return null
  if (!mesh.plateParts || mesh.plateParts.length <= 1) return null
  if (unitMmScale !== 1) {
    for (let i = 0; i < mesh.positions.length; i++) mesh.positions[i] *= unitMmScale
  }
  remapThreeMfPrintVolumeToViewer(mesh)
  return mesh
}

/** OPC default model; Bambu split / multi-mesh projects add more `<name>.model` files next to this. */
function isDefaultThreeMfModelPath(zipMemberName: string): boolean {
  const n = normalizePath(zipMemberName)
  return /(^|\/)3d\/3dmodel\.model$/.test(n) || /(^|\/)3d\/model\.model$/.test(n)
}

/** Plate assignment + world-space transform for a Bambu split-format sub-model file. */
type SubModelPlateHint = {
  plateId: number
  worldTransform: Float64Array
  /**
   * Per-component world transforms keyed by sub-model objectid string.
   * Present when a single sub-model path hosts multiple mesh objects that are
   * referenced by separate `<component objectid="…">` entries in the primary model
   * (e.g. Bambu files where all parts live in one `object_1.model`).
   */
  objectTransforms?: Map<string, Float64Array>
}

/**
 * Bambu split-format 3MF: the main model file (`3D/3dmodel.model`) contains assembly objects
 * (even IDs) whose `<components>` reference mesh objects in sub-model files via
 * `<component p:path="/3D/Objects/object_N.model" objectid="1"/>`.
 * The `plateAssignment` maps the assembly object IDs (even) from the main model.
 * This function pre-builds a `normalizedSubModelPath → { plateId, worldTransform }` lookup.
 * `worldTransform` is the 4×4 matrix (column-major) that places the sub-model mesh
 * into world (slicer) space: buildItemTransform × componentTransform.
 */
function buildSubModelPathToPlateMap(
  mainModel: Record<string, unknown>,
  plateAssignment: Map<string, number>,
  bambuAssemble: BambuAssembleComposeMap | null = null
): Map<string, SubModelPlateHint> {
  const result = new Map<string, SubModelPlateHint>()
  const resources = (mainModel as { resources?: unknown }).resources
  if (!resources) return result

  // Step 1: objectId → world transform from <build><item> elements
  const buildTransforms = new Map<string, Float64Array>()
  for (const it of getBuildItemsFromModel(mainModel)) {
    const item = it as Record<string, unknown>
    const oid = item["@_objectid"] ?? item["@_Objectid"] ?? item.objectid
    if (oid === undefined || oid === null) continue
    const tr = readXmlAttrFirstMatch(item, ["transform"]) ??
      (item["@_transform"] as string | undefined) ??
      (item.transform as string | undefined)
    const t12 = parseTransform12(tr)
    buildTransforms.set(String(oid), t12 ? mat4From3mf12(t12) : identityMat4())
  }

  // Step 2: for each assembly object, find cross-file <component p:path="..."> references
  const objects = normalizeArray(
    (resources as { object?: unknown; Object?: unknown }).object ??
      (resources as { Object?: unknown }).Object
  )
  for (const objRaw of objects) {
    const obj = objRaw as Record<string, unknown>
    const assemblyId = String(obj["@_id"] ?? obj.id ?? "").trim()
    if (!assemblyId) continue
    const plateId = lookupPlateForOidInst(plateAssignment, assemblyId, 0)
    if (plateId === undefined || plateId === 0) continue
    // Apply Bambu assemble placement (left-multiply) so sub-model pieces land at their correct
    // print positions rather than their assembled-design positions.  Without this, all parts of
    // a multi-piece plate appear at the same overlapping slicer coordinates.
    let buildTr = buildTransforms.get(assemblyId) ?? identityMat4()
    if (bambuAssemble) {
      const canonOid = canonical3mfObjectIdForKey(assemblyId)
      const row = bambuAssemble.get(assemblyId)?.get(0) ?? bambuAssemble.get(canonOid)?.get(0)
      if (row) {
        buildTr = multiplyMat4(row, buildTr)
      }
    }
    const comps = obj.components ?? (obj as { Components?: unknown }).Components
    const components = normalizeArray(
      (comps as { component?: unknown; Component?: unknown } | undefined)?.component ??
        (comps as { Component?: unknown } | undefined)?.Component
    )
    for (const cRaw of components) {
      const comp = cRaw as Record<string, unknown>
      // XML parser with removeNSPrefix:true converts p:path → @_path
      const rawPath =
        (comp["@_path"] as string | undefined) ??
        (comp.path as string | undefined) ??
        (comp["@_p:path"] as string | undefined)
      if (!rawPath) continue
      // Component-local transform (offset from assembly origin to mesh origin)
      const ctr = readXmlAttrFirstMatch(comp, ["transform"]) ??
        (comp["@_transform"] as string | undefined) ??
        (comp.transform as string | undefined)
      const ct12 = parseTransform12(ctr)
      const compTr = ct12 ? mat4From3mf12(ct12) : identityMat4()
      // World transform = (bambuAssemble × buildItemTransform) × componentTransform
      const worldTransform = multiplyMat4(buildTr, compTr)
      const normalized = normalizePath(normalizePartPath(rawPath))

      // Accumulate per-objectid transforms so when multiple components share the same
      // sub-model path (all 8 chicken parts in object_1.model) each gets its own matrix.
      const componentOid =
        readXmlAttrFirstMatch(comp, ["objectid"]) ??
        (comp["@_objectid"] as string | undefined) ??
        (comp.objectid as string | undefined)

      let entry = result.get(normalized)
      if (!entry) {
        entry = { plateId, worldTransform, objectTransforms: new Map() }
        result.set(normalized, entry)
      } else {
        entry.worldTransform = worldTransform  // last component wins as global fallback
      }
      if (componentOid) {
        const coidStr = String(componentOid)
        entry.objectTransforms!.set(coidStr, worldTransform)
        const canonOid = canonical3mfObjectIdForKey(coidStr)
        if (canonOid !== coidStr) entry.objectTransforms!.set(canonOid, worldTransform)
      }
    }
  }
  return result
}

/**
 * Rotate RH coordinates from typical slicer 3MF (+Z up from the bed) into this app’s
 * Babylon-style frame (+Y up, bed in XZ). Same rigid transform for every vertex.
 */
function remapThreeMfPrintVolumeToViewer(mesh: TriangleMesh): void {
  const remap = (p: Float32Array): void => {
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!
      const ys = p[i + 1]!
      const zs = p[i + 2]!
      p[i] = x
      p[i + 1] = zs
      p[i + 2] = -ys
    }
  }
  remap(mesh.positions)
  if (mesh.plateParts) {
    for (const pp of mesh.plateParts) {
      // For single-plate files with sub-objects, finalizeGeomBucketsToMesh returns
      // { ...merged, plateParts } where merged === plateParts[0].mesh (same object,
      // mergeTriangleMeshList([x]) === x).  The top-level remap above already covered
      // that buffer; remapping it a second time would corrupt the coordinates.
      if (pp.mesh.positions !== mesh.positions) remap(pp.mesh.positions)
      if (pp.subObjects) {
        for (const so of pp.subObjects) remap(so.mesh.positions)
      }
    }
  }
}

function countPlateOpenTagsInXml(xml: string): number {
  const m = xml.match(/<(?:[\w-]+:)?plate\b/gi)
  return m ? m.length : 0
}

async function readModelSettingsXml(zip: JSZip): Promise<string | null> {
  const entry = findZipEntry(zip, 'Metadata/model_settings.config')
  if (!entry) return null
  let xml = await entry.async('string')
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
  return xml
}

async function readProjectSettingsXml(zip: JSZip): Promise<string | null> {
  const entry = findZipEntry(zip, 'Metadata/project_settings.config')
  if (!entry) return null
  let xml = await entry.async('string')
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
  return xml
}

function mergeProcessHints(primary: ThreeMfProcessHints, fallback: ThreeMfProcessHints): ThreeMfProcessHints | undefined {
  const out: ThreeMfProcessHints = {
    layerHeightMm: primary.layerHeightMm ?? fallback.layerHeightMm,
    initialLayerHeightMm: primary.initialLayerHeightMm ?? fallback.initialLayerHeightMm,
    lineWidthMm: primary.lineWidthMm ?? fallback.lineWidthMm,
    nozzleDiameterMm: primary.nozzleDiameterMm ?? fallback.nozzleDiameterMm,
    printPresetId: primary.printPresetId ?? fallback.printPresetId,
    estimatedPrintTime: primary.estimatedPrintTime ?? fallback.estimatedPrintTime,
    estimatedModelWeight: primary.estimatedModelWeight ?? fallback.estimatedModelWeight,
    totalLayers: primary.totalLayers ?? fallback.totalLayers
  }
  return Object.values(out).some((v) => v !== undefined && String(v).length > 0) ? out : undefined
}

function parseOpcMetadataNameAttr(openingAttrs: string): string | null {
  const m = /\bname\s*=\s*["']([^"']*)["']/i.exec(openingAttrs)
  if (!m) return null
  const s = m[1]!.trim()
  return s.length > 0 ? s : null
}

/**
 * OPC / MS 3MF core document: `<metadata name="Title">…</metadata>` and self-closing
 * `<metadata name="Copyright" />` (Bambu Studio, MakerWorld).
 */
function extractOpcModelMetadataByName(xml: string): Map<string, string> {
  const out = new Map<string, string>()
  const voidRe = /<metadata\s+([^/>]+)\/>/gi
  let m: RegExpExecArray | null
  while ((m = voidRe.exec(xml)) !== null) {
    const name = parseOpcMetadataNameAttr(m[1]!)
    if (name) out.set(name, '')
  }
  const blockRe = /<metadata\s+([^>]+)>([\s\S]*?)<\/metadata\s*>/gi
  while ((m = blockRe.exec(xml)) !== null) {
    const name = parseOpcMetadataNameAttr(m[1]!)
    if (!name) continue
    out.set(name, (m[2] ?? '').trim())
  }
  return out
}

async function readPrimaryOpcModelXml(zip: JSZip): Promise<string | null> {
  const entries = Object.values(zip.files).filter((e) => !e.dir)
  const fb = pickModelEntry(entries)
  if (!fb) return null
  let xml = await fb.async('string')
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
  return xml
}

async function expandOidInstMapsWithPrimaryOpcModel(
  zip: JSZip,
  parser: XMLParser,
  plateAssignment: Map<string, number> | null,
  extruderMap: Map<string, number> | null
): Promise<{ plate: Map<string, number> | null; extruder: Map<string, number> | null }> {
  let xml = await readPrimaryOpcModelXml(zip)
  if (!xml) return { plate: plateAssignment, extruder: extruderMap }
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
  let doc: Record<string, unknown>
  try {
    doc = parser.parse(xml) as Record<string, unknown>
  } catch {
    return { plate: plateAssignment, extruder: extruderMap }
  }
  const model = findModelRoot(doc) ?? deepFindModelWithResources(doc)
  if (!model) return { plate: plateAssignment, extruder: extruderMap }
  const resourcesRaw = model.resources ?? (model as { Resources?: unknown }).Resources
  const resources = unwrapXmlRecord(resourcesRaw) as
    | { object?: unknown; Object?: unknown }
    | null
    | undefined
  const objects = normalizeArray(resources?.object ?? resources?.Object) as Record<string, unknown>[]
  const objectMap = buildObjectMap(objects)
  const plateExpanded = expandPlateAssignmentWithAssemblyChildKeys(model, objectMap, plateAssignment)
  const extruderExpanded = expandExtruderAssignmentWithAssemblyChildKeys(model, objectMap, extruderMap)
  const plateAncestor = expandOidInstMapOntoAncestorKeys(objectMap, plateExpanded)
  const extruderAncestor = expandOidInstMapOntoAncestorKeys(objectMap, extruderExpanded)
  // Also propagate DOWNWARD: composite build-item objects → their component mesh children.
  // This ensures mesh components inherit their parent's plate/extruder so geometry bucketing
  // routes them to the right plate even when the config only lists the composite object ID.
  const plate = expandOidInstMapOntoDescendantKeys(objectMap, plateAncestor)
  const extruder = expandOidInstMapOntoDescendantKeys(objectMap, extruderAncestor)
  return { plate, extruder }
}

/** `Metadata/plate_<n>.png` members (Bambu), sorted by plate index. */
/** Avoids the spread-into-charCodeAt stack-overflow for large typed arrays. */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

async function extractThumbnailDataUrls(zip: JSZip, paths: string[]): Promise<string[]> {
  const results: string[] = []
  for (const p of paths) {
    const entry = findZipEntry(zip, p)
    if (!entry) { results.push(''); continue }
    try {
      const bytes = await entry.async('uint8array')
      results.push(`data:image/png;base64,${uint8ArrayToBase64(bytes)}`)
    } catch {
      results.push('')
    }
  }
  return results
}

function listPlateThumbnailPathsInZip(zip: JSZip): string[] | undefined {
  const paths: string[] = []
  for (const key of Object.keys(zip.files)) {
    if (zip.files[key].dir) continue
    const n = normalizePartPath(key)
    if (!/^metadata\/plate_\d+\.png$/i.test(n)) continue
    paths.push(n)
  }
  if (paths.length === 0) return undefined
  paths.sort((a, b) => {
    const ma = /plate_(\d+)/i.exec(a)
    const mb = /plate_(\d+)/i.exec(b)
    return (ma ? parseInt(ma[1]!, 10) : 0) - (mb ? parseInt(mb[1]!, 10) : 0)
  })
  return paths
}

function parseCornersToBedMm(cornersStr: string): { widthMm: number; depthMm: number } | undefined {
  const parts = cornersStr
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  let any = false
  for (const p of parts) {
    const m = /^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i.exec(p)
    if (!m) continue
    const x = parseFloat(m[1]!)
    const y = parseFloat(m[2]!)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    any = true
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (!any) return undefined
  const w = maxX - minX
  const d = maxY - minY
  if (w < 10 || d < 10) return undefined
  return { widthMm: w, depthMm: d }
}

function parseBedPairMm(s: string): { widthMm: number; depthMm: number } | undefined {
  const t = s.trim()
  const m = /^(\d+(?:\.\d+)?)\s*[x×;]\s*(\d+(?:\.\d+)?)$/i.exec(t)
  if (!m) return undefined
  const a = parseFloat(m[1]!)
  const b = parseFloat(m[2]!)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 10 || b < 10) return undefined
  return { widthMm: a, depthMm: b }
}

/** Printable rectangle from Bambu / Orca `project_settings` (JSON, XML metadata, or INI lines). */
function parsePrintableBedMmFromProjectSettings(ps: string | null): { widthMm: number; depthMm: number } | undefined {
  if (!ps) return undefined
  const t = ps.trim()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>
      const keys = ['printable_area', 'bed_printable', 'print_bed_size', 'bed_size']
      for (const k of keys) {
        const raw = j[k]
        if (raw === undefined || raw === null) continue
        if (typeof raw === 'string') {
          const span = parseCornersToBedMm(raw) ?? parseBedPairMm(raw)
          if (span) return span
        }
        if (Array.isArray(raw)) {
          const joined = raw.map((x) => String(x).trim()).join(',')
          const span = parseCornersToBedMm(joined)
          if (span) return span
        }
      }
    } catch {
      /* ignore */
    }
  }
  for (const k of ['printable_area', 'bed_size', 'print_bed_size']) {
    const v = extractFirstMetadataValue(ps, k)
    if (!v) continue
    const span = parseCornersToBedMm(v) ?? parseBedPairMm(v)
    if (span) return span
  }
  const iniRe =
    /(?:^|[\n\r])[\t ]*(?:printable_area|bed_size|print_bed_size)[\t ]*=[\t ]*([^\n\r;]+)/gim
  let im: RegExpExecArray | null
  while ((im = iniRe.exec(ps)) !== null) {
    const body = im[1]!.trim()
    const span = parseCornersToBedMm(body) ?? parseBedPairMm(body)
    if (span) return span
  }
  return undefined
}

/** `<object id>` from OPC resources — compare to slicer `model_settings` when plates look empty. */
function collectOpcResourceObjectIdsFromXml(opcXml: string | null): string[] {
  if (!opcXml) return []
  const re = /<(?:[\w-]+:)?object\b([^>]*?)(?:\/>|>)/gi
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(opcXml)) !== null) {
    const tag = m[1] ?? ''
    const idM = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag)
    if (!idM) continue
    const id = String(idM[1]).trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function collectBuildObjectsFromOpcModelXml(
  opcXml: string | null,
  plateAssignment: Map<string, number> | null,
  extruderMap: Map<string, number> | null
): ThreeMfBuildObjectSummary[] {
  if (!opcXml) return []
  const re = /<(?:[\w-]+:)?object\b([^>]*?)(?:\/>|>)/gi
  const out: ThreeMfBuildObjectSummary[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(opcXml)) !== null) {
    const tag = m[1] ?? ''
    const idM = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag)
    if (!idM || String(idM[1]).trim() === '') continue
    const id = String(idM[1]).trim()
    const nameM =
      /\bname\s*=\s*["']([^"']*)["']/i.exec(tag) ??
      /\bName\s*=\s*["']([^"']*)["']/.exec(tag) ??
      /\bpartname\s*=\s*["']([^"']*)["']/i.exec(tag)
    const name = nameM && String(nameM[1]).trim().length > 0 ? String(nameM[1]).trim() : id
    const plateA = lookupPlateForOidInst(plateAssignment, id, 0)
    const plateB = lookupPlateForOidInst(plateAssignment, id, 1)
    const plateId = plateA ?? plateB
    const exA = lookupExtruderForOidInst(extruderMap, id, 0)
    const exB = lookupExtruderForOidInst(extruderMap, id, 1)
    const extruderSlot = exA ?? exB
    out.push({
      id,
      name,
      ...(plateId !== undefined ? { plateId } : {}),
      ...(extruderSlot !== undefined ? { extruderSlot } : {})
    })
  }
  return out
}

function enrichPlatePartsFilamentSlots(
  merged: TriangleMesh,
  plateAssignment: Map<string, number> | null,
  extruderMap: Map<string, number> | null
): void {
  if (!merged.plateParts || merged.plateParts.length === 0) return
  if (!extruderMap || extruderMap.size === 0) return
  if (!plateAssignment || plateAssignment.size === 0) return
  const counts = new Map<number, Map<number, number>>()
  for (const [key, slot] of extruderMap) {
    const colon = key.lastIndexOf(':')
    const oid = colon >= 0 ? key.slice(0, colon) : key
    const inst = colon >= 0 ? Number(key.slice(colon + 1)) : 0
    const pl = lookupPlateForOidInst(plateAssignment, oid, Number.isFinite(inst) ? inst : 0)
    if (pl === undefined) continue
    if (!counts.has(pl)) counts.set(pl, new Map())
    const row = counts.get(pl)!
    row.set(slot, (row.get(slot) ?? 0) + 1)
  }
  for (const part of merged.plateParts) {
    const row = counts.get(part.plateId)
    if (!row || row.size === 0) continue
    let bestSlot = 1
    let bestC = -1
    for (const [slot, c] of row) {
      if (c > bestC) {
        bestC = c
        bestSlot = slot
      }
    }
    part.filamentSlot = bestSlot
  }
}

function mergeSlicerDisplayNamesIntoBuildObjects(
  rows: ThreeMfBuildObjectSummary[],
  nameByOid: Map<string, string>
): ThreeMfBuildObjectSummary[] {
  if (nameByOid.size === 0) return rows
  return rows.map((o) => {
    const k = canonical3mfObjectIdForKey(o.id)
    const label =
      nameByOid.get(oidInstMapKey(o.id, 0)) ??
      nameByOid.get(oidInstMapKey(o.id, 1)) ??
      nameByOid.get(k) ??
      nameByOid.get(String(o.id).trim())
    if (!label || !label.trim()) return o
    const nm = o.name.trim()
    const idTrim = String(o.id).trim()
    const bare = nm === '' || nm === idTrim || nm === k
    if (!bare && nm.length > 0) return o
    return { ...o, name: label.trim() }
  })
}

/** When extruder→plate counting misses (id mismatch), copy dominant extruder per plate from the sidebar object list. */
function enrichPlatePartsFilamentSlotsFromBuildObjects(
  merged: TriangleMesh,
  buildObjects: ThreeMfBuildObjectSummary[]
): void {
  if (!merged.plateParts || merged.plateParts.length === 0 || buildObjects.length === 0) return
  const byPlate = new Map<number, Map<number, number>>()
  for (const o of buildObjects) {
    if (o.plateId === undefined || o.extruderSlot === undefined) continue
    if (!byPlate.has(o.plateId)) byPlate.set(o.plateId, new Map())
    const row = byPlate.get(o.plateId)!
    const s = o.extruderSlot
    row.set(s, (row.get(s) ?? 0) + 1)
  }
  for (const part of merged.plateParts) {
    if (part.filamentSlot !== undefined) continue
    const row = byPlate.get(part.plateId)
    if (!row || row.size === 0) continue
    let bestSlot = 1
    let bestC = -1
    for (const [slot, c] of row) {
      if (c > bestC) {
        bestC = c
        bestSlot = slot
      }
    }
    part.filamentSlot = bestSlot
  }
}

/**
 * Bambu / Orca NOAMS (No AMS, single-extruder multi-plate) files store the actual filament slot
 * for each plate in `Metadata/plate_N.json` as `first_extruder` (0-based index into the filament
 * list).  When every platePart ends up with the same `filamentSlot` (because all config objects
 * carry `extruder=1`), the mesh-based assignment gives us no useful per-plate signal.  This
 * function overrides `filamentSlot` from the JSON truth so each plate gets its correct color.
 */
async function enrichPlatePartsFilamentSlotsFromPlateJson(
  merged: TriangleMesh,
  zip: JSZip
): Promise<void> {
  if (!merged.plateParts || merged.plateParts.length === 0) return
  for (const part of merged.plateParts) {
    const plateId = part.plateId
    const entry = findZipEntry(zip, `Metadata/plate_${plateId}.json`)
    if (!entry) continue
    try {
      const text = await entry.async('string')
      const obj = JSON.parse(text) as Record<string, unknown>
      const fe = obj.first_extruder
      if (typeof fe === 'number' && Number.isFinite(fe) && fe >= 0) {
        // first_extruder is 0-based in Bambu/Orca 3MF; convert to 1-based filament slot.
        part.filamentSlot = Math.floor(fe) + 1
      }
    } catch {
      // ignore missing files or parse errors
    }
  }
}

/**
 * Plate and filament summary from the same sources Orca / Bambu Studio use in the 3MF:
 * `<plate>` / `plater_id` + `<model_instance>` in `model_settings.config`, and `<filament>` colour metadata
 * (plus `filament_colour =` INI lines already merged into the paint palette).
 */
async function buildThreeMfPackageMeta(
  zip: JSZip,
  plateAssignment: Map<string, number> | null,
  extruderMap: Map<string, number> | null,
  merged: TriangleMesh,
  filamentPaletteLinear: Float32Array | null,
  buildObjectsHint?: ThreeMfBuildObjectSummary[] | null
): Promise<ThreeMfPackageMeta> {
  const ms = await readModelSettingsXml(zip)
  const rawPlates = ms ? countPlateOpenTagsInXml(ms) : 0
  const assignIds =
    plateAssignment && plateAssignment.size > 0
      ? [...new Set(plateAssignment.values())].sort((a, b) => a - b)
      : []
  const meshPlates = merged.plateParts
  const plateCount = Math.max(meshPlates?.length ?? 0, rawPlates, assignIds.length, 1)

  const hexFromXml = await collectBestFilamentHexesFromZip(zip)
  const hexFromPal = linearRgbPaletteToHexList(filamentPaletteLinear)
  const filamentCount = Math.max(hexFromXml.length, hexFromPal.length, 1)
  const filamentColorsHex: string[] = []
  for (let i = 0; i < filamentCount; i++) {
    filamentColorsHex.push(hexFromXml[i] ?? hexFromPal[i] ?? '#B8BEC9')
  }

  const ps = await readProjectSettingsXml(zip)
  const bedParsed = ps ? parsePrintableBedMmFromProjectSettings(ps) : undefined
  const hMs = ms ? extractThreeMfSliceHintsFromConfigXml(ms) : { filamentTypes: [] as string[] }
  const hPs = ps
    ? ps.trim().startsWith('{')
      ? extractThreeMfSliceHintsFromJsonConfig(ps) ?? { filamentTypes: [] as string[] }
      : extractThreeMfSliceHintsFromConfigXml(ps)
    : { filamentTypes: [] as string[] }
  const typesBest =
    hMs.filamentTypes.length >= hPs.filamentTypes.length ? hMs.filamentTypes : hPs.filamentTypes
  const typesRow = typesBest.slice()
  while (typesRow.length < filamentCount) typesRow.push('—')
  const typesTrim = typesRow.slice(0, filamentCount)
  const hasMeaningfulTypes = typesTrim.some((t) => t !== '—')

  const pMs = ms ? extractThreeMfProcessHintsFromConfigXml(ms) : ({} as ThreeMfProcessHints)
  const pPs = ps
    ? ps.trim().startsWith('{')
      ? extractThreeMfProcessHintsFromJsonConfig(ps) ?? ({} as ThreeMfProcessHints)
      : extractThreeMfProcessHintsFromConfigXml(ps)
    : ({} as ThreeMfProcessHints)
  let processHints = mergeProcessHints(pMs, pPs)

  const opcXml = await readPrimaryOpcModelXml(zip)
  const parsedOpcObjectIds = collectOpcResourceObjectIdsFromXml(opcXml)
  let buildObjects: ThreeMfBuildObjectSummary[]
  if (buildObjectsHint && buildObjectsHint.length > 0) {
    buildObjects = buildObjectsHint
  } else {
    const displayNames = await loadBambuObjectDisplayNamesFromModelSettings(zip)
    buildObjects = mergeSlicerDisplayNamesIntoBuildObjects(
      collectBuildObjectsFromOpcModelXml(opcXml, plateAssignment, extruderMap),
      displayNames
    )
  }
  const plateIdSet = new Set<number>()
  if (meshPlates && meshPlates.length > 0) {
    for (const p of meshPlates) plateIdSet.add(p.plateId)
  }
  for (const id of assignIds) {
    if (Number.isFinite(id)) plateIdSet.add(id)
  }
  for (const o of buildObjects) {
    if (typeof o.plateId === 'number' && Number.isFinite(o.plateId)) plateIdSet.add(o.plateId)
  }
  // Do NOT add 1..plateCount synthetically: model_settings.config often lists more
  // <plate> entries than have geometry (e.g. 12 for a 6-plate A1 Mini project), which
  // would create empty bed cells in the viewer for every unlisted plate.
  const plateIds = [...plateIdSet].sort((a, b) => a - b)

  const opcMeta = opcXml ? extractOpcModelMetadataByName(opcXml) : null
  const opcTitle = opcMeta?.get('Title')?.trim()
  const opcProfileTitle = opcMeta?.get('ProfileTitle')?.trim()
  const opcDesigner = opcMeta?.get('Designer')?.trim()
  if (opcProfileTitle) {
    processHints = mergeProcessHints(processHints ?? ({} as ThreeMfProcessHints), {
      printPresetId: opcProfileTitle
    })
  }

  const plateThumbnailPaths    = listPlateThumbnailPathsInZip(zip)
  const plateThumbnailDataUrls = plateThumbnailPaths
    ? await extractThumbnailDataUrls(zip, plateThumbnailPaths)
    : undefined

  return {
    plateCount,
    plateIds,
    filamentCount,
    filamentColorsHex,
    projectName: hMs.projectName ?? hPs.projectName ?? opcTitle,
    bedType: hMs.bedType ?? hPs.bedType,
    printerModelId: hMs.printerModelId ?? hPs.printerModelId,
    ...(opcDesigner ? { designer: opcDesigner } : {}),
    ...(hasMeaningfulTypes ? { filamentTypes: typesTrim } : {}),
    ...(processHints ? { processHints } : {}),
    ...(plateThumbnailPaths ? { plateThumbnailPaths } : {}),
    ...(plateThumbnailDataUrls ? { plateThumbnailDataUrls } : {}),
    ...(bedParsed ? { bedWidthMm: bedParsed.widthMm, bedDepthMm: bedParsed.depthMm } : {}),
    ...(buildObjects.length > 0 ? { buildObjects } : {}),
    ...(parsedOpcObjectIds.length > 0 ? { parsedOpcObjectIds } : {})
  }
}

function meshAabbCenterXZInViewerSpace(positions: Float32Array): { x: number; z: number } {
  if (positions.length < 3) return { x: 0, z: 0 }
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!
    const z = positions[i + 2]!
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  if (!Number.isFinite(minX)) return { x: 0, z: 0 }
  return { x: (minX + maxX) * 0.5, z: (minZ + maxZ) * 0.5 }
}

/**
 * When slicer plate metadata does not yield `plateParts`, group each loaded `.model` mesh by the
 * coarse cell of its bounding-box centre on the viewer bed plane (XZ). Matches how generic 3MF
 * viewers rely on `<build>` transforms: bodies on different virtual plates are usually hundreds of
 * mm apart after `remapThreeMfPrintVolumeToViewer`.
 */
function inferPlatePartsFromPartMeshesSpatialXZ(parts: TriangleMesh[]): TriangleMeshPlatePart[] | null {
  if (parts.length < 2) return null
  for (const cellMm of [280, 260, 240, 220, 200, 180, 320, 300, 350, 160, 140, 120, 100, 85]) {
    const groups = new Map<string, TriangleMesh[]>()
    for (const p of parts) {
      const c = meshAabbCenterXZInViewerSpace(p.positions)
      const key = `${Math.floor(c.x / cellMm)},${Math.floor(c.z / cellMm)}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(p)
    }
    if (groups.size < 2) continue
    const plateParts: TriangleMeshPlatePart[] = []
    let pid = 1
    for (const k of [...groups.keys()].sort()) {
      const list = groups.get(k)!
      plateParts.push({ plateId: pid++, mesh: mergeTriangleMeshList(list) })
    }
    return plateParts
  }
  return null
}

/** Loads triangle mesh from a 3MF package (build items + component trees, then direct mesh fallback). */
/** Merge geometry from several `.model` parts; combine per-plate sub-meshes with matching `plateId`. */
function mergeMultiPartThreeMfMeshes(
  parts: TriangleMesh[],
  partPlateHints?: (number | undefined)[]
): TriangleMesh {
  if (parts.length === 0) return { positions: new Float32Array(0), indices: new Uint32Array(0) }
  if (parts.length === 1) return parts[0]!
  const baseMerge = mergeTriangleMeshList(parts)
  // Each entry carries a mesh and optional subObjects (propagated from Bambu split-format files).
  const byPlate = new Map<number, Array<{ mesh: TriangleMesh; subObjects?: TriangleMeshPlateSubObject[] }>>()
  const handled = new Array<boolean>(parts.length).fill(false)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    const hint = partPlateHints?.[i]
    // Bambu split-format pattern: single catch-all plate-0 with a known plate hint.
    // Use the hint for correct plate ID while preserving any subObjects from the part.
    const isSingleCatchAll =
      p.plateParts && p.plateParts.length === 1 && p.plateParts[0].plateId === 0
    if (isSingleCatchAll && hint !== undefined && Number.isFinite(hint)) {
      if (!byPlate.has(hint)) byPlate.set(hint, [])
      const catchAllSubs = p.plateParts![0].subObjects
      byPlate.get(hint)!.push({ mesh: p.plateParts![0].mesh, subObjects: catchAllSubs })
      handled[i] = true
      continue
    }
    if (p.plateParts && p.plateParts.length > 0) {
      for (const pp of p.plateParts) {
        if (!byPlate.has(pp.plateId)) byPlate.set(pp.plateId, [])
        byPlate.get(pp.plateId)!.push({ mesh: pp.mesh, subObjects: pp.subObjects })
      }
      handled[i] = true
      continue
    }
    if (hint !== undefined && Number.isFinite(hint)) {
      if (!byPlate.has(hint)) byPlate.set(hint, [])
      byPlate.get(hint)!.push({ mesh: p })
      handled[i] = true
    }
  }
  let nextSyntheticPlate =
    byPlate.size > 0 ? Math.max(...byPlate.keys()) + 1 : 1
  for (let i = 0; i < parts.length; i++) {
    if (handled[i]) continue
    const pid = nextSyntheticPlate++
    if (!byPlate.has(pid)) byPlate.set(pid, [])
    byPlate.get(pid)!.push({ mesh: parts[i]! })
  }
  if (byPlate.size <= 1) return baseMerge
  const plateParts: TriangleMeshPlatePart[] = []
  for (const pid of [...byPlate.keys()].sort((a, b) => a - b)) {
    const entries = byPlate.get(pid)!
    const meshList = entries.map((e) => e.mesh)
    // Collect subObjects from all contributing sources for this plate.
    const allSubs: TriangleMeshPlateSubObject[] = []
    for (const e of entries) {
      if (e.subObjects && e.subObjects.length > 0) allSubs.push(...e.subObjects)
    }
    const subObjects = allSubs.length >= 2 ? allSubs : undefined
    plateParts.push({
      plateId: pid,
      mesh: mergeTriangleMeshList(meshList),
      ...(subObjects ? { subObjects } : {})
    })
  }
  if (plateParts.length <= 1) return baseMerge
  return { ...baseMerge, plateParts }
}

export async function loadThreeMf(buffer: Uint8Array): Promise<TriangleMesh> {
  if (!buffer?.length) {
    throw new Error('3MF file is empty')
  }
  // ZIP local file header signature
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('3MF is not a valid ZIP package (wrong file type or corrupt download)')
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`3MF could not be opened as a ZIP archive: ${msg}`)
  }
  const candidates = await listModelZipCandidates(zip)
  if (candidates.length === 0) {
    throw new Error('No 3D model document found inside 3MF')
  }

  const filamentPaletteRgb = await loadFilamentPaletteFromZip(zip)
  const bambuAssemble = await loadBambuAssembleComposeMapFromZip(zip)

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: true,
    trimValues: true,
    ignoreDeclaration: true
  })
  const [plateAssignmentRaw, extruderMapRaw] = await Promise.all([
    loadBambuPlateObjectInstanceMap(zip),
    loadBambuExtruderSlotByOidInst(zip)
  ])
  const { plate: plateExpanded, extruder: extruderExpanded } = await expandOidInstMapsWithPrimaryOpcModel(
    zip,
    parser,
    plateAssignmentRaw,
    extruderMapRaw
  )
  const plateAssignment = normalizeOidInstMapKeys(plateExpanded)
  const extruderMap = normalizeOidInstMapKeys(extruderExpanded)
  // Expand both maps so mesh object IDs (source_object_id in config <part>) resolve correctly.
  // plateAssignment / extruderMap are null when no config data was found; empty Maps are safe
  // because expandMapsWithSourceObjectIds early-returns when both sizes are 0.
  await expandMapsWithSourceObjectIds(zip, plateAssignment ?? new Map(), extruderMap ?? new Map())
  const errors: string[] = []
  const meshParts: TriangleMesh[] = []
  const partPlateHints: (number | undefined)[] = []
  const multiModel = candidates.length > 1
  const hasDefaultMain = candidates.some((c) => isDefaultThreeMfModelPath(c.name))

  // Bambu split-format: pre-parse the primary model to build a
  // subModelPath → { plateId, worldTransform } map from <component p:path="..."> references.
  let subModelPathToPlate = new Map<string, SubModelPlateHint>()
  if (multiModel && plateAssignment && plateAssignment.size > 0) {
    const primaryFile =
      candidates.find((c) => isDefaultThreeMfModelPath(c.name)) ??
      (hasDefaultMain ? null : candidates[0])
    if (primaryFile) {
      try {
        let primaryXml = await primaryFile.async('string')
        if (primaryXml.charCodeAt(0) === 0xfeff) primaryXml = primaryXml.slice(1)
        const primaryDoc = parser.parse(primaryXml) as Record<string, unknown>
        const primaryModel = findModelRoot(primaryDoc) ?? deepFindModelWithResources(primaryDoc)
        if (primaryModel) {
          subModelPathToPlate = buildSubModelPathToPlateMap(primaryModel, plateAssignment, bambuAssemble)
        }
      } catch {
        // non-fatal — fall back to existing inference
      }
    }
  }

  for (const modelFile of candidates) {
    try {
      let xml = await modelFile.async('string')
      if (xml.charCodeAt(0) === 0xfeff) {
        xml = xml.slice(1)
      }
      let doc: Record<string, unknown>
      try {
        doc = parser.parse(xml) as Record<string, unknown>
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        errors.push(`${modelFile.name}: XML parse failed (${msg})`)
        continue
      }
      const model = findModelRoot(doc) ?? deepFindModelWithResources(doc)
      if (!model) {
        errors.push(`${modelFile.name}: unrecognized structure (no model/resources)`)
        continue
      }

      // Bambu split-format files (multiple .model entries) use identity build-item
      // transforms; the <assemble_item> data from model_settings.config provides the
      // actual per-instance placement, so we apply it for the primary split file only.
      //
      // Single-file (non-split) Bambu 3MF files are different: the <build><item>
      // transforms already encode the correct print-bed positions.  The assemble items
      // here represent the *assembly/CAD view* — how parts fit in the final product —
      // NOT corrections to the print placement.  Multiplying them onto the build
      // transforms scatters sub-objects across thousands of mm (their CAD positions).
      // For single-file models we therefore use ONLY the build transforms.
      const usePrimaryBambuAux =
        multiModel && (hasDefaultMain ? isDefaultThreeMfModelPath(modelFile.name) : candidates[0] === modelFile)

      // Bambu split-format: look up the sub-model hint BEFORE extraction so per-component
      // world transforms can be forwarded into collectDirectMeshes for files that pack
      // multiple mesh objects (referenced by separate <component objectid="…"> entries in
      // the primary model) into one sub-model file.
      const normalizedName = normalizePath(normalizePartPath(modelFile.name))
      const subHint = subModelPathToPlate.get(normalizedName)

      let mesh = extractTriangleMeshFromParsedModel(
        model,
        filamentPaletteRgb,
        bambuAssemble,
        usePrimaryBambuAux,
        plateAssignment,
        extruderMap,
        subHint?.objectTransforms ?? null
      )
      if (mesh.positions.length === 0) {
        errors.push(`${modelFile.name}: no mesh geometry`)
        continue
      }

      const unitAttr =
        (model as { '@_unit'?: string; '@_Unit'?: string })['@_unit'] ??
        (model as { '@_Unit'?: string })['@_Unit']
      const unitMmScale = threeMfUnitToMmScale(unitAttr)

      // Apply slicer-space positioning BEFORE viewer axis remapping.
      if (subHint !== undefined) {
        if (subHint.objectTransforms && subHint.objectTransforms.size > 0) {
          // Per-object transforms were already applied inside collectDirectMeshes; each
          // sub-object mesh is already at its correct slicer position.  Try to split the
          // single catch-all plate into per-cluster plates based on XY spatial separation.
          mesh = splitPlatePartsBySubObjectClusters(mesh, subHint.plateId)
        } else {
          // Single global world transform: shift all geometry in one pass.
          mesh.positions = transformPositionsMat4(mesh.positions, subHint.worldTransform)
          if (mesh.plateParts) {
            for (const pp of mesh.plateParts) {
              pp.mesh.positions = transformPositionsMat4(pp.mesh.positions, subHint.worldTransform)
              if (pp.subObjects) {
                for (const so of pp.subObjects) {
                  so.mesh.positions = transformPositionsMat4(so.mesh.positions, subHint.worldTransform)
                }
              }
            }
          }
        }
      }

      // Bambu split-format: a single sub-model file that had no build items lands its geometry
      // in catch-all plate bucket 0.  When we have a definitive plate hint (from the primary
      // model's component → plateAssignment look-up), remap plateId 0 → real plate ID so the
      // geometry is attributed to the correct plate number in both the viewer layout and the
      // sidebar's "Plate IDs" list.  Only applies when there is exactly one plate part (the
      // catch-all) and the real plate is ≥ 1.
      if (
        subHint &&
        subHint.plateId >= 1 &&
        mesh.plateParts &&
        mesh.plateParts.length === 1 &&
        mesh.plateParts[0].plateId === 0
      ) {
        mesh.plateParts[0].plateId = subHint.plateId
      }

      let meshRemappedToViewer = false
      if (!mesh.plateParts || mesh.plateParts.length <= 1) {
        const rescue = trySpatialRebuildSingleModelMesh(
          model,
          filamentPaletteRgb,
          bambuAssemble,
          usePrimaryBambuAux,
          plateAssignment,
          unitMmScale
        )
        if (rescue) {
          mesh = rescue
          meshRemappedToViewer = true
        }
      }
      if (!meshRemappedToViewer) {
        if (unitMmScale !== 1) {
          for (let i = 0; i < mesh.positions.length; i++) {
            mesh.positions[i] *= unitMmScale
          }
        }
        /** Slicer 3MF: bed in XY, +Z toward the nozzle. Viewer: bed in XZ, +Y up (Babylon). */
        remapThreeMfPrintVolumeToViewer(mesh)
      }

      let plateHint: number | undefined
      if (
        multiModel &&
        (!mesh.plateParts || mesh.plateParts.length <= 1) &&
        plateAssignment &&
        plateAssignment.size > 0
      ) {
        // First try the pre-built cross-file component path map (Bambu split format).
        plateHint = subHint?.plateId
        // Fall back to build-item / resource-ID inference for other multi-model formats.
        if (plateHint === undefined) {
          plateHint = inferDominantBuildPlateIdForModel(
            model,
            plateAssignment,
            bambuAssemble,
            usePrimaryBambuAux
          )
        }
      }
      meshParts.push(mesh)
      partPlateHints.push(plateHint)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`${modelFile.name}: ${msg}`)
    }
  }

  if (meshParts.length > 0) {
    let merged = mergeMultiPartThreeMfMeshes(
      meshParts,
      partPlateHints.length === meshParts.length ? partPlateHints : undefined
    )
    if (!merged.plateParts || merged.plateParts.length <= 1) {
      const spatial = inferPlatePartsFromPartMeshesSpatialXZ(meshParts)
      if (spatial && spatial.length > 1) {
        merged = { ...mergeTriangleMeshList(meshParts), plateParts: spatial }
      }
    }
    fixOneBasedIndices(merged)
    enrichPlatePartsFilamentSlots(merged, plateAssignment, extruderMap)
    const opcXmlForObjects = await readPrimaryOpcModelXml(zip)
    const displayNamesForObjects = await loadBambuObjectDisplayNamesFromModelSettings(zip)
    const buildObjectsForPackage = mergeSlicerDisplayNamesIntoBuildObjects(
      collectBuildObjectsFromOpcModelXml(opcXmlForObjects, plateAssignment, extruderMap),
      displayNamesForObjects
    )
    enrichPlatePartsFilamentSlotsFromBuildObjects(merged, buildObjectsForPackage)
    await enrichPlatePartsFilamentSlotsFromPlateJson(merged, zip)
    merged.packageMeta = await buildThreeMfPackageMeta(
      zip,
      plateAssignment,
      extruderMap,
      merged,
      filamentPaletteRgb,
      buildObjectsForPackage
    )
    return merged
  }

  const tail = errors.length ? `\n${errors.slice(0, 10).join('\n')}` : ''
  throw new Error(`3MF: could not load any model part from this package.${tail}`)
}
