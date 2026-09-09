/**
 * workers/cloudflare.js
 *
 * Cloudflare Worker port of servers/local.js — same endpoint contract.
 *
 * Storage model:
 *   - Baseline: static assets in dist/data/ (public namespaces only, baked
 *     by servers/github.js at build time). Read-only between deploys.
 *   - Deltas: D1 ("DB" binding). Everything written via /write lives here.
 *     Strongly consistent — you always see your own write.
 *   - Edge cache: anonymous reads are cached per edge location (Cache API)
 *     with a long TTL (CACHE_TTL_SECONDS, default 1 day). /write purges the
 *     affected entries; the TTL is the backstop when a purge can't reach a
 *     given edge location. Keyed (SYNC_KEY) requests are never cached.
 *   - IndexedDB in the browser: each visitor's local cache of all of the above.
 *
 * Endpoints (identical shapes to local.js, plus one addition):
 *   POST /read                       { namespace, key } -> { value } | 404
 *   POST /write                      { namespace, key, value, clientId } -> { status: 'saved' } | 401
 *   GET  /data/index.json            -> ["namespace/key", ...] (baseline ∪ public deltas)
 *   GET  /data/index.private.json    -> ["namespace/key", ...] (D1 only, auth required)
 *   GET  /data/<namespace>/<key>     -> raw file content (live: D1 first, then baked asset)
 *   GET  /stream                     -> SSE heartbeat (placeholder until Durable Objects fan-out)
 *   GET  /*                          -> static assets, SPA fallback to index.html
 *
 * Anonymous traffic is served from cache/assets and costs ~zero quota.
 * Only key holders can write, read private namespaces, or bypass the cache.
 */

const ALWAYS_PUBLIC = ['main', 'cache']

// D1 rows cap at 2 MB. Should never matter for hypertext — fail loudly
// instead of corrupting silently.
const MAX_VALUE_BYTES = 1_900_000

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

/* ---------- D1 ---------- */

async function dbRead(env, ns, key) {
  const row = await env.DB.prepare('SELECT v FROM files WHERE ns = ? AND k = ?')
    .bind(ns, key)
    .first('v')
  return row === null ? null : row
}

/** All stored deltas as "namespace/key" strings. */
async function listAllKeys(env) {
  const { results } = await env.DB.prepare('SELECT ns, k FROM files').all()
  return results.map((r) => `${r.ns}/${r.k}`)
}

/* ---------- static baseline ---------- */

/**
 * Fetch a baked baseline file from the static assets (dist/data/...).
 * Returns null on a miss. Keys are used decoded, as in index.json.
 */
async function readStaticAsset(env, request, assetPath) {
  const res = await env.ASSETS.fetch(new URL(assetPath, request.url))
  if (!res.ok) return null
  return await res.text()
}

/**
 * The full read chain: (optionally D1) -> baked asset -> same for main.
 * useDb is false for... nothing currently — anonymous reads also check D1,
 * they're just cache-wrapped. The flag exists so the author path and the
 * cached path share one implementation.
 */
async function lookup(env, request, namespace, key, useDb) {
  let value = null
  if (useDb) value = await dbRead(env, namespace, key)
  if (value === null) value = await readStaticAsset(env, request, `/data/${namespace}/${key}`)

  if (value === null && namespace.toLowerCase() !== 'main') {
    if (useDb) value = await dbRead(env, 'main', key)
    if (value === null) value = await readStaticAsset(env, request, `/data/main/${key}`)
  }
  return value
}

/* ---------- edge cache (anonymous traffic only) ---------- */

/** Synthetic cache key for POST /read results (POSTs have no cacheable URL). */
function readCacheKey(namespace, key) {
  return new Request(
    `https://qrx.cache/read/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`
  )
}

function ttl(env) {
  return parseInt(env.CACHE_TTL_SECONDS || '86400', 10)
}

/**
 * Cache-aside wrapper: serve from the edge cache if present, otherwise
 * compute, store (only 200s), return. Stored responses carry
 * Cache-Control: max-age=<ttl>, which is what expires them.
 */
async function cachedJson(env, ctx, cacheKey, compute) {
  const hit = await caches.default.match(cacheKey)
  if (hit) return hit
  const { body, status } = await compute()
  if (status === 200) {
    const store = json(body, status)
    store.headers.set('Cache-Control', `public, max-age=${ttl(env)}`)
    ctx.waitUntil(caches.default.put(cacheKey, store))
  }
  return json(body, status)
}

/**
 * Best-effort purge after a write. NOTE: the Cache API is per edge location,
 * so this only clears the location that served the write — everywhere else
 * freshens at TTL expiry. Also purges the public index (a write may be a
 * brand-new key). Writes to main/<key> can leave other-namespace reads of
 * <key> (which fall back to main) stale until TTL — accepted, documented.
 */
async function purgeAfterWrite(request, env, ctx, namespace, key) {
  ctx.waitUntil(Promise.all([
    caches.default.delete(readCacheKey(namespace, key)),
    caches.default.delete(new Request(new URL(`/data/${namespace}/${key}`, request.url))),
    caches.default.delete(readCacheKey('index', 'public')),
  ]))
}

