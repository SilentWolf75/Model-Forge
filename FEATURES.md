# Model Forge — Feature Tracker

This file tracks all implemented features, planned improvements, and known limitations.
It is kept up to date as changes are made and is intended to be useful context for any
AI coding assistant (Claude Code, Cursor, etc.) working on this project.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 33 |
| Frontend | React 18 + TypeScript 5 |
| 3D rendering | React Three Fiber (Three.js r184) |
| CAD kernel | occt-import-js (WASM) |
| 3MF / ZIP | jszip + fast-xml-parser |
| Build | electron-vite + Vite 5 |
| Packaging | electron-builder (NSIS + portable) |

---

## Key File Map

```
src/main/index.ts              — Electron main process, IPC handlers, window management
src/preload/index.ts           — contextBridge API surface (renderer ↔ main)
src/renderer/src/App.tsx       — Root React component, all UI state
src/renderer/src/styles.css    — All styles (dark theme, CSS variables)
src/renderer/src/viewer/
  R3FViewer.tsx                — React Three Fiber canvas, camera, mesh rendering, overlays
  cameraPrefs.ts               — localStorage camera preset persistence
src/renderer/src/loaders/
  index.ts                     — Format dispatcher (reads file extension)
  threeFormats.ts              — STL / OBJ via Three.js loaders
  threeMf.ts                   — Full 3MF parser (ZIP + XML + Bambu/Orca metadata)
  threeMfColors.ts             — Filament colour extraction
  threeMfBambuPaint.ts         — Triangle-level paint metadata
  stepOcct.ts                  — STEP loader via WASM CAD kernel
  stepTessellation.ts          — Tessellation quality presets + persistence
src/renderer/src/exporters/
  stl.ts                       — Binary STL encoder
  obj.ts                       — OBJ encoder
  threeMf.ts                   — 3MF encoder
src/renderer/src/mesh/
  types.ts                     — TriangleMesh, ThreeMfPackageMeta, etc.
  analyze.ts                   — Bounds, surface area, volume, print readiness
  toThree.ts                   — TriangleMesh → THREE.BufferGeometry (shared helper)
  merge.ts                     — Mesh merging
  openEdges.ts                 — Open boundary edge detection
  rotateAroundY.ts             — Quarter-turn rotation utilities (X, Y, Z)
  printSpace.ts                — Coordinate system transforms
src/renderer/src/repair/
  meshRepair.ts                — Mesh repair orchestration (weld, degenerate removal, color-preserving)
```

---

## Supported File Formats

| Format | Import | Export | Notes |
|---|---|---|---|
| STL | ✅ | ✅ (binary) | Via Babylon.js loaders |
| OBJ | ✅ | ✅ | Via Babylon.js loaders |
| 3MF | ✅ | ✅ | Full Bambu/Orca metadata, multi-plate |
| STEP / STP | ✅ | ❌ | Via WASM CAD kernel; export not possible (topology vs mesh) |
| PNG | — | ✅ | Screenshot capture |

---

## Implemented Features

### Viewing
- [x] Real-time React Three Fiber viewer with orbit camera (drei OrbitControls)
- [x] View modes: Solid, Wireframe, X-ray (look-through)
- [x] Camera presets: Quick / Default (wheel + pan speed, persisted)
- [x] Reset view (default 3/4 front-left perspective)
- [x] Under-bed inspection (camera can go below the print bed)
- [x] Screenshot capture (PNG export)
- [x] Drag-and-drop file loading
- [x] Loading overlay with cancel support (between WASM phases)

### Transform
- [x] Rotate 90° around Y (bed vertical axis)
- [x] Rotate 90° around X
- [x] Rotate 90° around Z

### Mesh Analysis
- [x] Open boundary edge detection (toggle "Open edges"; orange overlay; count in Print Readiness)
- [x] Point-to-point measurement tool (toggle "Measure"; click two surface points; distance in mm in sidebar)
- [x] Triangle and vertex count
- [x] Bounding box dimensions (X × Y × Z mm)
- [x] Diagonal measurement
- [x] Surface area (cm²)
- [x] Signed volume (cm³) — assumes closed, consistently wound mesh
- [x] Print readiness heuristics (orientation, size, density)

