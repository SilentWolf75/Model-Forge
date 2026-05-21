/**
 * R3FViewer — React Three Fiber renderer replacing BabylonViewer.
 * All TriangleMesh / loader / repair / analysis code is unchanged.
 * This file owns: scene graph, camera, lighting, overlays, measure mode.
 */
import {
  useEffect, useRef, forwardRef, useImperativeHandle, type ForwardedRef,
} from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import type { ThreeMfBuildObjectSummary, ThreeMfPackageMeta, TriangleMesh } from '../mesh/types'
import { type CameraPresetId } from './cameraPrefs'

// ─── Dev diagnostics ──────────────────────────────────────────────────────────
function mfDiagLog(...args: unknown[]): void {
  if (import.meta.env.DEV) console.log(...args) // eslint-disable-line no-console
}

// ─── Constants ────────────────────────────────────────────────────────────────
const BED_SURFACE_Y = -0.0005
const MODEL_BED_GAP_MM = 0.12
const DEFAULT_BED_MM = 280
const BED_MIN_MM = 220
const BED_MAX_MM = 1200
const BED_PADDING = 1.14
const OVERVIEW_PLATE_COLS = 3
const OVERVIEW_PLATE_GAP_MM = 24
const MIN_VISUAL_PART_HEIGHT_MM = 5
const MAX_THIN_PART_Y_SCALE = 12
const DEFAULT_VIEW_ALPHA = -0.48 * Math.PI
const DEFAULT_VIEW_BETA  = 1.05
const DEFAULT_RADIUS_FACTOR = 1.38
const MULTI_PLATE_RADIUS_FACTOR = 1.06
const BOUNCE_DURATION = 0.97  // seconds ≈ 58 frames @ 60 fps
const BG_COLOR = '#242933'    // sRGB match for Orca/Bambu dark background

// Orca gouraud.vs eye-space light directions (FROM surface TO light)
const ORCA_KEY_EYE  = new THREE.Vector3(-0.4574957,  0.4574957, 0.7624929)
const ORCA_FILL_EYE = new THREE.Vector3( 0.6985074,  0.1397015, 0.6985074)

// drei OrbitControls speed mappings for Babylon-compatible presets
const R3F_PRESETS: Record<CameraPresetId, { zoomSpeed: number; panSpeed: number }> = {
  default: { zoomSpeed: 3.5, panSpeed: 1.0 },
  quick:   { zoomSpeed: 9.0, panSpeed: 3.5 },
}

// ─── Public types ─────────────────────────────────────────────────────────────
export type ViewMode = 'solid' | 'wireframe' | 'xray'

export type ViewerHandle = {
  resetDefaultView:   () => void
  focusCameraOnPlate: (plateId: number) => void
  captureScreenshot:  () => string | null
}

// ─── Internal types ───────────────────────────────────────────────────────────
interface Props {
  mesh: TriangleMesh | null
  viewMode: ViewMode
  loadAnimSeq: number
  cameraPreset: CameraPresetId
  openEdgeLinePositions?: Float32Array | null
  measureMode?: boolean
  onMeasureResult?: (distanceMm: number, ptA: [number, number, number], ptB: [number, number, number]) => void
}

interface BounceState {
  mesh:      THREE.Object3D
  startY:    number
  restY:     number
  startTime: number  // -1 = capture on first frame
}

interface ViewerSceneProps extends Props {
  outerRef: ForwardedRef<ViewerHandle>
  controlsRef: React.MutableRefObject<OrbitControlsImpl | null>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexCssToColor(hex: string): THREE.Color {
  let t = hex.trim().replace(/^#/, '')
  if (t.length === 8) t = t.slice(2)
  if (t.length === 6) return new THREE.Color(`#${t}`)
  return new THREE.Color(0.52, 0.78, 1.0)
}

function dominantExtruderSlot(
  objs: ThreeMfBuildObjectSummary[] | undefined,
  plateId: number
): number | undefined {
  if (!objs?.length) return undefined
  const counts = new Map<number, number>()
  for (const o of objs) {
    if (o.plateId !== plateId || o.extruderSlot === undefined) continue
    counts.set(o.extruderSlot, (counts.get(o.extruderSlot) ?? 0) + 1)
  }
  let best: number | undefined, bestC = -1
  for (const [s, c] of counts) { if (c > bestC) { bestC = c; best = s } }
  return best
}

function meshAabbXZ(positions: Float32Array): { cx: number; cz: number } {
  if (positions.length < 3) return { cx: 0, cz: 0 }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!)
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!)
  }
  if (!Number.isFinite(minX)) return { cx: 0, cz: 0 }
  return { cx: (minX + maxX) * 0.5, cz: (minZ + maxZ) * 0.5 }
}

