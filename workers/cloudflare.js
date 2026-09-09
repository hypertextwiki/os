/**
 * workers/cloudflare.js
 *
 * Cloudflare Worker port of servers/local.js — same endpoint contract.
 *
 * Storage model (matches the GitHub Pages static build):
 *   - The baseline dataverse ships as static assets in dist/data/
 *     (public namespaces only, baked by servers/github.js at build time).
 *   - KV ("DATA" binding) holds deltas only: whatever was written via /write.
 *   - IndexedDB in the browser is a cache of both.
 *
 * Endpoints (identical shapes to local.js):
 *   POST /read                      { namespace, key } -> { value } | 404
 *   POST /write                     { namespace, key, value, clientId } -> { status: 'saved' } | 401
 *   GET  /data/index.json           -> ["namespace/key", ...] (static baseline ∪ public KV deltas)
 *   GET  /data/index.private.json   -> ["namespace/key", ...] (KV only, auth required)
 *   GET  /stream                    -> SSE heartbeat (placeholder until Durable Objects fan-out)
 *   GET  /*                         -> static assets from dist/, SPA fallback to index.html
 *
 * Read model:
 *   - Anonymous: static assets only. KV is never touched without a SYNC_KEY —
 *     unauthenticated traffic spends zero KV quota.
 *   - Key holders: KV first, then static assets, then the main fallback
 *     (KV, then assets). Private dataverses can live in KV safely because
 *     only key holders can ever read from KV.
 */

const ALWAYS_PUBLIC = ['main', 'cache']

const parseList = (s) =>
  (s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)

function isPublic(env, ns) {
  const set = new Set([...parseList(env.QRX_PUBLIC_NAMESPACES), ...ALWAYS_PUBLIC])
  return ns && set.has(ns.toLowerCase())
}

function isPrivate(env, ns) {
  return ns && parseList(env.QRX_PRIVATE_NAMESPACES).includes(ns.toLowerCase())
}

function authed(request, env) {
  return !!env.QRX_SYNC_KEY && request.headers.get('Authorization') === env.QRX_SYNC_KEY
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'OPTIONS, GET, POST',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  })
}

/** List all KV keys, following cursors. Returns full "namespace/key" strings. */
async function listAllKeys(env) {
  const out = []
  let cursor = undefined
  do {
    const page = await env.DATA.list({ cursor })
    for (const k of page.keys) out.push(k.name)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return out
}

/**
 * Fetch a baked baseline file from the static assets (dist/data/...).
 * Returns null on a miss. Mirrors the static bootloader's fetch path:
 * keys are used decoded, as in index.json.
 */
async function readStaticAsset(env, request, assetPath) {
  const res = await env.ASSETS.fetch(new URL(assetPath, request.url))
  if (!res.ok) return null
  return await res.text()
}

/**
 * POST /read — public namespaces readable without auth; everything else
 * requires the SYNC_KEY. Anonymous requests read static assets only and
 * never touch KV. Key holders read KV first, then assets. On a miss, the
 * same steps repeat against the main namespace.
 */
async function handleRead(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  const { namespace, key } = body || {}
  if (!namespace || key === undefined) return json({ error: 'Missing namespace or key' }, 400)

  const isAuthed = authed(request, env)
  if (!isAuthed && !isPublic(env, namespace)) {
    return json({ error: 'Namespace not in allowlist' }, 404)
  }

  let value = null
  if (isAuthed) value = await env.DATA.get(`${namespace}/${key}`)
  if (value === null) value = await readStaticAsset(env, request, `/data/${namespace}/${key}`)

  if (value === null && namespace.toLowerCase() !== 'main') {
    if (isAuthed) value = await env.DATA.get(`main/${key}`)
    if (value === null) value = await readStaticAsset(env, request, `/data/main/${key}`)
  }

  if (value === null) return json({ error: 'Not found' }, 404)
  return json({ value })
}

/** POST /write — requires SYNC_KEY. Writes are KV deltas; the baseline is never touched. */
async function handleWrite(request, env) {
  if (env.QRX_SYNC_KEY && !authed(request, env)) {
    return json({ error: 'Unauthorized' }, 401)
  }
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  const { namespace, key, value } = body || {}
  if (!namespace || !key) return json({ error: 'Missing namespace or key' }, 400)

  const kvKey = `${namespace}/${key}`
  if (kvKey.length > 512) return json({ error: 'Key too long' }, 400)

  await env.DATA.put(kvKey, value ?? '')
  return json({ status: 'saved' })
}

/**
 * GET /data/index.json — anonymous: the baked static index only (zero KV ops).
 * Key holders: static index unioned with live KV deltas in public namespaces.
 * GET /data/index.private.json — KV only (private namespaces are never
 * baked into assets), SYNC_KEY required.
 */
async function handleIndex(request, env, privateOnly) {
  if (privateOnly && !authed(request, env)) {
    return json({ error: 'Unauthorized' }, 401)
  }
  if (!privateOnly && !authed(request, env)) {
    const staticRaw = await readStaticAsset(env, request, '/data/index.json')
    return json(staticRaw ? JSON.parse(staticRaw) : [])
  }
  const kvKeys = (await listAllKeys(env)).filter((k) => {
    const ns = k.split('/')[0]
    return privateOnly ? isPrivate(env, ns) : isPublic(env, ns)
  })
  if (privateOnly) return json(kvKeys)

  const staticRaw = await readStaticAsset(env, request, '/data/index.json')
  const staticIndex = staticRaw ? JSON.parse(staticRaw) : []
  return json([...new Set([...staticIndex, ...kvKeys])])
}

/**
 * GET /stream — SSE placeholder. Holds the connection open with heartbeats so
 * EventSource clients (boot/sync) connect cleanly without reconnect-storming
 * the request quota. Real write notifications arrive with the Durable Object
 * fan-out phase; the client contract does not change.
 */
async function handleStream(request, env) {
  const url = new URL(request.url)
  if (env.QRX_SYNC_KEY && url.searchParams.get('auth') !== env.QRX_SYNC_KEY) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders() })
  }
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  const interval = setInterval(() => {
    writer.write(encoder.encode(': heartbeat\n\n')).catch(() => clearInterval(interval))
  }, 30000)
  writer.write(encoder.encode(': connected\n\n')).catch(() => {})
  return new Response(readable, {
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    try {
      if (request.method === 'POST' && url.pathname === '/read') return await handleRead(request, env)
      if (request.method === 'POST' && url.pathname === '/write') return await handleWrite(request, env)
      if (request.method === 'GET' && url.pathname === '/data/index.json') return await handleIndex(request, env, false)
      if (request.method === 'GET' && url.pathname === '/data/index.private.json') return await handleIndex(request, env, true)
      if (request.method === 'GET' && url.pathname === '/stream') return await handleStream(request, env)
    } catch (e) {
      return json({ error: e.message }, 500)
    }

    // Everything else: static assets, with SPA fallback to index.html
    // (configured via not_found_handling in wrangler.jsonc). Note this also
    // serves /data/<ns>/<key> baseline files directly — the same public
    // surface as the GitHub Pages build, which bakes only public namespaces.
    return env.ASSETS.fetch(request)
  },
}
