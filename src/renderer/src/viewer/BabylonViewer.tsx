import { useEffect, useImperativeHandle, forwardRef, useRef, useState } from 'react'
/** Side effect: registers `scene.beginDirectAnimation` etc. on Scene (required with tree-shaken imports). */
import '@babylonjs/core/Animations/animatable'
/** Side effect: registers MeshBuilder.CreateLineSystem (used for open-edge and measure overlays). */
import '@babylonjs/core/Meshes/Builders/linesBuilder'
import { Pick as babylonPick } from '@babylonjs/core/Culling/ray.core'
import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import type { ArcRotateCameraMouseWheelInput } from '@babylonjs/core/Cameras/Inputs/arcRotateCameraMouseWheelInput'
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Node } from '@babylonjs/core/node'
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents'
import type { Observer } from '@babylonjs/core/Misc/observable'
import type { PointerInfo } from '@babylonjs/core/Events/pointerEvents'
import { GridMaterial } from '@babylonjs/materials/grid/gridMaterial'
import { Material } from '@babylonjs/core/Materials/material'
import { Animation } from '@babylonjs/core/Animations/animation'
import { BounceEase, EasingFunction } from '@babylonjs/core/Animations/easing'
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { ThreeMfBuildObjectSummary, ThreeMfPackageMeta, TriangleMesh } from '../mesh/types'
import { triangleMeshToBabylon, createModelMaterial } from '../mesh/toBabylon'
import { CAMERA_PRESETS, type CameraPresetId } from './cameraPrefs'

function mfDiagLog(...args: unknown[]): void {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console -- intentional dev-only 3MF diagnostics
    console.log(...args)
  }
}

/** AABB centre on the viewer bed plane (XZ), mm — matches 3MF post-remap coordinates. */
function meshAabbCenterXZMm(positions: Float32Array): { cx: number; cz: number } {
  if (positions.length < 3) return { cx: 0, cz: 0 }
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
  if (!Number.isFinite(minX)) return { cx: 0, cz: 0 }
  return { cx: (minX + maxX) * 0.5, cz: (minZ + maxZ) * 0.5 }
}

/** Sit mesh bottom on the bed (Y only); preserves world XZ so multi-plate islands stay separated. */
function layoutPlateMeshBedYOnly(m: Mesh): number {
  m.computeWorldMatrix(true)
  let bi = m.getHierarchyBoundingVectors(true)
  m.position.y += BED_SURFACE_Y + MODEL_BED_GAP_MM - bi.min.y
  m.computeWorldMatrix(true)
  bi = m.getHierarchyBoundingVectors(true)
  const footW = bi.max.x - bi.min.x
  const footD = bi.max.z - bi.min.z
  return Math.min(BED_MAX_MM, Math.max(BED_MIN_MM, Math.max(footW, footD) * BED_PADDING))
}

/**
 * After coarse placement, align mesh world XZ bounds centre to the plate root (cell origin),
 * matching slicer behaviour where the build volume is centred on each plate.
 */
function snapMeshWorldXzCenterToPlateOrigin(m: Mesh, plateRoot: TransformNode): void {
  plateRoot.computeWorldMatrix(true)
  m.computeWorldMatrix(true)
  const bi = m.getHierarchyBoundingVectors(true)
  const midX = (bi.min.x + bi.max.x) * 0.5
  const midZ = (bi.min.z + bi.max.z) * 0.5
  const tx = plateRoot.getAbsolutePosition().x
  const tz = plateRoot.getAbsolutePosition().z
  m.position.x += tx - midX
  m.position.z += tz - midZ
  m.computeWorldMatrix(true)
}

/** Slicer clips / spacers can be under 1 mm tall — exaggerate Y only for on-screen readability (mm space). */
const MIN_VISUAL_PART_HEIGHT_MM = 5
const MAX_THIN_PART_Y_SCALE = 12

function boostVeryThinPartForVisibility(m: Mesh): void {
  m.computeWorldMatrix(true)
  let bi = m.getHierarchyBoundingVectors(true)
  const h = bi.max.y - bi.min.y
  if (!(h > 1e-4 && h < MIN_VISUAL_PART_HEIGHT_MM)) return
  const factor = Math.min(MAX_THIN_PART_Y_SCALE, MIN_VISUAL_PART_HEIGHT_MM / h)
  m.scaling.y *= factor
  m.computeWorldMatrix(true)
  bi = m.getHierarchyBoundingVectors(true)
  m.position.y += BED_SURFACE_Y + MODEL_BED_GAP_MM - bi.min.y
}

function logEmptyPlateDiagnostics(
  plateId: number,
  meta: ThreeMfPackageMeta | undefined,
  logOpcIdsOnce: { done: boolean }
): void {
  if (!meta) {
    mfDiagLog(`[ModelForge 3MF] Plate ${plateId} has no mesh (no 3MF package metadata to list expected object ids).`)
    return
  }
  if (!logOpcIdsOnce.done && meta.parsedOpcObjectIds && meta.parsedOpcObjectIds.length > 0) {
    mfDiagLog('[ModelForge 3MF] Parsed OPC `<object id>` list:', meta.parsedOpcObjectIds)
    logOpcIdsOnce.done = true
  }
  const expected = meta.buildObjects?.filter((o) => o.plateId === plateId).map((o) => o.id) ?? []
  mfDiagLog(
    `[ModelForge 3MF] Plate ${plateId} has no mesh. Object IDs from slicer metadata for this plate:`,
    expected
  )
  if (expected.length > 0 && meta.parsedOpcObjectIds && meta.parsedOpcObjectIds.length > 0) {
    const set = new Set(meta.parsedOpcObjectIds)
    const missing = expected.filter((id) => !set.has(id))
    if (missing.length > 0) {
      mfDiagLog(
        '[ModelForge 3MF] Metadata ids on this plate missing from OPC resources (different 3MF id, support-only, or mesh not merged):',
        missing
      )
    }
  }
}

export type ViewMode = 'solid' | 'wireframe' | 'xray'