function createModelMaterial(color: THREE.Color, useVc: boolean): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    color: useVc ? new THREE.Color(1, 1, 1) : color,
    specular: new THREE.Color(0.075, 0.075, 0.075),
    shininess: 20,
    side: THREE.DoubleSide,
    vertexColors: useVc,
  })
}

function applyViewMode(mat: THREE.MeshPhongMaterial, mode: ViewMode): void {
  mat.wireframe = mode === 'wireframe'
  if (mode === 'xray') {
    mat.transparent = true; mat.opacity = 0.38; mat.depthWrite = false
  } else {
    mat.transparent = false; mat.opacity = 1; mat.depthWrite = true
  }
  mat.needsUpdate = true
}

function meshToGeometry(data: TriangleMesh, useVc: boolean): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(data.positions.slice(), 3))
  geo.setIndex(new THREE.BufferAttribute(data.indices.slice(), 1))
  if (useVc && data.vertexColors && data.vertexColors.length === data.positions.length) {
    geo.setAttribute('color', new THREE.BufferAttribute(data.vertexColors.slice(), 3))
  }
  geo.computeVertexNormals()
  return geo
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry?.dispose()
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      for (const m of mats) (m as THREE.Material | undefined)?.dispose()
    }
  })
}

function createBedGroup(widthMm: number, depthMm: number): THREE.Group {
  const g = new THREE.Group()
  g.name = 'bed'
  g.position.y = BED_SURFACE_Y

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(widthMm, depthMm),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#29303a'), side: THREE.DoubleSide })
  )
  plane.rotation.x = -Math.PI / 2
  plane.name = 'bedPlane'
  g.add(plane)

  const majorDiv = Math.max(4, Math.round(Math.max(widthMm, depthMm) / 10))
  const grid = new THREE.GridHelper(Math.max(widthMm, depthMm), majorDiv, 0x4d576b, 0x4d576b)
  grid.name = 'bedGrid'
  ;(grid.material as THREE.LineBasicMaterial).transparent = true
  ;(grid.material as THREE.LineBasicMaterial).opacity = 0.6
  g.add(grid)

  return g
}

function setBedOpacity(bedGroup: THREE.Group, _opaque: boolean, seeThrough: boolean, belowBed: boolean): void {
  bedGroup.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const mat = child.material as THREE.MeshBasicMaterial
      if (belowBed) { mat.transparent = true; mat.opacity = 0.06; mat.depthWrite = false }
      else if (seeThrough) { mat.transparent = true; mat.opacity = 0.22; mat.depthWrite = false }
      else { mat.transparent = false; mat.opacity = 1; mat.depthWrite = true }
    }
    if (child instanceof THREE.LineSegments) {
      const mat = child.material as THREE.LineBasicMaterial
      mat.opacity = belowBed ? 0.06 : seeThrough ? 0.22 : 0.6
    }
  })
}

function setCameraOrbit(
  camera: THREE.Camera,
  controls: OrbitControlsImpl,
  target: THREE.Vector3,
  radius: number,
  alpha: number,
  beta: number,
): void {
  controls.target.copy(target)
  camera.position.set(
    target.x + radius * Math.sin(beta) * Math.sin(alpha),
    target.y + radius * Math.cos(beta),
    target.z + radius * Math.sin(beta) * Math.cos(alpha),
  )
  controls.update()
}

function bounceEaseOut(startY: number, restY: number, t: number): number {
  const eased = 1 - Math.abs(Math.cos(t * Math.PI * 2.5)) * Math.exp(-t * 4.5)
  return startY + (restY - startY) * eased
}

function worldBox(obj: THREE.Object3D): THREE.Box3 {
  obj.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(obj)
}

// ─── Scene component ─────────────────────────────────────────────────────────
// Renders inside <Canvas> so all R3F hooks are available.

