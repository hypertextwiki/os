# Hyperprompting Guide — Lessons from the Skybiome Build

Instructions for the assistant when the user is working in the QRx hyperprompting protocol. Distilled from a full multi-chain build session (a Bluesky particle-life simulation) including every bug class we hit and how it was fixed (see <context src="./data/main/prompts/skybiome.html" />)

---

## 1. The Protocol (how the machine works)

- The URL fragment is a sequential machine tape. `#filename?` followed by `&flag=value` steps.
- The tape drives an accumulator (`v`) that becomes the generated file. `&w` writes the accumulator to the database. `&a=1` switches to append mode.
- **Chain shape:** every chain starts with `&a=1` and ends with `&w`. The opening is `#name.html?e&w` (echo reset + write), then each chain is `&a=1&p=TASK: ...&w`.
- Newlines only ever appear *inside* `&p=` prompt values. Never put a newline between `&w` and `&a=1` — the browser reads it as a literal return character and breaks the tape.
- The generated code is concatenated scripts in one file. Each `&p=` step should output exactly one SCRIPT tag (or style/fragment), nothing more.
- The executing model has **no conception of the hyperprompt protocol**. Never instruct it about escaping, the tape, or the kernel. It just sees plain English and emits pure JS. Only the tape author (you, the assistant) handles URL encoding: `%3F` for `?`, `%26` for `&`, `%2B` for `+`, `%23` for `#` inside prompt values.
- A tape is executable code. Never author `&k=` (API keys) into shared tapes, and never run a stranger's tape with secrets in localStorage — `?x=` can read them.

## 2. The Prime Directive

**The chain is the source code. The generated file is build output.**

- Never hand-patch generated code without a corresponding chain edit. Never tune a chain to accommodate what the model happened to emit. Intent flows one direction only: chain → regenerate → code.
- Exception the user accepts: for *trivial* styling-only chains (pure CSS), a parallel manual CSS edit is fine, with the chain updated so future regenerations match. When in doubt, regenerate.
- When fixing a bug: diagnose in the generated file, fix the chain, re-run only the affected segment. The user can snip segments and their generated code out of the accumulator.
- Before changing any chain, do a dependency check: which later chains read the globals this chain creates? A chain whose globals are consumed by no one else is a leaf — safe to swap. State the dependency analysis explicitly.

## 3. Chain-Authoring Grammar (this is where all the bugs live)

The model samples from your wording. Ambiguity IS the bug.

- **Never give example numbers.** "For example 20000px" produces a hardcoded 20000. To a model, an example is the spec. Express all dimensions as multiples/percentages of screen size (`canvas.clientWidth`, viewport %).
- **Never use named CSS colors.** "green" becomes `#008000` (dim). Give exact hex values: `post #ff2a2a, thread #ffe600, reply #39ff14, like #4dc3ff, repost #e26bff, quote #ffffff`.
- Prefer creative-coding grammar over engineering-speak: "random hue between X and Y, saturation 100%" constrains the output distribution; adjectives don't.
- One concern per chain. Each chain's prompt ends with: `use var for all variables` and `ONLY generate this SCRIPT tag, do not return the previous code`.
- Pin IDs and global names exactly (`window.particles`, `window.cam`, `window.forceMatrix`, `window.simConfig`, `window.paused`) — later chains contract against them.
- If a value must be live-tunable later: put it on a `window.*` config object and require the loop to **read it live every frame**. Forbid caching derived values (a precomputed `RADIUS_SQ` silently kills a radius slider).
- Cross-chain mutation contract: **mutate shared objects in place, never replace them** (`window.forceMatrix`, `window.simConfig`) — earlier scripts may hold references.

## 4. External APIs — verify, don't assume

- **Read the docs every single time, even if you checked earlier in the session.** Context is not memory. (User's explicit rule, stated forcefully.)

## 5. Debugging workflow that worked

1. Get the actual generated file from the user; grep/read it before theorizing.
2. Classify the bug: API/auth, spec-ambiguity, cross-chain contract, or pure CSS.
3. Give the smallest possible chain fix — quote the exact replacement bullet(s), or the full chain segment if the user asks (never make them piece fragments together).
4. Binary answers when the user asks a binary question ("should I see dots yet?" → "yes, because…"). No tape rewrites unless asked.
5. Console-verifiable checks are gold (`window.particles[0].x` vs `window.cam`) — offer them so the user can confirm a diagnosis without editing anything.
6. "Works on localhost, fails on GitHub Pages" is almost always a **stub hydration** bug:
   localhost's boot/sync network-first read() masks empty stubs. Check the key's
   IndexedDB value — `''` means it was never hydrated.
7. The kernel strips the query from location.hash into `localStorage._q` after the first
   run, so the bootloader only sees query keys in the hash on the FIRST load. Repro
   every bug twice: fresh profile (incognito) and warm profile take different paths.
8. Ordering: boot/* files run before the tape on every navigation; `main:ready` fires
   during hydrate. A listener registered in a boot file sees tape-installed globals.6. "Works on localhost, fails on GitHub Pages" is almost always a **stub hydration** bug:
   localhost's boot/sync network-first read() masks empty stubs. Check the key's
   IndexedDB value — `''` means it was never hydrated.
7. The kernel strips the query from location.hash into `localStorage._q` after the first
   run, so the bootloader only sees query keys in the hash on the FIRST load. Repro
   every bug twice: fresh profile (incognito) and warm profile take different paths.
8. Ordering: boot/* files run before the tape on every navigation; `main:ready` fires
   during hydrate. A listener registered in a boot file sees tape-installed globals.

## 6. Dependencies between files (the read idiom)

- **There is no import statement — `read()` IS the import.** A file that needs another
  file's globals: `read('windows').then(c => { (new Function(G, 'v', 'arg', c))(this, void 0, ''); /* globals now live */ })`.
  Parallel deps: `Promise.all(['a','b'].map(k => read(k))).then(...)`.
- **Stubs are zero-byte.** Bootloaders write every indexed key as `''` (an unexplored
  node) and only pre-hydrate the target key, URL query keys, and `boot/*`. Anything
  else your code touches is empty until something reads it.
- **Reads hydrate on miss on every host.** Server: `boot/sync` makes read() network-first
  via POST /read. Static (GitHub Pages): the bootloader wraps read() to GET
  `data/<ns>/<key>` (main-namespace fallback) and caches it into IndexedDB. The idiom
  works everywhere — but only through `read()`, never raw IndexedDB access.
- **Assert after importing.** An unhydrated dep fails three hops later as
  `window.foo is not a function` with a minified stack. After eval, check
  `typeof window.theThing === 'function'` and throw naming the missing *node*
  (`missing dep: windows`), never the symbol.
- **No dependency declarations** — no frontmatter, no manifests. The graph may be
  unbounded; crawling IS the traversal. Revisit only if a measured waterfall hurts.

## 7. Working with this user (read this)

- They are the architect; you are the harness. They run generations themselves via API. Your job: protocol-correct chains, precise diagnosis, honest tradeoffs.
- **Do not create files unless asked.** Deliver chains inline in code blocks.
- **Do not add features unasked** (collapsible sections, extra buttons). Scope creep in chains = bugs in output.
- Keep responses short. When the user is frustrated, get shorter. Never narrate your process; show the fix.
- They correct sharply when you break protocol ("the chain is the spec") — accept immediately, restate the principle to confirm understanding, move on.
