/**
 * Writes build/icon.png (512×512) for electron-builder (Windows .exe).
 * Uses assets/app-icon.png when present; otherwise falls back to the built-in SVG mark.
 * Run: npm run icons
 */
import { existsSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outDir = join(root, 'build')
const outFile = join(outDir, 'icon.png')
const outIco = join(outDir, 'icon.ico')
const sourcePng = join(root, 'assets', 'app-icon.png')
const size = 512

/**
 * Transparent PNGs often leave margin around the subject; `contain` shrinks the whole bitmap so the glyph looks tiny vs icons that bleed to the edges.
 * Trim alpha, then scale with cover + slight zoom so the cube fills the square like typical first-party icons (may clip a hair of glow at corners).
 */
const TRIM_ALPHA_THRESHOLD = 4
const SUBJECT_ZOOM = 1.02  // cube+glow already fills the frame; minimal zoom avoids clipping glow edges

/** Windows Explorer picks layers by size; shortcut `icon index 0` is the first image — use 256 first so desktop large icons stay sharp. */
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]

/**
 * Encode an ICO file by embedding each size as a raw PNG blob.
 *
 * Windows Vista+ supports "PNG-in-ICO" (RFC-style) which preserves full
 * 32-bit RGBA including the alpha channel.  The older approach of writing BMP
 * DIBs for small sizes loses the alpha channel and renders transparent areas
 * as solid black.  By storing every layer as a PNG blob we guarantee correct
 * transparency at every size.
 *
 * ICO binary layout:
 *   6-byte header  →  N × 16-byte directory entries  →  N × PNG blobs
 */
async function writeIcoFromSquarePng(masterPath) {
  // Collect PNG buffers for each size
  const layers = await Promise.all(
    ICO_SIZES.map(async (s) => {
      const png = await sharp(masterPath)
        .resize(s, s, { fit: 'fill', kernel: 'lanczos3' })
        .png()
        .toBuffer()
      return { s, png }
    })
  )

  const n = layers.length
  const headerSize = 6
  const dirSize = 16 * n
  let offset = headerSize + dirSize

  // ICONDIR header (6 bytes)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)   // reserved
  header.writeUInt16LE(1, 2)   // type = 1 (icon)
  header.writeUInt16LE(n, 4)   // image count

  // Directory entries (16 bytes each)
  const dir = Buffer.alloc(dirSize)
  let di = 0
  for (const { s, png } of layers) {
    dir.writeUInt8(s >= 256 ? 0 : s, di)      // width  (0 = 256)
    dir.writeUInt8(s >= 256 ? 0 : s, di + 1)  // height (0 = 256)
    dir.writeUInt8(0, di + 2)                  // color count
    dir.writeUInt8(0, di + 3)                  // reserved
    dir.writeUInt16LE(1, di + 4)               // planes
    dir.writeUInt16LE(32, di + 6)              // bit count
    dir.writeUInt32LE(png.length, di + 8)      // byte count
    dir.writeUInt32LE(offset, di + 12)         // offset
    offset += png.length
    di += 16
  }

  const buf = Buffer.concat([header, dir, ...layers.map((l) => l.png)])
  await writeFile(outIco, buf)
  console.log('Wrote', outIco, '(' + ICO_SIZES.join(', ') + ' px, PNG-in-ICO 32-bit RGBA)')
}

/**
 * If the source PNG has a solid black background (common for AI-generated icon art),
 * strip it by mapping luminosity → alpha: alpha = clamp(max(R,G,B) × 2.2, 0, 255).
 * Pure black becomes transparent; fully-coloured pixels stay opaque; soft glows are preserved.
 * Returns the path of a temp transparent PNG (or inPath if no stripping needed).
 */
/**
 * Always applied: for every pixel set alpha = min(originalAlpha, max(R,G,B) × 3).
 *
 * This turns solid-black pixels transparent (max=0 → alpha=0) while keeping any
 * pixel with real colour fully opaque (max≥85 → clamped to 255).  Soft glow
 * pixels in the mid-range get proportional opacity.  Already-transparent pixels
 * are untouched (min of 0 and anything = 0).  Safe to run on images that already
 * have a transparent background — it's a no-op for them.
 */
async function stripBlackBackground(inPath, tmpPath) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const out = Buffer.from(data)
  for (let i = 0; i < out.length; i += 4) {
    const lum = Math.max(out[i], out[i + 1], out[i + 2])
    out[i + 3] = Math.min(out[i + 3], Math.min(255, lum * 3))
  }
  await sharp(out, { raw: { width, height, channels } }).png().toFile(tmpPath)
  console.log('  Black background stripped (luminosity-to-alpha ×3)')
  return tmpPath
}

async function squareIconFromSourcePng(inPath, px) {
  const tmpPath = inPath.replace(/\.png$/i, '_nobg_tmp.png')
  const srcPath = await stripBlackBackground(inPath, tmpPath)
  const base = sharp(srcPath).trim({ threshold: TRIM_ALPHA_THRESHOLD })
  const meta = await base.clone().metadata()
  const w = meta.width ?? px
  const h = meta.height ?? px
  const scale = Math.max(px / w, px / h) * SUBJECT_ZOOM
  const rw = Math.max(px, Math.ceil(w * scale))
  const rh = Math.max(px, Math.ceil(h * scale))
  // Buffer the processed output first, then clean up any temp file, then return a
  // fresh pipeline from the buffer so the caller can .toFile() it safely.
  const buf = await sharp(srcPath)
    .trim({ threshold: TRIM_ALPHA_THRESHOLD })
    .resize(rw, rh, { fit: 'fill' })
    .extract({
      left: Math.max(0, Math.floor((rw - px) / 2)),
      top: Math.max(0, Math.floor((rh - px) / 2)),
      width: px,
      height: px
    })
    .png()
    .toBuffer()
  if (srcPath !== inPath) await rm(srcPath, { force: true })
  return sharp(buf).png()
}

async function fromSourcePng() {
  await mkdir(outDir, { recursive: true })
  const pipeline = await squareIconFromSourcePng(sourcePng, size)
  await pipeline.toFile(outFile)
  console.log('Wrote', outFile, 'from', sourcePng, `(trim + cover ×${SUBJECT_ZOOM})`)
  await writeIcoFromSquarePng(outFile)
}

async function fromSvgFallback() {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="8%" y1="0%" x2="92%" y2="100%">
      <stop offset="0%" style="stop-color:#4aa3ff"/>
      <stop offset="100%" style="stop-color:#6b4dff"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.19)}" fill="#0e1016"/>
  <rect x="32" y="32" width="${size - 64}" height="${size - 64}" rx="${Math.round(size * 0.14)}" fill="url(#g)"/>
  <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle"
    font-family="Segoe UI, system-ui, sans-serif" font-size="200" font-weight="700" fill="#ffffff">MF</text>
</svg>`

  await mkdir(outDir, { recursive: true })
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outFile)
  console.log('Wrote', outFile, '(SVG fallback — add assets/app-icon.png to use your artwork)')
  await writeIcoFromSquarePng(outFile)
}

if (existsSync(sourcePng)) {
  await fromSourcePng()
} else {
  await fromSvgFallback()
}
