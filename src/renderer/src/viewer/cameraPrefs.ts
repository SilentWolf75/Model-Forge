export type CameraPresetId = 'default' | 'quick'

const STORAGE_KEY = 'modelForge.cameraPreset.v1'

export type CameraDynamics = {
  wheelPrecision: number
  panningSensibility: number
  wheelDeltaBoost: number
  panningInertia: number
}

export const CAMERA_PRESETS: Record<CameraPresetId, CameraDynamics> = {
  default: {
    wheelPrecision: 0.52,
    panningSensibility: 20,
    wheelDeltaBoost: 1.28,
    panningInertia: 0.3
  },
  quick: {
    wheelPrecision: 0.26,
    panningSensibility: 7,
    wheelDeltaBoost: 1.95,
    panningInertia: 0.22
  }
}

export function readStoredCameraPresetId(): CameraPresetId {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'default' || v === 'quick') return v
  } catch {
    /* private mode / SSR */
  }
  return 'quick'
}

export function writeStoredCameraPresetId(id: CameraPresetId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}