function ViewerScene({
  outerRef, controlsRef,
  mesh, viewMode, loadAnimSeq,
  openEdgeLinePositions, measureMode, onMeasureResult,
}: ViewerSceneProps): null {
  const { camera, gl, scene } = useThree()

  // Mutable refs — updated outside React's render cycle
  const viewModeRef          = useRef<ViewMode>(viewMode)
  const onMeasureResultRef   = useRef(onMeasureResult)
  onMeasureResultRef.current = onMeasureResult

  const modelRootRef      = useRef<THREE.Group | null>(null)
  const plateGroupsRef    = useRef<Map<number, THREE.Group>>(new Map())
  const bedGroupsRef      = useRef<THREE.Group[]>([])
  const bounceRef         = useRef<BounceState | null>(null)
  const lastSettledSeqRef = useRef(-1)
  const keyLightRef       = useRef<THREE.DirectionalLight>(new THREE.DirectionalLight(0xffffff, 0.48))
  const fillLightRef      = useRef<THREE.DirectionalLight>(new THREE.DirectionalLight(0xffffff, 0.18))
  const measurePtARef     = useRef<[number, number, number] | null>(null)
  const measureDownRef    = useRef<[number, number]>([0, 0])

  // Add lights to scene once
  useEffect(() => {
    const kl = keyLightRef.current
    const fl = fillLightRef.current
    scene.add(kl)
    scene.add(fl)
    scene.background = new THREE.Color(BG_COLOR)
    return () => { scene.remove(kl); scene.remove(fl) }
  }, [scene])

  // ── Imperative handle ──────────────────────────────────────────────────────
  useImperativeHandle(outerRef, () => ({
    resetDefaultView: () => {
      const ctrl = controlsRef.current
      if (!ctrl) return
      const root = modelRootRef.current
      if (!root) {
        setCameraOrbit(camera, ctrl, new THREE.Vector3(0, 0, 0), DEFAULT_BED_MM * 1.2, DEFAULT_VIEW_ALPHA, DEFAULT_VIEW_BETA)
        return
      }
      const box = worldBox(root)
      if (box.isEmpty()) return
      const center = box.getCenter(new THREE.Vector3())
      const ext = box.min.distanceTo(box.max)
      const isMulti = root.name === 'modelPlates'
      const beta   = isMulti ? Math.min(1.1, DEFAULT_VIEW_BETA * 0.97) : DEFAULT_VIEW_BETA
      const factor = isMulti ? MULTI_PLATE_RADIUS_FACTOR : DEFAULT_RADIUS_FACTOR
      setCameraOrbit(camera, ctrl, center, Math.max(ext * factor, 0.08), DEFAULT_VIEW_ALPHA, beta)
    },

    focusCameraOnPlate: (plateId: number): void => {
      const ctrl = controlsRef.current
      if (!ctrl) return
      const pg = plateGroupsRef.current.get(plateId)
      if (!pg) return
      const box = worldBox(pg)
      if (box.isEmpty()) return
      const center = box.getCenter(new THREE.Vector3())
      const size   = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z, 4)
      const fov    = (camera as THREE.PerspectiveCamera).fov ?? 45
      const tanH   = Math.tan((fov * Math.PI / 180) * 0.5)
      const radius = tanH > 1e-6 ? (maxDim * 0.5 * 1.42) / tanH : maxDim * 1.35
      setCameraOrbit(camera, ctrl, center, Math.max(0.03, radius), DEFAULT_VIEW_ALPHA, Math.min(1.08, DEFAULT_VIEW_BETA * 0.96))
    },

    captureScreenshot: (): string | null => {
      gl.render(scene, camera)
      try { return gl.domElement.toDataURL('image/png') } catch { return null }
    },
  }))

  // ── Per-frame: lights + bounce + bed fade ──────────────────────────────────
  useFrame(({ clock }) => {
    // Eye-space lighting: transform Orca directions from camera eye space → world space
    keyLightRef.current.position.copy(ORCA_KEY_EYE.clone().transformDirection(camera.matrixWorld))
    fillLightRef.current.position.copy(ORCA_FILL_EYE.clone().transformDirection(camera.matrixWorld))

    // Settle bounce
    const b = bounceRef.current
    if (b) {
      if (b.startTime === -1) b.startTime = clock.elapsedTime
      const t = Math.min((clock.elapsedTime - b.startTime) / BOUNCE_DURATION, 1)
      b.mesh.position.y = bounceEaseOut(b.startY, b.restY, t)
      if (t >= 1) { b.mesh.position.y = b.restY; bounceRef.current = null }
    }

    // Bed transparency when camera is below bed or in see-through mode
    const belowBed   = camera.position.y < BED_SURFACE_Y - 0.2
    const seeThrough = belowBed || viewModeRef.current === 'xray' || viewModeRef.current === 'wireframe'
    for (const bg of bedGroupsRef.current) setBedOpacity(bg, !seeThrough, seeThrough, belowBed)
  })

  // ── Mesh effect: full scene rebuild on load ────────────────────────────────
  useEffect(() => {
    viewModeRef.current = viewMode

    // Tear down previous model
    if (modelRootRef.current) { scene.remove(modelRootRef.current); disposeObject(modelRootRef.current); modelRootRef.current = null }
    for (const bg of bedGroupsRef.current) { scene.remove(bg); disposeObject(bg) }
    bedGroupsRef.current = []
    plateGroupsRef.current.clear()
    bounceRef.current = null
    measurePtARef.current = null
    clearOverlaysByName(scene, ['__openEdges', '__measureLine', '__measureDotA', '__measureDotB'])

    if (!mesh) {
      lastSettledSeqRef.current = -1
      const bed = createBedGroup(DEFAULT_BED_MM, DEFAULT_BED_MM)
      scene.add(bed)
      bedGroupsRef.current = [bed]
      return
    }

    const meta  = mesh.packageMeta
    const parts = mesh.plateParts
    const geomIds = parts && parts.length > 0
      ? [...new Set(parts.map((p) => p.plateId))].sort((a, b) => a - b)
      : null
    const layoutIds = geomIds ?? (meta?.plateIds?.length ? [...meta.plateIds].sort((a, b) => a - b) : [])
    const isMulti   = parts !== undefined && parts.length > 0 && (parts.length > 1 || layoutIds.length > 1)

    if (isMulti && parts) {
      buildMultiPlate(mesh, parts, layoutIds, meta)
    } else {
      buildSinglePlate(mesh, meta)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh, loadAnimSeq])

  // ── View mode: live material update ───────────────────────────────────────
  useEffect(() => {
    viewModeRef.current = viewMode
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.name.startsWith('model') && obj.material instanceof THREE.MeshPhongMaterial) {
        applyViewMode(obj.material as THREE.MeshPhongMaterial, viewMode)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode])

  // ── Open edge overlay ──────────────────────────────────────────────────────
  useEffect(() => {
    clearOverlaysByName(scene, ['__openEdges'])
    if (!openEdgeLinePositions || openEdgeLinePositions.length < 6) return
    // Only for single-plate (multi-plate TransformNode skipped same as Babylon)
    const modelMesh = scene.getObjectByName('model')
    if (!modelMesh) return

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(openEdgeLinePositions.slice(), 3))
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xff5214 }))
    lines.name = '__openEdges'
    lines.renderOrder = 1
    modelMesh.add(lines)  // parent to model mesh so it inherits bed offset
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openEdgeLinePositions])

  // ── Measure mode ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = gl.domElement
    clearOverlaysByName(scene, ['__measureLine', '__measureDotA', '__measureDotB'])
    measurePtARef.current = null
    if (!measureMode) return

    mfDiagLog('[Measure] mode ON')

    const onDown = (e: PointerEvent): void => {
      if (e.button === 0) measureDownRef.current = [e.clientX, e.clientY]
    }

    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const [dx, dy] = measureDownRef.current
      if (Math.hypot(e.clientX - dx, e.clientY - dy) > 8) return

      const rect   = canvas.getBoundingClientRect()
      const ndcX   = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const ndcY   = -((e.clientY - rect.top) / rect.height) * 2 + 1
      const caster = new THREE.Raycaster()
      caster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera)

      const targets: THREE.Object3D[] = []
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh && (o.name === 'model' || o.name.startsWith('model_p'))) targets.push(o)
      })

      const hits = caster.intersectObjects(targets, false)
      if (!hits.length || !hits[0]!.point) return
      const pt    = hits[0]!.point
      const ptArr: [number, number, number] = [pt.x, pt.y, pt.z]

      const dotName = measurePtARef.current ? '__measureDotB' : '__measureDotA'
      clearOverlaysByName(scene, [dotName])
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(1, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xffd91a, depthTest: false })
      )
      dot.name = dotName; dot.position.copy(pt); dot.renderOrder = 2
      scene.add(dot)

      if (!measurePtARef.current) {
        measurePtARef.current = ptArr
      } else {
        const ptA     = measurePtARef.current
        const distMm  = Math.hypot(ptArr[0] - ptA[0], ptArr[1] - ptA[1], ptArr[2] - ptA[2])
        clearOverlaysByName(scene, ['__measureLine'])
        const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...ptA), new THREE.Vector3(...ptArr)])
        const line    = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xffd91a, depthTest: false }))
        line.name = '__measureLine'; line.renderOrder = 2
        scene.add(line)
        onMeasureResultRef.current?.(distMm, ptA, ptArr)
        measurePtARef.current = null
      }
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    return () => { canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureMode])

  // ── Multi-plate builder ────────────────────────────────────────────────────
  function buildMultiPlate(
    _mesh: TriangleMesh,
    parts: NonNullable<TriangleMesh['plateParts']>,
    layoutIds: number[],
    meta: ThreeMfPackageMeta | undefined,
  ): void {
    const root = new THREE.Group()
    root.name  = 'modelPlates'
    scene.add(root)
    modelRootRef.current = root

    const bedW    = meta?.bedWidthMm
    const bedD    = meta?.bedDepthMm
    const cellSpan = bedW !== undefined && bedD !== undefined
      ? Math.max(bedW, bedD, 120) + OVERVIEW_PLATE_GAP_MM
      : DEFAULT_BED_MM + OVERVIEW_PLATE_GAP_MM

    const hexes       = meta?.filamentColorsHex
    const partByPlate = new Map(parts.map((p) => [p.plateId, p]))
    const allSameSlot =
      parts.length > 1 &&
      parts.every((p) => p.filamentSlot !== undefined && p.filamentSlot === parts[0]?.filamentSlot)

    layoutIds.forEach((plateId, idx) => {
      const col  = idx % OVERVIEW_PLATE_COLS
      const row  = Math.floor(idx / OVERVIEW_PLATE_COLS)
      const cx   = col * cellSpan + cellSpan * 0.5
      const cz   = row * cellSpan + cellSpan * 0.5

      const pg = new THREE.Group()
      pg.name  = `plate_${plateId}`
      pg.position.set(cx, 0, cz)
      root.add(pg)
      plateGroupsRef.current.set(plateId, pg)

      const gW  = bedW ?? DEFAULT_BED_MM
      const gD  = bedD ?? gW
      const bed = createBedGroup(gW, gD)
      pg.add(bed)
      bedGroupsRef.current.push(bed)

      const part = partByPlate.get(plateId)
      if (!part || part.mesh.indices.length === 0 || part.mesh.positions.length < 9) {
        mfDiagLog(`[ModelForge 3MF] Plate ${plateId} has no geometry.`)
        return
      }

      const { cx: ax, cz: az } = meshAabbXZ(part.mesh.positions)
      const fromBuild  = !allSameSlot ? dominantExtruderSlot(meta?.buildObjects, plateId) : undefined
      const useCyclic  =
        (part.filamentSlot === undefined || allSameSlot) &&
        (fromBuild === undefined) &&
        hexes !== undefined && hexes.length >= 2
      const cyclicSlot = useCyclic ? (idx % hexes!.length) + 1 : undefined
      const slotEff    = (!allSameSlot ? part.filamentSlot : undefined) ?? fromBuild ?? cyclicSlot ?? (hexes?.length === 1 ? 1 : undefined)
      const slotHex    = slotEff !== undefined && hexes?.[slotEff - 1] !== undefined ? hexes![slotEff - 1] : undefined
      const useVc      = Boolean(part.mesh.vertexColors?.length) && !slotHex

      const geo   = meshToGeometry(part.mesh, useVc)
      const color = slotHex ? hexCssToColor(slotHex) : new THREE.Color(0.52, 0.78, 1.0)
      const mat   = createModelMaterial(color, useVc)
      applyViewMode(mat, viewModeRef.current)

      const m3 = new THREE.Mesh(geo, mat)
      m3.name  = `model_p${plateId}`
      // Initial AABB offset: centre on plate cell
      m3.position.set(-ax, 0, -az)
      pg.add(m3)

      // Sit on bed surface (Y only)
      m3.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(m3)
      m3.position.y += BED_SURFACE_Y + MODEL_BED_GAP_MM - box.min.y

      // Thin part Y-scale boost (visual only, does not affect export)
      applyThinPartBoost(m3)

      // Snap XZ centre of mesh to plate grid cell origin
      m3.updateMatrixWorld(true)
      const box2 = new THREE.Box3().setFromObject(m3)
      const wc   = box2.getCenter(new THREE.Vector3())
      m3.position.x += pg.position.x - wc.x
      m3.position.z += pg.position.z - wc.z
    })

    // Frame overview
    const ctrl = controlsRef.current
    if (ctrl) {
      const box = new THREE.Box3()
      root.traverse((o) => {
        if (o instanceof THREE.Mesh && o.name.startsWith('model_p')) box.union(new THREE.Box3().setFromObject(o))
      })
      if (!box.isEmpty()) {
        const c   = box.getCenter(new THREE.Vector3())
        const ext = box.getSize(new THREE.Vector3()).length()
        setCameraOrbit(camera, ctrl, c, Math.max(ext * MULTI_PLATE_RADIUS_FACTOR, 0.08), DEFAULT_VIEW_ALPHA, Math.min(1.1, DEFAULT_VIEW_BETA * 0.97))
      }
    }
  }

  // ── Single-plate builder ───────────────────────────────────────────────────
  function buildSinglePlate(m: TriangleMesh, meta: ThreeMfPackageMeta | undefined): void {
    const solePart  = m.plateParts?.length === 1 ? m.plateParts[0] : undefined
    const hexes     = meta?.filamentColorsHex
    const plateKey  = solePart?.plateId ?? 1
    const fromBuild = dominantExtruderSlot(meta?.buildObjects, plateKey)
    const cyclic    =
      solePart?.filamentSlot === undefined && fromBuild === undefined && hexes && hexes.length >= 2
        ? ((plateKey - 1) % hexes.length) + 1 : undefined
    const slotEff   = solePart?.filamentSlot ?? fromBuild ?? cyclic ?? (hexes?.length === 1 ? 1 : undefined)
    const slotHex   = slotEff !== undefined && hexes?.[slotEff - 1] !== undefined ? hexes![slotEff - 1] : undefined
    const useVc     = Boolean(m.vertexColors?.length) && !slotHex

    const geo   = meshToGeometry(m, useVc)
    const color = slotHex ? hexCssToColor(slotHex) : new THREE.Color(0.52, 0.78, 1.0)
    const mat   = createModelMaterial(color, useVc)
    applyViewMode(mat, viewModeRef.current)

    const mesh3  = new THREE.Mesh(geo, mat)
    mesh3.name   = 'model'

    // Centre in XZ before adding to scene (local-space is still world-space here)
    geo.computeBoundingBox()
    const lb   = geo.boundingBox!
    mesh3.position.x = -(lb.min.x + lb.max.x) / 2
    mesh3.position.z = -(lb.min.z + lb.max.z) / 2

    // Sit on bed
    mesh3.position.y = BED_SURFACE_Y + MODEL_BED_GAP_MM - lb.min.y

    scene.add(mesh3)
    mesh3.updateMatrixWorld(true)

    // Thin part boost
    applyThinPartBoost(mesh3)

    mesh3.updateMatrixWorld(true)
    const wb = new THREE.Box3().setFromObject(mesh3)

    // Bed size driven by footprint
    const footW = wb.max.x - wb.min.x
    const footD = wb.max.z - wb.min.z
    const bedMm = Math.min(BED_MAX_MM, Math.max(BED_MIN_MM, Math.max(footW, footD) * BED_PADDING))
    const gW    = meta?.bedWidthMm ?? bedMm
    const gD    = meta?.bedDepthMm ?? meta?.bedWidthMm ?? bedMm
    const bed   = createBedGroup(gW, gD)
    scene.add(bed)
    bedGroupsRef.current = [bed]

    // Wrap in a Group so open-edge overlay and modelRootRef.current name check work
    const root = new THREE.Group()
    root.name  = 'modelRoot'
    scene.add(root)
    // Re-parent mesh3 under root
    scene.remove(mesh3)
    root.add(mesh3)
    mesh3.updateMatrixWorld(true)
    modelRootRef.current = root

    // Camera
    const center = wb.getCenter(new THREE.Vector3())
    const ext    = wb.min.distanceTo(wb.max)
    const radius = Math.max(ext * DEFAULT_RADIUS_FACTOR, 0.08)
    const ctrl   = controlsRef.current
    if (ctrl) setCameraOrbit(camera, ctrl, center, radius, DEFAULT_VIEW_ALPHA, DEFAULT_VIEW_BETA)

    // Settle bounce on fresh load (not on rotate/repair — same loadAnimSeq)
    if (loadAnimSeq > lastSettledSeqRef.current) {
      lastSettledSeqRef.current = loadAnimSeq
      const restY = mesh3.position.y
      const h     = wb.max.y - wb.min.y
      const lift  = Math.min(165, Math.max(18, h * 0.52))
      mesh3.position.y = restY + lift
      bounceRef.current = { mesh: mesh3, startY: restY + lift, restY, startTime: -1 }
    }
  }

  return null
}

