/**
 * Windows pack helper: avoids electron-builder downloading the "winCodeSign" 7z when possible.
 * That archive contains macOS dylib symlinks; extracting it on Windows fails with:
 *   "Cannot create symbolic link : A required privilege is not held by the client"
 * unless Developer Mode is on (Settings → Privacy & security → For developers).
 *
 * Mitigations used here:
 * - `signAndEditExecutable: false` + `afterPack` rcedit (see scripts/after-pack-rcedit.cjs) so
 *   winCodeSign is not downloaded; rcedit runs before ASAR integrity is embedded.
 * - Clear common signing env vars so unsigned local builds do not pull signing tools.
 * - If Windows SDK signtool.exe exists, set SIGNTOOL_PATH so signing never asks for winCodeSign.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

for (const k of ['WIN_CSC_LINK', 'CSC_LINK', 'CSC_NAME', 'CSC_FILE', 'CSC_FOR_WIN', 'WIN_CSC_KEY_PASSWORD']) {
  delete process.env[k]
}

function findSigntool() {
  const kitsRoot = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  try {
    const versions = fs.readdirSync(kitsRoot).filter((n) => /^\d/.test(n)).sort().reverse()
    for (const ver of versions) {
      const candidate = path.join(kitsRoot, ver, 'x64', 'signtool.exe')
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {
    /* no Kits */
  }
  return null
}

const signtool = findSigntool()
if (signtool) {
  process.env.SIGNTOOL_PATH = signtool
}

const extra = process.argv.slice(2)
const ebArgs = extra.length > 0 ? extra : ['--win']

const result = spawnSync('electron-builder', ebArgs, {
  stdio: 'inherit',
  shell: true,
  env: process.env
})

process.exit(result.status === null ? 1 : result.status)
