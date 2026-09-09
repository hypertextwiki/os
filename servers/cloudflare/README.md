# Cloudflare Deployment (section to merge into README.md)

## Serverless Deploys (Cloudflare Workers)

The same kernel runs as a Cloudflare Worker: `dist/` is served as static assets from the edge, and a single Worker (`workers/cloudflare.js`) reimplements the `local.js` endpoint contract — `/read`, `/write`, `/data/index.json`, `/data/index.private.json`, `/stream` — plus one addition, `GET /data/<namespace>/<key>`. The bootloader and `boot/sync` need no changes; they cannot tell the difference.

Storage model — the same three layers as every other deployment target, mapped onto Cloudflare, plus a fourth that only exists here:

- **Baseline = static assets.** `build:cloudflare` runs `servers/github.js` first, baking public namespaces from `data/` into `dist/data/` (plus a generated `index.json`), exactly like the GitHub Pages build. The dataverse is *deployed*, not uploaded — there is no seed step.
- **Deltas = D1.** A serverless SQLite database that only ever holds what was written through `/write`. D1 reads override the static baseline and are strongly consistent (you always see your own write). Writes are the only thing that meaningfully spends quota — the free tier allows 100,000 rows written/day, and autosaves won't dent it.
- **Edge cache = the anonymous fast path.** Anonymous reads are remembered per edge location (Cache API) for `CACHE_TTL_SECONDS` (default: one day). On a cache hit the Worker doesn't even execute — a million visitors in one second cost ~one D1 read per edge city, then nothing. Writes purge the affected entries; the TTL is the backstop for edge locations a purge can't reach. Keyed (SYNC_KEY) requests are never cached, and only public-namespace content is ever cacheable.
- **IndexedDB = each visitor's local cache.** Unchanged — the browser mirrors what it reads, works offline, and anonymous visitors' data never leaves their browser.

Read model — everyone gets the living dataverse; only the path differs:

- **Anonymous:** edge cache → D1 → baked assets → `main` fallback. Reads see your writes without a redeploy (bounded by the cache TTL in the worst case); public reads are cacheable, so anonymous traffic spends essentially zero database quota under any load.
- **Key holders:** D1 → baked assets → `main` fallback, fresh on every read — no cache in the path. `/data/index.json` unions the baked index with live D1 deltas. Private namespaces are key-holders-only, never baked, never cached.

Writes are D1 deltas (`/write`, SYNC_KEY required), and each write purges the cache entries it invalidates.

Two read shapes, because only one is naturally cacheable:

- `POST /read` — the `boot/sync` contract. Anonymous responses are cached by the Worker under a synthetic key; keyed responses are always fresh.
- `GET /data/<namespace>/<key>` — raw file content by URL, live (D1 first, then the baked asset). A dataverse file is a plain link: `https://your-worker.workers.dev/data/wiki/start`. Public namespaces only for anonymous; keyed GETs bypass the cache.

### First deploy

```bash
npm install
npx wrangler login
npm run deploy:cloudflare      # bakes data/ into assets, builds, deploys, applies D1 migrations
npx wrangler secret put QRX_SYNC_KEY   # only needed if you want to write
```

The D1 database has no ID committed to the repo — the first `wrangler deploy` auto-provisions it and links it to the `DB` binding, and the deploy script applies the schema migration right after. There is nothing account-specific in version control. No credit card required for any of it (Workers free + D1 free are cardless; R2 is the only Cloudflare product in this project's orbit that wants a card on file, and we don't use it).

`build:cloudflare` reads `QRX_PUBLIC_NAMESPACES` from `.env` if present (via `--env-file-if-exists`), same as `npm start`. Keep it in sync with the `QRX_PUBLIC_NAMESPACES` var in `wrangler.jsonc` — the former controls what gets baked into assets, the latter controls what the Worker serves to anonymous readers. (Same two-place wart as `deploy.yml`, now three. Sorry.)

### Forking (the zero-config path)

Clone → `wrangler login` → `npm run deploy:cloudflare`. Done — the baseline dataverse comes from the repo itself, so a fork boots fully populated. Set a `QRX_SYNC_KEY` secret only if the fork's owner wants to write. No dashboard, no seed, no card required. Free-tier budgets (100k Worker requests/day, 5M D1 rows read/day, 100k D1 rows written/day, 5 GB) comfortably cover single-author instances, and the edge cache means anonymous surges don't touch the database at all. Since September 2026 the free-tier D1 limits are hard-enforced — queries error until the midnight-UTC reset rather than billing you, so hitting a cap is an inconvenience, never a charge.

### Configuration

- `QRX_PUBLIC_NAMESPACES` / `QRX_PRIVATE_NAMESPACES` — plain vars in `wrangler.jsonc`, committed, safe to edit per fork.
- `CACHE_TTL_SECONDS` — plain var in `wrangler.jsonc`, default `86400` (one day). How long the edge remembers an anonymous read. Lower = fresher for strangers under active editing; higher = cheaper under load. Writes purge what they can, so staleness is the worst case, not the common one.
- `QRX_SYNC_KEY` — a Worker secret (`wrangler secret put`), never committed. Same role as in `.env`: authorizes `/write`, `/data/index.private.json`, and `/stream`, and bypasses the cache on reads. Cloudflare secrets are write-only — keep your local copy in `.env`.
- Custom domains and wildcard subdomains (`*.yourdomain.com`) attach via Routes; each hostname is a separate browser origin, so each subdomain gets its own isolated IndexedDB automatically.

### What's different at runtime

- **SPA routing is free.** `not_found_handling: "single-page-application"` in `wrangler.jsonc` serves `index.html` for unknown paths — the `404.html` sessionStorage hack is GitHub Pages-only.
- **`/stream` is a heartbeat-only placeholder.** EventSource clients connect and stay connected, but no write notifications are broadcast yet — cross-device live sync arrives with the Durable Objects phase. Sync-on-load (the bootloader) is unaffected.
- **D1 is strongly consistent** — you always read your own write, from any device, immediately. The one latency note: D1 has a single primary region, so uncached reads route there. Anonymous traffic almost never reaches D1 at all (cache hits), so this only applies to you.
- **Cache purges are per edge location.** A write clears the entries it can reach; other locations freshen at TTL expiry. A write to `main/<key>` can also leave another namespace's read of `<key>` (which falls back to `main`) stale until TTL. Both are bounded by `CACHE_TTL_SECONDS` — if that ever matters, lower it.
- **D1 rows cap at 2 MB** — irrelevant for hypertext, but a file larger than that gets a 400 from `/write` instead of silent corruption.
- **Baseline updates require a redeploy** (they're assets). D1 deltas apply instantly (for you) and within the cache TTL (for anonymous readers). If you edit `data/` locally and want it live: `npm run deploy:cloudflare`.

### Local dev

`npm run dev:cloudflare` builds, applies migrations to a local SQLite, and serves via `wrangler dev` — the baseline comes from the baked assets, so local dev boots fully populated with an empty database. Writes during dev go to that *local* database (in `.wrangler/state`, gitignored), separate from your deployed one. Note: `caches.default` behaves differently under `wrangler dev` than in production — don't judge cache behavior from local dev alone.

### Deploy to Cloudflare button

A one-click Deploy button (forks the repo into the user's GitHub and auto-provisions the database) is possible — but Workers Builds' auto-provisioning is currently non-idempotent and can fail on *re*deploys (error 10014). The CLI path above is unaffected and is the documented route until that bug settles.