// ─── Thin-part boost (visual Y-scale only — never affects export geometry) ────
function applyThinPartBoost(mesh3: THREE.Mesh): void {
  mesh3.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(mesh3)
  const h   = box.max.y - box.min.y
  if (!(h > 1e-4 && h < MIN_VISUAL_PART_HEIGHT_MM)) return
  const factor = Math.min(MAX_THIN_PART_Y_SCALE, MIN_VISUAL_PART_HEIGHT_MM / h)
  mesh3.scale.y *= factor
  mesh3.updateMatrixWorld(true)
  const box2 = new THREE.Box3().setFromObject(mesh3)
  mesh3.position.y += BED_SURFACE_Y + MODEL_BED_GAP_MM - box2.min.y
}

// ─── Overlay cleanup ──────────────────────────────────────────────────────────
function clearOverlaysByName(scene: THREE.Scene, names: string[]): void {
  for (const name of names) {
    const obj = scene.getObjectByName(name)
    if (obj) { disposeObject(obj); obj.parent?.remove(obj) }
  }
}

// ─── OrbitControls + ViewerScene wiring ──────────────────────────────────────
// Both rendered inside <Canvas> so they share the same R3F context.

interface CanvasContentsProps extends Props {
  outerRef: ForwardedRef<ViewerHandle>
}

