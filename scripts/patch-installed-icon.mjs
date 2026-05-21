import { rcedit } from '../node_modules/rcedit/lib/index.js'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const exe = 'C:\\Program Files\\Model Forge\\Model Forge.exe'
const ico = join(root, 'build', 'icon.ico')

if (!existsSync(exe)) { console.error('Installed exe not found:', exe); process.exit(1) }
if (!existsSync(ico)) { console.error('icon.ico not found:', ico); process.exit(1) }

console.log('Patching icon in:', exe)
await rcedit(exe, { icon: ico })
console.log('Done — cube icon embedded in installed exe')
