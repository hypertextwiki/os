import { copyFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

const files = [
  'README.md',
  'index.html',
  'package.json',
  'vite.config.js',
  'servers/local.js',
  'servers/github.js',
  'TEMPLATE.env',
]

const DEST = 'data/main/src'

for (const f of files) {
  const dest = join(DEST, f)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(f, dest)
  console.log(`Copied ${f} → ${dest}`)
}