function CanvasContents({ outerRef, cameraPreset, ...rest }: CanvasContentsProps): JSX.Element {
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const { zoomSpeed, panSpeed } = R3F_PRESETS[cameraPreset]
  // Update controls speed when preset changes (drei syncs props → instance)
  return (
    <>
      <ViewerScene outerRef={outerRef} controlsRef={controlsRef} cameraPreset={cameraPreset} {...rest} />
      <OrbitControls
        ref={controlsRef}
        zoomSpeed={zoomSpeed}
        panSpeed={panSpeed}
        rotateSpeed={1.0}
        enableDamping
        dampingFactor={0.08}
        minDistance={0.02}
        maxDistance={20000}
        minPolarAngle={0}
        maxPolarAngle={Math.PI}
        mouseButtons={{
          LEFT:   THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT:  THREE.MOUSE.PAN,
        }}
      />
    </>
  )
}

// ─── Public component ─────────────────────────────────────────────────────────
export const R3FViewer = forwardRef<ViewerHandle, Props>(function R3FViewer(props, ref) {
  return (
    <div className="viewer-canvas" style={{ width: '100%', height: '100%', display: 'block', overflow: 'hidden' }}>
      <Canvas
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        camera={{ fov: 45, near: 0.01, far: 20000, position: [0, 50, 200] }}
        style={{ width: '100%', height: '100%' }}
      >
        <ambientLight intensity={0.3} />
        <CanvasContents outerRef={ref} {...props} />
      </Canvas>
    </div>
  )
})
