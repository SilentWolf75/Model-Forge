import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('api', {
  openFileDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFile'),
  saveFileDialog: (ext: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFile', ext),
  readFile: (filePath: string): Promise<Uint8Array> => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath: string, data: Uint8Array): Promise<void> =>
    ipcRenderer.invoke('fs:writeFile', filePath, data),
  /** Registers a successfully opened file with the OS recent list (Jump List / Recent). */
  addRecentDocument: (filePath: string): Promise<void> => ipcRenderer.invoke('recent:add', filePath),
  getPendingOpenFile: (): Promise<string | null> => ipcRenderer.invoke('get-pending-open-file'),
  subscribeExternalFileOpen: (handler: (filePath: string) => void): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, filePath: string): void => {
      handler(filePath)
    }
    ipcRenderer.on('open-external-file', listener)
    return () => {
      ipcRenderer.removeListener('open-external-file', listener)
    }
  },
  /** Real path for a dropped file in Electron; empty string if unavailable (e.g. non-file drag). */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  /** Open a file path in the OS default application (e.g. the default slicer for .3mf). Returns error string or empty string on success. */
  openPath: (filePath: string): Promise<string> => ipcRenderer.invoke('shell:openPath', filePath),
  /** Returns the last 5 files opened in this app (from userData/recent-files.json). */
  getRecentFiles: (): Promise<Array<{ path: string; name: string; timestamp: number; thumb?: string }>> =>
    ipcRenderer.invoke('recent:getList'),
  /** Attach a small thumbnail data URL to a recent-files entry. */
  setRecentThumbnail: (filePath: string, thumbDataUrl: string): Promise<void> =>
    ipcRenderer.invoke('recent:setThumbnail', filePath, thumbDataUrl),
  /** Clears the recent files list. */
  clearRecentFiles: (): Promise<void> => ipcRenderer.invoke('recent:clear'),
  /** Get persisted app settings. */
  getSettings: (): Promise<{ slicerPath?: string; firstRunDone?: boolean }> => ipcRenderer.invoke('settings:get'),
  /** Persist a partial settings patch. */
  saveSettings: (patch: { slicerPath?: string; firstRunDone?: boolean }): Promise<void> => ipcRenderer.invoke('settings:set', patch),
  /** Open a file-picker for the slicer executable; returns chosen path or null. */
  browseSlicer: (): Promise<string | null> => ipcRenderer.invoke('settings:browseSlicer')
})
