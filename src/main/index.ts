import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { exec } from 'child_process'

const MODEL_EXT = new Set(['stl', 'obj', '3mf', 'step', 'stp', 'ply', 'fbx', 'glb', 'gltf', 'amf'])

function extensionOf(filePath: string): string {
  const i = filePath.lastIndexOf('.')
  return i >= 0 ? filePath.slice(i + 1).toLowerCase() : ''
}

/** Path to a model file passed on the command line (Windows default app, dev, etc.). */
function fileArgFromArgv(argv: readonly string[]): string | null {
  for (let i = argv.length - 1; i >= 1; i--) {
    const arg = argv[i]
    if (!arg || arg.startsWith('-')) continue
    const ext = extensionOf(arg)
    if (!MODEL_EXT.has(ext)) continue
    try {
      if (existsSync(arg)) return arg
    } catch {
      /* path may be unusual; still try to load */
    }
    return arg
  }
  return null
}

/** Block Chromium from loading dropped files as the document (replaces the app with a blank view). */
function shouldBlockNavigationToUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') {
      const p = u.pathname.toLowerCase().replace(/\\/g, '/')
      if (p.endsWith('.html') || p.endsWith('/')) return false
      return true
    }
  } catch {
    return false
  }
  return false
}

function loadAppShell(win: BrowserWindow): void {
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

let mainWindow: BrowserWindow | null = null
/** File to open before the renderer can subscribe to IPC (cold start, macOS open-file). */
let pendingExternalPath: string | null = null

/** PNG path for taskbar / window chrome (not the same as the .exe icon on Windows). */
function windowIconPath(): string | undefined {
  if (app.isPackaged) {
    const fromResources = join(process.resourcesPath, 'icon.png')
    if (existsSync(fromResources)) return fromResources
  }
  const fromBuild = join(process.cwd(), 'build', 'icon.png')
  if (existsSync(fromBuild)) return fromBuild
  return undefined
}

const WIN_MIN_W = 960
const WIN_MIN_H = 640

type PersistedWindowState = {
  fullscreen?: boolean
  maximized?: boolean
  bounds?: { x: number; y: number; width: number; height: number }
}

function windowStateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadPersistedWindowState(): PersistedWindowState | null {
  try {
    const p = windowStateFile()
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8')) as PersistedWindowState
    if (j.bounds) {
      const { width, height } = j.bounds
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null
      if (width < WIN_MIN_W || height < WIN_MIN_H) return null
    }
    return j
  } catch {
    return null
  }
}

function savePersistedWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  try {
    const st: PersistedWindowState = {
      fullscreen: win.isFullScreen(),
      maximized: win.isMaximized(),
      bounds: win.getBounds()
    }
    writeFileSync(windowStateFile(), JSON.stringify(st), 'utf8')
  } catch {
    /* ignore disk errors */
  }
}

// ── Update checker ────────────────────────────────────────────────────────────
// Fine-grained PAT with "Metadata" read-only permission (cannot access code).
// Create one at: github.com/settings/personal-access-tokens/new
//   → Fine-grained token → Repository: Model-Forge → Permissions: Metadata = Read-only
const UPDATE_REPO  = 'SilentWolf75/Model-Forge'
// Token is injected at build time from .env.local (local) or GitHub Secrets (CI).
// Never hardcode it here — GitHub will auto-revoke any token committed to the repo.
const UPDATE_TOKEN = (import.meta.env['MAIN_VITE_UPDATE_TOKEN'] as string) ?? ''

