const STORAGE_KEY = 'modelForge.stepTessellation'

export type StepTessellationPreset = 'auto' | 'coarse' | 'balanced' | 'fine'

const PRESETS: Record<Exclude<StepTessellationPreset, 'auto'>, Record<string, unknown>> = {
  /** Fewer triangles, faster tessellation; larger chord error vs. model size. */
  coarse: {
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.12,
    angularDeflection: 1.2
  },
  balanced: {
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.035,
    angularDeflection: 0.55
  },
  /** More triangles, slower; finer approximation of curved faces. */
  fine: {
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.008,
    angularDeflection: 0.28
  }
}

export function readStoredStepTessellationPreset(): StepTessellationPreset {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'auto' || raw === 'coarse' || raw === 'balanced' || raw === 'fine') return raw
  } catch {
    /* private mode / blocked storage */
  }
  return 'auto'
}

export function writeStoredStepTessellationPreset(preset: StepTessellationPreset): void {
  try {
    localStorage.setItem(STORAGE_KEY, preset)
  } catch {
    /* ignore */
  }
}

/** Arguments for `occt.ReadStepFile`; `null` uses occt-import-js defaults. */
export function stepTessellationParams(preset: StepTessellationPreset): Record<string, unknown> | null {
  if (preset === 'auto') return null
  return { ...PRESETS[preset] }
}

export function stepTessellationSummary(preset: StepTessellationPreset): string {
  switch (preset) {
    case 'auto':
      return 'Library default linear/angular deflection.'
    case 'coarse':
      return 'Faster import, fewer triangles — good for huge assemblies.'
    case 'balanced':
      return 'Middle ground for preview and most prints.'
    case 'fine':
      return 'Smoother curves, more triangles — slower and heavier in the viewer.'
    default:
      return ''
  }
}