export type BabylonViewerHandle = {
  /** Restore the same orbit and zoom as after a fresh load. */
  resetDefaultView: () => void
  /** Multi-plate 3MF only: frame the camera on one plate’s content (click an object in the sidebar). */
  focusCameraOnPlate: (plateId: number) => void
  /** Current frame as a PNG data URL, or null if the viewer is not ready. */
  captureScreenshot: () => string | null
}

/** Ground plane Y (mm). */
const BED_SURFACE_Y = -0.0005
/** Lift printed mesh slightly above the grid so coplanar bottoms do not z-fight with the bed. */
const MODEL_BED_GAP_MM = 0.12
/** Default build plate (mm) before any model is loaded. */
const DEFAULT_BED_MM = 280
const BED_MIN_MM = 220
const BED_MAX_MM = 1200
const BED_PADDING = 1.14
/** Bambu-style multi-plate overview: columns in the virtual build plate grid (mm spacing uses bed meta + gap). */
const OVERVIEW_PLATE_COLS = 3
const OVERVIEW_PLATE_GAP_MM = 24

/** Convert a single sRGB component (0–255 integer) to linear light. */
function srgbByteToLinear(byte: number): number {
  const c = byte / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * Parse a CSS hex colour (#RRGGBB or #AARRGGBB) and return a Babylon Color3
 * with components in **linear** light space.  Babylon's StandardMaterial
 * operates in linear space; the image-processing pipeline converts back to
 * sRGB for display so the rendered hue matches the original sRGB hex value.
 */
function hexCssToLinearColor3(hex: string): Color3 {
  let t = hex.trim().replace(/^#/, '')
  if (t.length === 8 && /^[0-9a-fA-F]+$/.test(t)) t = t.slice(2)
  if (t.length === 6 && /^[0-9a-fA-F]+$/.test(t)) {
    return new Color3(
      srgbByteToLinear(parseInt(t.slice(0, 2), 16)),
      srgbByteToLinear(parseInt(t.slice(2, 4), 16)),
      srgbByteToLinear(parseInt(t.slice(4, 6), 16))
    )
  }
  // Fallback: neutral grey — sRGB(0.72,0.75,0.79) → linear
  return new Color3(
    srgbByteToLinear(Math.round(0.72 * 255)),
    srgbByteToLinear(Math.round(0.75 * 255)),
    srgbByteToLinear(Math.round(0.79 * 255))
  )
}

/** When `filamentSlot` was not merged onto `plateParts`, infer dominant extruder from package `buildObjects`. */
function dominantExtruderSlotFromBuildObjects(
  objs: ThreeMfBuildObjectSummary[] | undefined,
  plateId: number
): number | undefined {
  if (!objs?.length) return undefined
  const counts = new Map<number, number>()
  for (const o of objs) {
    if (o.plateId !== plateId || o.extruderSlot === undefined) continue
    const s = o.extruderSlot
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  let best: number | undefined
  let bestC = -1
  for (const [s, c] of counts) {
    if (c > bestC) {
      bestC = c
      best = s
    }
  }
  return best
}

/**
 * Default orbit after each load: elevated 3/4 view from front-left (Babylon RH, Y-up).
 * alpha = longitude around Y; beta = angle from +Y toward the XZ plane (0 = top-down, π/2 = side).
 */
const DEFAULT_VIEW_ALPHA = -0.48 * Math.PI
const DEFAULT_VIEW_BETA = 1.05
const DEFAULT_RADIUS_FACTOR = 1.38
/** Multi-plate overview: ignore large bed grids for framing and zoom in slightly so small parts read better. */
const MULTI_PLATE_RADIUS_FACTOR = 1.06

interface Props {
  mesh: TriangleMesh | null
  viewMode: ViewMode
  /** Bumped in App only after a successful file load; used to gate the settle bounce (not rotate/repair). */
  loadAnimSeq: number
  /** Wheel zoom and right-drag pan speed; persisted in the app shell. */
  cameraPreset: CameraPresetId
  /**
   * When set, renders an orange line overlay for each open (boundary) edge.
   * Flat [x0,y0,z0, x1,y1,z1, ...] in model local space.
   * Set to null to hide.
   */
  openEdgeLinePositions?: Float32Array | null
  /** When true, a click (non-drag) on the model surface picks a point. Two picks → calls onMeasureResult. */
  measureMode?: boolean
  /** Called after two surface points are picked; distance is in mm. */
  onMeasureResult?: (distanceMm: number, ptA: [number, number, number], ptB: [number, number, number]) => void
}

function applyViewMode(mat: StandardMaterial, mode: ViewMode): void {
  mat.wireframe = mode === 'wireframe'
  if (mode === 'xray') {
    mat.alpha = 0.38
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND
    mat.backFaceCulling = false
    mat.disableLighting = false
    mat.forceDepthWrite = false
  } else {
    mat.alpha = 1
    mat.transparencyMode = Material.MATERIAL_OPAQUE
    // Many real-world print meshes (especially some 3MF exports) contain mixed winding.
    // Keep Solid visually solid by rendering both sides.
    mat.backFaceCulling = false
    mat.forceDepthWrite = true
  }
}

function forEachGroundMesh(scene: Scene, fn: (m: Mesh) => void): void {
  for (const m of scene.meshes) {
    if (m.name.startsWith('ground')) fn(m)
  }
}

/** Lets you orbit under the plate and still see the model (grid does not depth-occlude). */
function applyPrintBedViewMode(scene: Scene, mode: ViewMode): void {
  const seeThrough = mode === 'xray' || mode === 'wireframe'
  forEachGroundMesh(scene, (ground) => {
    const gMat = ground.material as GridMaterial | undefined
    if (!gMat) return
    if (seeThrough) {
      gMat.alpha = 0.22
      gMat.transparencyMode = Material.MATERIAL_ALPHABLEND
      gMat.disableDepthWrite = true
      gMat.forceDepthWrite = false
      gMat.opacity = 0.5
      gMat.backFaceCulling = false
    } else {
      gMat.alpha = 1
      gMat.transparencyMode = Material.MATERIAL_OPAQUE
      gMat.disableDepthWrite = false
      gMat.forceDepthWrite = false
      gMat.opacity = 1
      gMat.backFaceCulling = false
    }
  })
}

/** When camera is below the bed plane, fade the plate out so model underside is visible. */
function applyUnderBedVisibility(scene: Scene, mode: ViewMode): void {
  const cam = scene.activeCamera as ArcRotateCamera | undefined
  if (!cam) return
  const belowBed = cam.globalPosition.y < BED_SURFACE_Y - 0.2
  const forceSeeThrough = mode === 'xray' || mode === 'wireframe'
  const vis = belowBed || forceSeeThrough ? 0.06 : 1
  forEachGroundMesh(scene, (ground) => {
    ground.visibility = vis
  })
}

function createPrintBed(scene: Scene, widthMm: number, meshName = 'ground', depthMm?: number): Mesh {
  const d = depthMm ?? widthMm
  const grid = new GridMaterial(`gridMat_${meshName}_${Date.now()}`, scene)
  grid.majorUnitFrequency = 10
  grid.minorUnitVisibility = 0.32
  grid.gridRatio = 1
  grid.mainColor = new Color3(0.16, 0.18, 0.22)
  grid.lineColor = new Color3(0.30, 0.34, 0.42)
  const ground = MeshBuilder.CreateGround(meshName, { width: widthMm, height: d, subdivisions: 2 }, scene)
  ground.material = grid
  grid.backFaceCulling = false
  ground.position.y = BED_SURFACE_Y
  ground.isPickable = false
  ground.renderingGroupId = 0
  return ground
}

function applyEngineScalingForMesh(engine: Engine, triangleCount: number): void {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const base = dpr > 1.08 ? dpr / 1.12 : 1
  const heavy = triangleCount > 1_000_000 ? 1.48 : triangleCount > 500_000 ? 1.22 : 1
  engine.setHardwareScalingLevel(Math.max(1, base * heavy))
}

function applyDefaultOrbitToMesh(cam: ArcRotateCamera, mesh: Mesh, freeze: boolean): void {
  mesh.unfreezeWorldMatrix()
  mesh.computeWorldMatrix(true)
  const bi = mesh.getHierarchyBoundingVectors(true)
  const center = bi.min.add(bi.max).scale(0.5)
  const ext = bi.max.subtract(bi.min).length()
  // Keep zoom-out headroom proportional to model size (large imports can exceed fixed limits).
  cam.upperRadiusLimit = Math.max(2000, ext * 8.5)
  cam.setTarget(center)
  cam.radius = Math.max(ext * DEFAULT_RADIUS_FACTOR, 0.08)
  cam.alpha = DEFAULT_VIEW_ALPHA
  cam.beta = DEFAULT_VIEW_BETA
  if (freeze) {
    mesh.freezeWorldMatrix()
  }
}

type DefaultOrbitNodeOpts = {
  /** Omit bed grids from bounds and use max axis span (better for many plates in one view). */
  multiPlateOverview?: boolean
}

function applyDefaultOrbitToNode(
  cam: ArcRotateCamera,
  root: TransformNode,
  freeze: boolean,
  opts?: DefaultOrbitNodeOpts
): void {
  root.unfreezeWorldMatrix()
  let min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
  let max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY)
  let any = false
  const walk = (node: Node): void => {
    if (node instanceof AbstractMesh) {
      if (opts?.multiPlateOverview && node.name.startsWith('ground')) {
        for (const c of node.getChildren()) walk(c)
        return
      }
      node.computeWorldMatrix(true)
      const bi = node.getHierarchyBoundingVectors(true)
      min = Vector3.Minimize(min, bi.min)
      max = Vector3.Maximize(max, bi.max)
      any = true
    }
    for (const c of node.getChildren()) walk(c)
  }
  walk(root)
  if (!any || !Number.isFinite(min.x)) return
  const center = min.add(max).scale(0.5)
  const dx = max.x - min.x
  const dy = max.y - min.y
  const dz = max.z - min.z
  const ext = opts?.multiPlateOverview ? Math.max(dx, dy, dz, 1e-3) : max.subtract(min).length()
  const factor = opts?.multiPlateOverview ? MULTI_PLATE_RADIUS_FACTOR : DEFAULT_RADIUS_FACTOR
  cam.upperRadiusLimit = Math.max(2000, ext * 8.5)
  cam.setTarget(center)
  cam.radius = Math.max(ext * factor, 0.08)
  cam.alpha = DEFAULT_VIEW_ALPHA
  cam.beta = opts?.multiPlateOverview ? Math.min(1.1, DEFAULT_VIEW_BETA * 0.97) : DEFAULT_VIEW_BETA
  if (freeze) {
    const walkFreeze = (node: Node): void => {
      if (node instanceof AbstractMesh) node.freezeWorldMatrix()
      for (const c of node.getChildren()) walkFreeze(c)
    }
    walkFreeze(root)
  }
}

function unfreezeHierarchy(node: Node): void {
  if (node instanceof AbstractMesh) node.unfreezeWorldMatrix()
  for (const c of node.getChildren()) unfreezeHierarchy(c)
}

function findPlateRoot(root: TransformNode, plateId: number): TransformNode | null {
  const want = `plateRoot_${plateId}`
  for (const c of root.getChildren()) {
    if (c instanceof TransformNode && c.name === want) return c
  }
  return null
}

/** Fit orbit to one plate’s printed mesh (not the full bed) so thin parts fill the view. */
function applyCameraFocusToPlateContent(cam: ArcRotateCamera, plateRoot: TransformNode, plateId: number): void {
  unfreezeHierarchy(plateRoot)
  plateRoot.computeWorldMatrix(true)
  const meshName = `model_p${plateId}`
  let content: AbstractMesh | null = null
  for (const c of plateRoot.getChildren()) {
    if (c instanceof Mesh && c.name === meshName) {
      content = c
      break
    }
  }
  let min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
  let max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY)
  const merge = (mesh: AbstractMesh): void => {
    mesh.computeWorldMatrix(true)
    const bi = mesh.getHierarchyBoundingVectors(true)
    min = Vector3.Minimize(min, bi.min)
    max = Vector3.Maximize(max, bi.max)
  }
  if (content && !content.isDisposed()) merge(content)
  else {
    for (const c of plateRoot.getChildren()) {
      if (c instanceof AbstractMesh && !c.name.startsWith('ground')) merge(c)
    }
  }
  if (!Number.isFinite(min.x)) return
  const center = min.add(max).scale(0.5)
  const dx = max.x - min.x
  const dy = max.y - min.y
  const dz = max.z - min.z
  const maxDim = Math.max(dx, dy, dz, 4)
  cam.upperRadiusLimit = Math.max(2000, maxDim * 14)
  cam.setTarget(center)
  const fov = cam.fov
  const tanHalf = Math.tan(fov * 0.5)
  const pad = 1.42
  const rFromFov = tanHalf > 1e-6 ? (maxDim * 0.5 * pad) / tanHalf : maxDim * 1.35
  cam.radius = Math.max(0.03, Math.min(rFromFov, cam.upperRadiusLimit * 0.92))
  cam.alpha = DEFAULT_VIEW_ALPHA
  cam.beta = Math.min(1.08, DEFAULT_VIEW_BETA * 0.96)
}

/** Longer duration so a larger drop still reads clearly. */
const SETTLE_FRAMES = 58

function playSettleBounce(scene: Scene, mesh: Mesh, restY: number, onDone: () => void): void {
  mesh.computeWorldMatrix(true)
  const bi = mesh.getHierarchyBoundingVectors(true)
  const height = bi.max.y - bi.min.y
  /** Initial lift (mm): scales with model height, capped so tiny/huge meshes stay sane. */
  const lift = Math.min(165, Math.max(18, height * 0.52))
  mesh.position.y = restY + lift

  const anim = new Animation(
    'settleY',
    'position.y',
    60,
    Animation.ANIMATIONTYPE_FLOAT,
    Animation.ANIMATIONLOOPMODE_CONSTANT
  )
  anim.setKeys([
    { frame: 0, value: restY + lift },
    { frame: SETTLE_FRAMES, value: restY }
  ])
  /** More bounces + higher bounciness = bigger “spring” at landing. */
  const ease = new BounceEase(5, 3.2)
  ease.setEasingMode(EasingFunction.EASINGMODE_EASEOUT)
  anim.setEasingFunction(ease)

  scene.beginDirectAnimation(mesh, [anim], 0, SETTLE_FRAMES, false, 1, onDone)
}

export const BabylonViewer = forwardRef<BabylonViewerHandle, Props>(function BabylonViewer(
  { mesh, viewMode, loadAnimSeq, cameraPreset, openEdgeLinePositions, measureMode, onMeasureResult },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const sceneRef = useRef<Scene | null>(null)
  const meshRef = useRef<Mesh | TransformNode | null>(null)
  const viewModeRef = useRef<ViewMode>(viewMode)
  const cameraPresetRef = useRef(cameraPreset)
  cameraPresetRef.current = cameraPreset
  const wheelDeltaBoostRef = useRef(CAMERA_PRESETS[cameraPreset].wheelDeltaBoost)
  /** Greatest `loadAnimSeq` we already played the settle bounce for (rotate/repair keep the same seq). */
  const lastSettledLoadSeqRef = useRef(-1)
  /** Measurement: first picked world point (null when waiting for first click). */
  const measurePtARef = useRef<[number, number, number] | null>(null)
  /** Observer handle so we can remove it when measure mode exits. */
  const measureObserverRef = useRef<Observer<PointerInfo> | null>(null)
  /** Stable ref so the tap handler always calls the latest onMeasureResult without re-registering. */
  const onMeasureResultRef = useRef(onMeasureResult)
  onMeasureResultRef.current = onMeasureResult
  /**
   * Bumped after each new Babylon scene is created (via queueMicrotask in init).
   * React dev Strict Mode recreates the scene without changing `mesh` props; a boolean
   * `sceneReady` can stay `true` across dispose/recreate (batched updates), so the mesh
   * effect never re-runs and the viewport stays empty while the app still shows "Loaded".
   */
  const [sceneRevision, setSceneRevision] = useState(0)

  useImperativeHandle(
    ref,
    () => ({
      resetDefaultView: () => {
        const scene = sceneRef.current
        const m = meshRef.current
        const cam = scene?.activeCamera as ArcRotateCamera | undefined
        if (!scene || !m || !cam) return
        if (m instanceof TransformNode && m.name === 'modelPlates') {
          applyDefaultOrbitToNode(cam, m, true, { multiPlateOverview: true })
        } else if (m instanceof TransformNode) {
          applyDefaultOrbitToNode(cam, m, true)
        } else {
          applyDefaultOrbitToMesh(cam, m, true)
        }
      },
      focusCameraOnPlate: (plateId: number): void => {
        const scene = sceneRef.current
        const root = meshRef.current
        const cam = scene?.activeCamera as ArcRotateCamera | undefined
        if (!scene || !root || !cam) return
        if (!(root instanceof TransformNode) || root.name !== 'modelPlates') return
        unfreezeHierarchy(root)
        const plateRoot = findPlateRoot(root, plateId)
        if (!plateRoot) return
        applyCameraFocusToPlateContent(cam, plateRoot, plateId)
      },
      captureScreenshot: (): string | null => {
        const scene = sceneRef.current
        const canvas = canvasRef.current
        if (!scene || !canvas) return null
        scene.render()
        try {
          return canvas.toDataURL('image/png')
        } catch {
          return null
        }
      }
    }),
    []
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      adaptToDeviceRatio: true,
      powerPreference: 'high-performance'
    })
    if (dpr > 1.08) {
      engine.setHardwareScalingLevel(Math.max(1, dpr / 1.12))
    }
    engineRef.current = engine
    const scene = new Scene(engine)
    sceneRef.current = scene
    // Very dark background, close to Orca Slicer / Bambu Studio.
    // clearColor bypasses the image-processing post-process, so it is stored
    // as a linear value that the browser will display as-is on the sRGB canvas.
    // sRGB(0.14,0.16,0.20) → linear ≈ (0.017,0.022,0.033)
    scene.clearColor = new Color4(0.017, 0.022, 0.033, 1)
    // Enable Babylon's gamma-correction pipeline so that colours defined in
    // linear space (our diffuseColor inputs) are converted back to sRGB for
    // display, reproducing the original sRGB hex values faithfully.
    scene.imageProcessingConfiguration.isEnabled = true
    scene.imageProcessingConfiguration.exposure = 1.0
    scene.imageProcessingConfiguration.colorGradingEnabled = false
    scene.imageProcessingConfiguration.colorCurvesEnabled = false

    const camera = new ArcRotateCamera('cam', DEFAULT_VIEW_ALPHA, DEFAULT_VIEW_BETA, 8, Vector3.Zero(), scene)
    camera.attachControl(canvas, true)
    camera.lowerAlphaLimit = null
    camera.upperAlphaLimit = null
    camera.lowerBetaLimit = null
    camera.upperBetaLimit = null
    camera.allowUpsideDown = true
    camera.lowerRadiusLimit = 0.02
    camera.upperRadiusLimit = 2000
    const dyn = CAMERA_PRESETS[cameraPresetRef.current]
    wheelDeltaBoostRef.current = dyn.wheelDeltaBoost
    /** Lower = faster zoom (Babylon default is ~3). */
    camera.wheelPrecision = dyn.wheelPrecision
    /** Lower = faster pan (default ~1000). Right-drag pans the view. */
    camera.panningSensibility = dyn.panningSensibility
    camera.inertia = 0
    camera.panningInertia = dyn.panningInertia
    camera.angularSensibilityX = 260
    camera.angularSensibilityY = 260

    const mousewheel = camera.inputs.attached.mousewheel as ArcRotateCameraMouseWheelInput | undefined
    if (mousewheel) {
      mousewheel.customComputeDeltaFromMouseWheel = (wheelDelta, input) => {
        const cam = input.camera
        const base = wheelDelta / (input.wheelPrecision * 40)
        const scale = Math.max(0.35, Math.min(2.8, cam.radius / 180))
        return base * scale * wheelDeltaBoostRef.current
      }
    }

    // ── Exact Orca Slicer / Bambu Studio lighting (from resources/shaders/140/gouraud.vs) ──
    // INTENSITY_AMBIENT = 0.3, applied uniformly to all faces (diffuse == groundColor = no glow)
    const ambientLight = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene)
    ambientLight.intensity = 0.3
    ambientLight.diffuse = new Color3(1, 1, 1)
    ambientLight.groundColor = new Color3(1, 1, 1)  // same as diffuse → flat ambient, no directional glow
    ambientLight.specular = new Color3(0, 0, 0)     // no specular from ambient

    // LIGHT_TOP: diffuse = 0.8 * 0.6 = 0.48, eye-space dir = normalize(-0.6, 0.6, 1.0)
    // Lights are in eye-space in Orca (they track the camera) — we replicate this by updating
    // the world-space direction every frame from the camera's inverse view matrix.
    const keyLight = new DirectionalLight('key', new Vector3(0, -1, 0), scene)
    keyLight.intensity = 0.48
    keyLight.diffuse = new Color3(1, 1, 1)
    keyLight.specular = new Color3(1, 1, 1)  // specular level set on material (0.075)

    // LIGHT_FRONT: diffuse = 0.3 * 0.6 = 0.18, eye-space dir = normalize(1.0, 0.2, 1.0)
    // Orca has no specular on the front light.
    const fillLight = new DirectionalLight('fill', new Vector3(0, -1, 0), scene)
    fillLight.intensity = 0.18
    fillLight.diffuse = new Color3(1, 1, 1)
    fillLight.specular = new Color3(0, 0, 0)

    // Eye-space light directions from Orca's gouraud.vs (direction FROM surface TO light)
    const ORCA_TOP_EYE  = new Vector3(-0.4574957,  0.4574957, 0.7624929)
    const ORCA_FRONT_EYE = new Vector3( 0.6985074,  0.1397015, 0.6985074)
    const _invView = Matrix.Identity()

    createPrintBed(scene, DEFAULT_BED_MM)
    applyPrintBedViewMode(scene, viewModeRef.current)
    applyUnderBedVisibility(scene, viewModeRef.current)

    const onResize = (): void => engine.resize()
    window.addEventListener('resize', onResize)
    engine.runRenderLoop(() => {
      // Keep lights in eye-space (tracking the camera) to exactly match Orca/Bambu behaviour.
      // Orca's lights are in eye-space, so they always come from the same screen-relative directions.
      const cam = scene.activeCamera
      if (cam) {
        cam.getViewMatrix().invertToRef(_invView)
        // Orca's light dir is FROM surface TO light; Babylon's direction is the ray direction (opposite).
        const kd = Vector3.TransformNormal(ORCA_TOP_EYE, _invView)
        kd.negateInPlace()
        keyLight.direction.copyFrom(kd)
        const fd = Vector3.TransformNormal(ORCA_FRONT_EYE, _invView)
        fd.negateInPlace()
        fillLight.direction.copyFrom(fd)
      }
      applyUnderBedVisibility(scene, viewModeRef.current)
      scene.render()
    })
    /** After Strict dispose+recreate in the same tick, bump revision so mesh sync runs again. */
    queueMicrotask(() => {
      setSceneRevision((r) => r + 1)
    })

    return () => {
      window.removeEventListener('resize', onResize)
      scene.dispose()
      engine.dispose()
      engineRef.current = null
      sceneRef.current = null
      meshRef.current = null
    }
  }, [])

  useEffect(() => {
    const dyn = CAMERA_PRESETS[cameraPreset]
    wheelDeltaBoostRef.current = dyn.wheelDeltaBoost
    const cam = sceneRef.current?.activeCamera as ArcRotateCamera | undefined
    if (!cam) return
    cam.wheelPrecision = dyn.wheelPrecision
    cam.panningSensibility = dyn.panningSensibility
    cam.panningInertia = dyn.panningInertia
  }, [cameraPreset])

  useEffect(() => {
    const scene = sceneRef.current
    const engine = scene?.getEngine() ?? null
    if (!scene || sceneRevision < 1) return

    const prev = meshRef.current
    if (prev && !prev.isDisposed()) {
      prev.dispose(false, true)
    }
    meshRef.current = null
    // Clear overlays from the previous mesh
    for (const name of ['__openEdges', '__measureLine', '__measureDotA', '__measureDotB']) {
      const old = scene.getMeshByName(name)
      if (old && !old.isDisposed()) old.dispose()
    }
    measurePtARef.current = null
    // The measureMode effect re-runs when App.tsx resets measureMode on mesh change, which cleans up its own observer.
    if (!mesh) {
      lastSettledLoadSeqRef.current = -1
      const cam = scene.activeCamera as ArcRotateCamera | undefined
      if (cam) cam.upperRadiusLimit = 2000
      if (engine) {
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
        engine.setHardwareScalingLevel(dpr > 1.08 ? Math.max(1, dpr / 1.12) : 1)
        engine.resize()
      }
      forEachGroundMesh(scene, (g) => g.dispose(false, true))
      createPrintBed(scene, DEFAULT_BED_MM, 'ground')
      applyPrintBedViewMode(scene, viewModeRef.current)
      applyUnderBedVisibility(scene, viewModeRef.current)
      return
    }

    const meta = mesh.packageMeta
    const solePart = mesh.plateParts?.length === 1 ? mesh.plateParts[0] : undefined
    const hexesSole = meta?.filamentColorsHex
    const plateKey = solePart?.plateId ?? 1
    const fromBuildSole = dominantExtruderSlotFromBuildObjects(meta?.buildObjects, plateKey)
    const cyclicSole =
      solePart?.filamentSlot === undefined &&
      fromBuildSole === undefined &&
      hexesSole &&
      hexesSole.length >= 2
        ? ((plateKey - 1) % hexesSole.length) + 1
        : undefined
    const soleSlotEff =
      solePart?.filamentSlot ??
      fromBuildSole ??
      cyclicSole ??
      (hexesSole && hexesSole.length === 1 ? 1 : undefined)
    const soleSlotHex =
      soleSlotEff !== undefined &&
      hexesSole &&
      hexesSole.length > 0 &&
      hexesSole[soleSlotEff - 1] !== undefined
        ? hexesSole[soleSlotEff - 1]
        : undefined
    const soleUseFilamentTint = Boolean(soleSlotHex)
    const soleMeshPayload =
      soleUseFilamentTint && mesh.vertexColors && mesh.vertexColors.length > 0
        ? { ...mesh, vertexColors: undefined }
        : mesh
    const mat = createModelMaterial(
      scene,
      soleSlotHex !== undefined ? hexCssToLinearColor3(soleSlotHex) : new Color3(0.52, 0.78, 1.0)
    )
    mat.name = `modelMat_${Date.now()}`
    applyViewMode(mat, viewMode)

    forEachGroundMesh(scene, (g) => g.dispose(false, true))

    const parts = mesh.plateParts
    // Prefer the actual plateParts plate IDs (geometry-backed) over meta.plateIds.
    // meta.plateIds includes ALL plates from model_settings.config (e.g. 12 entries
    // for an A1 Mini project), most of which may have no geometry and would show as
    // empty bed cells. Only fall back to meta.plateIds when there are no plateParts.
    const geomPlateIds =
      parts && parts.length > 0
        ? [...new Set(parts.map((pp) => pp.plateId))].sort((a, b) => a - b)
        : null
    const layoutPlateIds =
      geomPlateIds ??
      (meta?.plateIds && meta.plateIds.length > 0
        ? [...meta.plateIds].sort((a, b) => a - b)
        : [])
    const multiPlate =
      parts !== undefined &&
      parts.length > 0 &&
      (parts.length > 1 || layoutPlateIds.length > 1)

    const layoutOnePlateMesh = (m: Mesh): number => {
      m.computeWorldMatrix(true)
      let bi = m.getHierarchyBoundingVectors(true)
      m.position.y += BED_SURFACE_Y + MODEL_BED_GAP_MM - bi.min.y
      m.computeWorldMatrix(true)
      bi = m.getHierarchyBoundingVectors(true)
      const cx = (bi.min.x + bi.max.x) * 0.5
      const cz = (bi.min.z + bi.max.z) * 0.5
      m.position.x -= cx
      m.position.z -= cz
      m.computeWorldMatrix(true)
      bi = m.getHierarchyBoundingVectors(true)
      const footW = bi.max.x - bi.min.x
      const footD = bi.max.z - bi.min.z
      return Math.min(BED_MAX_MM, Math.max(BED_MIN_MM, Math.max(footW, footD) * BED_PADDING))
    }

    if (multiPlate && parts) {
      const root = new TransformNode('modelPlates', scene)
      meshRef.current = root

      const bedWMeta = meta?.bedWidthMm
      const bedDMeta = meta?.bedDepthMm
      const cellSpan =
        bedWMeta !== undefined && bedDMeta !== undefined
          ? Math.max(bedWMeta, bedDMeta, 120) + OVERVIEW_PLATE_GAP_MM
          : DEFAULT_BED_MM + OVERVIEW_PLATE_GAP_MM

      const partByPlate = new Map(parts.map((p) => [p.plateId, p]))
      const opcLogOnce = { done: false }
      // NOAMS detection: if every part shares the same filamentSlot (e.g. all extruder=1),
      // the slot carries no per-plate information — fall back to cyclic plate-order coloring.
      const allSameSlot =
        parts.length > 1 &&
        parts.every((p) => p.filamentSlot !== undefined && p.filamentSlot === parts[0]?.filamentSlot)

      layoutPlateIds.forEach((plateId, plateIndex) => {
        const plateRoot = new TransformNode(`plateRoot_${plateId}`, scene)
        plateRoot.parent = root

        const col = plateIndex % OVERVIEW_PLATE_COLS
        const row = Math.floor(plateIndex / OVERVIEW_PLATE_COLS)
        const cellCx = col * cellSpan + cellSpan * 0.5
        const cellCz = row * cellSpan + cellSpan * 0.5
        plateRoot.position.x = cellCx
        plateRoot.position.z = cellCz

        const groundW0 = bedWMeta ?? DEFAULT_BED_MM
        const groundD0 = bedDMeta ?? groundW0
        const part = partByPlate.get(plateId)
        const hasGeom =
          part !== undefined &&
          part.mesh.indices.length > 0 &&
          part.mesh.positions.length >= 9

        if (!hasGeom) {
          logEmptyPlateDiagnostics(plateId, meta, opcLogOnce)
          const ground = createPrintBed(scene, groundW0, `ground_p${plateId}`, groundD0)
          ground.parent = plateRoot
          return
        }

        const { cx, cz } = meshAabbCenterXZMm(part.mesh.positions)

        const hexes = meta?.filamentColorsHex
        const fromBuild = dominantExtruderSlotFromBuildObjects(meta?.buildObjects, plateId)
        // Use cyclic plate-order slot when: (a) no per-part slot is assigned, OR (b) all parts
        // share the same slot (NOAMS single-extruder multi-plate) — slot gives no useful signal.
        const useCyclic =
          (part.filamentSlot === undefined || allSameSlot) &&
          (fromBuild === undefined || allSameSlot) &&
          hexes !== undefined &&
          hexes.length >= 2
        const cyclicSlot = useCyclic ? (plateIndex % hexes!.length) + 1 : undefined
        const slotEff =
          (!allSameSlot ? part.filamentSlot : undefined) ??
          (!allSameSlot ? fromBuild : undefined) ??
          cyclicSlot ??
          (hexes && hexes.length === 1 ? 1 : undefined)
        const slotHex =
          slotEff !== undefined &&
          hexes &&
          hexes.length > 0 &&
          hexes[slotEff - 1] !== undefined
            ? hexes[slotEff - 1]
            : undefined
        const useFilamentTint = Boolean(slotHex)
        const meshPayload =
          useFilamentTint && part.mesh.vertexColors && part.mesh.vertexColors.length > 0
            ? { ...part.mesh, vertexColors: undefined }
            : part.mesh
        let subMat: StandardMaterial
        if (useFilamentTint && slotHex) {
          subMat = createModelMaterial(scene, hexCssToLinearColor3(slotHex))
          subMat.name = `${mat.name}_p${plateId}_slot`
        } else {
          subMat = mat.clone(`${mat.name}_p${plateId}`)
        }
        applyViewMode(subMat, viewMode)
        const m = triangleMeshToBabylon(
          `model_p${plateId}`,
          scene,
          meshPayload,
          subMat,
          useFilamentTint ? { useVertexColors: false } : undefined
        )
        m.parent = plateRoot
        m.isPickable = false
        m.renderingGroupId = 0

        // Centre the plate mesh on the grid cell using AABB centre.
        // Bambu / Orca 3MF files apply <assemble_item> transforms that collapse objects
        // into design-space coordinates (near origin), so the AABB centre gives a
        // good approximation of where objects live relative to the plate bed.
        m.position.x = -cx
        m.position.z = -cz

        const bedMm = layoutPlateMeshBedYOnly(m)
        snapMeshWorldXzCenterToPlateOrigin(m, plateRoot)
        boostVeryThinPartForVisibility(m)
        snapMeshWorldXzCenterToPlateOrigin(m, plateRoot)
        const groundW = bedWMeta ?? bedMm
        const groundD = bedDMeta ?? bedMm
        const ground = createPrintBed(scene, groundW, `ground_p${plateId}`, groundD)
        ground.parent = plateRoot
      })

      if (engine) {
        applyEngineScalingForMesh(engine, mesh.indices.length / 3)
      }

      const cam = scene.activeCamera as ArcRotateCamera
      if (cam) {
        applyDefaultOrbitToNode(cam, root, false, { multiPlateOverview: true })
        const walkFreeze = (node: Node): void => {
          if (node instanceof AbstractMesh) node.freezeWorldMatrix()
          for (const c of node.getChildren()) walkFreeze(c)
        }
        walkFreeze(root)
      }
    } else {
      const m = triangleMeshToBabylon(
        'model',
        scene,
        soleMeshPayload,
        mat,
        soleUseFilamentTint ? { useVertexColors: false } : undefined
      )
      meshRef.current = m
      m.isPickable = false
      m.renderingGroupId = 0

      const bedMm = layoutOnePlateMesh(m)
      boostVeryThinPartForVisibility(m)
      m.computeWorldMatrix(true)
      {
        const bi = m.getHierarchyBoundingVectors(true)
        m.position.x -= (bi.min.x + bi.max.x) * 0.5
        m.position.z -= (bi.min.z + bi.max.z) * 0.5
      }
      m.computeWorldMatrix(true)

      const gw = meta?.bedWidthMm
      const gd = meta?.bedDepthMm
      createPrintBed(scene, gw ?? bedMm, 'ground', gd ?? gw ?? bedMm)
      applyPrintBedViewMode(scene, viewMode)
      applyUnderBedVisibility(scene, viewModeRef.current)

      const restY = m.position.y

      if (engine) {
        applyEngineScalingForMesh(engine, mesh.indices.length / 3)
      }

      const cam = scene.activeCamera as ArcRotateCamera
      const playSettle = loadAnimSeq > lastSettledLoadSeqRef.current
      if (playSettle) {
        lastSettledLoadSeqRef.current = loadAnimSeq
      }
      if (cam) {
        applyDefaultOrbitToMesh(cam, m, false)
        if (playSettle) {
          playSettleBounce(scene, m, restY, () => {
            if (meshRef.current === m && !m.isDisposed()) {
              m.freezeWorldMatrix()
            }
          })
        } else {
          m.freezeWorldMatrix()
        }
      } else {
        m.freezeWorldMatrix()
      }
    }

    applyPrintBedViewMode(scene, viewMode)
    applyUnderBedVisibility(scene, viewModeRef.current)

    engine?.resize()
  }, [sceneRevision, mesh, loadAnimSeq])

  /** Open edge overlay: create or destroy a line system whenever the positions prop changes. */
  useEffect(() => {
    const scene = sceneRef.current
    const root = meshRef.current
    if (!scene) return

    const prev = scene.getMeshByName('__openEdges')
    if (prev && !prev.isDisposed()) prev.dispose()

    if (!openEdgeLinePositions || openEdgeLinePositions.length < 6) return
    if (!(root instanceof Mesh)) return // skip multi-plate TransformNode

    const lines: Vector3[][] = []
    for (let i = 0; i + 5 < openEdgeLinePositions.length; i += 6) {
      lines.push([
        new Vector3(openEdgeLinePositions[i], openEdgeLinePositions[i + 1], openEdgeLinePositions[i + 2]),
        new Vector3(openEdgeLinePositions[i + 3], openEdgeLinePositions[i + 4], openEdgeLinePositions[i + 5])
      ])
    }

    const lineSystem = MeshBuilder.CreateLineSystem('__openEdges', { lines, updatable: false }, scene)
    lineSystem.color = new Color3(1, 0.32, 0.08)
    lineSystem.renderingGroupId = 1
    // Inherit the model mesh transform so lines stay aligned after bed placement
    lineSystem.parent = root
    lineSystem.isPickable = false
  }, [openEdgeLinePositions])

  /**
   * Measure mode: on each non-drag left click, calls scene.pick() with a predicate that finds any
   * model mesh (bypasses isPickable to avoid stale flag issues after freeze/layout). Two picks in
   * sequence → draws a yellow line and fires onMeasureResult with the distance in mm.
   *
   * Drag detection: compares scene.pointerX/Y (Babylon render-buffer coords) between POINTERDOWN
   * and POINTERUP. Threshold is 20 render-buffer pixels — large enough to tolerate slight jitter on
   * HiDPI displays.
   */
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    if (measureObserverRef.current) {
      scene.onPointerObservable.remove(measureObserverRef.current)
      measureObserverRef.current = null
    }
    for (const name of ['__measureLine', '__measureDotA', '__measureDotB']) {
      const m = scene.getMeshByName(name)
      if (m && !m.isDisposed()) m.dispose()
    }
    measurePtARef.current = null

    if (!measureMode) return

    mfDiagLog('[Measure] mode ON — scene meshes:', scene.meshes.map((m) => m.name).join(', '))

    let downX = 0
    let downY = 0

    // Pick model meshes by name (bypasses isPickable entirely when a predicate is provided, so
    // freezeWorldMatrix or stale flags cannot cause misses).
    const modelPredicate = (m: AbstractMesh): boolean =>
      m.name === 'model' || m.name.startsWith('model_p')

    measureObserverRef.current = scene.onPointerObservable.add((info) => {
      const evt = info.event as PointerEvent
      if (evt.button !== 0) return

      if (info.type === PointerEventTypes.POINTERDOWN) {
        downX = scene.pointerX
        downY = scene.pointerY
        mfDiagLog('[Measure] POINTERDOWN at', downX, downY)

      } else if (info.type === PointerEventTypes.POINTERUP) {
        const dist = Math.hypot(scene.pointerX - downX, scene.pointerY - downY)
        mfDiagLog('[Measure] POINTERUP dist=', dist, 'pointerXY=', scene.pointerX, scene.pointerY)
        if (dist > 20) return

        const pickResult = babylonPick(scene, scene.pointerX, scene.pointerY, modelPredicate)
        mfDiagLog('[Measure] pick: hit=', pickResult?.hit, 'mesh=', pickResult?.pickedMesh?.name, 'pt=', pickResult?.pickedPoint?.toString())
        if (!pickResult?.hit || !pickResult.pickedPoint) return

        const pt: [number, number, number] = [pickResult.pickedPoint.x, pickResult.pickedPoint.y, pickResult.pickedPoint.z]

        const dotName = measurePtARef.current ? '__measureDotB' : '__measureDotA'
        const existingDot = scene.getMeshByName(dotName)
        if (existingDot && !existingDot.isDisposed()) existingDot.dispose()
        const dot = MeshBuilder.CreateSphere(dotName, { diameter: 2, segments: 6 }, scene)
        dot.position = new Vector3(pt[0], pt[1], pt[2])
        dot.isPickable = false
        dot.renderingGroupId = 1
        const dotMat = createModelMaterial(scene, new Color3(1, 0.85, 0.1))
        dotMat.disableLighting = true
        dot.material = dotMat

        if (!measurePtARef.current) {
          measurePtARef.current = pt
        } else {
          const ptA = measurePtARef.current
          const distanceMm = Math.hypot(pt[0] - ptA[0], pt[1] - ptA[1], pt[2] - ptA[2])

          const existingLine = scene.getMeshByName('__measureLine')
          if (existingLine && !existingLine.isDisposed()) existingLine.dispose()
          const measureLine = MeshBuilder.CreateLineSystem(
            '__measureLine',
            { lines: [[new Vector3(ptA[0], ptA[1], ptA[2]), new Vector3(pt[0], pt[1], pt[2])]], updatable: false },
            scene
          )
          measureLine.color = new Color3(1, 0.85, 0.1)
          measureLine.renderingGroupId = 1
          measureLine.isPickable = false

          onMeasureResultRef.current?.(distanceMm, ptA, pt)
          measurePtARef.current = null
        }
      }
    })

    return () => {
      if (measureObserverRef.current) {
        scene.onPointerObservable.remove(measureObserverRef.current)
        measureObserverRef.current = null
      }
    }
  }, [measureMode])

  useEffect(() => {
    viewModeRef.current = viewMode
    const scene = sceneRef.current
    const root = meshRef.current
    if (root) {
      const applyMatRecursive = (node: Node): void => {
        if (node instanceof AbstractMesh) {
          const mm = node.material as StandardMaterial | undefined
          if (mm) applyViewMode(mm, viewMode)
        }
        for (const c of node.getChildren()) applyMatRecursive(c)
      }
      applyMatRecursive(root)
    }
    if (scene) {
      applyPrintBedViewMode(scene, viewMode)
      applyUnderBedVisibility(scene, viewMode)
    }
  }, [viewMode])

  return <canvas ref={canvasRef} className="viewer-canvas" />
})