### Mesh Repair
- [x] Remove degenerate triangles (zero-area)
- [x] Vertex de-duplication / optimization
- [x] Repair impact report

### 3MF / Slicer Integration
- [x] Bambu Studio and Orca Slicer project metadata (bed type, printer, designer)
- [x] Multi-plate support (separate bed grids, per-plate camera focus)
- [x] Filament slot extraction with hex colors and material types
- [x] Process snapshot (layer height, nozzle, print time estimate, weight)
- [x] OPC build object listing with plate and extruder slot mapping
- [x] Triangle-level Bambu paint metadata (color per face)
- [x] Filament swatch labels (slot index badge on each color swatch)

### File Operations
- [x] Open file dialog
- [x] Drag-and-drop (file or folder drop onto viewer)
- [x] OS recent documents (Windows Jump List via `app.addRecentDocument`)
- [x] In-app recent files list (userData/recent-files.json, last 20 files)
- [x] Export: STL, OBJ, 3MF, PNG screenshot
- [x] File associations (.stl, .obj, .3mf, .step, .stp) — Windows
- [x] Cold-start file open (command-line arg, Windows default app)
- [x] macOS open-file event support
- [x] "Open in default slicer" — opens current file's source path in the OS default app

### UI / UX
- [x] Dark theme (CSS variables, Segoe UI)
- [x] Responsive layout (viewer + 300px sidebar)
- [x] Status line with real-time feedback
- [x] About dialog with What's New changelog
- [x] Keyboard shortcuts panel (`?` key)
- [x] Window state persistence (size, position, maximize, fullscreen)
- [x] STEP tessellation quality selector (Auto / Coarse / Balanced / Fine, persisted)

### Keyboard Shortcuts
| Key | Action |
|---|---|
| `O` | Open file dialog |
| `W` | Wireframe view |
| `S` | Solid view |
| `L` | Look-through (X-ray) view |
| `R` | Reset camera view |
| `P` | Save screenshot |
| `?` | Show keyboard shortcuts |
| `Escape` | Cancel load / close modal |

---

## Planned / In Progress

### High priority
- [x] **Measurement tool** — click two surface points; distance shown in sidebar and status (yellow line/dot overlay, world-space mm). Uses `Pick()` from `ray.core` directly; predicate bypasses `isPickable` so frozen meshes are hit-testable.
- [x] **Open boundary edge detection** — orange line overlay for non-watertight edges; count in Print Readiness; lazy-computed on toggle
- [ ] **LOD / decimation on import** — user-controlled quality slider for very large models (>500K triangles)

### Medium priority
- [ ] **Split `threeMf.ts`** — 139KB file; split into `threeMfParser.ts`, `threeMfPlates.ts`, `threeMfBambu.ts` for maintainability
- [ ] **STEP quality preview** — show triangle count estimate before loading at each quality preset
- [ ] **State management refactor** — move model/UI/settings state out of `App.tsx` into Zustand stores

### Low priority / nice-to-have
- [ ] **Mesh boolean operations** — union, subtract (requires external WASM lib)
- [ ] **Slicer executable discovery** — auto-detect Bambu Studio / Orca Slicer install paths and launch directly
- [ ] **3MF thumbnail preview** — display `Metadata/plate_<n>.png` embedded thumbnails in the sidebar

---

## Known Limitations

- Volume calculation assumes a **closed, consistently wound** mesh; results are unreliable for open shells.
- WASM tessellation (STEP) **cannot be interrupted mid-call** — cancel takes effect between phases.
- `sandbox: false` is set in Electron for the renderer; this is required for certain preload APIs but is a mild security trade-off.
- Thin parts (<5mm) receive a non-geometric Y-scale boost in the viewer for visibility; this does not affect exported geometry.
- Mixed-winding meshes render with `THREE.DoubleSide` (both sides visible); this is cosmetic.
- "Open in default slicer" opens the **original source file**, not the current in-memory state. Export first if you've applied transforms or repairs.
- Export to STEP is not possible — STEP encodes CAD topology, not triangle meshes. Use STL or 3MF for slicers.

