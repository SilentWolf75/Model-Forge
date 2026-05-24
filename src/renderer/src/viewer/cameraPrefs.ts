export type CameraPresetId = 'default' | 'quick'

const STORAGE_KEY = 'modelForge.cameraPreset.v1'

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