/* ---------- endpoint handlers ---------- */

/**
 * POST /read — the boot/sync contract. Keyed: fresh from D1, never cached.
 * Anonymous: same data, but wrapped in the edge cache. Both fall back to
 * baked assets, then the main namespace.
 */
async function handleRead(request, env, ctx) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  const { namespace, key } = body || {}
  if (!namespace || key === undefined) return json({ error: 'Missing namespace or key' }, 400)

  if (authed(request, env)) {
    const value = await lookup(env, request, namespace, key, true)
    return value === null ? json({ error: 'Not found' }, 404) : json({ value })
  }
  if (!isPublic(env, namespace)) {
    return json({ error: 'Namespace not in allowlist' }, 404)
  }

  return cachedJson(env, ctx, readCacheKey(namespace, key), async () => {
    const value = await lookup(env, request, namespace, key, true)
    return value === null
      ? { body: { error: 'Not found' }, status: 404 }
      : { body: { value }, status: 200 }
  })
}

/**
 * GET /data/<namespace>/<key> — live raw reads by URL. This is what makes a
 * dataverse file a plain link: anonymous readers get cached live content,
 * keyed readers get fresh content. Unlisted/private namespaces 404 for
 * anonymous without ever touching D1.
 */
async function handleDataFile(request, env, ctx, pathname) {
  const rest = pathname.slice('/data/'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return env.ASSETS.fetch(request)
  const namespace = decodeURIComponent(rest.slice(0, slash))
  const key = decodeURIComponent(rest.slice(slash + 1))

  const isAuthed = authed(request, env)
  if (!isAuthed && !isPublic(env, namespace)) {
    return new Response('Not found', { status: 404 })
  }

  const mimes = {
    html: 'text/html', md: 'text/markdown', json: 'application/json',
    js: 'text/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml',
  }
  const ext = key.split('.').pop()
  const contentType = mimes[ext] || 'text/plain; charset=utf-8'

  const serve = async () => {
    const value = await lookup(env, request, namespace, key, true)
    if (value === null) return null
    return new Response(value, { headers: { 'Content-Type': contentType } })
  }

  if (isAuthed) {
    const res = await serve()
    return res || new Response('Not found', { status: 404 })
  }

  const hit = await caches.default.match(request)
  if (hit) return hit
  const res = await serve()
  if (!res) return new Response('Not found', { status: 404 })
  res.headers.set('Cache-Control', `public, max-age=${ttl(env)}`)
  ctx.waitUntil(caches.default.put(request, res.clone()))
  return res
}

/** POST /write — requires SYNC_KEY. Writes are D1 deltas; purges the edge cache. */
async function handleWrite(request, env, ctx) {
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
  if (typeof value === 'string' && value.length > MAX_VALUE_BYTES) {
    return json({ error: 'Value exceeds 2 MB D1 row limit' }, 400)
  }

  await env.DB.prepare('INSERT OR REPLACE INTO files (ns, k, v) VALUES (?, ?, ?)')
    .bind(namespace, key, value ?? '')
    .run()
  await purgeAfterWrite(request, env, ctx, namespace, key)
  return json({ status: 'saved' })
}

/**
 * GET /data/index.json — baseline ∪ public D1 deltas. Anonymous: cached.
 * Keyed: fresh. GET /data/index.private.json — D1 only, SYNC_KEY required,
 * never cached (private namespaces are never baked into assets).
 */
async function handleIndex(request, env, ctx, privateOnly) {
  if (privateOnly && !authed(request, env)) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const compute = async () => {
    const dbKeys = (await listAllKeys(env)).filter((k) => {
      const ns = k.split('/')[0]
      return privateOnly ? isPrivate(env, ns) : isPublic(env, ns)
    })
    if (privateOnly) return { body: dbKeys, status: 200 }
    const staticRaw = await readStaticAsset(env, request, '/data/index.json')
    const staticIndex = staticRaw ? JSON.parse(staticRaw) : []
    return { body: [...new Set([...staticIndex, ...dbKeys])], status: 200 }
  }

  if (authed(request, env)) {
    const { body, status } = await compute()
    return json(body, status)
  }
  return cachedJson(env, ctx, readCacheKey('index', 'public'), compute)
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
      if (request.method === 'POST' && url.pathname === '/read') return await handleRead(request, env, ctx)
      if (request.method === 'POST' && url.pathname === '/write') return await handleWrite(request, env, ctx)
      if (request.method === 'GET' && url.pathname === '/data/index.json') return await handleIndex(request, env, ctx, false)
      if (request.method === 'GET' && url.pathname === '/data/index.private.json') return await handleIndex(request, env, ctx, true)
      if (request.method === 'GET' && url.pathname === '/stream') return await handleStream(request, env)
      if (request.method === 'GET' && url.pathname.startsWith('/data/')) return await handleDataFile(request, env, ctx, url.pathname)
    } catch (e) {
      return json({ error: e.message }, 500)
    }

    // Everything else: static assets, with SPA fallback to index.html
    // (configured via not_found_handling in wrangler.jsonc).
    return env.ASSETS.fetch(request)
  },
}
