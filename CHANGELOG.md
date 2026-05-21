# Changelog

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
