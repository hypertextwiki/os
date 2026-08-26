import { readFileSync, writeFileSync, statSync } from 'fs'
import { readdir } from 'fs/promises'
import { resolve, join, extname } from 'path'

const ROOT = resolve(process.cwd())

const FULL_SOURCES = ['.', 'servers', 'data/main/docs', 'data/reddit/posts']

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.github', 'scripts', 'public', 'data'
])

const SKIP_FILES = new Set([
  'llms-full.txt', 'llms.txt', 'package-lock.json', '.DS_Store', '.env'
])

const TEXT_EXTS = new Set([
  '.md', '.html', '.js', '.json', '.css', '.txt', '.yml', '.yaml', '.sh'
])

async function walk(dir, base = '') {
  const results = []
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true })
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      results.push(...await walk(rel, rel))
    } else {
      if (e.name === 'TEMPLATE.env') {
        results.push(rel)
      } else {
        if (SKIP_FILES.has(e.name)) continue
        if (!TEXT_EXTS.has(extname(e.name))) continue
        results.push(rel)
      }
    }
  }
  return results
}

async function buildFull() {
  const all = []
  for (const src of FULL_SOURCES) {
    try { statSync(join(ROOT, src)) } catch { continue }
    all.push(...await walk(src, src === '.' ? '' : src))
  }
  const unique = [...new Set(all)].sort()
  const chunks = unique.map(f => {
    const raw = readFileSync(join(ROOT, f), 'utf-8')
    return `<context path="${f}">\n${raw}\n</context>`
  })
  writeFileSync(join(ROOT, 'public', 'llms-full.txt'), chunks.join('\n\n'))
  console.log(`Wrote public/llms-full.txt (${unique.length} files)`)
}

buildFull().catch(err => { console.error(err); process.exit(1) })
