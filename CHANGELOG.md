# Changelog

## 2.0 Alpha 4 — 2026-05-24

- **Turntable:** New **Turntable** toggle in the Scene toolbar (keyboard **T**) enables OrbitControls `autoRotate` at 1.5 rpm for hands-free model presentation. Turns off automatically on new load.
- **Material presets:** New **Shading** sidebar section exposes four surface presets — Default (PLA 0.55/0.02), Silk (0.12/0.38), Matte (0.92/0.00), Metallic (0.18/0.88) — that update roughness/metalness live on all model materials without reloading. Also updates the saved `origMat` when a special overlay (face-orient / overhang) is active, so the preset is preserved on exit.
- **Auto-orient:** New **Auto-orient** button in the Scene toolbar tries all 6 canonical face-down rotations (±X, ±Z in 90° steps) and selects the orientation with the fewest overhang triangles (>45° from horizontal). Reports the applied rotation label in the status bar.
- **Undo / redo:** All mesh-modifying operations (repair, rotate, snap, scale, auto-orient) now push to a 10-step undo stack. **Ctrl+Z** / **Ctrl+Y** (or Ctrl+Shift+Z) step backward/forward. Toolbar ⟲/⟳ icon buttons show the stack depth in their tooltip. History and redo stack are cleared on file load/close.
- **Command palette:** **Ctrl+K** opens a floating command palette with fuzzy substring search across all app actions (open, close, view modes, material presets, repair, export, etc.). Keyboard-navigable with ↑↓/Enter/Esc; disabled commands are shown dimmed.
- **Batch export:** New **All plates — STL (batch)** entry in the Export dropdown (visible for multi-plate 3MF files). A single save dialog picks the base path; each plate is written to `{base}_plate{id}.stl` automatically.
- **Annotations:** New **Annotate** toggle button activates pin-placement mode. Clicking the model surface opens a small text-input dialog; the annotation appears as a frosted blue chip anchored in 3D space (via drei `Html`) and is listed in the new sidebar **Annotations** section with per-item delete buttons and a "Clear all" action.

## 2.0 Alpha 3 — 2026-05-23

- **Measurement label in viewport:** The distance reading now appears as a yellow frosted-glass chip anchored to the midpoint of the measurement line in 3D space (rendered via drei `Html`), in addition to the sidebar result. Label clears when measure mode is turned off or a new first point is picked. Raycasting also now hits single-plate sub-objects (`model_s*`) that were previously ignored.
- **Overhang heat map:** New **Overhang** view mode (toolbar and keyboard shortcut **H**) colours every face by its angle from horizontal using a GLSL fragment shader with screen-space derivative normals (`dFdx`/`dFdy`): green ≤ 45° (printable), orange gradient through the threshold, red > 45° (critical). Implemented as a `ShaderMaterial` swap identical to the existing Face-orient mode — originals are saved and restored on exit.
- **Snap to bed:** New **Snap to bed** button in the Scene toolbar segment translates the mesh so its lowest vertex is exactly at Y = 0. Recurses into `plateParts` the same way the existing rotation helpers do. Reports how much the model was shifted.
- **Ambient occlusion:** Added `N8AO` screen-space ambient occlusion via `@react-three/postprocessing`. Runs at full resolution with `screenSpaceRadius` so the effect scales correctly regardless of model size. Uses `multisampling={0}` to defer to the canvas's built-in MSAA.

## 2.0 Alpha 2 — 2026-05-23

