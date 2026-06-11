export interface AppApi {
  openFileDialog: () => Promise<string | null>
  saveFileDialog: (ext: string) => Promise<string | null>
  readFile: (filePath: string) => Promise<Uint8Array>
  writeFile: (filePath: string, data: Uint8Array) => Promise<void>
  addRecentDocument: (filePath: string) => Promise<void>
  /** Path passed on startup (double-click file); cleared after first read. */
  getPendingOpenFile: () => Promise<string | null>
  /** Further opens while the app is running (second instance, macOS open-file). */
  subscribeExternalFileOpen: (handler: (filePath: string) => void) => () => void
  /** Path on disk for a file from drag-and-drop; empty string if not available. */
  getPathForFile: (file: File) => string
  /** Open a file path in the OS default application. Returns error string or empty on success. */
  openPath: (filePath: string) => Promise<string>
  /** Returns the last 5 files opened in this app. */
  getRecentFiles: () => Promise<Array<{ path: string; name: string; timestamp: number; thumb?: string }>>
  /** Attach a small thumbnail data URL to a recent-files entry. */
  setRecentThumbnail: (filePath: string, thumbDataUrl: string) => Promise<void>
  /** Clears the recent files list. */
  clearRecentFiles: () => Promise<void>
  /** Get persisted app settings. */
  getSettings: () => Promise<{ slicerPath?: string; firstRunDone?: boolean }>
  /** Persist a partial settings patch. */
  saveSettings: (patch: { slicerPath?: string; firstRunDone?: boolean }) => Promise<void>
  /** Open a file-picker for the slicer executable; returns chosen path or null. */
  browseSlicer: () => Promise<string | null>
}

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