async function checkForUpdates(win: BrowserWindow): Promise<void> {
  if (!UPDATE_TOKEN) return
  try {
    const res = await fetch(
      `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      {
        headers: {
          'User-Agent':    'Model-Forge-Updater',
          'Accept':        'application/vnd.github+json',
          'Authorization': `Bearer ${UPDATE_TOKEN}`
        }
      }
    )
    if (!res.ok) return
    const data = await res.json() as { tag_name: string; html_url: string }
    const latest  = data.tag_name.replace(/^v/, '')
    const current = app.getVersion()
    if (latest === current) return
    const { response } = await dialog.showMessageBox(win, {
      type:      'info',
      title:     'Update Available',
      message:   `Model Forge ${data.tag_name} is available`,
      detail:    `You are running v${current}.\n\nWould you like to go to the download page?`,
      buttons:   ['Download', 'Later'],
      defaultId: 0,
      cancelId:  1
    })
    if (response === 0) shell.openExternal(data.html_url)
  } catch {
    // Best-effort — silently ignore network errors
  }
}

function createWindow(): void {
  const icon = windowIconPath()
  const saved = loadPersistedWindowState()
  let width = 1280
  let height = 800
  let x: number | undefined
  let y: number | undefined
  const b = saved?.bounds
  if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) {
    width = Math.max(WIN_MIN_W, Math.min(7680, Math.floor(b.width)))
    height = Math.max(WIN_MIN_H, Math.min(4320, Math.floor(b.height)))
    if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
      x = Math.floor(b.x)
      y = Math.floor(b.y)
    }
  }
  const win = new BrowserWindow({
    width,
    height,
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    minWidth: WIN_MIN_W,
    minHeight: WIN_MIN_H,
    show: false,
    autoHideMenuBar: true,
    /** Avoid blank white window before the renderer paints (matches app dark theme). */
    backgroundColor: '#0c0d10',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      /** Extra guard: do not turn file drops into top-level navigations. */
      navigateOnDragDrop: false
    }
  })
  mainWindow = win

  win.on('closed', () => {
    mainWindow = null
  })

  win.on('close', () => {
    savePersistedWindowState(win)
  })

  win.on('ready-to-show', () => {
    const wantFs = Boolean(saved?.fullscreen)
    const wantMax = Boolean(saved?.maximized)
    if (wantFs) {
      win.setFullScreen(true)
    } else if (wantMax) {
      win.maximize()
    }
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  /**
   * Dropping a model onto the window triggers a frame navigation to file:///…/model.stl.
   * In recent Electron, `will-frame-navigate` is what fires (not always `will-navigate`).
   */
  win.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) return
    if (shouldBlockNavigationToUrl(event.url)) {
      event.preventDefault()
    }
  })

  win.webContents.on('will-navigate', (event) => {
    if (!event.isMainFrame) return
    if (shouldBlockNavigationToUrl(event.url)) {
      event.preventDefault()
    }
  })

  /** If a bad navigation still completes, reload the app shell instead of staying on a blank/binary view. */
  win.webContents.on('did-navigate', (_event, url) => {
    if (shouldBlockNavigationToUrl(url)) {
      loadAppShell(win)
    }
  })

  loadAppShell(win)
}

function focusMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.focus()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const pathToOpen = fileArgFromArgv(argv)
    if (pathToOpen && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('open-external-file', pathToOpen)
      focusMainWindow()
    }
  })

  if (process.platform === 'darwin') {
    app.on('open-file', (event, filePath) => {
      event.preventDefault()
      pendingExternalPath = filePath
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('open-external-file', filePath)
      }
    })
  }

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.modelforge.viewer')
    }

    const fromArgv = fileArgFromArgv(process.argv)
    if (fromArgv) {
      pendingExternalPath = fromArgv
    }

    ipcMain.handle('dialog:openFile', async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Open 3D model',
        properties: ['openFile'],
        filters: [
          { name: '3D models', extensions: ['stl', 'obj', '3mf', 'glb', 'gltf', 'amf', 'ply', 'fbx', 'step', 'stp'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (canceled || filePaths.length === 0) return null
      return filePaths[0]
    })

    ipcMain.handle('fs:readFile', async (_, filePath: string) => {
      const buf = await readFile(filePath)
      return Buffer.from(buf)
    })

    ipcMain.handle('fs:writeFile', async (_, filePath: string, data: Uint8Array | Buffer) => {
      const body = Buffer.isBuffer(data) ? data : Buffer.from(data)
      await writeFile(filePath, body)
    })

    ipcMain.handle('recent:add', async (_, filePath: string) => {
      if (typeof filePath !== 'string' || filePath.length === 0) return
      try {
        if (existsSync(filePath)) app.addRecentDocument(filePath)
      } catch {
        /* ignore invalid paths */
      }
      try {
        const listPath = join(app.getPath('userData'), 'recent-files.json')
        type RecentEntry = { path: string; name: string; timestamp: number }
        let list: RecentEntry[] = []
        if (existsSync(listPath)) {
          try {
            list = JSON.parse(readFileSync(listPath, 'utf8')) as RecentEntry[]
          } catch { /* corrupt file */ }
        }
        const name = filePath.split(/[/\\]/).pop() ?? filePath
        list = list.filter((f) => f.path !== filePath)
        list.unshift({ path: filePath, name, timestamp: Date.now() })
        writeFileSync(listPath, JSON.stringify(list.slice(0, 5)), 'utf8')
      } catch { /* ignore disk errors */ }
    })

    ipcMain.handle('recent:getList', () => {
      try {
        const listPath = join(app.getPath('userData'), 'recent-files.json')
        if (!existsSync(listPath)) return []
        const list = JSON.parse(readFileSync(listPath, 'utf8'))
        return Array.isArray(list) ? list.slice(0, 5) : []
      } catch {
        return []
      }
    })

    ipcMain.handle('recent:clear', () => {
      try {
        const listPath = join(app.getPath('userData'), 'recent-files.json')
        writeFileSync(listPath, JSON.stringify([]), 'utf8')
        app.clearRecentDocuments()
      } catch { /* ignore */ }
    })

    // ── App settings ────────────────────────────────────────────────────────
    type AppSettings = { slicerPath?: string; firstRunDone?: boolean }
    const settingsPath = join(app.getPath('userData'), 'settings.json')

    const loadSettings = (): AppSettings => {
      try { return JSON.parse(readFileSync(settingsPath, 'utf8')) as AppSettings } catch { return {} }
    }
    const saveSettings = (patch: Partial<AppSettings>): void => {
      try { writeFileSync(settingsPath, JSON.stringify({ ...loadSettings(), ...patch }, null, 2), 'utf8') } catch { /* ignore */ }
    }

    /** Common Windows install paths for Bambu Studio and Orca Slicer. */
    const autoDetectSlicer = (): string | null => {
      if (process.platform !== 'win32') return null
      const lad = process.env.LOCALAPPDATA ?? ''
      const pf  = process.env.ProgramFiles ?? 'C:\\Program Files'
      const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
      const candidates = [
        join(pf,  'Bambu Studio', 'bambu-studio.exe'),
        join(lad, 'Programs', 'Bambu Studio', 'bambu-studio.exe'),
        join(pf,  'BambuStudio', 'bambu-studio.exe'),
        join(lad, 'BambuStudio', 'bambu-studio.exe'),
        join(pf,  'OrcaSlicer', 'orca-slicer.exe'),
        join(lad, 'Programs', 'OrcaSlicer', 'orca-slicer.exe'),
        join(pf86,'OrcaSlicer', 'orca-slicer.exe'),
      ]
      return candidates.find(existsSync) ?? null
    }

    ipcMain.handle('settings:get', () => {
      const s = loadSettings()
      // Auto-detect slicer on first call if not yet set
      if (!s.slicerPath) {
        const found = autoDetectSlicer()
        if (found) { s.slicerPath = found; saveSettings({ slicerPath: found }) }
      }
      return s
    })

    ipcMain.handle('settings:set', (_, patch: Partial<AppSettings>) => {
      saveSettings(patch)
    })

    ipcMain.handle('settings:browseSlicer', async () => {
      const win = BrowserWindow.getFocusedWindow()
      const result = await dialog.showOpenDialog(win!, {
        title: 'Select your slicer executable',
        filters: process.platform === 'win32'
          ? [{ name: 'Executable', extensions: ['exe'] }]
          : [{ name: 'Application', extensions: ['app', '*'] }],
        properties: ['openFile']
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    })

    ipcMain.handle('shell:openPath', async (_, filePath: string) => {
      if (process.platform !== 'win32') return shell.openPath(filePath)
      const s = loadSettings()
      const slicerExe = s.slicerPath && existsSync(s.slicerPath) ? s.slicerPath : null
      if (!slicerExe) return 'no-slicer'
      return new Promise<string>((resolve) => {
        const safeExe  = slicerExe.replace(/"/g, '\\"')
        const safeFile = filePath.replace(/"/g, '\\"')
        exec(`"${safeExe}" "${safeFile}"`, (error) => resolve(error ? error.message : ''))
      })
    })

    ipcMain.handle('dialog:saveFile', async (_, ext: string) => {
      const filters: Electron.FileFilter[] = []
      if (ext === 'stl') filters.push({ name: 'STL', extensions: ['stl'] })
      else if (ext === 'obj') filters.push({ name: 'OBJ', extensions: ['obj'] })
      else if (ext === '3mf') filters.push({ name: '3MF', extensions: ['3mf'] })
      else if (ext === 'step' || ext === 'stp')
        filters.push({ name: 'STEP', extensions: ['step', 'stp'] })
      else if (ext === 'png') filters.push({ name: 'PNG image', extensions: ['png'] })
      else filters.push({ name: 'All', extensions: ['*'] })

      const title = ext === 'png' ? 'Save screenshot' : 'Export model'
      const { canceled, filePath } = await dialog.showSaveDialog({
        title,
        filters
      })
      if (canceled || !filePath) return null
      return filePath
    })

    ipcMain.handle('get-pending-open-file', () => {
      const p = pendingExternalPath
      pendingExternalPath = null
      return p
    })

    createWindow()

    // Check for updates ~3 s after startup so the window is fully loaded first
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        void checkForUpdates(mainWindow)
      }
    }, 3000)

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
