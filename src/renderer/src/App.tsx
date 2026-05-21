import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { R3FViewer, type ViewerHandle, type ViewMode } from './viewer/R3FViewer'
import {
  readStoredCameraPresetId,
  writeStoredCameraPresetId,
  type CameraPresetId
} from './viewer/cameraPrefs'
import type { ThreeMfBuildObjectSummary, ThreeMfProcessHints, TriangleMesh } from './mesh/types'
import {
  rotateMeshQuarterTurnAroundY,
  rotateMeshQuarterTurnAroundX,
  rotateMeshQuarterTurnAroundZ
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

const idleStatusMessage = 'Open an STL, OBJ, 3MF, or STEP file to begin.'

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

function isSupportedModelFilename(name: string): boolean {
  const ext = extensionOf(name)
  return ext === 'stl' || ext === 'obj' || ext === '3mf' || ext === 'step' || ext === 'stp'
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
  const exportDropdownRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<ViewerHandle>(null)
  /** Avoid consuming startup path twice (React Strict Mode remount). */
  const startupOpenHandled = useRef(false)
  /** Set true when user cancels; checked after async work. Cannot interrupt WASM mid-call. */
  const loadCancelledRef = useRef(false)

  const stats = useMemo(() => (mesh ? meshStats(mesh) : null), [mesh])
  const [repairReport, setRepairReport] = useState<string[] | null>(null)
  const meshAnalysis = useMemo(() => (mesh ? analyzeMesh(mesh) : null), [mesh])
  const repairImpact = useMemo(() => (mesh ? repairImpactReport(mesh) : null), [mesh])
  const printLines = useMemo(() => {
    if (!meshAnalysis || repairImpact === null) return []
    return printReadinessLines(meshAnalysis, repairImpact.removedDegenerate)
  }, [meshAnalysis, repairImpact])

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
    } else {
      // Clear stale overlays whenever the mesh object changes (repair/rotate/new load)
      setShowOpenEdges(false)
      setOpenEdgeResult(null)
      setMeasureMode(false)
      setMeasureResult(null)
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
    const loaded = await loadModelFromBuffer(label, data, onProgress, stepTessellationParams(stepTessPreset))
    if (loadCancelledRef.current) {
      setStatus('Load cancelled.')
      return
    }
    setFocusedPlateId(null)
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
        setStatus('Unsupported file type. Use STL, OBJ, 3MF, or STEP/STP.')
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
    await openFile()
  }, [openFile])

  const runRepair = useCallback(() => {
    if (!mesh) return
    const { mesh: fixed, report } = repairMesh(mesh)
    setFocusedPlateId(null)
    setMesh(fixed)
    setRepairReport([
      `Degenerate triangles removed: ${report.removedDegenerate.toLocaleString()}`,
      `Vertices: ${report.verticesBefore.toLocaleString()} → ${report.verticesAfter.toLocaleString()}`,
    ])
    setStatus(`Repaired — ${report.removedDegenerate} degenerate triangles removed.`)
  }, [mesh])

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

  const rotateAroundBedY = useCallback(() => {
    if (!mesh) return
    setMesh(rotateMeshQuarterTurnAroundY(mesh))
    setStatus('Rotated 90° around the bed (Y). Export uses this orientation.')
  }, [mesh])

  const rotateAroundX = useCallback(() => {
    if (!mesh) return
    setMesh(rotateMeshQuarterTurnAroundX(mesh))
    setStatus('Rotated 90° around X. Export uses this orientation.')
  }, [mesh])

  const rotateAroundZ = useCallback(() => {
    if (!mesh) return
    setMesh(rotateMeshQuarterTurnAroundZ(mesh))
    setStatus('Rotated 90° around Z. Export uses this orientation.')
  }, [mesh])

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
    const anyModalOpen = aboutOpen || shortcutsOpen || exportMenuOpen
    const onKey = (e: KeyboardEvent): void => {
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
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, aboutOpen, shortcutsOpen, exportMenuOpen, mesh, openFile, resetView, saveScreenshot])

  return (
    <div
      className={`app${viewerDragActive ? ' file-drag' : ''}`}
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
            {(['solid', 'wireframe', 'xray'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={viewMode === m ? 'btn active' : 'btn'}
                onClick={() => setViewMode(m)}
                disabled={!mesh}
                title={!mesh ? 'Open a model first' : undefined}
              >
                {m === 'solid' ? 'Solid' : m === 'wireframe' ? 'Wireframe' : 'Look-through'}
              </button>
            ))}
          </div>
          <div className="seg">
            <span className="seg-label">Scene</span>
            <button type="button" className="btn" onClick={resetView} disabled={!mesh || busy}
              title={!mesh ? 'Open a model first' : 'Restore default camera angle and zoom (R)'}>
              Reset view
            </button>
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

          <div className="toolbar-sep" aria-hidden />

          {/* ── Help / Settings / Export ── */}
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
                OBJ
              </button>
              <button type="button" role="menuitem" onClick={() => void exportAs('3mf')}>
                3MF
              </button>
              <button type="button" role="menuitem" className="muted" onClick={stepExportInfo}>
                STEP (info)
              </button>
            </div>
          </div>
        </div>
      </header>
      <main className="main">
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
          />
          {!mesh && (
            <div className="empty-overlay">
              <h1>Open a print mesh to preview it on the plate</h1>
              <p>Orbit with the mouse: left drag rotates, wheel zooms, right drag pans.</p>
              <p className="hint">
                Drop a file here or use Open · Formats: STL, OBJ, 3MF, STEP/STP · First STEP load may take a moment (CAD
                kernel).
              </p>
            </div>
          )}
        </div>
        <aside className="side">
          <section>
            <h2>Current file</h2>
            <p className="mono">{fileLabel ?? '—'}</p>
          </section>
          {recentFiles.length > 0 ? (
            <section>
              <div className="recent-files-header">
                <h2>Recent files</h2>
                <button
                  type="button"
                  className="recent-files-clear-btn"
                  title="Clear recent files"
                  onClick={() => {
                    void window.api.clearRecentFiles().then(() => setRecentFiles([]))
                  }}
                >
                  Clear
                </button>
              </div>
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
            </section>
          ) : null}
          {stats ? (
            <section>
              <h2>Mesh</h2>
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
            </section>
          ) : null}
          {mesh?.packageMeta ? (
            <section>
              <h2>Slicer package (3MF)</h2>
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
              <div className="filament-swatches" aria-label="Filament colours from package">
                {mesh.packageMeta.filamentColorsHex.map((h, i) => (
                  <span
                    key={i}
                    className="filament-swatch"
                    title={`Slot ${i + 1}: ${mesh.packageMeta?.filamentTypes?.[i] ?? ''} ${h}`.trim()}
                  >
                    <span className="filament-swatch-dot" style={{ backgroundColor: h }} aria-hidden />
                    <span className="filament-swatch-label">T{i + 1}</span>
                  </span>
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
            </section>
          ) : null}
          {mesh ? (<section>
            <h2>Measurements</h2>
            {meshAnalysis ? (
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
                <p className="side-line">
                  <span className="side-k">Volume (signed)</span>{' '}
                  <span className="side-v">{(Math.abs(meshAnalysis.signedVolumeMm3) / 1000).toFixed(2)} cm³</span>
                </p>
                <p className="side-note">Volume assumes a closed, consistently wound mesh; open shells are not reliable.</p>
              </>
            ) : null}
          </section>) : null}
          {mesh ? (<section>
            <h2>Print readiness</h2>
            {printLines.length > 0 ? (
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
          </section>) : null}
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
          <section>
            <h2>STEP import</h2>
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
          </section>
          <section>
            <h2>Status</h2>
            <p className={`status${statusClass(status) ? ` status--${statusClass(status)}` : ''}`}>{status}</p>
          </section>
        </aside>
      </main>

      {settingsOpen ? <SettingsModal onClose={() => setSettingsOpen(false)} /> : null}
      {shortcutsOpen ? <ShortcutsModal onClose={() => setShortcutsOpen(false)} /> : null}

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