- **3MF floating model fix:** Bambu split-format 3MF files (multi-color single-plate, e.g. AMS prints) no longer float above the bed. Root cause was a double-remap bug: `finalizeGeomBucketsToMesh` returns `{ ...merged, plateParts }` where `merged` and `plateParts[0].mesh` alias the same `Float32Array`. The axis-remap pass was transforming that buffer twice (slicer XYZ → viewer → viewer again), corrupting Y coordinates and lifting sub-objects ~155 mm above the plate. Fixed with a reference-equality guard: `if (pp.mesh.positions !== mesh.positions) remap(pp.mesh.positions)`.
- **Light / dark theme:** New toolbar toggle (☀ / 🌙) switches between dark (default) and light CSS variable sets; choice is persisted to `localStorage` across sessions.
- **Collapsible sidebar:** Toolbar ▶/◀ button hides or restores the right sidebar, giving the viewport the full window width.
- **Viewport stats chip:** Filename, triangle count, plate count, estimated print time, and estimated weight are shown in a frosted glass chip anchored to the top-left of the viewport whenever a model is loaded.
- **Plate thumbnail strip:** For multi-plate 3MF files, a frosted bar along the bottom of the viewport shows plate preview thumbnails; clicking one frames that plate in the 3D view.
- **Filament swatch click-to-copy:** Filament color swatches in the sidebar are now buttons; clicking one copies the hex color to the clipboard and briefly shows a green ✓ badge.
- **Enhanced empty / drop zone:** The no-model state is replaced with a bordered dashed drop zone that highlights on file drag-over.
- **Exploded view:** New **Explode** toolbar button (visible only for multi-body models) fans sub-objects outward from the model's XZ centre. Animation is a per-frame spring lerp (factor 0.14) for a smooth snap in both directions. Sub-objects are wrapped in host Groups so the explosion is pure transform animation — no geometry is modified.
- **Blob shadow:** A soft radial gradient disc is placed at bed surface under every single-plate model, sized to the model's footprint × 1.35, using `MultiplyBlending` for a natural pooled shadow effect.

## 2.0 Alpha 1 — 2026-05-22

