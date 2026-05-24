# Model Forge — 3D Print Viewer

A desktop 3D model viewer built for print preparation. Inspect, orient, analyze, and export your models before sending them to the slicer — with full support for Bambu Lab multi-plate and AMS color 3MF files.

![Model Forge — AMS multi-color model](docs/screenshots/main-view.png)

---

## Downloads

Head to the [Releases](https://github.com/SilentWolf75/Model-Forge/releases) page to grab the latest build.

| File | Description |
|------|-------------|
| `Model Forge-x.x.x-Setup.exe` | Installer — adds Start Menu shortcut and file associations |
| `Model Forge-x.x.x-portable.exe` | Portable — single `.exe`, no installation needed |

> Windows 10 / 11 x64 only.

---

## Features

### Viewing
- Solid, Wireframe, and X-ray (look-through) view modes
- Ambient occlusion for realistic depth
- Camera presets (Quick / Default) with persisted settings
- Turntable auto-rotate for hands-free presentation
- Drag-and-drop file loading

### Print Preparation
- **Auto-orient** — automatically rotates models flat-side-down on load, ready to print
- **Snap to bed** — drops the model so the lowest vertex sits exactly on the plate
- **Rotate** — 90° steps around X, Y, Z axes
- **Overhang analysis** — heat-map view highlights faces that need support (red > 45°, green ≤ 45°)
- **Mesh repair** — removes degenerate triangles, welds open seams
- **Open edge detection** — highlights non-watertight boundary edges in orange

![Overhang heat map view](docs/screenshots/overhang.png)

### 3MF / Bambu Lab Support
- Full multi-plate layout with correct per-plate positioning
- AMS multi-color filament display with color swatches
- NOAMS (single-extruder multi-plate) correct per-plate colors
- Filament slot labels (T1, T2…) and material names
- Slicer package metadata: printer, bed type, layer height, nozzle

![Multi-plate 3MF layout](docs/screenshots/multi-plate.png)

### Analysis
- Triangle and vertex count
- Bounding box dimensions (X × Y × Z mm)
- Surface area and volume
- Estimated print weight (PLA)
- Shell count, overhang percentage
- Print readiness checklist with actionable tips

### Tools
- **Measure** — click two points on the model to get the straight-line distance in mm
- **Annotations** — pin text notes to any point on the model surface
- **Command palette** (Ctrl+K) — fuzzy search across all app actions
- **Undo / Redo** (Ctrl+Z / Ctrl+Y) — 10-step history for all mesh operations
- **Screenshot** — export the current viewport as PNG
- **Open in slicer** — send the file directly to your default slicer

### Export
| Format | Notes |
|--------|-------|
| STL (binary) | Single model or per-plate batch export |
| OBJ | With material file |
| 3MF | Preserves mesh structure |

---

## Supported Import Formats

| Format | Notes |
|--------|-------|
| STL | Binary and ASCII |
| OBJ | With MTL materials |
| 3MF | Full Bambu / Orca Slicer metadata |
| STEP / STP | Via WASM CAD kernel (occt-import-js) |
| PLY | Binary and ASCII |
| AMF | Additive Manufacturing Format |
| FBX | Via Three.js loader |
| GLTF / GLB | Via Three.js loader |

---

## Building from Source

**Requirements:** Node.js 20+, npm

```bash
git clone https://github.com/SilentWolf75/Model-Forge.git
cd Model-Forge
npm install
npm run dev
```

**Build a distributable:**
```bash
npm run pack:win          # NSIS installer + portable .exe
npm run pack:win:setup    # NSIS installer only
```

Output goes to the `release/` folder.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 42 |
| Frontend | React 18 + TypeScript 5 |
| 3D rendering | React Three Fiber (Three.js r184) |
| Post-processing | N8AO ambient occlusion |
| CAD kernel | occt-import-js (WASM) |
| 3MF / ZIP | JSZip + fast-xml-parser |
| Build | electron-vite + Vite 8 |
| Packaging | electron-builder (NSIS + portable) |

---

## License

MIT