---

## Architecture Notes (for AI assistants)

- **IPC pattern**: all Electron main-process operations go through `src/preload/index.ts` (`contextBridge`). Never call `ipcRenderer` directly from renderer components.
- **Mesh pipeline**: files are decoded into a `TriangleMesh` (see `mesh/types.ts`). Three.js / R3F is only used for display; all export/analysis operates on `TriangleMesh` directly.
- **State**: all React state lives in `App.tsx`. `R3FViewer` exposes an imperative handle (`ViewerHandle`) for camera operations (`resetDefaultView`, `focusCameraOnPlate`, `captureScreenshot`).
- **plateParts**: when a multi-plate 3MF is loaded, `mesh.plateParts` holds per-plate geometry. The top-level `mesh.positions/indices` is a merged copy used for export and analysis.
- **Coordinate system**: Three.js uses right-handed Y-up. Print space is right-handed Z-up. `mesh/printSpace.ts` handles the remap on load: `viewer_x = slicer_x`, `viewer_y = slicer_z`, `viewer_z = -slicer_y`.
- **Three.js matrix update semantics**: `obj.updateMatrixWorld(true)` updates obj AND descendants DOWNWARD — does NOT update ancestors. `obj.updateWorldMatrix(true, false)` walks UP through the parent chain first, then updates obj. Always use `updateWorldMatrix(true, false)` before calling `Box3.setFromObject(obj)` when `obj` has not been rendered yet (Box3 only calls `updateWorldMatrix(false, false)` internally — no parent traversal).
- **R3F viewer scene**: `ViewerScene` component (renders inside `<Canvas>`) uses `useEffect` with `[mesh, loadAnimSeq]` to rebuild the scene on new loads. Bed groups are tracked in `bedGroupsRef`. Plate groups in `plateGroupsRef`. Eye-space lighting follows camera in `useFrame`.
- **Picking (measure mode)**: uses `THREE.Raycaster` with `pointerdown`/`pointerup` events on the canvas. No Babylon scene.pick().
- **occt-import-js**: must be in `optimizeDeps.include` (not `exclude`) in `electron.vite.config.ts`. It is a CJS/UMD module; exclusion causes Vite to serve it as raw ESM with no default export, crashing the renderer. esbuild handles the JS wrapper fine — the WASM binary is loaded dynamically at runtime and is not touched by the pre-bundler.
- **STL / OBJ loading**: via `threeFormats.ts` using Three.js `STLLoader` / `OBJLoader` (no Babylon dependency).

---

## Changelog Summary

| Version | Date | Highlights |
|---|---|---|
| 2.0.0-alpha.1 | 2026-05-22 | Renderer rewrite: Babylon.js → React Three Fiber (Three.js r184). Multi-plate bed-plane camera. TypeScript clean. Vertex-color-preserving repair. X/Z rotation propagates plateParts. |
| 1.0.0-beta.11 | 2026-05-20 | NOAMS multi-color 3MF support, sRGB color accuracy fix |
| 1.0.0-beta.10 | 2026-05-08 | Measurement tool (click-to-pick, yellow overlay, mm distance), open boundary edge detection (orange overlay, Print Readiness count) |
| 1.0.0-beta.9 | 2026-05-08 | Keyboard shortcuts panel, X/Z rotation buttons, open-in-slicer, recent files sidebar, filament slot labels |
| 1.0.0-beta.8 | 2026-04-25 | Camera presets (Quick/Default), multi-plate UI polish, OPC ancestor propagation |
| 1.0.0-beta.7 | 2026-04-25 | Multi-plate layout, Bambu-style plate grids, per-plate camera focus |
| 1.0.0-beta.6 | 2026-04-24 | Bambu paint metadata, filament palette, robust 3MF package discovery |
| 1.0.0-beta.5 | 2026-04-22 | Drag-and-drop, navigation guards |
| 1.0.0-beta.1–4 | 2026-04 | Initial viewer, STL/OBJ/3MF/STEP support, mesh analysis, repair, export |