- **Renderer rewrite:** Replaced Babylon.js with **React Three Fiber** (Three.js r168). All mesh loading, repair, analysis, and export code is unchanged; only the scene graph and camera layer changed.
- **Multi-plate camera:** Overview targets the **bed plane (Y = 0)** instead of the mid-point between beds and model tops, so plates appear level rather than floating. Radius is driven by the XZ footprint only (ignores model height). `resetDefaultView` is aligned to match the initial framing exactly.
- **TypeScript hygiene:** All 5 pre-existing errors resolved — added `occt-import-js` module declaration, fixed `ArrayBufferView` cast in STEP loader, fixed two `expanded`-possibly-null accesses and one nullable-map argument in the 3MF parser.
- **Repair preserves vertex colors:** `repairMesh` now carries per-vertex colors through the weld pass (first-wins). Previously they were silently dropped, causing color loss for OBJ / painted 3MF meshes after repair.
- **Rotate X/Z propagates to plate parts:** `rotateMeshQuarterTurnAroundX` and `rotateMeshQuarterTurnAroundZ` now recurse into `plateParts` the same way Y rotation already did.
- **Dead code removal:** Removed unused `scalePositions` from `printSpace.ts` (didn't preserve colors/meta); deduplicated inline `meshToGeometry` into shared `toThree.ts`.

## 1.0 Beta 11 — 2026-05-20

- **NOAMS multi-color 3MF:** Single-extruder multi-plate (NOAMS) files now display the correct filament color per plate. `plate_N.json`'s `first_extruder` field (0-based) is read after build-object enrichment and overrides the filament slot for each plate, so all four plates of a NOAMS print render with their true colors rather than the default extruder 1 color.
- **Color accuracy:** Fixed sRGB color rendering across all file types. `hexCssToLinearColor3` now applies the full IEC 61966-2-1 sRGB→linear transfer function before passing colors to Babylon's StandardMaterial. Babylon's image-processing gamma pipeline is enabled so the linear-to-sRGB conversion is applied on output, making rendered filament colors faithfully match the original sRGB hex values (and Bambu Studio / Orca Slicer's appearance).

## 1.0 Beta 10 — 2026-05-08

- **Open boundary edge detection:** New **Open edges** button highlights non-watertight mesh edges in orange. The edge count is added to the Print Readiness panel. Computation is lazy (runs on first toggle); result clears automatically on repair, rotate, or new load.
- **Measurement tool:** New **Measure** button activates click-to-pick mode. Click two points on the model surface to get the straight-line distance in mm. Result shown in a new Measurement sidebar section with coordinates of both points and a yellow line/dot overlay in the viewer. Click ✕ to clear.
- Both overlays use Babylon.js rendering group 1 so they draw on top of the model; line system parent-child hierarchy keeps overlays aligned after bed placement transforms.

## 1.0 Beta 9 — 2026-05-08

- **Keyboard shortcuts:** `O` open, `W`/`S`/`L` view modes, `R` reset camera, `P` screenshot, `?` shortcuts panel. Press `?` at any time to see the full list.
- **Transform:** Added **↻X** and **↻Z** rotation buttons alongside the existing ↻Y; all three rotate the mesh 90° through its bounding-box center.
- **Open in slicer:** Button appears in the toolbar when a file was loaded from disk. Sends the source file to the OS default application for that format (e.g. Bambu Studio for .3mf).
- **Recent files:** Sidebar now shows the last 20 files opened in the app (persisted to `userData/recent-files.json`). Click any entry to reload it; the active file is highlighted.
- **Filament swatches:** Each color swatch now shows its slot index label (T1, T2, …) below the color block for easier identification without relying on color alone.
- **Tracking:** Added `FEATURES.md` — a comprehensive feature map, planned work list, architecture notes, and changelog summary kept in the project root for AI coding assistant context.

## 1.0 Beta 8 — 2026-04-25

- **3MF import:** Propagate slicer plate / extruder maps onto **ancestor** `<object>` ids in the OPC component tree (with existing child→build-root expansion) so fewer plates lose geometry when metadata keys a leaf.
- **Viewer:** **Cam → Quick / Default** presets (wheel zoom + right-drag pan); choice is **saved** in `localStorage` for the next session.
- **Multi-plate UI:** **All plates** appears after you focus a plate from the sidebar; **Reset view** clears plate focus. Sidebar row **highlight** for the framed plate.
- **Diagnostics:** `[ModelForge 3MF]` empty-plate console logs run only in **development** builds.
- **Export:** Documented that STL/OBJ/3MF encoders use **`TriangleMesh` only**, not Babylon-only display scaling.
- **Release:** Version bump to `1.0.0-beta.8`.

## 1.0 Beta 7 — 2026-04-25

- **3MF multi-plate:** Plate list in metadata now drives the full grid (including plates with no merged mesh); console diagnostics list expected object ids vs OPC `<object id>` when a plate has no geometry.
- **3MF package meta:** `parsedOpcObjectIds` and a merged `plateIds` set (geometry, slicer assignment, build objects, and sequential plate count) for consistent UI and layout.
- **Viewer (Bambu-style plates):** Center each plate’s mesh on its bed in XZ; multi-plate default camera ignores bed grids for framing and zooms in slightly; very thin parts get a capped vertical scale boost so clips and spacers stay visible (geometry unchanged for export).
- **Viewer:** Per-plate camera focus from the sidebar (“Model objects” row click); faster mouse wheel zoom; removed decorative empty-plate markers so they are not confused with real parts.
- **Release:** Version bump to `1.0.0-beta.7`.

## 1.0 Beta 6 — 2026-04-24

- **3MF import:** More robust package/model-part discovery (`_rels/.rels`, all `[Content_Types]` model overrides, multi-candidate fallback with per-part diagnostics) so previously failing 3MFs now load.
- **3MF color preview:** Added support for slicer paint metadata (Bambu/Prusa-style triangle paint attributes) and filament palette extraction from embedded config files, with sensible fallback colors when palette data is absent.
- **3MF transforms/viewer parity:** Applied print-space axis remap for 3MF into viewer space so model placement matches slicer orientation more closely.
- **Viewer rendering:** Improved solid-mode robustness for mixed winding meshes and made under-bed inspection practical by reducing build-plate occlusion when orbiting below.
- **Release:** Version bump to `1.0.0-beta.6`.

## 1.0 Beta 5 — 2026-04-22

- **Drag and drop:** Open models by dropping anywhere on the window; load via file buffer; main-process navigation guards so the app is not replaced by a raw `file://` document.
- **Viewer:** Settle animation uses `@babylonjs/core/Animations/animatable` so `beginDirectAnimation` is available under tree-shaking; larger bounce on load.
- **Loading:** Full-screen overlay with phased status for STEP (CAD engine → tessellation → assembly), disk read for path opens, and **Cancel** / **Escape** between async phases (WASM tessellation itself cannot be interrupted mid-call).
- **Release:** Version bump to `1.0.0-beta.5`.

## 1.0 Beta 4 — 2026-04-21

- **Scene:** Reset view (default camera angle and zoom) and Rotate 90° around the bed (Y); export uses the rotated mesh.
- **Release:** Version bump to `1.0.0-beta.4`.

## 1.0 Beta 3 and earlier

See git history for prior changes (viewer defaults, Windows installer, file-axis loading, icons).
