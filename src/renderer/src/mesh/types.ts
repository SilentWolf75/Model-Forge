/** One distinct-color object within a plate (multi-color plates only). */
export interface TriangleMeshPlateSubObject {
  mesh: TriangleMesh
  /** 1-based extruder/filament slot that determines this object’s color. */
  extruderSlot: number
}

/** One slicer plate’s geometry (viewer draws a separate bed per entry when multiple). */
export interface TriangleMeshPlatePart {
  /** Slicer plate index (often 1-based in metadata). */
  plateId: number
  mesh: TriangleMesh
  /**
   * Bambu/Orca extruder index (1-based), from `model_settings` when the mesh has no usable
   * per-triangle material colours — drives preview tint from `packageMeta.filamentColorsHex[slot-1]`.
   */
  filamentSlot?: number
  /**
   * Per-object sub-meshes when this plate contains ≥2 objects with different extruder slots.
   * When present, the viewer renders each sub-object with its own filament color instead of
   * applying a single flat tint to the merged plate mesh.
   */
  subObjects?: TriangleMeshPlateSubObject[]
}

/** One `<object>` from the OPC model for sidebar / tooling. */
export type ThreeMfBuildObjectSummary = {
  id: string
  name: string
  plateId?: number
  extruderSlot?: number
}

/** Process / slice fields often stored as `<metadata key="…" value="…"/>` in Orca / Bambu configs. */
export type ThreeMfProcessHints = {
  layerHeightMm?: string
  initialLayerHeightMm?: string
  lineWidthMm?: string
  nozzleDiameterMm?: string
  /** `print_settings_id`, `process_setting_name`, or similar. */
  printPresetId?: string
  /** Slicer time estimate when exported (e.g. Bambu `prediction` on a plate). */
  estimatedPrintTime?: string
  /** Model weight estimate when present (`weight` metadata). */
  estimatedModelWeight?: string
  totalLayers?: string
}

/**
 * Summary of slicer package data read from a Bambu / Orca 3MF (`Metadata/*.config`),
 * OPC `3dmodel.model` metadata, and similar sources.
 */
export type ThreeMfPackageMeta = {
  plateCount: number
  /** Distinct plate indices from metadata or per-plate geometry. */
  plateIds: number[]
  filamentCount: number
  /** One display colour per filament slot (#RRGGBB). */
  filamentColorsHex: string[]
  /**
   * Human title: slicer `from_name` / `model_name` when present, else OPC
   * `<metadata name="Title">` from `3dmodel.model`.
   */
  projectName?: string
  /** OPC `<metadata name="Designer">` (e.g. MakerWorld) when present. */
  designer?: string
  /** Orca/Bambu `curr_bed_type` / `bed_type` metadata when present. */
  bedType?: string
  /** `printer_model_id` or similar preset id string. */
  printerModelId?: string
  /** Printable bed from `project_settings` when present (mm). */
  bedWidthMm?: number
  bedDepthMm?: number
  /** `<object id name>` rows from the primary OPC `3dmodel.model` (with plate / extruder when known). */
  buildObjects?: ThreeMfBuildObjectSummary[]
  /** One material label per slot (e.g. PLA), from `<filament>` metadata `type`. */
  filamentTypes?: string[]
  /** Layer / nozzle / preset / estimate strings when found in config XML. */
  processHints?: ThreeMfProcessHints
  /**
   * Bambu-style `Metadata/plate_<n>.png` paths inside the 3MF (ZIP member names), sorted by plate index.
   * Consumers can read bytes from the archive when building a plate picker.
   */
  plateThumbnailPaths?: string[]
  /**
   * Data URLs (`data:image/png;base64,…`) for each plate thumbnail, parallel to `plateThumbnailPaths`.
   * Extracted eagerly during load so the UI can display them without re-opening the archive.
   * Empty string entries indicate thumbnails that failed to decode.
   */
  plateThumbnailDataUrls?: string[]
  /**
   * `<object id="…">` values from the primary OPC `3dmodel.model` resources (parse / filter diagnostics).
   */
  parsedOpcObjectIds?: string[]
}

/** Single watertight-oriented triangle soup in millimeters. */
export interface TriangleMesh {
  positions: Float32Array
  indices: Uint32Array
  /** Optional linear RGB (0–1) per position triple; same length as `positions` when present. */
  vertexColors?: Float32Array
  /**
   * When several entries exist, each plate is shown on its own build grid (Bambu-style multi-plate 3MF).
   * Top-level `positions`/`indices` remain the full merge for export and stats.
   */
  plateParts?: TriangleMeshPlatePart[]
  /** Set when the mesh was loaded from a slicer 3MF with recognizable metadata. */
  packageMeta?: ThreeMfPackageMeta
}

export function meshByteSize(m: TriangleMesh): number {
  return m.positions.byteLength + m.indices.byteLength + (m.vertexColors?.byteLength ?? 0)
}
