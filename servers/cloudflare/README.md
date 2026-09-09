# Cloudflare Deployment (section to merge into README.md)

## Serverless Deploys (Cloudflare Workers)

The same kernel runs as a Cloudflare Worker: `dist/` is served as static assets from the edge, and a single Worker (`workers/cloudflare.js`) reimplements the `local.js` endpoint contract — `/read`, `/write`, `/data/index.json`, `/data/index.private.json`, `/stream`. The bootloader and `boot/sync` need no changes; they cannot tell the difference.

Storage model — the same three layers as every other deployment target, mapped onto Cloudflare:

- **Baseline = static assets.** `build:cloudflare` runs `servers/github.js` first, baking public namespaces from `data/` into `dist/data/` (plus a generated `index.json`), exactly like the GitHub Pages build. The dataverse is *deployed*, not uploaded — there is no seed step.
- **Deltas = KV.** The `DATA` namespace only ever holds what was written through `/write`. KV reads override the static baseline; KV writes are the only thing that spends the free tier's 1,000 writes/day budget.
- **IndexedDB = cache.** Unchanged — the browser mirrors what it reads, works offline.

Read order in `/read`: KV → baked asset → same two steps against `main`. `/data/index.json` is the union of the baked index and live KV deltas (public namespaces only). Private namespaces are never baked into assets; they exist only as KV deltas, readable solely with the SYNC_KEY.

### First deploy

```bash
npm install
npx wrangler login
npm run deploy:cloudflare      # bakes data/ into assets, builds, deploys
npx wrangler secret put QRX_SYNC_KEY   # only needed if you want to write
```

The KV namespace has no ID committed to the repo — the first `wrangler deploy` auto-provisions it and links it to the `DATA` binding. There is nothing account-specific in version control.

`build:cloudflare` reads `QRX_PUBLIC_NAMESPACES` from `.env` if present (via `--env-file-if-exists`), same as `npm start`. Keep it in sync with the `QRX_PUBLIC_NAMESPACES` var in `wrangler.jsonc` — the former controls what gets baked into assets, the latter controls what the Worker allows reads from. (Same two-place wart as `deploy.yml`, now three. Sorry.)

### Forking (the zero-config path)

Clone → `wrangler login` → `npm run deploy:cloudflare`. Done — the baseline dataverse comes from the repo itself, so a fork boots fully populated. Set a `QRX_SYNC_KEY` secret only if the fork's owner wants to write. No dashboard, no seed, no card required. Free-tier budgets (100k requests/day, 100k KV reads/day, 1k KV writes/day) comfortably cover single-author instances, and writes are the only scarce resource now — note the cap if you leave an autosaving editor open all day; local IndexedDB writes are always free, only `/write` syncs count.

### Configuration

- `QRX_PUBLIC_NAMESPACES` / `QRX_PRIVATE_NAMESPACES` — plain vars in `wrangler.jsonc`, committed, safe to edit per fork.
- `QRX_SYNC_KEY` — a Worker secret (`wrangler secret put`), never committed. Same role as in `.env`: authorizes `/write`, `/data/index.private.json`, and `/stream`. Cloudflare secrets are write-only — keep your local copy in `.env`.
- Custom domains and wildcard subdomains (`*.yourdomain.com`) attach via Routes; each hostname is a separate browser origin, so each subdomain gets its own isolated IndexedDB automatically.

### What's different at runtime

- **SPA routing is free.** `not_found_handling: "single-page-application"` in `wrangler.jsonc` serves `index.html` for unknown paths — the `404.html` sessionStorage hack is GitHub Pages-only.
- **`/stream` is a heartbeat-only placeholder.** EventSource clients connect and stay connected, but no write notifications are broadcast yet — cross-device live sync arrives with the Durable Objects phase. Sync-on-load (the bootloader) is unaffected.
- **KV is eventually consistent on reads.** A write is visible to `index.json` immediately (list is strongly consistent) but a `/read` from a different edge location may serve a stale value briefly. For a single-author dataverse this is invisible.
- **Baseline updates require a redeploy** (they're assets). KV deltas apply instantly. If you edit `data/` locally and want it live: `npm run deploy:cloudflare`.

### Local dev

`npm run dev:cloudflare` builds and serves via `wrangler dev` — the baseline comes from the baked assets, so local dev boots fully populated with an empty KV. Writes during dev go to a *local* emulated KV, separate from your deployed namespace.

### Deploy to Cloudflare button

A one-click Deploy button (forks the repo into the user's GitHub and auto-provisions KV) is possible — but Workers Builds' auto-provisioning is currently non-idempotent and can fail on *re*deploys (error 10014). The CLI path above is unaffected and is the documented route until that bug settles.
