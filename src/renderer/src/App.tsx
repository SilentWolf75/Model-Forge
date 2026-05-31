import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { R3FViewer, type ViewerHandle, type ViewMode, type SnapView, type MaterialPreset, type Annotation } from './viewer/R3FViewer'
import {
  readStoredCameraPresetId,
  writeStoredCameraPresetId,
  type CameraPresetId
} from './viewer/cameraPrefs'
import type { ThreeMfBuildObjectSummary, ThreeMfProcessHints, TriangleMesh } from './mesh/types'
import {
  rotateMeshQuarterTurnAroundY,
  rotateMeshQuarterTurnAroundX,
  rotateMeshQuarterTurnAroundZ,
  mirrorMesh,
  centerMeshOnBed
} from './mesh/rotateAroundY'
import { extensionOf, loadModelFromBuffer } from './loaders'
import {
  readStoredStepTessellationPreset,
  writeStoredStepTessellationPreset,
  stepTessellationParams,
  stepTessellationSummary,
  type StepTessellationPreset
} from './loaders/stepTessellation'
import { repairMesh } from './repair/meshRepair'
import { encodeBinaryStl } from './exporters/stl'
import { encodeObj } from './exporters/obj'
import { encodeThreeMf } from './exporters/threeMf'
import { DISPLAY_VERSION } from './version'
import { WhatsNew } from './WhatsNew'
import packageJson from '../../../package.json'
import { analyzeMesh, printReadinessLines, repairImpactReport } from './mesh/analyze'
import { findOpenEdges } from './mesh/openEdges'

function dataUrlToPngBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || !dataUrl.startsWith('data:image')) return null
  const b64 = dataUrl.slice(comma + 1)
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function formatTimestamp(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fileExtBadge(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return ''
  const ext = name.slice(dot + 1).toUpperCase()
  return ext === 'STP' ? 'STEP' : ext
}

function meshStats(m: TriangleMesh): { vertices: string; triangles: string; bounds: string } {
  const nV = m.positions.length / 3
  const nT = m.indices.length / 3
  let minx = Infinity, miny = Infinity, minz = Infinity
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  const p = m.positions
  for (let i = 0; i < p.length; i += 3) {
    minx = Math.min(minx, p[i]); miny = Math.min(miny, p[i + 1]); minz = Math.min(minz, p[i + 2])
    maxx = Math.max(maxx, p[i]); maxy = Math.max(maxy, p[i + 1]); maxz = Math.max(maxz, p[i + 2])
  }
  return {
    vertices: nV.toLocaleString(),
    triangles: nT.toLocaleString(),
    bounds: `${(maxx - minx).toFixed(2)} × ${(maxy - miny).toFixed(2)} × ${(maxz - minz).toFixed(2)} mm`,
  }
}

function statusClass(s: string): string {
  const lo = s.toLowerCase()
  if (/error|failed|unsupported|could not/.test(lo)) return 'err'
  if (/cancel|no open edge/.test(lo)) return 'warn'
  if (/loaded|exported|rotated|opened|repaired|screenshot|distance|cleared/.test(lo)) return 'ok'
  return ''
}

const idleStatusMessage = 'Open a model to begin. Formats: STL OBJ 3MF GLB GLTF AMF PLY FBX STEP/STP'

type RecentFile = { path: string; name: string; timestamp: number }

function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [slicerPath, setSlicerPath] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setSlicerPath(s.slicerPath ?? '')
      setLoading(false)
    })
  }, [])

  const browse = async (): Promise<void> => {
    setBrowsing(true)
    const picked = await window.api.browseSlicer()
    setBrowsing(false)
    if (picked) setSlicerPath(picked)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    await window.api.saveSettings({ slicerPath: slicerPath.trim() || undefined, firstRunDone: true })
    setSaving(false)
    onClose()
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="settings-title">Settings</h2>

        <section className="settings-section">
          <h3 className="settings-section-title">Slicer application</h3>
          <p className="settings-desc">
            Used by <strong>Open in slicer</strong>. Browse to your slicer&apos;s executable
            (e.g.&nbsp;<code>bambu-studio.exe</code> or <code>orca-slicer.exe</code>).
          </p>
          <div className="settings-row">
            <input
              className="settings-input"
              type="text"
              value={loading ? 'Loading…' : slicerPath}
              onChange={(e) => setSlicerPath(e.target.value)}
              placeholder="Path to slicer executable…"
              disabled={loading || browsing}
              spellCheck={false}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void browse()}
              disabled={loading || browsing || saving}
            >
              {browsing ? 'Picking…' : 'Browse…'}
            </button>
          </div>
        </section>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void save()}
            disabled={loading || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ShortcutsModal({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-dialog shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <table className="shortcuts-table">
          <tbody>
            <tr><td className="sc-key">O</td><td>Open file</td></tr>
            <tr><td className="sc-key">W</td><td>Wireframe view</td></tr>
            <tr><td className="sc-key">S</td><td>Solid view</td></tr>
            <tr><td className="sc-key">L</td><td>Look-through (X-ray) view</td></tr>
            <tr><td className="sc-key">R</td><td>Reset camera</td></tr>
            <tr><td className="sc-key">P</td><td>Save screenshot</td></tr>
            <tr><td className="sc-key">F</td><td>Toggle face orientation overlay</td></tr>
            <tr><td className="sc-key">H</td><td>Toggle overhang heat map</td></tr>
            <tr><td className="sc-key">T</td><td>Toggle turntable (auto-rotate)</td></tr>
            <tr><td className="sc-key">M</td><td>Toggle measure mode</td></tr>
            <tr><td className="sc-key">E</td><td>Toggle open edge highlight</td></tr>
            <tr><td className="sc-key">[ / ]</td><td>Previous / next plate (multi-plate 3MF)</td></tr>
            <tr><td className="sc-key">Ctrl+Z</td><td>Undo mesh transform</td></tr>
            <tr><td className="sc-key">Ctrl+Y</td><td>Redo mesh transform</td></tr>
            <tr><td className="sc-key">Ctrl+K</td><td>Open command palette</td></tr>
            <tr><td className="sc-key">1</td><td>Snap to Front view</td></tr>
            <tr><td className="sc-key">2</td><td>Snap to Back view</td></tr>
            <tr><td className="sc-key">3</td><td>Snap to Left view</td></tr>
            <tr><td className="sc-key">4</td><td>Snap to Right view</td></tr>
            <tr><td className="sc-key">5</td><td>Snap to Top view</td></tr>
            <tr><td className="sc-key">6</td><td>Snap to Bottom view</td></tr>
            <tr><td className="sc-key">?</td><td>Show this panel</td></tr>
            <tr><td className="sc-key">Esc</td><td>Cancel load / close dialog</td></tr>
          </tbody>
        </table>
        <div className="modal-actions">
          <button type="button" className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ─── Command palette ──────────────────────────────────────────────────────────
interface Command {
  id: string
  label: string
  description?: string
  run: () => void
  disabled?: boolean
}

function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    if (!q) return commands
    return commands.filter((c) =>
      c.label.toLowerCase().includes(q) || (c.description?.toLowerCase().includes(q) ?? false)
    )
  }, [query, commands])

  // Reset cursor when result list changes
  useEffect(() => { setActiveIdx(0) }, [filtered.length])

  const run = useCallback((cmd: Command): void => {
    if (cmd.disabled) return
    onClose()
    cmd.run()
  }, [onClose])

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmd-palette-header">
          <span className="cmd-palette-hint">⌘K</span>
          <input
            ref={inputRef}
            className="cmd-palette-input"
            type="text"
            placeholder="Type a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, filtered.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)) }
              else if (e.key === 'Enter') {
                const cmd = filtered[activeIdx]
                if (cmd && !cmd.disabled) run(cmd)
              }
              else if (e.key === 'Escape') { e.preventDefault(); onClose() }
            }}
          />
        </div>
        <ul className="cmd-palette-list" role="listbox">
          {filtered.length === 0 ? (
            <li className="cmd-palette-empty">No matching commands</li>
          ) : (
            filtered.map((cmd, i) => (
              <li
                key={cmd.id}
                className={`cmd-palette-item${i === activeIdx ? ' active' : ''}${cmd.disabled ? ' disabled' : ''}`}
                role="option"
                aria-selected={i === activeIdx}
                onMouseEnter={() => setActiveIdx(i)}
                onPointerDown={(e) => { e.preventDefault(); if (!cmd.disabled) run(cmd) }}
              >
                <span className="cmd-palette-label">{cmd.label}</span>
                {cmd.description ? <span className="cmd-palette-desc">{cmd.description}</span> : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}

/**
 * Returns g/cm³ for a filament type label (case-insensitive, prefix-matched).
 * Falls back to PLA density when type is unrecognised or absent.
 */
function filamentDensity(filamentTypes: string[] | undefined): { densityGcm3: number; label: string } {
  const raw = (filamentTypes?.[0] ?? '').toUpperCase().trim()
  if (/^(ASA|ABS)/.test(raw)) return { densityGcm3: 1.05, label: raw || 'ASA/ABS' }
  if (/^PA/.test(raw) || /^NYLON/.test(raw)) return { densityGcm3: 1.10, label: raw || 'PA/Nylon' }
  if (/^(TPU|TPE)/.test(raw)) return { densityGcm3: 1.21, label: raw || 'TPU/TPE' }
  if (/^PC/.test(raw)) return { densityGcm3: 1.20, label: raw || 'PC' }
  if (/^PETG/.test(raw)) return { densityGcm3: 1.27, label: raw || 'PETG' }
  // PLA / PLA+ / unknown → PLA default
  return { densityGcm3: 1.24, label: raw || 'PLA' }
}

/** Translate the mesh so its lowest vertex sits exactly at Y = 0 (on the bed). */
function snapMeshToBed(mesh: TriangleMesh): TriangleMesh {
  const p = mesh.positions
  let minY = Infinity
  for (let i = 1; i < p.length; i += 3) minY = Math.min(minY, p[i]!)
  if (!Number.isFinite(minY) || Math.abs(minY) < 0.001) return mesh
  const positions = p.slice()
  for (let i = 1; i < positions.length; i += 3) (positions[i] as number) -= minY
  const plateParts = mesh.plateParts?.map((pp) => ({
    ...pp,
    mesh: snapMeshToBed(pp.mesh),
  }))
  return { ...mesh, positions, ...(plateParts ? { plateParts } : {}) }
}

/**
 * Score an orientation for print quality.  Lower = better.
 *
 * The key insight: a large flat base sitting ON the bed has many triangles
 * with downward normals at Y_min — those are NOT overhangs; the bed supports them.
 * We therefore split downward-facing triangles into two buckets:
 *   • bed-contact (centroid ≤ Y_min + bedZone) → reward these (subtract from score)
 *   • true overhangs (centroid above bedZone)   → penalise these (add to score)
 *
 * Result: a flat-base-down orientation wins because the huge flat base becomes a
 * large bonus instead of a large penalty.
 */
function computeOverhangScore(mesh: TriangleMesh): number {
  const p = mesh.positions
  const ix = mesh.indices
  // Find Y extents to set the bed-contact zone height.
  let minY = Infinity, maxY = -Infinity
  for (let i = 1; i < p.length; i += 3) {
    const y = p[i]!
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const height = maxY - minY
  // Anything whose centroid is within this distance of Y_min is "on the bed".
  // 1 % of height, clamped to [0.5 mm, 5 mm].
  const bedZone = Math.max(0.5, Math.min(5, height * 0.01))

  let overhangs = 0   // penalised
  let bedContact = 0  // rewarded
  for (let i = 0; i < ix.length; i += 3) {
    const i0 = ix[i]! * 3, i1 = ix[i + 1]! * 3, i2 = ix[i + 2]! * 3
    const ax = p[i1]! - p[i0]!,   ay = p[i1 + 1]! - p[i0 + 1]!, az = p[i1 + 2]! - p[i0 + 2]!
    const bx = p[i2]! - p[i0]!,   by = p[i2 + 1]! - p[i0 + 1]!, bz = p[i2 + 2]! - p[i0 + 2]!
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (len < 1e-10) continue
    if (-ny / len > 0.707) {
      const cy = (p[i0 + 1]! + p[i1 + 1]! + p[i2 + 1]!) / 3
      if (cy <= minY + bedZone) bedContact++
      else                      overhangs++
    }
  }
  // Small weight on bedContact so it acts as a tiebreaker without swamping overhangs.
  return overhangs - bedContact * 0.5
}

/** Try 6 canonical face-down orientations; return the one with the fewest overhang triangles. */
function autoOrientMesh(mesh: TriangleMesh): { mesh: TriangleMesh; bestIdx: number } {
  const rx = rotateMeshQuarterTurnAroundX
  const rz = rotateMeshQuarterTurnAroundZ
  const candidates: TriangleMesh[] = [
    mesh,
    rx(mesh),
    rx(rx(mesh)),
    rx(rx(rx(mesh))),
    rz(mesh),
    rz(rz(rz(mesh))),
  ]
  const scores = candidates.map(computeOverhangScore)
  const best = scores.indexOf(Math.min(...scores))
  return { mesh: candidates[best]!, bestIdx: best }
}

/** Scale every position in a TriangleMesh by a uniform factor; preserves plateParts. */
function scaleMesh(mesh: TriangleMesh, factor: number): TriangleMesh {
  const positions = mesh.positions.slice()
  for (let i = 0; i < positions.length; i++) positions[i] *= factor
  const plateParts = mesh.plateParts?.map((p) => ({
    ...p,
    mesh: scaleMesh(p.mesh, factor),
  }))
  return { ...mesh, positions, ...(plateParts ? { plateParts } : {}) }
}

function extractPlateMesh(mesh: TriangleMesh, plateId: number): TriangleMesh | null {
  const part = mesh.plateParts?.find((p) => p.plateId === plateId)
  return part?.mesh ?? null
}

function isSupportedModelFilename(name: string): boolean {
  const ext = extensionOf(name)
  return (
    ext === 'stl' || ext === 'obj' || ext === '3mf' ||
    ext === 'step' || ext === 'stp' ||
    ext === 'glb' || ext === 'gltf' || ext === 'amf' ||
    ext === 'ply'  || ext === 'fbx'
  )
}

function ThreeMfBuildObjectsList({
  objects,
  onSelectPlate,
  focusedPlateId
}: {
  objects: ThreeMfBuildObjectSummary[]
  /** When set, rows with a `plateId` focus the 3D camera on that plate (multi-plate 3MF). */
  onSelectPlate?: (plateId: number) => void
  /** Highlights the row for the plate last framed from the sidebar. */
  focusedPlateId?: number | null
}): JSX.Element {
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const mult = 1.65
    const onWheel = (e: WheelEvent): void => {
      if (el.scrollHeight <= el.clientHeight + 1) return
      e.preventDefault()
      el.scrollTop += e.deltaY * mult
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [objects])
  return (
    <>
      <h3 className="side-subh">Model objects</h3>
      {onSelectPlate ? <p className="side-note">Click a row to frame that plate in the viewer.</p> : null}
      <ul ref={listRef} className="build-objects-list" aria-label="OPC object names from 3MF">
        {objects.map((o) => {
          const canFocus = Boolean(onSelectPlate && o.plateId !== undefined)
          const rowFocused = focusedPlateId !== undefined && focusedPlateId !== null && o.plateId === focusedPlateId
          return (
            <li key={o.id}>
              <button
                type="button"
                className={`build-object-item build-object-item-btn${rowFocused ? ' build-object-item-btn--focused' : ''}`}
                disabled={!canFocus}
                title={canFocus ? 'Show this plate in the 3D view' : undefined}
                onClick={() => {
                  if (o.plateId !== undefined) onSelectPlate?.(o.plateId)
                }}
              >
                <span className="build-object-name">{o.name}</span>
                <span className="build-object-meta mono">
                  id {o.id}
                  {o.plateId !== undefined ? ` · plate ${o.plateId}` : ''}
                  {o.extruderSlot !== undefined ? (
                    <span className="extruder-slot-badge" title="Filament / extruder slot">
                      {' '}
                      · T{o.extruderSlot}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function ThreeMfProcessSnapshot({ hints }: { hints: ThreeMfProcessHints }): JSX.Element | null {
  if (!Object.values(hints).some((v) => v !== undefined && String(v).trim().length > 0)) return null
  const row = (label: string, val: string | undefined): JSX.Element | null =>
    val && val.trim().length > 0 ? (
      <p className="side-line" key={label}>
        <span className="side-k">{label}</span> <span className="side-v mono proc-hint">{val.trim()}</span>
      </p>
    ) : null
  return (
    <>
      <h3 className="side-subh">Process snapshot</h3>
      {row('Layer height', hints.layerHeightMm)}
      {row('First layer height', hints.initialLayerHeightMm)}
      {row('Line width', hints.lineWidthMm)}
      {row('Nozzle', hints.nozzleDiameterMm)}
      {row('Print / process', hints.printPresetId)}
      {row('Est. print time', hints.estimatedPrintTime)}
      {row('Est. model weight', hints.estimatedModelWeight)}
      {row('Total layers', hints.totalLayers)}
    </>
  )
}

export function App(): JSX.Element {
  const [mesh, setMesh] = useState<TriangleMesh | null>(null)
  /** Incremented only after a successful file decode so the viewer can play load-only motion (not rotate/repair). */
  const [loadAnimSeq, setLoadAnimSeq] = useState(0)
  const [stepTessPreset, setStepTessPreset] = useState<StepTessellationPreset>(readStoredStepTessellationPreset)
  const [fileLabel, setFileLabel] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('solid')
  const [cameraPreset, setCameraPreset] = useState<CameraPresetId>(() => readStoredCameraPresetId())
  const [focusedPlateId, setFocusedPlateId] = useState<number | null>(null)
  const [status, setStatus] = useState<string>(idleStatusMessage)
  const [busy, setBusy] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [viewerDragActive, setViewerDragActive] = useState(false)
  /** Short label for the loading overlay (mirrors status line during load). */
  const [loadPhase, setLoadPhase] = useState<string | null>(null)
  /** Full disk path of the currently loaded file (null if loaded from buffer with no path). */
  const [filePath, setFilePath] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([])
  const [openEdgeResult, setOpenEdgeResult] = useState<{ count: number; linePositions: Float32Array } | null>(null)
  const [showOpenEdges, setShowOpenEdges] = useState(false)
  const [measureMode, setMeasureMode] = useState(false)
  const [measureResult, setMeasureResult] = useState<{
    distanceMm: number
    ptA: [number, number, number]
    ptB: [number, number, number]
  } | null>(null)
  /** Section / clip Y — null means no clip; number is Y height in mm (world space). */
  const [clipY, setClipY] = useState<number | null>(null)
  const [showCoM, setShowCoM] = useState(false)
  const [showDimensions, setShowDimensions] = useState(false)
  const [showNormals, setShowNormals] = useState(false)
  /** Scale target input string, e.g. "100" mm along the chosen axis. */
  const [scaleInput, setScaleInput] = useState('')
  const [scaleAxis, setScaleAxis] = useState<'x' | 'y' | 'z' | 'uniform'>('uniform')
  /** Which sidebar sections are collapsed (set of section ids). */
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('mf-theme') as 'dark' | 'light') ?? 'dark')
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [explodedView, setExplodedView] = useState(false)
  const [swatchCopied, setSwatchCopied] = useState<number | null>(null)
  const [turntable, setTurntable] = useState(false)
  const [materialPreset, setMaterialPreset] = useState<MaterialPreset>('default')
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [pendingAnnotationPos, setPendingAnnotationPos] = useState<[number, number, number] | null>(null)
  const [pendingAnnotationText, setPendingAnnotationText] = useState('')
  const nextAnnotationId = useRef(1)
  const [meshHistory, setMeshHistory] = useState<TriangleMesh[]>([])
  const [meshFuture, setMeshFuture] = useState<TriangleMesh[]>([])
  const meshRef = useRef<TriangleMesh | null>(null)
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false)
  const exportDropdownRef   = useRef<HTMLDivElement>(null)
  const snapViewDropdownRef = useRef<HTMLDivElement>(null)
  const [snapViewMenuOpen, setSnapViewMenuOpen] = useState(false)
  const viewerRef = useRef<ViewerHandle>(null)
  /** Avoid consuming startup path twice (React Strict Mode remount). */
  const startupOpenHandled = useRef(false)
  /** Set true when user cancels; checked after async work. Cannot interrupt WASM mid-call. */
  const loadCancelledRef = useRef(false)

  const stats = useMemo(() => (mesh ? meshStats(mesh) : null), [mesh])
  // Keep meshRef in sync so applyMeshOp / undo / redo can read current mesh in callbacks
  meshRef.current = mesh
  const [repairReport, setRepairReport] = useState<string[] | null>(null)
  const meshAnalysis = useMemo(() => (mesh ? analyzeMesh(mesh) : null), [mesh])
  const repairImpact = useMemo(() => (mesh ? repairImpactReport(mesh) : null), [mesh])
  const printLines = useMemo(() => {
    if (!meshAnalysis || repairImpact === null) return []
    return printReadinessLines(meshAnalysis, repairImpact.removedDegenerate)
  }, [meshAnalysis, repairImpact])

  // Persist theme to localStorage
  useEffect(() => { localStorage.setItem('mf-theme', theme) }, [theme])

  const hasSubObjects = Boolean(
    mesh?.plateParts?.some((p) => p.subObjects && p.subObjects.length >= 2)
  )

  const showPlateOverviewControls = Boolean(
    mesh &&
      mesh.plateParts &&
      mesh.plateParts.length > 0 &&
      (mesh.plateParts.length > 1 || (mesh.packageMeta?.plateIds?.length ?? 0) > 1)
  )

  useEffect(() => {
    void window.api.getRecentFiles().then(setRecentFiles).catch(() => {})
  }, [])

  useEffect(() => {
    if (!mesh) {
      setExportMenuOpen(false)
      setShowOpenEdges(false)
      setOpenEdgeResult(null)
      setMeasureMode(false)
      setMeasureResult(null)
      setRepairReport(null)
      setExplodedView(false)
    } else {
      // Clear stale overlays whenever the mesh object changes (repair/rotate/new load)
      setShowOpenEdges(false)
      setOpenEdgeResult(null)
      setMeasureMode(false)
      setMeasureResult(null)
      setExplodedView(false)
    }
  }, [mesh])

  useEffect(() => {
    writeStoredCameraPresetId(cameraPreset)
  }, [cameraPreset])

  useEffect(() => {
    writeStoredStepTessellationPreset(stepTessPreset)
  }, [stepTessPreset])

  useEffect(() => {
    if (!busy || aboutOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        loadCancelledRef.current = true
        setLoadPhase('Cancelling after current step…')
        setStatus('Cancelling after current step…')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, aboutOpen])

  useEffect(() => {
    if (!exportMenuOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      const root = exportDropdownRef.current
      if (root && !root.contains(e.target as Node)) {
        setExportMenuOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExportMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [exportMenuOpen])

  useEffect(() => {
    if (!snapViewMenuOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      const root = snapViewDropdownRef.current
      if (root && !root.contains(e.target as Node)) setSnapViewMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape') setSnapViewMenuOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [snapViewMenuOpen])

  useEffect(() => {
    if (!aboutOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAboutOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [aboutOpen])

  useEffect(() => {
    if (!shortcutsOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShortcutsOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [shortcutsOpen])

  /** Mesh decode + mesh state; does not toggle `busy` / overlay — callers do. */
  const performMeshLoad = useCallback(async (label: string, data: Uint8Array): Promise<void> => {
    const onProgress = (phase: string): void => {
      setLoadPhase(phase)
      setStatus(phase)
    }
    let loaded = await loadModelFromBuffer(label, data, onProgress, stepTessellationParams(stepTessPreset))
    if (loadCancelledRef.current) {
      setStatus('Load cancelled.')
      return
    }
    // Auto-orient non-3MF files so the flat base sits on the print bed, then snap so
    // the lowest vertex is exactly at Y=0.  3MF files are already correctly oriented
    // and positioned by the slicer (minY ≈ 0) and must not be rotated.
    const is3mf = label.toLowerCase().endsWith('.3mf')
    if (!is3mf && loaded.positions.length > 0) {
      const { mesh: oriented } = autoOrientMesh(loaded)
      loaded = snapMeshToBed(oriented)
    }
    setFocusedPlateId(null)
    setShowOpenEdges(false)
    setOpenEdgeResult(null)
    setMeasureMode(false)
    setMeasureResult(null)
    setMeshHistory([])
    setMeshFuture([])
    setAnnotations([])
    setAnnotationMode(false)
    setTurntable(false)
    setMaterialPreset('default')
    setMesh(loaded)
    setLoadAnimSeq((n) => n + 1)
    const short = label.split(/[/\\]/).pop() ?? label
    setFileLabel(short)
    setStatus(`Loaded ${short}`)
  }, [stepTessPreset])

  const loadFileFromBuffer = useCallback(async (label: string, data: Uint8Array, recentPath?: string) => {
    loadCancelledRef.current = false
    setBusy(true)
    setLoadPhase('Loading…')
    setStatus('Loading…')
    try {
      await performMeshLoad(label, data)
      if (!loadCancelledRef.current && recentPath) {
        void window.api.addRecentDocument(recentPath)
        void window.api.getRecentFiles().then(setRecentFiles).catch(() => {})
      }
      setFilePath(recentPath ?? null)
    } catch (e) {
      if (!loadCancelledRef.current) {
        const msg = e instanceof Error ? e.message : String(e)
        setStatus(`Error: ${msg}`)
      }
    } finally {
      setBusy(false)
      setLoadPhase(null)
    }
  }, [performMeshLoad])

  const loadFileFromPath = useCallback(
    async (path: string) => {
      loadCancelledRef.current = false
      setBusy(true)
      setLoadPhase('Reading file from disk…')
      setStatus('Reading file from disk…')
      try {
        const raw = await window.api.readFile(path)
        const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
        await performMeshLoad(path, data)
        if (!loadCancelledRef.current) {
          void window.api.addRecentDocument(path)
          void window.api.getRecentFiles().then(setRecentFiles).catch(() => {})
        }
        setFilePath(path)
      } catch (e) {
        if (!loadCancelledRef.current) {
          const msg = e instanceof Error ? e.message : String(e)
          setStatus(`Error: ${msg}`)
        }
      } finally {
        setBusy(false)
        setLoadPhase(null)
      }
    },
    [performMeshLoad]
  )

  /** Always load from the File object buffer — avoids Electron path quirks and matches “Open” behavior. */
  const loadDroppedFile = useCallback(
    async (file: File) => {
      if (!isSupportedModelFilename(file.name)) {
        setStatus('Unsupported file type. Supported: STL OBJ 3MF GLB GLTF AMF PLY FBX STEP/STP')
        return
      }
      try {
        const raw = await file.arrayBuffer()
        const diskPath = window.api.getPathForFile(file)
        const label = diskPath.length > 0 ? diskPath : file.name
        await loadFileFromBuffer(label, new Uint8Array(raw), diskPath.length > 0 ? diskPath : undefined)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setStatus(`Error: ${msg}`)
      }
    },
    [loadFileFromBuffer]
  )

  const openFile = useCallback(async () => {
    const path = await window.api.openFileDialog()
    if (!path) {
      setStatus('Open cancelled.')
      return
    }
    await loadFileFromPath(path)
  }, [loadFileFromPath])

  useEffect(() => {
    void (async () => {
      if (!startupOpenHandled.current) {
        startupOpenHandled.current = true
        // Show settings on first run (no slicer configured yet)
        const settings = await window.api.getSettings()
        if (!settings.firstRunDone) setSettingsOpen(true)
        const pending = await window.api.getPendingOpenFile()
        if (pending) await loadFileFromPath(pending)
      }
    })()
    const unsub = window.api.subscribeExternalFileOpen((path) => {
      void loadFileFromPath(path)
    })
    return unsub
  }, [loadFileFromPath])

  const closeModel = useCallback(() => {
    setMesh(null)
    setFileLabel(null)
    setFilePath(null)
    setExportMenuOpen(false)
    setViewMode('solid')
    setFocusedPlateId(null)
    setShowOpenEdges(false)
    setOpenEdgeResult(null)
    setMeasureMode(false)
    setMeasureResult(null)
    setMeshHistory([])
    setMeshFuture([])
    setAnnotations([])
    setAnnotationMode(false)
    setTurntable(false)
    setMaterialPreset('default')
    setStatus(idleStatusMessage)
  }, [])

  /** Clears the plate, then opens the file picker for the next model. */
  const openNewModel = useCallback(async () => {
    setMesh(null)
    setFileLabel(null)
    setFilePath(null)
    setFocusedPlateId(null)
    setExportMenuOpen(false)
    setViewMode('solid')
    setShowOpenEdges(false)
    setOpenEdgeResult(null)
    setMeasureMode(false)
    setMeasureResult(null)
    setMeshHistory([])
    setMeshFuture([])
    setAnnotations([])
    setAnnotationMode(false)
    setTurntable(false)
    setMaterialPreset('default')
    await openFile()
  }, [openFile])

  /** Apply a mesh transform: push current mesh to history, clear redo stack, set new mesh. */
  const applyMeshOp = useCallback((newMesh: TriangleMesh) => {
    const prev = meshRef.current
    if (prev) {
      setMeshHistory((h) => {
        const next = [...h, prev]
        return next.length > 10 ? next.slice(-10) : next
      })
    }
    setMeshFuture([])
    setMesh(newMesh)
  }, [])

  const undo = useCallback(() => {
    setMeshHistory((h) => {
      if (h.length === 0) return h
      const prev = h[h.length - 1]!
      const remaining = h.slice(0, -1)
      const curr = meshRef.current
      if (curr) setMeshFuture((f) => [...f, curr])
      setMesh(prev)
      setStatus('Undo.')
      return remaining
    })
  }, [])

  const redo = useCallback(() => {
    setMeshFuture((f) => {
      if (f.length === 0) return f
      const next = f[f.length - 1]!
      const remaining = f.slice(0, -1)
      const curr = meshRef.current
      if (curr) setMeshHistory((h) => {
        const nx = [...h, curr]
        return nx.length > 10 ? nx.slice(-10) : nx
      })
      setMesh(next)
      setStatus('Redo.')
      return remaining
    })
  }, [])

  const runRepair = useCallback(() => {
    if (!mesh) return
    const { mesh: fixed, report } = repairMesh(mesh)
    setFocusedPlateId(null)
    setShowOpenEdges(false)
    setOpenEdgeResult(null)
    setMeasureMode(false)
    setMeasureResult(null)
    applyMeshOp(fixed)
    setRepairReport([
      `Degenerate triangles removed: ${report.removedDegenerate.toLocaleString()}`,
      `Vertices: ${report.verticesBefore.toLocaleString()} → ${report.verticesAfter.toLocaleString()}`,
    ])
    setStatus(`Repaired — ${report.removedDegenerate} degenerate triangles removed.`)
  }, [mesh, applyMeshOp])

  const exportAs = useCallback(
    async (kind: 'stl' | 'obj' | '3mf') => {
      if (!mesh) return
      setExportMenuOpen(false)
      setBusy(true)
      try {
        const path = await window.api.saveFileDialog(kind)
        if (!path) {
          setStatus('Export cancelled.')
          return
        }
        let body: Uint8Array
        if (kind === 'stl') body = encodeBinaryStl(mesh)
        else if (kind === 'obj') body = new TextEncoder().encode(encodeObj(mesh))
        else body = await encodeThreeMf(mesh)
        await window.api.writeFile(path, body)
        setStatus(`Exported ${kind.toUpperCase()} to disk.`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setStatus(`Export error: ${msg}`)
      } finally {
        setBusy(false)
      }
    },
    [mesh]
  )

  const exportPlateAs = useCallback(
    async (kind: 'stl' | 'obj') => {
      if (!mesh || focusedPlateId === null) return
      const plateMesh = extractPlateMesh(mesh, focusedPlateId)
      if (!plateMesh) { setStatus(`No geometry for plate ${focusedPlateId}.`); return }
      setExportMenuOpen(false)
      setBusy(true)
      try {
        const path = await window.api.saveFileDialog(kind)
        if (!path) { setStatus('Export cancelled.'); return }
        let body: Uint8Array
        if (kind === 'stl') body = encodeBinaryStl(plateMesh)
        else body = new TextEncoder().encode(encodeObj(plateMesh, `plate_${focusedPlateId}`))
        await window.api.writeFile(path, body)
        setStatus(`Exported plate ${focusedPlateId} as ${kind.toUpperCase()}.`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setStatus(`Export error: ${msg}`)
      } finally {
        setBusy(false)
      }
    },
    [mesh, focusedPlateId]
  )

  const stepExportInfo = useCallback(() => {
    setExportMenuOpen(false)
    setStatus(
      'STEP export is not available for triangle meshes. STEP stores CAD topology, not print meshes. Use STL or 3MF for slicers; import STEP, then export to those formats.'
    )
  }, [])

  const resetView = useCallback(() => {
    setFocusedPlateId(null)
    viewerRef.current?.resetDefaultView()
  }, [])

  const snapView = useCallback((view: SnapView) => {
    setSnapViewMenuOpen(false)
    viewerRef.current?.snapCameraToView(view)
  }, [])

  const snapToBed = useCallback(() => {
    if (!mesh) return
    setShowOpenEdges(false); setOpenEdgeResult(null)
    setMeasureMode(false);   setMeasureResult(null)
    const snapped = snapMeshToBed(mesh)
    if (snapped === mesh) { setStatus('Model is already on the bed.'); return }
    applyMeshOp(snapped)
    setStatus('Snapped to bed.')
  }, [mesh, applyMeshOp])

  const rotateAroundBedY = useCallback(() => {
    if (!mesh) return
    setShowOpenEdges(false); setOpenEdgeResult(null)
    setMeasureMode(false);   setMeasureResult(null)
    applyMeshOp(rotateMeshQuarterTurnAroundY(mesh))
    setStatus('Rotated 90° around the bed (Y). Export uses this orientation.')
  }, [mesh, applyMeshOp])

  const rotateAroundX = useCallback(() => {
    if (!mesh) return
    setShowOpenEdges(false); setOpenEdgeResult(null)
    setMeasureMode(false);   setMeasureResult(null)
    applyMeshOp(rotateMeshQuarterTurnAroundX(mesh))
    setStatus('Rotated 90° around X. Export uses this orientation.')
  }, [mesh, applyMeshOp])

  const rotateAroundZ = useCallback(() => {
    if (!mesh) return
    setShowOpenEdges(false); setOpenEdgeResult(null)
    setMeasureMode(false);   setMeasureResult(null)
    applyMeshOp(rotateMeshQuarterTurnAroundZ(mesh))
    setStatus('Rotated 90° around Z. Export uses this orientation.')
  }, [mesh, applyMeshOp])

  const mirrorX = useCallback(() => {
    if (!mesh) return
    applyMeshOp(mirrorMesh(mesh, 'x'))
    setStatus('Mirrored on X axis.')
  }, [mesh, applyMeshOp])

  const mirrorY = useCallback(() => {
    if (!mesh) return
    applyMeshOp(mirrorMesh(mesh, 'y'))
    setStatus('Mirrored on Y axis.')
  }, [mesh, applyMeshOp])

  const mirrorZ = useCallback(() => {
    if (!mesh) return
    applyMeshOp(mirrorMesh(mesh, 'z'))
    setStatus('Mirrored on Z axis.')
  }, [mesh, applyMeshOp])

  const centerOnBed = useCallback(() => {
    if (!mesh) return
    const centered = centerMeshOnBed(mesh)
    if (centered === mesh) { setStatus('Already centred on bed.'); return }
    applyMeshOp(centered)
    setStatus('Centred on bed.')
  }, [mesh, applyMeshOp])

  const cyclePlate = useCallback((dir: 1 | -1) => {
    if (!mesh?.plateParts || mesh.plateParts.length === 0) return
    const ids = [...new Set(mesh.plateParts.map((p) => p.plateId))].sort((a, b) => a - b)
    if (ids.length < 2) return
    const curIdx = focusedPlateId !== null ? ids.indexOf(focusedPlateId) : -1
    const nextIdx = ((curIdx + dir) + ids.length) % ids.length
    const nextId = ids[nextIdx]!
    viewerRef.current?.focusCameraOnPlate(nextId)
    setFocusedPlateId(nextId)
    setStatus(`Plate ${nextId}`)
  }, [mesh, focusedPlateId])

  const openInSlicer = useCallback(async () => {
    if (!filePath) return
    const err = await window.api.openPath(filePath)
    if (!err) {
      setStatus(`Opened in slicer: ${filePath.split(/[/\\]/).pop()}`)
    } else if (err === 'no-slicer') {
      setSettingsOpen(true)
    } else if (err !== 'cancelled') {
      setStatus(`Could not open in slicer: ${err}`)
    }
  }, [filePath])

  const toggleOpenEdges = useCallback(() => {
    if (!mesh) return
    if (showOpenEdges) {
      setShowOpenEdges(false)
      setOpenEdgeResult(null)
      return
    }
    const result = findOpenEdges(mesh)
    setOpenEdgeResult(result)
    setShowOpenEdges(true)
    setStatus(
      result.count === 0
        ? 'No open edges found — mesh appears watertight.'
        : `Found ${result.count.toLocaleString()} open edge${result.count === 1 ? '' : 's'} (shown in orange).`
    )
  }, [mesh, showOpenEdges])

  const handleMeasureResult = useCallback(
    (distanceMm: number, ptA: [number, number, number], ptB: [number, number, number]) => {
      setMeasureResult({ distanceMm, ptA, ptB })
      setStatus(`Distance: ${distanceMm.toFixed(2)} mm`)
    },
    []
  )

  const toggleMeasureMode = useCallback(() => {
    setMeasureMode((m) => {
      if (!m) {
        setMeasureResult(null)
        setStatus('Measure: click two points on the model surface.')
      } else {
        setMeasureResult(null)
        setStatus('Measure mode off.')
      }
      return !m
    })
  }, [])

  const runAutoOrient = useCallback(() => {
    if (!mesh) return
    setShowOpenEdges(false); setOpenEdgeResult(null)
    setMeasureMode(false);   setMeasureResult(null)
    const { mesh: oriented, bestIdx } = autoOrientMesh(mesh)
    if (bestIdx === 0) { setStatus('Auto-orient: already in optimal orientation.'); return }
    applyMeshOp(snapMeshToBed(oriented))
    const labels = ['identity', 'X+90°', 'X+180°', 'X-90°', 'Z+90°', 'Z-90°']
    setStatus(`Auto-orient: applied ${labels[bestIdx] ?? 'rotation'} to minimise overhangs.`)
  }, [mesh, applyMeshOp])

  const batchExportPlates = useCallback(async () => {
    if (!mesh?.plateParts || mesh.plateParts.length === 0) return
    setExportMenuOpen(false)
    setBusy(true)
    try {
      const path = await window.api.saveFileDialog('stl')
      if (!path) { setStatus('Batch export cancelled.'); return }
      const basePath = path.replace(/\.[^.]+$/, '')
      let exported = 0
      for (const part of mesh.plateParts) {
        const platePath = `${basePath}_plate${part.plateId}.stl`
        const body = encodeBinaryStl(part.mesh)
        await window.api.writeFile(platePath, body)
        exported++
      }
      setStatus(`Batch export done: ${exported} plate${exported === 1 ? '' : 's'} saved as STL.`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus(`Batch export error: ${msg}`)
    } finally {
      setBusy(false)
    }
  }, [mesh])

  const handleAnnotationPlace = useCallback((pos: [number, number, number]) => {
    setPendingAnnotationPos(pos)
    setPendingAnnotationText('')
  }, [])

  const toggleSection = useCallback((id: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const applyScale = useCallback(() => {
    if (!mesh || !meshAnalysis) return
    const target = parseFloat(scaleInput)
    if (!Number.isFinite(target) || target <= 0) {
      setStatus('Enter a positive number (mm) to scale to.')
      return
    }
    const [dx, dy, dz] = meshAnalysis.bounds.size
    let current: number
    if      (scaleAxis === 'x') current = dx
    else if (scaleAxis === 'y') current = dy
    else if (scaleAxis === 'z') current = dz
    else current = Math.max(dx, dy, dz)
    if (!Number.isFinite(current) || current <= 0) { setStatus('Cannot compute current size.'); return }
    const factor = target / current
    applyMeshOp(scaleMesh(mesh, factor))
    setStatus(`Scaled ×${factor.toFixed(4)} → ${target} mm${scaleAxis !== 'uniform' ? ` (${scaleAxis.toUpperCase()})` : ''}.`)
  }, [mesh, meshAnalysis, scaleInput, scaleAxis, applyMeshOp])

  const saveScreenshot = useCallback(async () => {
    if (!mesh) return
    const dataUrl = viewerRef.current?.captureScreenshot()
    if (!dataUrl) {
      setStatus('Could not capture screenshot — try again after the model finishes loading.')
      return
    }
    const bytes = dataUrlToPngBytes(dataUrl)
    if (!bytes) {
      setStatus('Could not read screenshot data.')
      return
    }
    try {
      const path = await window.api.saveFileDialog('png')
      if (!path) {
        setStatus('Screenshot save cancelled.')
        return
      }
      await window.api.writeFile(path, bytes)
      const short = path.split(/[/\\]/).pop() ?? path
      setStatus(`Saved screenshot: ${short}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus(`Screenshot error: ${msg}`)
    }
  }, [mesh])

  // Placed after all useCallback declarations to avoid temporal dead zone errors.
  useEffect(() => {
    const anyModalOpen = aboutOpen || shortcutsOpen || exportMenuOpen || cmdPaletteOpen
    const onKey = (e: KeyboardEvent): void => {
      // Ctrl/Cmd combos: handled before modal/busy guards (some work even with modals)
      if (!busy && (e.ctrlKey || e.metaKey)) {
        if (e.key === 'k') { e.preventDefault(); if (!anyModalOpen) setCmdPaletteOpen(true); return }
        if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); if (!anyModalOpen) undo(); return }
        if (e.key === 'z' && e.shiftKey)  { e.preventDefault(); if (!anyModalOpen) redo(); return }
        if (e.key === 'y')                { e.preventDefault(); if (!anyModalOpen) redo(); return }
      }
      if (busy || anyModalOpen) return
      const tag = (e.target as HTMLElement | null)?.tagName ?? ''
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      switch (e.key) {
        case '?': setShortcutsOpen(true); break
        case 'o': case 'O': void openFile(); break
        case 'w': case 'W': if (mesh) setViewMode('wireframe'); break
        case 's': case 'S': if (mesh) setViewMode('solid'); break
        case 'l': case 'L': if (mesh) setViewMode('xray'); break
        case 'r': case 'R': if (mesh) resetView(); break
        case 'p': case 'P': if (mesh) void saveScreenshot(); break
        case '1': if (mesh) snapView('front');  break
        case '2': if (mesh) snapView('back');   break
        case '3': if (mesh) snapView('left');   break
        case '4': if (mesh) snapView('right');  break
        case '5': if (mesh) snapView('top');    break
        case '6': if (mesh) snapView('bottom'); break
        case 'm': case 'M': if (mesh) toggleMeasureMode(); break
        case 'e': case 'E': if (mesh) toggleOpenEdges(); break
        case 'f': case 'F': if (mesh) setViewMode((v) => v === 'faceOrient' ? 'solid' : 'faceOrient'); break
        case 'h': case 'H': if (mesh) setViewMode((v) => v === 'overhang' ? 'solid' : 'overhang'); break
        case 't': case 'T': if (mesh) setTurntable((v) => !v); break
        case '[': if (mesh) cyclePlate(-1); break
        case ']': if (mesh) cyclePlate(1);  break
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, aboutOpen, shortcutsOpen, exportMenuOpen, cmdPaletteOpen, mesh, openFile, resetView, saveScreenshot, snapView, toggleMeasureMode, toggleOpenEdges, undo, redo, cyclePlate])

  const commands = useMemo<Command[]>(() => [
    { id: 'open',        label: 'Open model…',                  run: () => void openFile() },
    { id: 'close',       label: 'Close model',                  run: closeModel,                    disabled: !mesh },
    { id: 'new',         label: 'New model…',                   run: () => void openNewModel(),     disabled: !mesh },
    { id: 'undo',        label: `Undo${meshHistory.length ? ` (${meshHistory.length})` : ''}`, run: undo, disabled: meshHistory.length === 0 },
    { id: 'redo',        label: `Redo${meshFuture.length ? ` (${meshFuture.length})` : ''}`,  run: redo, disabled: meshFuture.length === 0 },
    { id: 'repair',      label: 'Repair mesh',                  description: 'Remove degenerate triangles and weld vertices', run: runRepair,       disabled: !mesh },
    { id: 'snap-bed',    label: 'Snap to bed',                  description: 'Move lowest vertex to Y=0',                    run: snapToBed,       disabled: !mesh },
    { id: 'auto-orient', label: 'Auto-orient',                  description: 'Rotate to minimise overhang triangles',        run: runAutoOrient,   disabled: !mesh },
    { id: 'rotate-y',    label: 'Rotate 90° Y',                 run: rotateAroundBedY,  disabled: !mesh },
    { id: 'rotate-x',    label: 'Rotate 90° X',                 run: rotateAroundX,     disabled: !mesh },
    { id: 'rotate-z',    label: 'Rotate 90° Z',                 run: rotateAroundZ,     disabled: !mesh },
    { id: 'mirror-x',    label: 'Mirror X',                     description: 'Flip model on X axis', run: mirrorX, disabled: !mesh },
    { id: 'mirror-y',    label: 'Mirror Y',                     description: 'Flip model on Y axis', run: mirrorY, disabled: !mesh },
    { id: 'mirror-z',    label: 'Mirror Z',                     description: 'Flip model on Z axis', run: mirrorZ, disabled: !mesh },
    { id: 'center-bed',  label: 'Centre on bed',                description: 'Move model XZ centre to bed origin', run: centerOnBed, disabled: !mesh },
    { id: 'plate-prev',  label: 'Previous plate ([)',           run: () => cyclePlate(-1), disabled: !mesh?.plateParts?.length },
    { id: 'plate-next',  label: 'Next plate (])',               run: () => cyclePlate(1),  disabled: !mesh?.plateParts?.length },
    { id: 'view-solid',  label: 'View: Solid (S)',               run: () => setViewMode('solid'),       disabled: !mesh },
    { id: 'view-wire',   label: 'View: Wireframe (W)',           run: () => setViewMode('wireframe'),   disabled: !mesh },
    { id: 'view-xray',   label: 'View: Look-through (L)',        run: () => setViewMode('xray'),        disabled: !mesh },
    { id: 'view-face',   label: 'View: Face orientation (F)',    run: () => setViewMode('faceOrient'),  disabled: !mesh },
    { id: 'view-ohang',  label: 'View: Overhang heat map (H)',   run: () => setViewMode('overhang'),    disabled: !mesh },
    { id: 'mat-default', label: 'Material: Default',            run: () => setMaterialPreset('default'), disabled: !mesh },
    { id: 'mat-silk',    label: 'Material: Silk (glossy)',       run: () => setMaterialPreset('silk'),    disabled: !mesh },
    { id: 'mat-matte',   label: 'Material: Matte (flat)',        run: () => setMaterialPreset('matte'),   disabled: !mesh },
    { id: 'mat-metal',   label: 'Material: Metallic',            run: () => setMaterialPreset('metal'),   disabled: !mesh },
    { id: 'turntable',   label: turntable ? 'Turntable: Stop (T)' : 'Turntable: Start (T)', run: () => setTurntable((v) => !v), disabled: !mesh },
    { id: 'annotate',    label: annotationMode ? 'Annotations: Stop placing' : 'Annotations: Place mode', run: () => setAnnotationMode((v) => !v), disabled: !mesh },
    { id: 'clear-ann',   label: 'Clear all annotations',        run: () => { setAnnotations([]); setStatus('Annotations cleared.') }, disabled: annotations.length === 0 },
    { id: 'screenshot',  label: 'Save screenshot (P)',           run: () => void saveScreenshot(),    disabled: !mesh },
    { id: 'open-edges',  label: showOpenEdges ? 'Open edges: Hide (E)' : 'Open edges: Show (E)', run: toggleOpenEdges, disabled: !mesh },
    { id: 'measure',     label: measureMode ? 'Measure mode: Off (M)' : 'Measure mode: On (M)', run: toggleMeasureMode, disabled: !mesh },
    { id: 'reset-view',  label: 'Reset camera (R)',              run: resetView,                      disabled: !mesh },
    { id: 'open-slicer', label: 'Open in slicer',               run: () => void openInSlicer(),      disabled: !filePath },
    { id: 'export-stl',  label: 'Export STL',                   run: () => void exportAs('stl'),     disabled: !mesh },
    { id: 'export-obj',  label: 'Export OBJ',                   run: () => void exportAs('obj'),     disabled: !mesh },
    { id: 'export-3mf',  label: 'Export 3MF',                   run: () => void exportAs('3mf'),     disabled: !mesh },
    { id: 'batch-export',label: 'Batch export all plates as STL', run: () => void batchExportPlates(), disabled: !mesh?.plateParts || mesh.plateParts.length < 2 },
    { id: 'shortcuts',   label: 'Keyboard shortcuts (?)',         run: () => setShortcutsOpen(true) },
    { id: 'settings',    label: 'Settings (⚙)',                   run: () => setSettingsOpen(true) },
    { id: 'dimensions',  label: showDimensions ? 'Dimensions: Hide' : 'Dimensions: Show', run: () => setShowDimensions((v) => !v), disabled: !mesh },
    { id: 'normals',     label: showNormals ? 'Normals: Hide'    : 'Normals: Show',       run: () => setShowNormals((v) => !v),    disabled: !mesh },
  ], [mesh, meshHistory.length, meshFuture.length, turntable, annotationMode, annotations.length, measureMode, showOpenEdges, showDimensions, showNormals, filePath,
      openFile, closeModel, openNewModel, undo, redo, runRepair, snapToBed, runAutoOrient,
      rotateAroundBedY, rotateAroundX, rotateAroundZ, mirrorX, mirrorY, mirrorZ, centerOnBed, cyclePlate,
      saveScreenshot, toggleOpenEdges, toggleMeasureMode, resetView, openInSlicer, exportAs, batchExportPlates])

  return (
    <div
      className={`app${viewerDragActive ? ' file-drag' : ''}`}
      data-theme={theme}
      onDragEnter={(e) => {
        if (e.dataTransfer.types?.includes('Files')) {
          e.preventDefault()
          setViewerDragActive(true)
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types?.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null
        if (next && e.currentTarget.contains(next)) return
        setViewerDragActive(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setViewerDragActive(false)
        const f = e.dataTransfer.files?.[0]
        if (f) void loadDroppedFile(f)
      }}
    >
      <header className="toolbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <button
              type="button"
              className="brand-name-btn"
              onClick={() => setAboutOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={aboutOpen}
            >
              Model Forge
            </button>
          </div>
        </div>
        <div className="toolbar-actions">
          {/* ── File ── */}
          <button type="button" className="btn primary" onClick={() => void openFile()} disabled={busy}>
            Open model…
          </button>
          {mesh ? (
            <>
              <button type="button" className="btn" onClick={closeModel} disabled={busy}>
                Close model
              </button>
              <button type="button" className="btn" onClick={() => void openNewModel()} disabled={busy}>
                New model…
              </button>
            </>
          ) : null}

          <div className="toolbar-sep" aria-hidden />

          {/* ── View / Scene / Cam ── */}
          <div className="seg">
            <span className="seg-label">View</span>
            {(['solid', 'wireframe', 'xray', 'faceOrient', 'overhang'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={viewMode === m ? 'btn active' : 'btn'}
                onClick={() => setViewMode(m)}
                disabled={!mesh}
                title={
                  !mesh ? 'Open a model first'
                  : m === 'faceOrient' ? 'Colour front faces blue and back faces red — spot inverted normals (F)'
                  : m === 'overhang'   ? 'Heat-map faces by overhang angle: green ≤ 45° / yellow / red > 45° (H)'
                  : undefined
                }
              >
                {m === 'solid' ? 'Solid' : m === 'wireframe' ? 'Wireframe' : m === 'xray' ? 'Look-through' : m === 'faceOrient' ? 'Face orient' : 'Overhang'}
              </button>
            ))}
          </div>
          <div className="seg">
            <span className="seg-label">Scene</span>
            <button type="button" className="btn" onClick={resetView} disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Restore default camera angle and zoom (R)'}>
              Reset view
            </button>
            <div className={`dropdown${snapViewMenuOpen ? ' open' : ''}`} ref={snapViewDropdownRef}>
              <button
                type="button"
                className="btn"
                disabled={!mesh || busy}
                aria-expanded={snapViewMenuOpen}
                aria-haspopup="menu"
                title={!mesh ? 'Open a model first' : 'Snap to a standard orthographic view (keys 1–6)'}
                onClick={() => setSnapViewMenuOpen((o) => !o)}
              >
                Views ▾
              </button>
              <div className="dropdown-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => snapView('front')}>Front (1)</button>
                <button type="button" role="menuitem" onClick={() => snapView('back')}>Back (2)</button>
                <button type="button" role="menuitem" onClick={() => snapView('left')}>Left (3)</button>
                <button type="button" role="menuitem" onClick={() => snapView('right')}>Right (4)</button>
                <button type="button" role="menuitem" onClick={() => snapView('top')}>Top (5)</button>
                <button type="button" role="menuitem" onClick={() => snapView('bottom')}>Bottom (6)</button>
              </div>
            </div>
            {showPlateOverviewControls && focusedPlateId !== null ? (
              <button
                type="button"
                className="btn"
                onClick={resetView}
                disabled={!mesh || busy}
                title="Return to the full multi-plate layout (clears plate focus)"
              >
                All plates
              </button>
            ) : null}
            <button type="button" className="btn" onClick={rotateAroundBedY} disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Rotate 90° around Y (bed vertical axis)'}>
              ↻Y
            </button>
            <button type="button" className="btn" onClick={rotateAroundX} disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Rotate 90° around X (tip forward/back)'}>
              ↻X
            </button>
            <button type="button" className="btn" onClick={rotateAroundZ} disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Rotate 90° around Z (roll left/right)'}>
              ↻Z
            </button>
            <button type="button" className="btn" onClick={snapToBed} disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Translate the mesh so its lowest vertex sits exactly on the build plate (Y = 0)'}>
              Snap to bed
            </button>
            <button type="button" className="btn" onClick={centerOnBed} disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Move the model so its XZ centre is at the bed origin'}>
              Centre
            </button>
            <button type="button" className="btn" onClick={mirrorX} disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Mirror on X axis (left ↔ right)'}>
              ⇔X
            </button>
            <button type="button" className="btn" onClick={mirrorY} disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Mirror on Y axis (flip upside down)'}>
              ⇔Y
            </button>
            <button type="button" className="btn" onClick={mirrorZ} disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Mirror on Z axis (front ↔ back)'}>
              ⇔Z
            </button>
            <button type="button" className="btn" onClick={runAutoOrient} disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Try 6 face-down orientations and pick the one with the fewest overhang triangles'}>
              Auto-orient
            </button>
            <button
              type="button"
              className={turntable ? 'btn active' : 'btn'}
              onClick={() => setTurntable((v) => !v)}
              disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Auto-rotate the model in the viewer (T)'}
            >
              Turntable
            </button>
          </div>
          <div className="seg">
            <span className="seg-label">Cam</span>
            <button
              type="button"
              className={cameraPreset === 'quick' ? 'btn active' : 'btn'}
              onClick={() => setCameraPreset('quick')}
              disabled={busy}
              title="Faster wheel zoom and right-drag pan (saved for next launch)"
            >
              Quick
            </button>
            <button
              type="button"
              className={cameraPreset === 'default' ? 'btn active' : 'btn'}
              onClick={() => setCameraPreset('default')}
              disabled={busy}
              title="Moderate zoom and pan speed (saved for next launch)"
            >
              Default
            </button>
          </div>

          <div className="toolbar-sep" aria-hidden />

          {/* ── Tools ── */}
          <button type="button" className="btn" onClick={runRepair} disabled={!mesh || busy}
            title={!mesh ? 'Open a model first' : 'Remove degenerate triangles and de-duplicate vertices'}>
            Repair mesh
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void saveScreenshot()}
            disabled={!mesh || busy}
            title={!mesh ? 'Open a model first' : 'Save the current view as a PNG image (P)'}
          >
            Screenshot…
          </button>
          <button
            type="button"
            className={showOpenEdges ? 'btn active' : 'btn'}
            onClick={toggleOpenEdges}
            disabled={!mesh || busy}
            title={!mesh ? 'Open a model first' : 'Highlight open (boundary) edges in orange — shows where the mesh is not watertight'}
          >
            Open edges
          </button>
          <button
            type="button"
            className={measureMode ? 'btn active' : 'btn'}
            onClick={toggleMeasureMode}
            disabled={!mesh || busy}
            title={!mesh ? 'Open a model first' : 'Click two points on the model to measure distance in mm'}
          >
            Measure
          </button>
          {filePath ? (
            <button
              type="button"
              className="btn"
              onClick={() => void openInSlicer()}
              disabled={busy}
              title={`Open the source file in the OS default application for this format\n${filePath}\n\nNote: reflects the original file, not any in-app transforms. Export first if needed.`}
            >
              Open in slicer
            </button>
          ) : null}

          {hasSubObjects ? (
            <button
              type="button"
              className={explodedView ? 'btn active' : 'btn'}
              onClick={() => setExplodedView((v) => !v)}
              disabled={busy}
              title="Fan sub-objects outward to inspect a multi-body model"
            >
              Explode
            </button>
          ) : null}
          <button
            type="button"
            className={annotationMode ? 'btn active' : 'btn'}
            onClick={() => setAnnotationMode((v) => !v)}
            disabled={!mesh || busy}
            title={!mesh ? 'Open a model first' : 'Click the model surface to place text annotation pins'}
          >
            Annotate
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={undo}
            disabled={meshHistory.length === 0 || busy}
            title={meshHistory.length === 0 ? 'Nothing to undo' : `Undo (Ctrl+Z) — ${meshHistory.length} step${meshHistory.length === 1 ? '' : 's'}`}
            aria-label="Undo"
          >
            ⟲
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={redo}
            disabled={meshFuture.length === 0 || busy}
            title={meshFuture.length === 0 ? 'Nothing to redo' : `Redo (Ctrl+Y) — ${meshFuture.length} step${meshFuture.length === 1 ? '' : 's'}`}
            aria-label="Redo"
          >
            ⟳
          </button>

          <div className="toolbar-sep" aria-hidden />

          {/* ── Help / Settings / Export ── */}
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setSidebarVisible((v) => !v)}
            title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
            aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          >
            {sidebarVisible ? '▶' : '◀'}
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? '☀' : '🌙'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setSettingsOpen(true)}
            title="App settings (slicer path, preferences)"
            aria-label="Settings"
          >
            ⚙
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setShortcutsOpen(true)}
            title="Show keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            ?
          </button>
          <div className={`dropdown${exportMenuOpen ? ' open' : ''}`} ref={exportDropdownRef}>
            <button
              type="button"
              className="btn"
              disabled={!mesh || busy}
              aria-expanded={exportMenuOpen}
              aria-haspopup="menu"
              title={!mesh ? 'Open a model first' : 'Export the model to a different format'}
              onClick={() => setExportMenuOpen((o) => !o)}
            >
              Export ▾
            </button>
            <div className="dropdown-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void exportAs('stl')}>
                STL (binary)
              </button>
              <button type="button" role="menuitem" onClick={() => void exportAs('obj')}>
                OBJ{mesh?.vertexColors?.length ? ' + vertex colours' : ''}
              </button>
              <button type="button" role="menuitem" onClick={() => void exportAs('3mf')}>
                3MF
              </button>
              <button type="button" role="menuitem" className="muted" onClick={stepExportInfo}>
                STEP (info)
              </button>
              {mesh?.plateParts && mesh.plateParts.length >= 2 ? (
                <>
                  <div className="dropdown-divider" role="separator" aria-hidden />
                  <button type="button" role="menuitem" onClick={() => void batchExportPlates()}>
                    All plates — STL (batch)
                  </button>
                </>
              ) : null}
              {focusedPlateId !== null && mesh?.plateParts?.some((p) => p.plateId === focusedPlateId) ? (
                <>
                  <div className="dropdown-divider" role="separator" aria-hidden />
                  <button type="button" role="menuitem" onClick={() => void exportPlateAs('stl')}>
                    Plate {focusedPlateId} — STL
                  </button>
                  <button type="button" role="menuitem" onClick={() => void exportPlateAs('obj')}>
                    Plate {focusedPlateId} — OBJ
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </header>
      <main className={`main${sidebarVisible ? '' : ' sidebar-hidden'}`}>
        <div className="viewer-wrap">
          <R3FViewer
            ref={viewerRef}
            mesh={mesh}
            viewMode={viewMode}
            loadAnimSeq={loadAnimSeq}
            cameraPreset={cameraPreset}
            openEdgeLinePositions={showOpenEdges ? openEdgeResult?.linePositions ?? null : null}
            measureMode={measureMode}
            onMeasureResult={handleMeasureResult}
            clipY={clipY}
            showCoM={showCoM}
            showDimensions={showDimensions}
            showNormals={showNormals}
            explodedView={explodedView}
            turntable={turntable}
            materialPreset={materialPreset}
            annotationMode={annotationMode}
            annotations={annotations}
            onAnnotationPlace={handleAnnotationPlace}
          />

          {/* ── Stats chip ─────────────────────────────────────────────── */}
          {mesh && stats ? (
            <div className="viewport-stats">
              {fileLabel ? <span className="vs-name">{fileLabel}</span> : null}
              {fileLabel ? <span className="vs-sep" aria-hidden /> : null}
              <span className="vs-chip">{stats.triangles} tri</span>
              {mesh.packageMeta?.plateCount != null && mesh.packageMeta.plateCount > 1 ? (
                <span className="vs-chip">{mesh.packageMeta.plateCount} plates</span>
              ) : null}
              {mesh.packageMeta?.processHints?.estimatedPrintTime ? (
                <span className="vs-chip">⏱ {mesh.packageMeta.processHints.estimatedPrintTime}</span>
              ) : null}
              {mesh.packageMeta?.processHints?.estimatedModelWeight ? (
                <span className="vs-chip">{mesh.packageMeta.processHints.estimatedModelWeight}</span>
              ) : null}
            </div>
          ) : null}

          {/* ── Explode HUD label ──────────────────────────────────────── */}
          {explodedView ? <div className="explode-hud">Exploded view</div> : null}


          {!mesh && (
            <div className="empty-overlay">
              <div className="empty-drop-zone">
                <span className="empty-icon" aria-hidden>⬡</span>
                <h1>Drop a model or click Open</h1>
                <p className="hint">
                  STL · OBJ · 3MF · GLB/GLTF · AMF · PLY · FBX · STEP/STP<br />
                  Orbit: left drag · Zoom: wheel · Pan: right drag
                </p>
              </div>
            </div>
          )}
        </div>
        <aside className="side">
          {/* ── Current file — always visible ─────────────────────────────── */}
          <section>
            <h2>Current file</h2>
            <p className="mono">{fileLabel ?? '—'}</p>
          </section>

          {/* ── Recent files — collapsible ────────────────────────────────── */}
          {recentFiles.length > 0 ? (
            <section>
              <div className="recent-files-header">
                <h2
                  className="section-h"
                  role="button"
                  tabIndex={0}
                  aria-expanded={!collapsedSections.has('recent')}
                  onClick={() => toggleSection('recent')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('recent') } }}
                >
                  Recent files
                  <span className="section-chevron" aria-hidden>{collapsedSections.has('recent') ? '▸' : '▾'}</span>
                </h2>
                {!collapsedSections.has('recent') ? (
                  <button
                    type="button"
                    className="recent-files-clear-btn"
                    title="Clear recent files"
                    onClick={() => { void window.api.clearRecentFiles().then(() => setRecentFiles([])) }}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
              {!collapsedSections.has('recent') ? (
                <ul className="recent-files-list">
                  {recentFiles.slice(0, 5).map((f) => (
                    <li key={f.path}>
                      <button
                        type="button"
                        className={`recent-file-btn${f.path === filePath ? ' recent-file-btn--active' : ''}`}
                        disabled={busy}
                        title={f.path}
                        onClick={() => void loadFileFromPath(f.path)}
                      >
                        <span className="recent-file-badge">{fileExtBadge(f.name)}</span>
                        <span className="recent-file-name">{f.name}</span>
                        <span className="recent-file-time">{formatTimestamp(f.timestamp)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {/* ── Mesh — collapsible ────────────────────────────────────────── */}
          {stats ? (
            <section>
              <h2
                className="section-h"
                role="button"
                tabIndex={0}
                aria-expanded={!collapsedSections.has('mesh')}
                onClick={() => toggleSection('mesh')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('mesh') } }}
              >
                Mesh
                <span className="section-chevron" aria-hidden>{collapsedSections.has('mesh') ? '▸' : '▾'}</span>
              </h2>
              {!collapsedSections.has('mesh') ? (
                <>
                  <p className="side-line"><span className="side-k">Vertices</span> <span className="side-v mono">{stats.vertices}</span></p>
                  <p className="side-line"><span className="side-k">Triangles</span> <span className="side-v mono">{stats.triangles}</span></p>
                  <p className="side-line"><span className="side-k">Bounds (X×Y×Z)</span> <span className="side-v mono">{stats.bounds}</span></p>
                  {repairReport ? (
                    <div className="repair-card">
                      {repairReport.map((r, i) => {
                        const [label, val] = r.split(': ')
                        return (
                          <div key={i} className="repair-card-row">
                            <span>{label}</span><span>{val}</span>
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}

          {/* ── Slicer package (3MF) — collapsible ───────────────────────── */}
          {mesh?.packageMeta ? (
            <section>
              <h2
                className="section-h"
                role="button"
                tabIndex={0}
                aria-expanded={!collapsedSections.has('pkg')}
                onClick={() => toggleSection('pkg')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('pkg') } }}
              >
                Slicer package (3MF)
                <span className="section-chevron" aria-hidden>{collapsedSections.has('pkg') ? '▸' : '▾'}</span>
              </h2>
              {!collapsedSections.has('pkg') ? (
                <>
                  {mesh.packageMeta.projectName ? (
                    <p className="side-line">
                      <span className="side-k">Project</span>{' '}
                      <span className="side-v proj-meta">{mesh.packageMeta.projectName}</span>
                    </p>
                  ) : null}
                  {mesh.packageMeta.designer ? (
                    <p className="side-line">
                      <span className="side-k">Designer</span> <span className="side-v">{mesh.packageMeta.designer}</span>
                    </p>
                  ) : null}
                  {mesh.packageMeta.bedType ? (
                    <p className="side-line">
                      <span className="side-k">Bed type</span> <span className="side-v">{mesh.packageMeta.bedType}</span>
                    </p>
                  ) : null}
                  {mesh.packageMeta.printerModelId ? (
                    <p className="side-line">
                      <span className="side-k">Printer / preset</span>{' '}
                      <span className="side-v mono">{mesh.packageMeta.printerModelId}</span>
                    </p>
                  ) : null}
                  {mesh.packageMeta.bedWidthMm !== undefined && mesh.packageMeta.bedDepthMm !== undefined ? (
                    <p className="side-line">
                      <span className="side-k">Printable bed</span>{' '}
                      <span className="side-v">
                        {mesh.packageMeta.bedWidthMm} × {mesh.packageMeta.bedDepthMm} mm
                      </span>
                    </p>
                  ) : null}
                  <p className="side-line">
                    <span className="side-k">Plates</span> <span className="side-v">{mesh.packageMeta.plateCount}</span>
                  </p>
                  {mesh.packageMeta.plateIds.length > 0 ? (
                    <p className="side-note mono">Plate ids: {mesh.packageMeta.plateIds.join(', ')}</p>
                  ) : null}
                  <p className="side-line">
                    <span className="side-k">Filament slots</span>{' '}
                    <span className="side-v">{mesh.packageMeta.filamentCount}</span>
                  </p>
                  {mesh.packageMeta.plateThumbnailDataUrls?.length ? (
                    <div className="plate-thumbs" aria-label="Plate preview thumbnails">
                      {mesh.packageMeta.plateThumbnailDataUrls.map((url, i) => {
                        const plateId = mesh.packageMeta?.plateIds?.[i]
                        const canFocus = plateId !== undefined && mesh.plateParts && mesh.plateParts.length > 0
                        return url ? (
                          <button
                            key={i}
                            type="button"
                            className={`plate-thumb-btn${plateId === focusedPlateId ? ' plate-thumb-btn--focused' : ''}`}
                            disabled={!canFocus}
                            title={plateId !== undefined ? `Plate ${plateId}` : undefined}
                            onClick={() => {
                              if (canFocus && plateId !== undefined) {
                                viewerRef.current?.focusCameraOnPlate(plateId)
                                setFocusedPlateId(plateId)
                              }
                            }}
                          >
                            <img src={url} alt={`Plate ${plateId ?? i + 1} preview`} className="plate-thumb-img" />
                            {plateId !== undefined ? <span className="plate-thumb-label">Plate {plateId}</span> : null}
                          </button>
                        ) : null
                      })}
                    </div>
                  ) : null}
                  <div className="filament-swatches" aria-label="Filament colours from package">
                    {mesh.packageMeta.filamentColorsHex.map((h, i) => (
                      <button
                        key={i}
                        type="button"
                        className="filament-swatch"
                        title={`Slot ${i + 1}: ${mesh.packageMeta?.filamentTypes?.[i] ?? ''} ${h} — click to copy`.trim()}
                        onClick={() => {
                          void navigator.clipboard.writeText(h).then(() => {
                            setSwatchCopied(i)
                            setTimeout(() => setSwatchCopied((c) => (c === i ? null : c)), 1400)
                          })
                        }}
                      >
                        <span className="filament-swatch-dot" style={{ backgroundColor: h }} aria-hidden />
                        <span className="filament-swatch-label">T{i + 1}</span>
                        {swatchCopied === i ? <span className="swatch-copied-badge" aria-hidden>✓</span> : null}
                      </button>
                    ))}
                  </div>
                  {mesh.packageMeta.filamentTypes?.length ? (
                    <p className="side-note mono fil-type-line">{mesh.packageMeta.filamentTypes.join(' · ')}</p>
                  ) : null}
                  {mesh.packageMeta.buildObjects && mesh.packageMeta.buildObjects.length > 0 ? (
                    <ThreeMfBuildObjectsList
                      objects={mesh.packageMeta.buildObjects}
                      focusedPlateId={focusedPlateId}
                      onSelectPlate={
                        mesh.plateParts &&
                        mesh.plateParts.length > 0 &&
                        (mesh.packageMeta.plateIds?.length ?? 0) > 1
                          ? (plateId) => {
                              viewerRef.current?.focusCameraOnPlate(plateId)
                              setFocusedPlateId(plateId)
                            }
                          : undefined
                      }
                    />
                  ) : null}
                  {mesh.packageMeta.processHints ? (
                    <ThreeMfProcessSnapshot hints={mesh.packageMeta.processHints} />
                  ) : null}
                  <p className="side-note">
                    From Orca / Bambu `Metadata/model_settings.config`, `project_settings.config`, and OPC
                    `3dmodel.model` metadata (title, designer, profile title).
                  </p>
                </>
              ) : null}
            </section>
          ) : null}

          {/* ── Measurements — collapsible ────────────────────────────────── */}
          {mesh ? (
            <section>
              <h2
                className="section-h"
                role="button"
                tabIndex={0}
                aria-expanded={!collapsedSections.has('measurements')}
                onClick={() => toggleSection('measurements')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('measurements') } }}
              >
                Measurements
                <span className="section-chevron" aria-hidden>{collapsedSections.has('measurements') ? '▸' : '▾'}</span>
              </h2>
              {!collapsedSections.has('measurements') && meshAnalysis ? (
                <>
                  <p className="side-line">
                    <span className="side-k">Size (ΔX × ΔY × ΔZ)</span>{' '}
                    <span className="side-v">
                      {meshAnalysis.bounds.size[0].toFixed(2)} × {meshAnalysis.bounds.size[1].toFixed(2)} ×{' '}
                      {meshAnalysis.bounds.size[2].toFixed(2)} mm
                    </span>
                  </p>
                  <p className="side-line">
                    <span className="side-k">Diagonal</span> <span className="side-v">{meshAnalysis.bounds.diagonalMm.toFixed(2)} mm</span>
                  </p>
                  <p className="side-line">
                    <span className="side-k">Surface area</span>{' '}
                    <span className="side-v">{(meshAnalysis.surfaceAreaMm2 / 100).toFixed(1)} cm²</span>
                  </p>
                  {(() => {
                    const volCm3 = Math.abs(meshAnalysis.signedVolumeMm3) / 1000
                    const { densityGcm3, label } = filamentDensity(mesh.packageMeta?.filamentTypes)
                    const weightG = volCm3 * densityGcm3
                    return (
                      <>
                        <p className="side-line">
                          <span className="side-k">Volume (signed)</span>{' '}
                          <span className="side-v">{volCm3.toFixed(2)} cm³</span>
                        </p>
                        <p className="side-line">
                          <span className="side-k">Est. weight ({label})</span>{' '}
                          <span className="side-v">{weightG.toFixed(1)} g</span>
                        </p>
                      </>
                    )
                  })()}
                  <p className="side-line">
                    <span className="side-k">Shells</span>{' '}
                    <span className="side-v">{meshAnalysis.shellCount}</span>
                  </p>
                  <p className="side-line">
                    <span className="side-k">Overhangs (&gt;45°)</span>{' '}
                    <span className="side-v">
                      {meshAnalysis.overhangTriangleCount.toLocaleString()} tri
                      {meshAnalysis.triangleCount > 0
                        ? ` (${((meshAnalysis.overhangTriangleCount / meshAnalysis.triangleCount) * 100).toFixed(1)}%)`
                        : ''}
                    </span>
                  </p>
                  <p className="side-note">Volume assumes a closed, consistently wound mesh. Weight is for solid 100% infill.</p>
                </>
              ) : null}
            </section>
          ) : null}

          {/* ── Print readiness — collapsible ─────────────────────────────── */}
          {mesh ? (
            <section>
              <h2
                className="section-h"
                role="button"
                tabIndex={0}
                aria-expanded={!collapsedSections.has('readiness')}
                onClick={() => toggleSection('readiness')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('readiness') } }}
              >
                Print readiness
                <span className="section-chevron" aria-hidden>{collapsedSections.has('readiness') ? '▸' : '▾'}</span>
              </h2>
              {!collapsedSections.has('readiness') && printLines.length > 0 ? (
                <ul className="readiness-list">
                  {printLines.map((line, i) => (
                    <li key={i} className={`readiness-${line.level}`}>
                      {line.text}
                    </li>
                  ))}
                  {openEdgeResult !== null ? (
                    <li className={openEdgeResult.count === 0 ? 'readiness-ok' : 'readiness-warn'}>
                      {openEdgeResult.count === 0
                        ? 'No open edges — mesh appears watertight.'
                        : `${openEdgeResult.count.toLocaleString()} open edge${openEdgeResult.count === 1 ? '' : 's'} detected (mesh not watertight).`}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </section>
          ) : null}

          {/* ── Analysis overlays — collapsible ───────────────────────────── */}
          {mesh ? (
            <section>
              <h2
                className="section-h"
                role="button"
                tabIndex={0}
                aria-expanded={!collapsedSections.has('overlays')}
                onClick={() => toggleSection('overlays')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('overlays') } }}
              >
                Analysis overlays
                <span className="section-chevron" aria-hidden>{collapsedSections.has('overlays') ? '▸' : '▾'}</span>
              </h2>
              {!collapsedSections.has('overlays') ? (
                <>
                  <div className="overlay-btns">
                    <button
                      type="button"
                      className={viewMode === 'faceOrient' ? 'btn active' : 'btn'}
                      onClick={() => setViewMode((v) => v === 'faceOrient' ? 'solid' : 'faceOrient')}
                      title="Colour front faces blue and back faces red — spot inverted normals (F)"
                    >
                      Face orient
                    </button>
                    <button
                      type="button"
                      className={showCoM ? 'btn active' : 'btn'}
                      onClick={() => setShowCoM((v) => !v)}
                      title="Show the bounding-box centre of mass as an orange crosshair"
                    >
                      Centre of mass
                    </button>
                    <button
                      type="button"
                      className={showDimensions ? 'btn active' : 'btn'}
                      onClick={() => setShowDimensions((v) => !v)}
                      disabled={!mesh}
                      title="Show W × D × H dimension labels on the model"
                    >
                      Dimensions
                    </button>
                    <button
                      type="button"
                      className={showNormals ? 'btn active' : 'btn'}
                      onClick={() => setShowNormals((v) => !v)}
                      disabled={!mesh}
                      title="Show face normals as lines (useful for diagnosing flipped faces)"
                    >
                      Normals
                    </button>
                  </div>
                  {meshAnalysis ? (
                    <label className="side-field">
                      <span className="side-field-label">
                        Section plane{clipY === null ? ' (off)' : ` — ${clipY.toFixed(1)} mm`}
                      </span>
                      <div className="section-slider-row">
                        <input
                          type="range"
                          min={meshAnalysis.bounds.min[1]}
                          max={meshAnalysis.bounds.max[1]}
                          step={0.5}
                          value={clipY ?? meshAnalysis.bounds.max[1]}
                          onChange={(e) => setClipY(parseFloat(e.target.value))}
                        />
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setClipY(null)}
                          disabled={clipY === null}
                          style={{ padding: '2px 7px', fontSize: '0.78rem', lineHeight: 1.4 }}
                        >
                          Off
                        </button>
                      </div>
                      <p className="side-note">Drag to reveal a cross-section. Off restores the full model.</p>
                    </label>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}

          {/* ── Shading — collapsible ────────────────────────────────────── */}
          {mesh ? (
            <section>
              <h2
                className="section-h"
                role="button"
                tabIndex={0}
                aria-expanded={!collapsedSections.has('shading')}
                onClick={() => toggleSection('shading')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('shading') } }}
              >
                Shading
                <span className="section-chevron" aria-hidden>{collapsedSections.has('shading') ? '▸' : '▾'}</span>
              </h2>
              {!collapsedSections.has('shading') ? (
                <>
                  <p className="side-note">Material appearance preset — adjusts surface roughness and metalness.</p>
                  <div className="shading-presets">
                    {(['default', 'silk', 'matte', 'metal'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={materialPreset === p ? 'btn active' : 'btn'}
                        onClick={() => setMaterialPreset(p)}
                        title={
                          p === 'default' ? 'Balanced roughness (default PLA look)' :
                          p === 'silk'    ? 'Low roughness, mild metalness — silk / satin finish' :
                          p === 'matte'   ? 'Very high roughness, no metalness — flat/matte finish' :
                                           'Low roughness, high metalness — metallic finish'
                        }
                      >
                        {p === 'default' ? 'Default' : p === 'silk' ? 'Silk' : p === 'matte' ? 'Matte' : 'Metal'}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </section>
          ) : null}

          {/* ── Scale — collapsible ───────────────────────────────────────── */}
          {mesh ? (
            <section>
              <h2
                className="section-h"
                role="button"
                tabIndex={0}
                aria-expanded={!collapsedSections.has('scale')}
                onClick={() => toggleSection('scale')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('scale') } }}
              >
                Scale
                <span className="section-chevron" aria-hidden>{collapsedSections.has('scale') ? '▸' : '▾'}</span>
              </h2>
              {!collapsedSections.has('scale') ? (
                <>
                  <div className="scale-row">
                    <select
                      className="scale-axis-select"
                      value={scaleAxis}
                      onChange={(e) => setScaleAxis(e.target.value as 'x' | 'y' | 'z' | 'uniform')}
                      aria-label="Scale axis"
                    >
                      <option value="uniform">Uniform</option>
                      <option value="x">X axis</option>
                      <option value="y">Y axis</option>
                      <option value="z">Z axis</option>
                    </select>
                    <input
                      type="text"
                      className="scale-input"
                      placeholder="Target mm…"
                      value={scaleInput}
                      onChange={(e) => setScaleInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') applyScale() }}
                      aria-label="Target size in millimetres"
                    />
                    <button type="button" className="btn primary" onClick={applyScale}>
                      Apply
                    </button>
                  </div>
                  {meshAnalysis ? (
                    <p className="side-note">
                      Current: {meshAnalysis.bounds.size[0].toFixed(1)} × {meshAnalysis.bounds.size[1].toFixed(1)} × {meshAnalysis.bounds.size[2].toFixed(1)} mm
                    </p>
                  ) : null}
                  <p className="side-note">Enter a target size in mm and press Apply. Scales the entire mesh uniformly or along one axis.</p>
                </>
              ) : null}
            </section>
          ) : null}

          {/* ── Measurement result — always visible when present ──────────── */}
          {measureResult ? (
            <section>
              <h2>Measurement</h2>
              <div className="measure-result">
                <span className="measure-dist">{measureResult.distanceMm.toFixed(2)} mm</span>
                <button
                  type="button"
                  className="measure-clear"
                  onClick={() => { setMeasureResult(null); setStatus('Measurement cleared.') }}
                  title="Clear measurement"
                >
                  ✕
                </button>
              </div>
              <div className="measure-coords">
                <div className="measure-coord-row">
                  <span className="measure-coord-label">A</span>
                  <span className="measure-coord-val">
                    {measureResult.ptA.map((v) => v.toFixed(1)).join(', ')} mm
                  </span>
                </div>
                <div className="measure-coord-row">
                  <span className="measure-coord-label">B</span>
                  <span className="measure-coord-val">
                    {measureResult.ptB.map((v) => v.toFixed(1)).join(', ')} mm
                  </span>
                </div>
              </div>
            </section>
          ) : null}

          {/* ── Annotations — collapsible ────────────────────────────────── */}
          {mesh && (annotations.length > 0 || annotationMode) ? (
            <section>
              <h2
                className="section-h"
                role="button"
                tabIndex={0}
                aria-expanded={!collapsedSections.has('annotations')}
                onClick={() => toggleSection('annotations')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('annotations') } }}
              >
                Annotations
                <span className="section-chevron" aria-hidden>{collapsedSections.has('annotations') ? '▸' : '▾'}</span>
              </h2>
              {!collapsedSections.has('annotations') ? (
                <>
                  {annotationMode ? (
                    <p className="side-note" style={{ color: 'var(--accent)' }}>Click the model to place a pin.</p>
                  ) : null}
                  {annotations.length === 0 ? (
                    <p className="side-note">No annotations yet.</p>
                  ) : (
                    <ul className="annotation-list">
                      {annotations.map((ann) => (
                        <li key={ann.id} className="annotation-list-item">
                          <span className="annotation-list-text">{ann.text}</span>
                          <button
                            type="button"
                            className="annotation-list-del"
                            title="Remove annotation"
                            onClick={() => setAnnotations((prev) => prev.filter((a) => a.id !== ann.id))}
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {annotations.length > 0 ? (
                    <button
                      type="button"
                      className="btn"
                      style={{ marginTop: 4, width: '100%' }}
                      onClick={() => { setAnnotations([]); setStatus('Annotations cleared.') }}
                    >
                      Clear all
                    </button>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}

          {/* ── STEP import — collapsible ─────────────────────────────────── */}
          <section>
            <h2
              className="section-h"
              role="button"
              tabIndex={0}
              aria-expanded={!collapsedSections.has('step')}
              onClick={() => toggleSection('step')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('step') } }}
            >
              STEP import
              <span className="section-chevron" aria-hidden>{collapsedSections.has('step') ? '▸' : '▾'}</span>
            </h2>
            {!collapsedSections.has('step') ? (
              <>
                <label className="side-field">
                  <span className="side-field-label" id="step-tess-label">
                    Mesh quality
                  </span>
                  <select
                    className="side-select"
                    value={stepTessPreset}
                    onChange={(e) => setStepTessPreset(e.target.value as StepTessellationPreset)}
                    aria-labelledby="step-tess-label"
                    aria-describedby="step-tess-hint"
                  >
                    <option value="auto">Auto (library default)</option>
                    <option value="coarse">Coarse — faster, fewer triangles</option>
                    <option value="balanced">Balanced</option>
                    <option value="fine">Fine — slower, smoother curves</option>
                  </select>
                </label>
                <p id="step-tess-hint" className="side-note">
                  {stepTessellationSummary(stepTessPreset)} Applies on the next .step / .stp load.
                </p>
              </>
            ) : null}
          </section>

          {/* ── Status — always visible ───────────────────────────────────── */}
          <section>
            <h2>Status</h2>
            <p className={`status${statusClass(status) ? ` status--${statusClass(status)}` : ''}`}>{status}</p>
          </section>
        </aside>
      </main>

      {settingsOpen ? <SettingsModal onClose={() => setSettingsOpen(false)} /> : null}
      {shortcutsOpen ? <ShortcutsModal onClose={() => setShortcutsOpen(false)} /> : null}
      {cmdPaletteOpen ? <CommandPalette commands={commands} onClose={() => setCmdPaletteOpen(false)} /> : null}

      {/* ── Annotation text input dialog ──────────────────────────────── */}
      {pendingAnnotationPos ? (
        <div className="modal-backdrop" role="presentation" onClick={() => { setPendingAnnotationPos(null); setPendingAnnotationText('') }}>
          <div
            className="modal-dialog annotation-input-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ann-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="ann-dialog-title">Add annotation</h2>
            <input
              className="settings-input"
              type="text"
              autoFocus
              placeholder="Annotation text…"
              value={pendingAnnotationText}
              onChange={(e) => setPendingAnnotationText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pendingAnnotationText.trim()) {
                  setAnnotations((prev) => [...prev, { id: nextAnnotationId.current++, pos: pendingAnnotationPos, text: pendingAnnotationText.trim() }])
                  setPendingAnnotationPos(null)
                  setPendingAnnotationText('')
                } else if (e.key === 'Escape') {
                  setPendingAnnotationPos(null)
                  setPendingAnnotationText('')
                }
              }}
            />
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => { setPendingAnnotationPos(null); setPendingAnnotationText('') }}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!pendingAnnotationText.trim()}
                onClick={() => {
                  if (!pendingAnnotationText.trim()) return
                  setAnnotations((prev) => [...prev, { id: nextAnnotationId.current++, pos: pendingAnnotationPos, text: pendingAnnotationText.trim() }])
                  setPendingAnnotationPos(null)
                  setPendingAnnotationText('')
                }}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {aboutOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setAboutOpen(false)}
        >
          <div
            className="modal-dialog about-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
            aria-describedby="about-whats-new"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="about-title">Model Forge</h2>
            <p className="about-line about-muted">{DISPLAY_VERSION}</p>
            <p className="about-line">{packageJson.description}</p>
            <p className="about-line about-muted about-copy">
              Copyright © 2026 · {packageJson.license} License
            </p>
            <div id="about-whats-new" className="about-whats-new">
              <h3 className="whats-new-title">What&apos;s new</h3>
              <WhatsNew />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn primary" onClick={() => setAboutOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {busy && loadPhase ? (
        <div className="load-overlay" role="alertdialog" aria-modal="true" aria-busy="true" aria-live="polite">
          <div className="load-panel">
            <div className="load-spinner" aria-hidden />
            <p className="load-phase">{loadPhase}</p>
            <p className="load-hint">Heavy work (especially STEP) cannot stop mid-call; cancel takes effect between phases.</p>
            <div className="load-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  loadCancelledRef.current = true
                  setLoadPhase('Cancelling after current step…')
                  setStatus('Cancelling after current step…')
                }}
              >
                Cancel load
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
