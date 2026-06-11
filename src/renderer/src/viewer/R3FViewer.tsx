/**
 * R3FViewer — React Three Fiber renderer replacing BabylonViewer.
 * All TriangleMesh / loader / repair / analysis code is unchanged.
 * This file owns: scene graph, camera, lighting, overlays, measure mode.
 */
import {
  useEffect, useRef, useState, useMemo, forwardRef, useImperativeHandle, type ForwardedRef,
} from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls, GizmoHelper, GizmoViewcube, Html } from '@react-three/drei'
import { EffectComposer, N8AO } from '@react-three/postprocessing'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import type { ThreeMfBuildObjectSummary, ThreeMfPackageMeta, TriangleMesh } from '../mesh/types'
import { triangleMeshToGeometry } from '../mesh/toThree'
import { computeWallThicknessColors } from '../mesh/wallThickness'
import { type CameraPresetId } from './cameraPrefs'

// ─── Dev diagnostics ──────────────────────────────────────────────────────────
function mfDiagLog(...args: unknown[]): void {
  if (import.meta.env.DEV) console.log(...args) // eslint-disable-line no-console
}

// ─── Constants ────────────────────────────────────────────────────────────────
const BED_SURFACE_Y = -0.0005
const MODEL_BED_GAP_MM = 0.12
const DEFAULT_BED_MM = 280
const BED_PAD_MM = 50          // flat padding on each side of the model footprint
const BED_MIN_MM = 80          // minimum bed dimension even for tiny models
const BED_MAX_MM = 1200
const OVERVIEW_PLATE_COLS = 3
const OVERVIEW_PLATE_GAP_MM = 24
const MIN_VISUAL_PART_HEIGHT_MM = 5
const MAX_THIN_PART_Y_SCALE = 12
const DEFAULT_VIEW_ALPHA        = -0.48 * Math.PI  // single-plate: front-left 3/4 view
const DEFAULT_VIEW_BETA         = 1.05
const DEFAULT_RADIUS_FACTOR     = 1.38
const MULTI_PLATE_VIEW_ALPHA    = -0.75 * Math.PI  // overview: front-left corner — all 3 cols equally visible
const MULTI_PLATE_VIEW_BETA     = 0.92             // slightly more top-down than single plate
const MULTI_PLATE_RADIUS_FACTOR = 1.14             // a bit more margin around the grid
const BOUNCE_DURATION = 1.15  // seconds ≈ 69 frames @ 60 fps
const BG_COLOR = '#242933'    // sRGB match for Orca/Bambu dark background

// Orca gouraud.vs eye-space light directions (FROM surface TO light)
const ORCA_KEY_EYE  = new THREE.Vector3(-0.4574957,  0.4574957, 0.7624929)
const ORCA_FILL_EYE = new THREE.Vector3( 0.6985074,  0.1397015, 0.6985074)

// drei OrbitControls speed mappings for Babylon-compatible presets
const R3F_PRESETS: Record<CameraPresetId, { zoomSpeed: number; panSpeed: number }> = {
  default: { zoomSpeed: 3.5, panSpeed: 1.0 },
  quick:   { zoomSpeed: 9.0, panSpeed: 3.5 },
}

// ─── Face-orientation shader (front=blue, back=red, via gl_FrontFacing) ──────
const FACE_ORIENT_MAT = new THREE.ShaderMaterial({
  vertexShader:   `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `void main() { gl_FragColor = gl_FrontFacing ? vec4(0.26,0.52,0.96,1.0) : vec4(0.95,0.27,0.27,1.0); }`,
  side: THREE.DoubleSide,
})

// ─── Overhang heat-map shader (face-normal derived in frag shader via dFdx/dFdy) ─
// green = printable (normal faces up), yellow = mild overhang, red = critical (>45°)
const OVERHANG_MAT = new THREE.ShaderMaterial({
  vertexShader: `
    varying vec3 vWorldPos;
    void main() {
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec3 vWorldPos;
    void main() {
      vec3 dx = dFdx(vWorldPos);
      vec3 dy = dFdy(vWorldPos);
      vec3 n  = normalize(cross(dx, dy));
      // d > 0 ⟹ face normal has a downward component; >0.707 ⟹ >45° overhang
      float d = dot(n, vec3(0.0, -1.0, 0.0));
      vec3 green  = vec3(0.22, 0.78, 0.32);
      vec3 yellow = vec3(0.96, 0.74, 0.10);
      vec3 red    = vec3(0.92, 0.20, 0.20);
      vec3 col;
      if      (d < 0.0)   col = green;
      else if (d < 0.707) col = mix(green, yellow, d / 0.707);
      else                col = mix(yellow, red,   (d - 0.707) / 0.293);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
  side: THREE.DoubleSide,
})

// ─── Public types ─────────────────────────────────────────────────────────────
export type ViewMode = 'solid' | 'wireframe' | 'xray' | 'faceOrient' | 'overhang' | 'wallThick'
export type SnapView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'

export type MaterialPreset = 'default' | 'silk' | 'matte' | 'metal'
export const MATERIAL_PRESETS: Record<MaterialPreset, { roughness: number; metalness: number }> = {
  default: { roughness: 0.55, metalness: 0.02 },
  silk:    { roughness: 0.12, metalness: 0.38 },
  matte:   { roughness: 0.92, metalness: 0.00 },
  metal:   { roughness: 0.18, metalness: 0.88 },
}

export interface Annotation {
  id: number
  pos: [number, number, number]
  text: string
}

export type ViewerHandle = {
  resetDefaultView:   () => void
  focusCameraOnPlate: (plateId: number) => void
  captureScreenshot:  () => string | null
  snapCameraToView:   (view: SnapView) => void
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
  /** Y-axis clip height in mm; null = no clipping.  Positive = keep below this height. */
  clipY?: number | null
  /** When true, show a center-of-mass crosshair marker in the scene. */
  showCoM?: boolean
  /** When true, render W×D×H dimension labels anchored to the model's bounding box. */
  showDimensions?: boolean
  /** When true, render face-normal lines on the model. */
  showNormals?: boolean
  /** Override the default bed size (mm) shown when no 3MF metadata is present. */
  defaultBedMm?: number
  /** When true, fan sub-objects outward from the model centre for inspection. */
  explodedView?: boolean
  /** When true, OrbitControls auto-rotate (turntable mode). */
  turntable?: boolean
  /** Material appearance preset — adjusts roughness / metalness. */
  materialPreset?: MaterialPreset
  /** When true, pointer clicks on the model call onAnnotationPlace. */
  annotationMode?: boolean
  /** Annotation pins to render as 3D Html labels. */
  annotations?: Annotation[]
  /** Called with world-space hit position when annotationMode is true and user clicks. */
  onAnnotationPlace?: (pos: [number, number, number]) => void
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

function createModelMaterial(color: THREE.Color, useVc: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: useVc ? new THREE.Color(1, 1, 1) : color,
    roughness: 0.55,
    metalness: 0.02,
    side: THREE.DoubleSide,
    vertexColors: useVc,
  })
}

function applyViewMode(mat: THREE.MeshStandardMaterial, mode: ViewMode): void {
  mat.wireframe = mode === 'wireframe'
  if (mode === 'xray') {
    mat.transparent = true; mat.opacity = 0.38; mat.depthWrite = false
  } else {
    mat.transparent = false; mat.opacity = 1; mat.depthWrite = true
  }
  mat.needsUpdate = true
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

  // ── Surface — PEI graphite: dark charcoal, clearly distinct from the app bg ─
  // polygonOffset pushes the plane slightly behind the grid lines in the depth
  // buffer so they always draw on top without z-fighting.
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(widthMm, depthMm),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color('#2e3340'),
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    })
  )
  plane.rotation.x = -Math.PI / 2
  plane.name = 'bedPlane'
  g.add(plane)

  // ── Grid — 10 mm cells, clipped to the actual bed rectangle ─────────────────
  // Build rectangular grid manually so it never extends past the narrower edge
  // (THREE.GridHelper is always square and would bleed out on elongated beds).
  const GRID_STEP = 10
  const hw = widthMm / 2, hd = depthMm / 2
  const gridPts: number[] = []
  for (let x = -hw; x <= hw + 0.001; x += GRID_STEP) gridPts.push(x, 0, -hd,  x, 0,  hd)
  for (let z = -hd; z <= hd + 0.001; z += GRID_STEP) gridPts.push(-hw, 0, z,  hw, 0, z)
  const gridGeo = new THREE.BufferGeometry()
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3))
  const grid = new THREE.LineSegments(
    gridGeo,
    new THREE.LineBasicMaterial({ color: 0x3a4f68, transparent: true, opacity: 0.88 })
  )
  grid.name = 'bedGrid'
  g.add(grid)

  // ── Perimeter border — crisp edge that defines the printable area boundary ──
  const borderPts = [
    new THREE.Vector3(-hw, 0.15, -hd),
    new THREE.Vector3( hw, 0.15, -hd),
    new THREE.Vector3( hw, 0.15,  hd),
    new THREE.Vector3(-hw, 0.15,  hd),
  ]
  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(borderPts),
    new THREE.LineBasicMaterial({ color: 0x5a7ea8, transparent: true, opacity: 0.65 })
  )
  border.name = 'bedBorder'
  g.add(border)

  // ── Shadow-catcher — receives model shadows without altering the bed colour ─
  // Sized 1.5× the bed so shadows at shallow angles still land on it.
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(widthMm * 1.5, depthMm * 1.5),
    new THREE.ShadowMaterial({ opacity: 0.28, transparent: true, depthWrite: false })
  )
  shadowCatcher.rotation.x = -Math.PI / 2
  shadowCatcher.receiveShadow = true
  shadowCatcher.name = 'shadowCatcher'
  shadowCatcher.renderOrder = 2
  g.add(shadowCatcher)

  return g
}

