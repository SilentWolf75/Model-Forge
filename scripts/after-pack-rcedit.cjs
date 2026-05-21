/**
 * Patch the packaged Windows exe (icon + version resources) *after* the build
 * finishes copying files and Electron embeds ASAR integrity. That step rewrites
 * the PE with resedit; applying the icon here keeps the ICO from being lost.
 *
 * Requires `signAndEditExecutable: false` and `npm run icons` so build/icon.ico exists.
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { setTimeout: delay } = require('timers/promises')

async function rceditExeSafe(exePath, options) {
  const { rcedit } = await import('rcedit')
  const base = path.basename(exePath)
  const work = path.join(os.tmpdir(), `model-forge-rcedit-${process.pid}-${Date.now()}-${base}`)
  await fs.promises.copyFile(exePath, work)
  try {
    await rcedit(work, options)
    for (let i = 0; i < 8; i++) {
      try {
        await fs.promises.copyFile(work, exePath)
        return
      } catch (e) {
        if (i === 7) throw e
        await delay(120 * (i + 1))
      }
    }
  } finally {
    await fs.promises.unlink(work).catch(() => {})
  }
}

function quadVersion(semver) {
  const s = String(semver ?? '1.0.0')
  const core = s.split('-')[0].split('+')[0]
  const parts = core.split('.').map((p) => parseInt(p, 10) || 0)
  const a = parts[0] ?? 0
  const b = parts[1] ?? 0
  const c = parts[2] ?? 0
  return `${a}.${b}.${c}.0`
}

module.exports = async (context) => {
  if (context.electronPlatformName !== 'win32') return

  const projectDir = context.packager.info.projectDir
  const appInfo = context.packager.appInfo
  const cfg = context.packager.config
  const exeName = `${appInfo.productFilename}.exe`
  const exe = path.join(context.appOutDir, exeName)
  const ico = path.join(projectDir, 'build', 'icon.ico')

  if (!fs.existsSync(exe)) {
    console.warn('[afterPack-rcedit] exe not found:', exe)
    return
  }
  if (!fs.existsSync(ico)) {
    console.warn('[afterPack-rcedit] build/icon.ico missing — run: npm run icons')
    return
  }

  const metadata = context.packager.info.metadata
  const semver = appInfo.shortVersion || cfg.buildVersion || metadata.version
  const version = quadVersion(semver)
  const displayVersion = metadata.displayVersion || semver
  const desc = cfg.description || appInfo.productName
  const author = typeof cfg.author === 'string' ? cfg.author : cfg.author?.name || ''

  const versionString = {
    FileDescription: desc,
    ProductName: appInfo.productName,
    ProductVersion: displayVersion,
    LegalCopyright: cfg.copyright || '',
    InternalName: `${appInfo.productFilename}.exe`,
    OriginalFilename: `${appInfo.productFilename}.exe`
  }
  if (author) {
    versionString.CompanyName = author
  }

  await rceditExeSafe(exe, {
    icon: ico,
    'file-version': version,
    'product-version': version,
    'version-string': versionString
  })
}
