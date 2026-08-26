import { readFileSync, writeFileSync, statSync } from 'fs'
import { readdir } from 'fs/promises'
import { resolve, join, extname } from 'path'

const ROOT = resolve(process.cwd())

// ── llms.txt manifest ──
const SECTIONS = [
  {
    title: 'Kernel',
    items: [
      { path: '/', title: 'QRx Kernel', desc: 'The live generative OS — a single HTML file that turns any browser into an offline-first REPL using URL hashes as a command tape and IndexedDB as a filesystem' },
      { path: '/llms-full.txt', title: 'Complete Source Corpus', desc: 'Every project file concatenated with <context> tags for deep LLM ingestion' },
    ]
  },
  {
    title: 'Core Source',
    items: [
      { path: '/data/main/src/README.md', title: 'README', desc: 'Project overview, kernel API reference, server setup, build pipeline, and developer notes' },
      { path: '/data/main/src/index.html', title: 'Kernel Source', desc: 'The bare kernel HTML — the entire OS in one file, minified to fit inside a QR code' },
      { path: '/data/main/src/package.json', title: 'Package Manifest', desc: 'Dependencies, npm scripts, and project metadata' },
      { path: '/data/main/src/vite.config.js', title: 'Build Configuration', desc: 'Vite build pipeline, QR code generation, bootloader injection, and PWA setup' },
      { path: '/data/main/src/TEMPLATE.env', title: 'Environment Template', desc: 'Configuration template for sync key, namespaces, and server port' },
    ]
  },
  {
    title: 'Server',
    items: [
      { path: '/data/main/src/servers/local.js', title: 'Local Server', desc: 'Express-based server with namespace routing, SSE streaming, auth, and IndexedDB sync' },
      { path: '/data/main/src/servers/github.js', title: 'GitHub Pages Build', desc: 'Pre-build step that mirrors server namespace logic for static hosting' },
    ]
  },
  {
    title: 'Guides',
    items: [
      { path: '/data/main/docs/hyperprompting-guide.md', title: 'Hyperprompting Guide', desc: 'Protocol specification, chain-authoring grammar, and debugging workflow for the QRx machine tape' },
      { path: '/data/reddit/posts/hyperprompting/260621-how-to-llm-wrap-hyperlinks.md', title: 'LLM-Wrap Tutorial', desc: 'How to create serverless Data URI hyperlinks and QR codes that generate ephemeral apps' },
    ]
  },
  {
    title: 'Theory',
    items: [
      { path: '/data/reddit/posts/hyperprompting/260620-welcome-to-hyperprompting.md', title: 'Welcome to Hyperprompting', desc: 'Introduction to the subreddit, the teleology of hypertext, and the project north star' },
      { path: '/data/reddit/posts/hyperprompting/260731-what-is-a-dataverse.md', title: 'What is a Dataverse', desc: 'Theory on digital universes, knowledge graphs, and the Ruliad as hypertext' },
      { path: '/data/reddit/posts/hyperprompting/260810-links-that-click-themselves.md', title: 'Links That Click Themselves', desc: 'On autopoietic hypertext, multiversal simulators, and links that navigate themselves' },
      { path: '/data/reddit/posts/hyperprompting/260811-generative-sneakernets.md', title: 'Generative Sneakernets', desc: 'Distributing code on paper via QR codes and regenerative zines' },
      { path: '/data/reddit/posts/hyperprompting/260622-towards-hypercompression-of-autopoietic-hypertext.md', title: 'Hypercompression Theory', desc: 'Semantic compression and the upper limits of QR-based hyperprompts' },
      { path: '/data/reddit/posts/hyperprompting/260814-autopoeitic-hypertext.md', title: 'Autopoietic Hypertext', desc: 'On hypertext that produces and maintains its own context' },
      { path: '/data/reddit/posts/labofoz/260811-welcome-to-labofoz.md', title: 'Welcome to Lab of Oz', desc: 'Towards a radio-based decentralized commune and radical gnosis' },
    ]
  },
  {
    title: 'Build',
    items: [
      { path: '/data/reddit/posts/hyperprompting/260624-towards-social-os.md', title: 'Social OS Devlog', desc: 'Building a social operating system with the Reddit port of the kernel' },
      { path: '/data/reddit/posts/hyperprompting/260816-minesweeper.md', title: 'Minesweeper Demo', desc: 'Interactive Minesweeper built with the Reddit port of the hyperprompting kernel' },
    ]
  },
  {
    title: 'Optional',
    items: [
      { path: '/data/reddit/posts/interactivefiction/260810-nonlinear-narratives.md', title: 'Nonlinear Narratives', desc: 'Technique for creating nonlinear narratives from swappable story segments' },
      { path: '/data/reddit/posts/labofoz/260812-cyborgmorphism.md', title: 'Cyborgmorphism', desc: 'On physically extended reality creatures and cyborgmorphism' },
      { path: '/data/reddit/posts/labofoz/260818-why-i-turned-down-openai.md', title: 'Why I Turned Down OpenAI', desc: 'Personal devlog on turning down OpenAI, Google, and Microsoft' },
      { path: '/data/reddit/posts/hyperprompting/260629-what-cybernetics-books-are-you-reading.md', title: 'Cybernetics Reading List', desc: 'Foundational cybernetics books and study approach' },
    ]
  }
]

function buildLlmsTxt() {
  const lines = [
    '# QRx',
    '',
    '> A browser-based generative operating system. QRx turns any browser into an offline-first REPL for prompting and vibe-coding, using IndexedDB as a filesystem, URL hashes as a command tape, and AI generation for code synthesis.',
    '',
    'QRx is designed to be entirely self-contained in a single HTML file that can be encoded as a QR code. The kernel exposes a minimal API for reading, writing, executing, and generating content via LLM prompts.',
    ''
  ]
  for (const s of SECTIONS) {
    lines.push(`## ${s.title}`)
    lines.push('')
    for (const item of s.items) {
      lines.push(`- [${item.title}](${item.path}): ${item.desc}`)
    }
    lines.push('')
  }
  lines.push(`Last reviewed: ${new Date().toISOString().split('T')[0]}`)
  writeFileSync(join(ROOT, 'public', 'llms.txt'), lines.join('\n'))
  console.log('Wrote public/llms.txt')
}

// ── llms-full.txt ──
const FULL_SOURCES = ['.', 'servers', 'data/main/docs', 'data/main/src', 'data/reddit/posts']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.github', 'scripts', 'public', 'data'])
const SKIP_FILES = new Set(['llms-full.txt', 'llms.txt', 'package-lock.json', '.DS_Store', '.env'])
const TEXT_EXTS = new Set(['.md', '.html', '.js', '.json', '.css', '.txt', '.yml', '.yaml', '.sh'])

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

async function buildLlmsFull() {
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

async function main() {
  buildLlmsTxt()
  await buildLlmsFull()
}

main().catch(err => { console.error(err); process.exit(1) })