function setBedOpacity(bedGroup: THREE.Group, _opaque: boolean, seeThrough: boolean, belowBed: boolean): void {
  bedGroup.traverse((child) => {
    // Shadow-catcher always stays fully transparent; its opacity is fixed.
    if (child.name === 'shadowCatcher') return
    if (child instanceof THREE.Mesh) {
      const mat = child.material as THREE.MeshBasicMaterial
      const wasTransparent = mat.transparent
      if (belowBed) { mat.transparent = true; mat.opacity = 0.06; mat.depthWrite = false }
      else if (seeThrough) { mat.transparent = true; mat.opacity = 0.22; mat.depthWrite = false }
      else { mat.transparent = false; mat.opacity = 1; mat.depthWrite = true }
      if (mat.transparent !== wasTransparent) mat.needsUpdate = true
    }
    // THREE.LineSegments (GridHelper) and THREE.LineLoop (border) both extend THREE.Line.
    if (child instanceof THREE.Line) {
      const mat = child.material as THREE.LineBasicMaterial
      const normalOpacity = child.name === 'bedBorder' ? 0.65 : 0.88
      mat.opacity = belowBed ? 0.06 : seeThrough ? 0.22 : normalOpacity
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
  const eased = 1 - Math.abs(Math.cos(t * Math.PI * 2.8)) * Math.exp(-t * 3.0)
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
  clipY, showCoM, showDimensions, showNormals, defaultBedMm, explodedView,
  materialPreset, annotationMode, annotations, onAnnotationPlace,
}: ViewerSceneProps): JSX.Element {
  const { camera, gl, scene } = useThree()

  // Mutable refs — updated outside React's render cycle
  const prevViewModeRef      = useRef<ViewMode>(viewMode)
  const viewModeRef          = useRef<ViewMode>(viewMode)
  const onMeasureResultRef     = useRef(onMeasureResult)
  onMeasureResultRef.current   = onMeasureResult
  const onAnnotationPlaceRef   = useRef(onAnnotationPlace)
  onAnnotationPlaceRef.current = onAnnotationPlace
  const annotDownRef           = useRef<[number, number]>([0, 0])

  const modelRootRef      = useRef<THREE.Group | null>(null)
  /** Previous mesh prop — used to detect transform-only updates for the fast path. */
  const lastMeshRef       = useRef<TriangleMesh | null>(null)
  const plateGroupsRef    = useRef<Map<number, THREE.Group>>(new Map())
  const bedGroupsRef      = useRef<THREE.Group[]>([])
  const bounceRef         = useRef<BounceState | null>(null)
  const lastSettledSeqRef = useRef(-1)
  const keyLightRef       = useRef<THREE.DirectionalLight>(new THREE.DirectionalLight(0xffffff, 0.55))
  const fillLightRef      = useRef<THREE.DirectionalLight>(new THREE.DirectionalLight(0xffffff, 0.18))
  const measurePtARef     = useRef<[number, number, number] | null>(null)
  const measureDownRef    = useRef<[number, number]>([0, 0])

  // Exploded-view animation data
  interface ExplodeItem { host: THREE.Group; restPos: THREE.Vector3; dir: THREE.Vector3 }
  const explodeItemsRef    = useRef<ExplodeItem[]>([])
  const explodeProgressRef = useRef(0)   // 0 = collapsed, 1 = fully exploded
  const explodeTargetRef   = useRef(0)
  const explodedViewRef    = useRef(false)
  explodedViewRef.current  = explodedView ?? false

  // Blob shadow reference for cleanup
  const blobShadowRef = useRef<THREE.Mesh | null>(null)

  // Measurement label rendered in 3D space via Html
  const [measureLabel, setMeasureLabel] = useState<{ pos: THREE.Vector3; dist: number } | null>(null)

  // Dimension label positions — derived from raw mesh geometry so they sit at the correct
  // world coords without depending on sceneObj which isn't set yet during memo evaluation.
  // World X/Z are centred (viewer offsets by -(min+max)/2), so centred coords = geom - centre.
  const dimBounds = useMemo(() => {
    if (!showDimensions || !mesh) return null
    const p = mesh.positions
    if (p.length < 3) return null
    let mnX=p[0]!,mxX=p[0]!,mnY=p[1]!,mxY=p[1]!,mnZ=p[2]!,mxZ=p[2]!
    for (let i=3;i<p.length;i+=3){
      if(p[i]!<mnX)mnX=p[i]!;   if(p[i]!>mxX)mxX=p[i]!
      if(p[i+1]!<mnY)mnY=p[i+1]!; if(p[i+1]!>mxY)mxY=p[i+1]!
      if(p[i+2]!<mnZ)mnZ=p[i+2]!; if(p[i+2]!>mxZ)mxZ=p[i+2]!
    }
    const w=mxX-mnX, h=mxY-mnY, d=mxZ-mnZ
    const PAD=Math.max(8, Math.max(w,h,d)*0.06)
    const Y0=BED_SURFACE_Y+MODEL_BED_GAP_MM
    return {
      w, h, d,
      wPos: [0,         Y0-PAD*0.4, d/2+PAD ] as [number,number,number],
      dPos: [w/2+PAD,   Y0-PAD*0.4, 0       ] as [number,number,number],
      hPos: [w/2+PAD,   Y0+h/2,     d/2+PAD ] as [number,number,number],
    }
  }, [mesh, showDimensions])

  // Drive explode animation target when the prop toggles
  useEffect(() => {
    explodeTargetRef.current = explodedView ? 1 : 0
  }, [explodedView])

  // Face-normal lines — added as children of model meshes so they inherit world transform
  useEffect(() => {
    const removeNormals = (): void => {
      const toRemove: THREE.Object3D[] = []
      modelRootRef.current?.traverse((obj) => { if (obj.name === '__normals') toRemove.push(obj) })
      toRemove.forEach((obj) => {
        obj.parent?.remove(obj)
        if (obj instanceof THREE.LineSegments) { obj.geometry.dispose(); (obj.material as THREE.Material).dispose() }
      })
    }
    removeNormals()
    if (!showNormals || !modelRootRef.current) return
    const NORMAL_LEN = 3, MAX_PER_MESH = 2000
    modelRootRef.current.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.name.startsWith('model')) return
      const geo = child.geometry as THREE.BufferGeometry
      const posAttr = geo.attributes.position as THREE.BufferAttribute | undefined
      if (!posAttr) return
      const idxAttr = geo.index
      const triCount = idxAttr ? idxAttr.count / 3 : posAttr.count / 3
      const stride = Math.max(1, Math.floor(triCount / MAX_PER_MESH))
      const pts: number[] = []
      for (let t = 0; t < triCount; t += stride) {
        const ia = idxAttr ? idxAttr.getX(t*3)   : t*3
        const ib = idxAttr ? idxAttr.getX(t*3+1) : t*3+1
        const ic = idxAttr ? idxAttr.getX(t*3+2) : t*3+2
        const ax=posAttr.getX(ia),ay=posAttr.getY(ia),az=posAttr.getZ(ia)
        const bx=posAttr.getX(ib),by=posAttr.getY(ib),bz=posAttr.getZ(ib)
        const cx=posAttr.getX(ic),cy=posAttr.getY(ic),cz=posAttr.getZ(ic)
        const ox=(ax+bx+cx)/3, oy=(ay+by+cy)/3, oz=(az+bz+cz)/3
        let nx=(by-ay)*(cz-az)-(bz-az)*(cy-ay)
        let ny=(bz-az)*(cx-ax)-(bx-ax)*(cz-az)
        let nz=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax)
        const l=Math.sqrt(nx*nx+ny*ny+nz*nz); if(l<1e-10) continue
        nx/=l; ny/=l; nz/=l
        pts.push(ox,oy,oz, ox+nx*NORMAL_LEN,oy+ny*NORMAL_LEN,oz+nz*NORMAL_LEN)
      }
      if (pts.length === 0) return
      const lg = new THREE.BufferGeometry()
      lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      const lm = new THREE.LineBasicMaterial({ color: 0x44ff88, depthTest: false, transparent: true, opacity: 0.75 })
      const ls = new THREE.LineSegments(lg, lm)
      ls.name = '__normals'; ls.renderOrder = 3
      child.add(ls)
    })
    return removeNormals
  }, [mesh, showNormals])

  // Add lights to scene once; configure key-light shadow map
  useEffect(() => {
    const kl = keyLightRef.current
    kl.castShadow            = true
    kl.shadow.mapSize.width  = 2048
    kl.shadow.mapSize.height = 2048
    kl.shadow.camera.near    = 1
    kl.shadow.camera.far     = 3000
    kl.shadow.camera.left    = -700
    kl.shadow.camera.right   = 700
    kl.shadow.camera.top     = 700
    kl.shadow.camera.bottom  = -700
    kl.shadow.bias           = -0.0015
    kl.shadow.radius         = 4   // PCFSoftShadowMap blur radius

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
      const size   = box.getSize(new THREE.Vector3())
      const isMulti = root.name === 'modelPlates'
      let ext: number
      if (isMulti) {
        center.y = 0  // target bed plane — same as initial framing
        ext = Math.max(size.x, size.z, 1e-3)
      } else {
        ext = box.min.distanceTo(box.max)
      }
      const alpha  = isMulti ? MULTI_PLATE_VIEW_ALPHA  : DEFAULT_VIEW_ALPHA
      const beta   = isMulti ? MULTI_PLATE_VIEW_BETA   : DEFAULT_VIEW_BETA
      const factor = isMulti ? MULTI_PLATE_RADIUS_FACTOR : DEFAULT_RADIUS_FACTOR
      setCameraOrbit(camera, ctrl, center, Math.max(ext * factor, 0.08), alpha, beta)
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

    snapCameraToView: (view: SnapView): void => {
      const ctrl = controlsRef.current
      if (!ctrl) return
      // azimuth (alpha) and polar (beta) for each canonical view
      const ALPHA: Record<SnapView, number> = {
        front:  0,
        back:   Math.PI,
        right:  Math.PI / 2,
        left:   -Math.PI / 2,
        top:    0,
        bottom: 0,
      }
      const BETA: Record<SnapView, number> = {
        front:  Math.PI / 2,
        back:   Math.PI / 2,
        right:  Math.PI / 2,
        left:   Math.PI / 2,
        top:    0.01,       // near 0 avoids gimbal lock; still effectively straight down
        bottom: Math.PI - 0.01,
      }
      const alpha = ALPHA[view]
      const beta  = BETA[view]
      const root  = modelRootRef.current
      if (!root) {
        setCameraOrbit(camera, ctrl, new THREE.Vector3(0, 0, 0), DEFAULT_BED_MM * 1.2, alpha, beta)
        return
      }
      const box = worldBox(root)
      if (box.isEmpty()) return
      const center = box.getCenter(new THREE.Vector3())
      const ext    = box.min.distanceTo(box.max)
      setCameraOrbit(camera, ctrl, center, Math.max(ext * DEFAULT_RADIUS_FACTOR, 0.08), alpha, beta)
    },
  }), [])

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

    // Exploded-view animation: lerp progress toward target
    const items = explodeItemsRef.current
    if (items.length > 0) {
      const target = explodeTargetRef.current
      const prev   = explodeProgressRef.current
      if (Math.abs(target - prev) > 0.001) {
        const next = prev + (target - prev) * 0.14   // spring lerp
        explodeProgressRef.current = next
        const EXPLODE_DIST = 60 // mm outward in XZ
        for (const { host, restPos, dir } of items) {
          host.position.set(
            restPos.x + dir.x * EXPLODE_DIST * next,
            restPos.y,
            restPos.z + dir.z * EXPLODE_DIST * next,
          )
        }
      }
    }
  })

  // ── Mesh effect: full scene rebuild on load ────────────────────────────────
  useEffect(() => {
    viewModeRef.current = viewMode

    // ── Fast path: transform-only update ─────────────────────────────────────
    // Rigid transforms (rotate/mirror/translate/scale and their undos) share the
    // indices array by reference, so we can patch the existing GPU position
    // buffer in place instead of tearing down and rebuilding the whole scene.
    // Camera stays put — no jarring reframe on every rotate.
    const prevMesh = lastMeshRef.current
    lastMeshRef.current = mesh
    if (
      mesh && prevMesh && mesh !== prevMesh &&
      loadAnimSeq === lastSettledSeqRef.current &&     // not a fresh load
      !mesh.plateParts?.length && !prevMesh.plateParts?.length &&
      mesh.indices === prevMesh.indices &&
      mesh.positions.length === prevMesh.positions.length &&
      tryFastTransformUpdate(mesh)
    ) {
      return
    }

    // Tear down previous model
    if (modelRootRef.current) { scene.remove(modelRootRef.current); disposeObject(modelRootRef.current); modelRootRef.current = null }
    for (const bg of bedGroupsRef.current) { scene.remove(bg); disposeObject(bg) }
    bedGroupsRef.current = []
    plateGroupsRef.current.clear()
    bounceRef.current = null
    measurePtARef.current = null
    explodeItemsRef.current = []
    explodeProgressRef.current = 0
    if (blobShadowRef.current) {
      const b = blobShadowRef.current
      scene.remove(b)
      b.geometry.dispose()
      const bm = b.material as THREE.MeshBasicMaterial
      bm.map?.dispose()
      bm.dispose()
      blobShadowRef.current = null
    }
    clearOverlaysByName(scene, ['__openEdges', '__measureLine', '__measureDotA', '__measureDotB', '__com', '__comDot'])

    if (!mesh) {
      lastSettledSeqRef.current = -1
      const bedSz = defaultBedMm ?? DEFAULT_BED_MM
      const bed = createBedGroup(bedSz, bedSz)
      scene.add(bed)
      bedGroupsRef.current = [bed]
      // Frame empty bed the same way resetDefaultView would for no-model state
      const ctrl = controlsRef.current
      if (ctrl) setCameraOrbit(camera, ctrl, new THREE.Vector3(0, 0, 0), DEFAULT_BED_MM * 1.2, DEFAULT_VIEW_ALPHA, DEFAULT_VIEW_BETA)
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

  // ── View mode: live material update (including special-mode swaps) ────────
  useEffect(() => {
    const prev = prevViewModeRef.current
    prevViewModeRef.current = viewMode
    viewModeRef.current     = viewMode
    const isSpecial = (m: string) => m === 'faceOrient' || m === 'overhang' || m === 'wallThick'
    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || !obj.name.startsWith('model')) return

      // Leaving wall-thick mode: restore original geometry + material
      if (prev === 'wallThick' && obj.userData.wallThickApplied) {
        const flatGeo = obj.geometry as THREE.BufferGeometry
        if (obj.userData.origGeo) obj.geometry = obj.userData.origGeo as THREE.BufferGeometry
        if (obj.userData.origMat) obj.material  = obj.userData.origMat as THREE.MeshStandardMaterial
        flatGeo.dispose()
        delete obj.userData.origGeo; delete obj.userData.origMat; delete obj.userData.wallThickApplied
        return
      }

      // Leaving face-orient or overhang → restore saved standard material
      if (isSpecial(prev) && obj.userData.origMat instanceof THREE.MeshStandardMaterial) {
        obj.material = obj.userData.origMat as THREE.MeshStandardMaterial
        delete obj.userData.origMat
      }

      if (viewMode === 'faceOrient') {
        if (obj.material !== FACE_ORIENT_MAT) {
          obj.userData.origMat = obj.material
          obj.material = FACE_ORIENT_MAT
        }
      } else if (viewMode === 'overhang') {
        if (obj.material !== OVERHANG_MAT) {
          obj.userData.origMat = obj.material
          obj.material = OVERHANG_MAT
        }
      } else if (viewMode === 'wallThick' && !obj.userData.wallThickApplied) {
        // Swap to a flat (non-indexed) geometry immediately so the model stays visible
        // while the thickness is computed.  A neutral grey material is shown first.
        const origGeo = obj.geometry as THREE.BufferGeometry
        const flatGeo = origGeo.toNonIndexed()
        flatGeo.computeVertexNormals()
        obj.userData.origGeo = origGeo
        obj.userData.origMat = obj.material
        obj.userData.wallThickApplied = true
        obj.geometry = flatGeo
        const pendingMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.85, metalness: 0 })
        obj.material = pendingMat

        // Capture references for the async callback
        const capturedObj = obj
        const capturedFlat = flatGeo
        const capturedPending = pendingMat

        // Run computation on next tick so the frame can render the grey placeholder first
        setTimeout(() => {
          if (!capturedObj.userData.wallThickApplied) return  // mode was exited before we ran
          const posAttr  = capturedFlat.attributes.position as THREE.BufferAttribute
          const triCount = posAttr.count / 3
          if (triCount > 0) {
            const positions = new Float32Array(posAttr.array)
            const flatIdx   = new Uint32Array(triCount * 3)
            for (let i = 0; i < flatIdx.length; i++) flatIdx[i] = i
            const box  = new THREE.Box3().setFromBufferAttribute(posAttr)
            const diag = box.min.distanceTo(box.max)
            const maxD = Math.max(2, Math.min(15, diag * 0.08))
            const { perTriColor } = computeWallThicknessColors(
              { positions, indices: flatIdx } as import('../mesh/types').TriangleMesh,
              { maxDistMm: maxD }
            )
            const colorArr = new Float32Array(triCount * 9)
            for (let t = 0; t < triCount; t++) {
              const r=perTriColor[t*3]!, g=perTriColor[t*3+1]!, b=perTriColor[t*3+2]!
              colorArr[t*9]=r;   colorArr[t*9+1]=g; colorArr[t*9+2]=b
              colorArr[t*9+3]=r; colorArr[t*9+4]=g; colorArr[t*9+5]=b
              colorArr[t*9+6]=r; colorArr[t*9+7]=g; colorArr[t*9+8]=b
            }
            capturedFlat.setAttribute('color', new THREE.Float32BufferAttribute(colorArr, 3))
            const colorMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 })
            capturedObj.material = colorMat
            capturedPending.dispose()
          }
        }, 0)
      } else if (obj.material instanceof THREE.MeshStandardMaterial) {
        applyViewMode(obj.material, viewMode)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, mesh])

  // ── Material preset: update roughness / metalness on existing materials ────
  useEffect(() => {
    const vals = MATERIAL_PRESETS[materialPreset ?? 'default']
    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || !obj.name.startsWith('model')) return
      if (obj.material instanceof THREE.MeshStandardMaterial) {
        obj.material.roughness = vals.roughness
        obj.material.metalness = vals.metalness
        obj.material.needsUpdate = true
      }
      // Also update the saved original when a special overlay is active
      if (obj.userData.origMat instanceof THREE.MeshStandardMaterial) {
        obj.userData.origMat.roughness = vals.roughness
        obj.userData.origMat.metalness = vals.metalness
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialPreset, loadAnimSeq])

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
    setMeasureLabel(null)
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
        if (o instanceof THREE.Mesh && (
          o.name === 'model' ||
          o.name.startsWith('model_p') ||
          o.name.startsWith('model_s')
        )) targets.push(o)
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
        // First point — clear any previous label
        setMeasureLabel(null)
        measurePtARef.current = ptArr
      } else {
        const ptA    = measurePtARef.current
        const distMm = Math.hypot(ptArr[0] - ptA[0], ptArr[1] - ptA[1], ptArr[2] - ptA[2])
        clearOverlaysByName(scene, ['__measureLine'])
        const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...ptA), new THREE.Vector3(...ptArr)])
        const line    = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xffd91a, depthTest: false }))
        line.name = '__measureLine'; line.renderOrder = 2
        scene.add(line)
        // Label at midpoint of the line, offset slightly upward so it clears the geometry
        const mid = new THREE.Vector3(
          (ptA[0] + ptArr[0]) * 0.5,
          (ptA[1] + ptArr[1]) * 0.5 + 3,
          (ptA[2] + ptArr[2]) * 0.5,
        )
        setMeasureLabel({ pos: mid, dist: distMm })
        onMeasureResultRef.current?.(distMm, ptA, ptArr)
        measurePtARef.current = null
      }
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    return () => { canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureMode])

  // ── Annotation placement ───────────────────────────────────────────────────
  useEffect(() => {
    const canvas = gl.domElement
    if (!annotationMode) return

    const onDown = (e: PointerEvent): void => {
      if (e.button === 0) annotDownRef.current = [e.clientX, e.clientY]
    }
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const [dx, dy] = annotDownRef.current
      if (Math.hypot(e.clientX - dx, e.clientY - dy) > 8) return

      const rect   = canvas.getBoundingClientRect()
      const ndcX   = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const ndcY   = -((e.clientY - rect.top) / rect.height) * 2 + 1
      const caster = new THREE.Raycaster()
      caster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera)
      const targets: THREE.Object3D[] = []
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh && (
          o.name === 'model' || o.name.startsWith('model_p') || o.name.startsWith('model_s')
        )) targets.push(o)
      })
      const hits = caster.intersectObjects(targets, false)
      if (!hits.length || !hits[0]!.point) return
      const pt = hits[0]!.point
      onAnnotationPlaceRef.current?.([pt.x, pt.y, pt.z])
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    return () => { canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotationMode])

  // ── Section / clipping plane ───────────────────────────────────────────────
  useEffect(() => {
    if (clipY == null) {
      gl.clippingPlanes = []
    } else {
      // Keep everything with y <= clipY; clip (discard) where y > clipY.
      // Plane equation: dot((0,-1,0), p) + clipY >= 0  ↔  y <= clipY
      gl.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), clipY)]
    }
    return () => { gl.clippingPlanes = [] }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipY])

  // ── Center-of-mass crosshair ───────────────────────────────────────────────
  useEffect(() => {
    clearOverlaysByName(scene, ['__com'])
    if (!showCoM) return
    const root = modelRootRef.current
    if (!root) return
    const box = worldBox(root)
    if (box.isEmpty()) return
    const c  = box.getCenter(new THREE.Vector3())
    const r  = box.min.distanceTo(box.max) * 0.08
    const pts = [
      new THREE.Vector3(c.x - r, c.y, c.z), new THREE.Vector3(c.x + r, c.y, c.z),
      new THREE.Vector3(c.x, c.y - r, c.z), new THREE.Vector3(c.x, c.y + r, c.z),
      new THREE.Vector3(c.x, c.y, c.z - r), new THREE.Vector3(c.x, c.y, c.z + r),
    ]
    const geo  = new THREE.BufferGeometry().setFromPoints(pts)
    const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xff9900, depthTest: false, linewidth: 2 }))
    line.name = '__com'; line.renderOrder = 3
    scene.add(line)
    // Small sphere at the CoM
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(r * 0.35, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff9900, depthTest: false })
    )
    dot.name = '__comDot'; dot.position.copy(c); dot.renderOrder = 3
    scene.add(dot)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCoM, loadAnimSeq])

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

      // When this plate has per-build-item sub-objects, create one THREE.Mesh per item so each
      // piece renders separately (positions preserved from the slicer layout).  Each sub-object
      // picks its own vertex-color / flat-tint decision independently.
      const useVc = Boolean(part.mesh.vertexColors?.length)
      const subs  = part.subObjects && part.subObjects.length >= 2 ? part.subObjects : null
      mfDiagLog(`[viewer diag] plate ${plateId}: subObjects=${part.subObjects?.length ?? 'none'}  subs=${subs?.length ?? 'null'}`)

      if (subs) {
        // Multi-color plate: one THREE.Mesh per extruder-slot sub-object
        const subGroup = new THREE.Group()
        subGroup.name = `model_p${plateId}`
        subGroup.position.set(-ax, 0, -az)
        pg.add(subGroup)

        // NOAMS (no-AMS, single-extruder multi-plate): all sub-objects share the same
        // extruderSlot (default = 1) because the extruder map has no per-object data.
        // The authoritative per-plate color comes from part.filamentSlot (set by
        // enrichPlatePartsFilamentSlotsFromPlateJson via plate_N.json `first_extruder`).
        // For AMS multi-color plates, sub-objects carry distinct extruder slots — use those.
        const allSubsSameSlot = subs.length > 0 && subs.every((s) => s.extruderSlot === subs[0]!.extruderSlot)
        const plateSlotOverride = allSubsSameSlot ? part.filamentSlot : undefined

        for (let si = 0; si < subs.length; si++) {
          const so = subs[si]!
          const soUseVc = Boolean(so.mesh.vertexColors?.length)
          const effectiveSlot = plateSlotOverride ?? so.extruderSlot
          const soHex   = hexes?.[effectiveSlot - 1]
          const soColor = !soUseVc && soHex ? hexCssToColor(soHex) : new THREE.Color(0.52, 0.78, 1.0)
          const soGeo   = triangleMeshToGeometry(so.mesh, { useVertexColors: soUseVc })
          soGeo.computeBoundingBox()
          mfDiagLog(`[viewer diag] plate ${plateId} sub[${si}]: verts=${so.mesh.positions.length/3}  bbox=${JSON.stringify(soGeo.boundingBox?.min)}-${JSON.stringify(soGeo.boundingBox?.max)}`)
          const soMat   = createModelMaterial(soColor, soUseVc)
          applyViewMode(soMat, viewModeRef.current)
          const soMesh      = new THREE.Mesh(soGeo, soMat)
          soMesh.name       = `model_p${plateId}_s${so.extruderSlot}`
          soMesh.castShadow = true
          // Lift each sub-mesh individually to the bed surface.  Bambu assemble transforms
          // can encode objects in local/assembly-centered Y frames where some pieces have
          // negative Y (below the virtual bed).  Correcting per sub-object keeps all pieces
          // at bed level instead of lifting the entire group by the worst-case outlier.
          const soMinY = soGeo.boundingBox!.min.y
          soMesh.position.y = BED_SURFACE_Y + MODEL_BED_GAP_MM - soMinY
          subGroup.add(soMesh)
        }

        // Snap XZ centre to plate grid cell origin (Y was already corrected per sub-mesh above)
        subGroup.updateWorldMatrix(true, false)
        const box2 = new THREE.Box3().setFromObject(subGroup)
        const wc   = box2.getCenter(new THREE.Vector3())
        subGroup.position.x += pg.position.x - wc.x
        subGroup.position.z += pg.position.z - wc.z
      } else {
        // Single-color (or vertex-colored) plate: original single-mesh path
        // Vertex colors represent actual painted / material-group data — always preferred over
        // the flat filament-slot tint.  slotHex is only used when no vertex colors are present.
        const geo   = triangleMeshToGeometry(part.mesh, { useVertexColors: useVc })
        const color = !useVc && slotHex ? hexCssToColor(slotHex) : new THREE.Color(0.52, 0.78, 1.0)
        const mat   = createModelMaterial(color, useVc)
        applyViewMode(mat, viewModeRef.current)

        const m3 = new THREE.Mesh(geo, mat)
        m3.name        = `model_p${plateId}`
        m3.castShadow  = true
        // Initial AABB offset: centre on plate cell
        m3.position.set(-ax, 0, -az)
        pg.add(m3)

        // Sit on bed surface (Y only).
        // updateWorldMatrix(true, false) walks UP the parent chain so pg.matrixWorld
        // is correct before Box3.setFromObject reads it (Box3 only calls (false,false)).
        m3.updateWorldMatrix(true, false)
        const box = new THREE.Box3().setFromObject(m3)
        m3.position.y += BED_SURFACE_Y + MODEL_BED_GAP_MM - box.min.y

        // Thin part Y-scale boost (visual only, does not affect export)
        applyThinPartBoost(m3)

        // Snap XZ centre of mesh to plate grid cell origin (safety net; should be ~0 correction)
        m3.updateWorldMatrix(true, false)
        const box2 = new THREE.Box3().setFromObject(m3)
        const wc   = box2.getCenter(new THREE.Vector3())
        m3.position.x += pg.position.x - wc.x
        m3.position.z += pg.position.z - wc.z
      }
    })

    // Frame overview — XZ footprint centred on bed plane (Y=0), max XZ axis drives radius
    const ctrl = controlsRef.current
    if (ctrl) {
      root.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(root)
      if (!box.isEmpty()) {
        const c    = box.getCenter(new THREE.Vector3())
        c.y = 0  // target bed plane — prevents tall models pulling target into mid-air
        const size = box.getSize(new THREE.Vector3())
        const ext  = Math.max(size.x, size.z, 1e-3)  // XZ footprint only for radius
        setCameraOrbit(camera, ctrl, c, Math.max(ext * MULTI_PLATE_RADIUS_FACTOR, 0.08), MULTI_PLATE_VIEW_ALPHA, MULTI_PLATE_VIEW_BETA)
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
    // Vertex colors represent actual painted / material-group data — always preferred over
    // the flat filament-slot tint.  slotHex is only used when no vertex colors are present.
    const useVc  = Boolean(m.vertexColors?.length)
    const subs   = solePart?.subObjects && solePart.subObjects.length >= 2 ? solePart.subObjects : null

    // The merged geometry drives centering and bed-size regardless of which render path is taken.
    const mergedGeo = triangleMeshToGeometry(m, { useVertexColors: false })
    mergedGeo.computeBoundingBox()
    const lb = mergedGeo.boundingBox!

    // Build the scene object — either a sub-group (one mesh per item) or a single merged mesh.
    let sceneObj: THREE.Object3D
    if (subs) {
      const subGroup  = new THREE.Group()
      subGroup.name   = 'model'
      // XZ centre on origin; Y sits on bed after world-matrix update below
      subGroup.position.set(-(lb.min.x + lb.max.x) / 2, 0, -(lb.min.z + lb.max.z) / 2)
      // NOAMS single-plate: same logic as multi-plate — prefer filamentSlot when all subs share the same slot
      const spAllSubsSameSlot = subs.length > 0 && subs.every((s) => s.extruderSlot === subs[0]!.extruderSlot)
      const spSlotOverride = spAllSubsSameSlot ? (slotEff ?? undefined) : undefined
      for (const so of subs) {
        const soUseVc = Boolean(so.mesh.vertexColors?.length)
        const spEffSlot = spSlotOverride ?? so.extruderSlot
        const soHex   = hexes?.[spEffSlot - 1]
        const soColor = !soUseVc && soHex ? hexCssToColor(soHex) : new THREE.Color(0.52, 0.78, 1.0)
        const soGeo   = triangleMeshToGeometry(so.mesh, { useVertexColors: soUseVc })
        soGeo.computeBoundingBox()
        const soCenter = soGeo.boundingBox!.getCenter(new THREE.Vector3())
        const soMat   = createModelMaterial(soColor, soUseVc)
        applyViewMode(soMat, viewModeRef.current)
        const soMesh      = new THREE.Mesh(soGeo, soMat)
        soMesh.name       = `model_s${so.extruderSlot}`
        soMesh.castShadow = true
        // Offset mesh so its geometry is centred at the host's local origin.
        // This lets us animate soHost.position for exploded view without
        // changing the mesh vertices.
        soMesh.position.copy(soCenter).negate()
        const soHost   = new THREE.Group()
        soHost.name    = `host_s${so.extruderSlot}`
        soHost.position.copy(soCenter)
        soHost.add(soMesh)
        subGroup.add(soHost)
        // Record explode data — direction is XZ outward from the merged model's XZ centre.
        // lb is in raw slicer coords; subGroup offsets by -(lb.cx, 0, lb.cz) so the model
        // centre maps to world origin. soCenter is also in raw slicer coords, so the
        // vector from merged centre → sub-object centre is (soCenter - mergedCentre).
        const mergedCx = (lb.min.x + lb.max.x) * 0.5
        const mergedCz = (lb.min.z + lb.max.z) * 0.5
        const explodeDir = new THREE.Vector3(soCenter.x - mergedCx, 0, soCenter.z - mergedCz)
        if (explodeDir.length() > 0.1) explodeDir.normalize()
        else explodeDir.set(1, 0, 0)
        explodeItemsRef.current.push({ host: soHost, restPos: soCenter.clone(), dir: explodeDir })
      }
      mergedGeo.dispose()
      sceneObj = subGroup
    } else {
      mergedGeo.dispose()
      const geo   = triangleMeshToGeometry(m, { useVertexColors: useVc })
      const color = !useVc && slotHex ? hexCssToColor(slotHex) : new THREE.Color(0.52, 0.78, 1.0)
      const mat   = createModelMaterial(color, useVc)
      applyViewMode(mat, viewModeRef.current)
      const mesh3       = new THREE.Mesh(geo, mat)
      mesh3.name        = 'model'
      mesh3.castShadow  = true
      mesh3.position.x = -(lb.min.x + lb.max.x) / 2
      mesh3.position.z = -(lb.min.z + lb.max.z) / 2
      sceneObj = mesh3
    }

    // Sit on bed surface.  Non-3MF models are snapped to minY=0 on load and after
    // auto-orient, so lb.min.y=0 and this places the model exactly on the bed.
    // After a manual rotation (↻X/Z) the model is NOT auto-snapped, so lb.min.y
    // will be non-zero and the model will visually float — the user can then click
    // "Snap to bed" to drop it back down.  3MF models are already at minY≈0 from
    // the slicer so this works unchanged for those too.
    sceneObj.position.y = BED_SURFACE_Y + MODEL_BED_GAP_MM

    // Wrap before scene add — root stays at origin so local space = world space
    const root = new THREE.Group()
    root.name  = 'modelRoot'
    root.add(sceneObj)
    sceneObj.updateMatrixWorld(true)

    // Thin part boost (single-mesh path only — groups handled implicitly by mesh children)
    if (!subs && sceneObj instanceof THREE.Mesh) applyThinPartBoost(sceneObj)

    scene.add(root)
    modelRootRef.current = root
    sceneObj.updateMatrixWorld(true)
    const wb = new THREE.Box3().setFromObject(sceneObj)

    rebuildBedAndShadow(wb)

    // Camera
    const center = wb.getCenter(new THREE.Vector3())
    const ext    = wb.min.distanceTo(wb.max)
    const radius = Math.max(ext * DEFAULT_RADIUS_FACTOR, 0.08)
    const ctrl   = controlsRef.current
    if (ctrl) setCameraOrbit(camera, ctrl, center, radius, DEFAULT_VIEW_ALPHA, DEFAULT_VIEW_BETA)

    // Settle bounce on fresh load (not on rotate/repair — same loadAnimSeq)
    if (loadAnimSeq > lastSettledSeqRef.current) {
      lastSettledSeqRef.current = loadAnimSeq
      const restY = sceneObj.position.y
      const h     = wb.max.y - wb.min.y
      const lift  = Math.min(220, Math.max(40, h * 0.75))
      sceneObj.position.y = restY + lift
      bounceRef.current = { mesh: sceneObj, startY: restY + lift, restY, startTime: -1 }
    }
  }

  /**
   * (Re)create the single-plate bed grid and blob shadow sized to the model's
   * world-space footprint.  Idempotent: removes any existing bed/shadow first,
   * so both the full rebuild and the transform fast-path can call it.
   */
  function rebuildBedAndShadow(wb: THREE.Box3): void {
    for (const bg of bedGroupsRef.current) { scene.remove(bg); disposeObject(bg) }
    bedGroupsRef.current = []
    if (blobShadowRef.current) {
      const b = blobShadowRef.current
      scene.remove(b)
      b.geometry.dispose()
      const bm = b.material as THREE.MeshBasicMaterial
      bm.map?.dispose()
      bm.dispose()
      blobShadowRef.current = null
    }

    // Bed size: 50 mm padding on every side of the model's XZ footprint.
    // Width and depth are computed independently so the plate matches the
    // model's aspect ratio rather than always being a square.
    const footW = wb.max.x - wb.min.x
    const footD = wb.max.z - wb.min.z
    const bedRef = defaultBedMm ?? DEFAULT_BED_MM
    const gW    = Math.min(BED_MAX_MM, Math.max(BED_MIN_MM, Math.max(footW + BED_PAD_MM * 2, bedRef)))
    const gD    = Math.min(BED_MAX_MM, Math.max(BED_MIN_MM, Math.max(footD + BED_PAD_MM * 2, bedRef)))
    const bed   = createBedGroup(gW, gD)
    scene.add(bed)
    bedGroupsRef.current = [bed]

    // Blob shadow — soft radial gradient disc at bed surface matching model footprint
    {
      const sw = Math.max(footW * 1.35, 20)
      const sd = Math.max(footD * 1.35, 20)
      const canv = document.createElement('canvas')
      canv.width = 128; canv.height = 128
      const ctx = canv.getContext('2d')!
      const cx2 = canv.width / 2, cy2 = canv.height / 2
      const grad = ctx.createRadialGradient(cx2, cy2, 0, cx2, cy2, cx2)
      grad.addColorStop(0,   'rgba(0,0,0,0.52)')
      grad.addColorStop(0.55,'rgba(0,0,0,0.28)')
      grad.addColorStop(1,   'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, canv.width, canv.height)
      const blobTex = new THREE.CanvasTexture(canv)
      const blobMat = new THREE.MeshBasicMaterial({
        map: blobTex, transparent: true, depthWrite: false,
        blending: THREE.MultiplyBlending,
        premultipliedAlpha: true,  // required by MultiplyBlending in Three.js r184+
      })
      const blobGeo  = new THREE.PlaneGeometry(sw, sd)
      const blobMesh = new THREE.Mesh(blobGeo, blobMat)
      blobMesh.rotation.x = -Math.PI / 2
      blobMesh.position.set(0, BED_SURFACE_Y + 0.1, 0)
      blobMesh.renderOrder = 1
      blobMesh.name = '__blobShadow'
      scene.add(blobMesh)
      blobShadowRef.current = blobMesh
    }
  }

  /**
   * Transform-only update: write new positions into the existing GPU buffer,
   * re-place the model on the bed, and resize the bed/shadow.  Returns false
   * when the current scene shape can't be patched (sub-object group, wall-thick
   * overlay active, vertex count changed) so the caller falls back to a full
   * rebuild.  The camera is deliberately left untouched.
   */
  function tryFastTransformUpdate(m: TriangleMesh): boolean {
    const root = modelRootRef.current
    if (!root || root.name !== 'modelRoot') return false
    const m3 = root.getObjectByName('model')
    if (!(m3 instanceof THREE.Mesh)) return false           // sub-object group path
    if (m3.userData.wallThickApplied || m3.userData.origGeo) return false
    const geo = m3.geometry as THREE.BufferGeometry
    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!posAttr || posAttr.array.length !== m.positions.length) return false

    // Same overlay invalidation as the full rebuild — they reference old coords
    clearOverlaysByName(scene, ['__openEdges', '__measureLine', '__measureDotA', '__measureDotB', '__com', '__comDot'])
    measurePtARef.current = null

    ;(posAttr.array as Float32Array).set(m.positions)
    posAttr.needsUpdate = true
    geo.computeVertexNormals()
    geo.computeBoundingBox()
    geo.computeBoundingSphere()
    const lb = geo.boundingBox!

    // Same placement rules as buildSinglePlate: XZ centred on the bed origin,
    // Y offset is constant so a floating mesh (minY > 0) visibly floats.
    m3.scale.y = 1
    m3.position.set(
      -(lb.min.x + lb.max.x) / 2,
      BED_SURFACE_Y + MODEL_BED_GAP_MM,
      -(lb.min.z + lb.max.z) / 2,
    )
    applyThinPartBoost(m3)
    m3.updateMatrixWorld(true)

    rebuildBedAndShadow(new THREE.Box3().setFromObject(m3))
    return true
  }

  // Html overlays: measurement label + annotation pins
  return (
    <>
      {measureLabel ? (
        <Html
          position={[measureLabel.pos.x, measureLabel.pos.y, measureLabel.pos.z]}
          center
          zIndexRange={[10, 20]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="measure-3d-label">{measureLabel.dist.toFixed(2)} mm</div>
        </Html>
      ) : null}
      {annotations?.map((ann) => (
        <Html
          key={ann.id}
          position={ann.pos}
          center
          zIndexRange={[10, 20]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="annotation-3d-label">{ann.text}</div>
        </Html>
      ))}
      {dimBounds ? (
        <>
          <Html position={dimBounds.wPos} center zIndexRange={[10, 20]} style={{ pointerEvents: 'none' }}>
            <div className="dim-label">W {dimBounds.w.toFixed(1)} mm</div>
          </Html>
          <Html position={dimBounds.dPos} center zIndexRange={[10, 20]} style={{ pointerEvents: 'none' }}>
            <div className="dim-label">D {dimBounds.d.toFixed(1)} mm</div>
          </Html>
          <Html position={dimBounds.hPos} center zIndexRange={[10, 20]} style={{ pointerEvents: 'none' }}>
            <div className="dim-label">H {dimBounds.h.toFixed(1)} mm</div>
          </Html>
        </>
      ) : null}
    </>
  )
}

// ─── Thin-part boost (visual Y-scale only — never affects export geometry) ────
function applyThinPartBoost(mesh3: THREE.Mesh): void {
  // updateWorldMatrix(true, false) walks UP through parent chain so pg.matrixWorld
  // is current before Box3.setFromObject (which only calls updateWorldMatrix(false,false))
  mesh3.updateWorldMatrix(true, false)
  const box = new THREE.Box3().setFromObject(mesh3)
  const h   = box.max.y - box.min.y
  if (!(h > 1e-4 && h < MIN_VISUAL_PART_HEIGHT_MM)) return
  const factor = Math.min(MAX_THIN_PART_Y_SCALE, MIN_VISUAL_PART_HEIGHT_MM / h)
  mesh3.scale.y *= factor
  mesh3.updateWorldMatrix(true, false)
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
  return (
    <>
      <ViewerScene outerRef={outerRef} controlsRef={controlsRef} cameraPreset={cameraPreset} {...rest} />
      <EffectComposer multisampling={0}>
        <N8AO aoRadius={20} intensity={5} quality="medium" screenSpaceRadius halfRes={false} depthAwareUpsampling />
      </EffectComposer>
      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewcube
          faces={['Right', 'Left', 'Top', 'Bottom', 'Front', 'Back']}
          opacity={0.82}
          color="#1e2333"
          strokeColor="#52b8ff"
          textColor="#c8d4e8"
          hoverColor="#3a4a6a"
        />
      </GizmoHelper>
      <OrbitControls
        ref={controlsRef}
        autoRotate={rest.turntable ?? false}
        autoRotateSpeed={1.5}
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
        shadows="percentage"
        gl={{ preserveDrawingBuffer: true, antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.9 }}
        camera={{ fov: 45, near: 0.01, far: 20000, position: [-291, 167, 18] }}
        style={{ width: '100%', height: '100%' }}
      >
        <ambientLight intensity={0.35} />
        <CanvasContents outerRef={ref} {...props} />
      </Canvas>
    </div>
  )
})
