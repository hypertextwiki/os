# Hyperprompting Guide — Lessons from the Skybiome and Chat-Agent Builds

Instructions for the assistant when the user is working in the QRx hyperprompting protocol. Distilled from two full multi-chain build sessions: a Bluesky particle-life simulation (see <context src="./data/main/prompts/skybiome.html" />) and the `#apps/chat` agent harness (see <context src="./data/main/prompts/apps/chat" /> and <context src="./data/main/docs/tools/agent.md" />).

---

## 1. The Protocol (how the machine works)

- The URL fragment is a sequential machine tape. `#filename?` followed by `&flag=value` steps.
- The tape drives an accumulator (`v`) that becomes the generated file. `&w` writes the accumulator to the database. `&a=1` switches to append mode.
- **Chain shape:** every chain starts with `&a=1` and ends with `&w`. The opening is `#name?e&w` (echo reset + write), then each chain is `&a=1&p=TASK: ...&w`.
- Newlines only ever appear *inside* `&p=` prompt values. Never put a newline between `&w` and `&a=1` — the browser reads it as a literal return character and breaks the tape.
- The generated code is concatenated scripts in one file. Each `&p=` step should output exactly one SCRIPT tag (or style/fragment), nothing more.
- The executing model has **no conception of the hyperprompt protocol**. Never instruct it about escaping, the tape, or the kernel. It just sees plain English and emits pure JS. Only the tape author (you, the assistant) handles URL encoding: `%3F` for `?`, `%26` for `&`, `%2B` for `+`, `%23` for `#` inside prompt values.
- A tape is executable code. Never author `&k=` (API keys) into shared tapes, and never run a stranger's tape with secrets in localStorage — `?x=` can read them.

### Tape integrity (hard-won)

- **Exactly one raw `?` per tape.** The kernel splits the hash on `?` and keeps only the filename and the first query segment. A raw `?` anywhere inside a value — a JavaScript ternary is the classic offender — silently truncates the tape. If the truncation lands before the final `&w`, the chain *runs* and generates but *never writes*. Symptom: "I ran it three times and nothing persisted." Before delivering any tape, count the raw `?` characters: the answer must be 1.
- Raw `=` inside values is safe (only the first `=` splits a param). Everything else structural must be encoded.
- Chain file house format: `?p=TASK:` on the same line as the tape start, sub-points as two-space-indented hyphen lines, no trailing periods, `&w` on its own closing line.

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

### Prompting weaker generator models

When the generating model is small, terse prompts under-specify. Switch to maximally descriptive grammar:

- Numbered imperative steps (`STEP 1: ...`, `STEP 2: ...`) instead of prose paragraphs.
- Exact strings to copy where format matters ("Line 1 MUST be one single block comment in this exact style: ...").
- Explicit anti-patterns for every failure you've observed: "do NOT define a function", "NEVER declare var read". Weak models don't infer what not to do.
- Point at the kernel instead of explaining it: `?c=src` plus "look at how the kernel implements the global read(k, d) and reimplement the same split" beats two paragraphs of mechanics, and keeps the chain self-contained.

## 4. Wrapper Chains (stacking behavior without regenerating old chains)

Late chains often need to wrap a function an earlier chain defined (e.g. appending sections to a prompt builder). The pattern is `var prevThing = window.thing; window.thing = wrapper`. Three rules, all learned from production bugs:

- **Top-level `var` in a classic script is a SHARED GLOBAL.** Two wrapper chains that both declare `var prevBuild` collide: the second capture overwrites the first, the first wrapper then calls itself, and you get `Maximum call stack size exceeded`. Every capture variable gets a unique name (`prevBuildSkills`, `prevBuildIdentity`, `prevFetchCompact`).
- **Idempotency flags.** Re-running a wrapper chain must not double-wrap. Guard with `window._hasThing` flags.
- **Never self-call.** A wrapper must never invoke its own `window.*` name inside its body — call the captured previous function.

## 5. Event Rewiring

When a later chain replaces the behavior of wired-up DOM elements, clone-and-rebind **every element that carries a listener** — not just the obvious one. Cloning the submit button but not the textarea leaves the old Ctrl+Enter listener alive: it fires first on the stale path, clears the input, and the new handler no-ops on empty text. Symptom: "I clicked submit and nothing from the new chain ran."

## 6. External APIs — verify, don't assume

- **Read the docs every single time, even if you checked earlier in the session.** Context is not memory. (User's explicit rule, stated forcefully.)

## 7. Debugging workflow that worked

1. Get the actual generated file from the user; grep/read it before theorizing.
2. Classify the bug: API/auth, spec-ambiguity, cross-chain contract, tape-integrity, or pure CSS.
3. Give the smallest possible chain fix — quote the exact replacement bullet(s), or the full chain segment if the user asks (never make them piece fragments together).
4. Binary answers when the user asks a binary question ("should I see dots yet?" → "yes, because…"). No tape rewrites unless asked.
5. Console-verifiable checks are gold (`window.particles[0].x` vs `window.cam`) — offer them so the user can confirm a diagnosis without editing anything.
6. "Works on localhost, fails on GitHub Pages" is almost always a **stub hydration** bug: localhost's boot/sync network-first read() masks empty stubs. Check the key's IndexedDB value — `''` means it was never hydrated.
7. The kernel strips the query from location.hash into `localStorage._q` after the first run, so the bootloader only sees query keys in the hash on the FIRST load. Repro every bug twice: fresh profile (incognito) and warm profile take different paths.
8. Ordering: boot/* files run before the tape on every navigation; `main:ready` fires during hydrate. A listener registered in a boot file sees tape-installed globals.
9. A generated file that duplicates a chain's script is usually harmless (redefines the same globals) — but check the chain file for a duplicated link before assuming.
10. When the same tape "ran but didn't write", suspect tape truncation (a raw `?` in a value) before suspecting the model.

## 8. Filesystem Semantics (what values mean)

- **`''` means "stub, not yet fetched" — NOT "deleted".** The bootloader stubs every indexed key as an empty string so it appears in listings without a full fetch, and network-first reads treat an empty result as "go fetch it." Writing `''` to a key therefore creates a zombie: sync may resurrect the content, and kernel `read()` treats empty as falsy and silently falls back to the `main` namespace. **Deletion must be structural** (`tx('readwrite', db).delete(key)`), never a value.
- **Path syntax:** `namespace#filename` splits at the `#` — namespace is the IndexedDB database name, filename is the key inside it. Bare filename reads the current namespace (with `main` fallback). Kernel `read(k, d)` takes the two parts separately; it does NOT parse the `#` form — callers split it themselves.
- `read(k, d)` accepts a string namespace and resolves it (`getDB` internally). `keys(q, d)` does NOT — `d` must be a database handle, so `await getDB(ns)` first.

## 9. Tool Files (agent-callable files)

Tools are plain JS files (e.g. `tools/read`) discovered by prefix and executed by the agent harness. They are their own generative chains (`#prompts/tools/read` → `#tools/read?e&w&c=src&p=...&w`), one per tool, each independently regenerable.

- The file is **raw JavaScript** — no script tags, no HTML, no fences.
- **The code IS the body of an async function** whose only argument `INPUT` is the raw string the agent wrote after its action line. Say this explicitly in the prompt, or weak models wrap everything in an unused function definition (the tool returns `undefined` forever) or write `var read = ...` and shadow the kernel global into infinite recursion.
- Never redeclare or shadow kernel globals (`read`, `write`, `keys`, `getDB`, `queryDB`, `tx`, `IDBKeyRange`).
- **Line 1 is a single `/* */` block comment** describing the tool and its INPUT format with examples. This comment is the tool's *entire* interface documentation — the agent sees only that line in its prompt. Nobody human reads it, so be verbose.
- **Errors are returned as strings, never thrown.** A thrown error kills the agent loop; a string (`Error: file not found: x`) is just an observation the model can reason about and recover from.
- INPUT is one raw string by design: the model emits text, and a raw string is the zero-loss transport — no JSON escaping tax on file contents. Multi-field tools define a micro-format (e.g. write: first line is the path, the rest is content). Tools that genuinely need structure can JSON.parse(INPUT) internally — structure is opt-in per tool, not a tax on every call.

## 10. Dependencies between files (the read idiom)

- **There is no import statement — `read()` IS the import.** A file that needs another file's globals: `read('windows').then(c => { (new Function(G, 'v', 'arg', c))(this, void 0, ''); /* globals now live */ })`. Parallel deps: `Promise.all(['a','b'].map(k => read(k))).then(...)`.
- **Stubs are zero-byte.** Bootloaders write every indexed key as `''` (an unexplored node) and only pre-hydrate the target key, URL query keys, and `boot/*`. Anything else your code touches is empty until something reads it.
- **Reads hydrate on miss on every host.** Server: `boot/sync` makes read() network-first via POST /read. Static (GitHub Pages): the bootloader wraps read() to GET `data/<ns>/<key>` (main-namespace fallback) and caches it into IndexedDB. The idiom works everywhere — but only through `read()`, never raw IndexedDB access.
- **Assert after importing.** An unhydrated dep fails three hops later as `window.foo is not a function` with a minified stack. After eval, check `typeof window.theThing === 'function'` and throw naming the missing *node* (`missing dep: windows`), never the symbol.
- **No dependency declarations** — no frontmatter, no manifests. The graph may be unbounded; crawling IS the traversal. Revisit only if a measured waterfall hurts.

## 11. Working with this user (read this)

- They are the architect; you are the harness. They run generations themselves via API. Your job: protocol-correct chains, precise diagnosis, honest tradeoffs.
- **Do not create files unless asked.** Deliver chains inline in code blocks.
- **Do not add features unasked** (collapsible sections, extra buttons). Scope creep in chains = bugs in output.
- Keep responses short. When the user is frustrated, get shorter. Never narrate your process; show the fix.
- They correct sharply when you break protocol ("the chain is the spec") — accept immediately, restate the principle to confirm understanding, move on.
- When the user questions a number or a design choice, answer with its actual lineage: researched constant, shipped-system precedent, or heuristic guess. Never dress a guess up as a derivation. If you don't know, say so and go research it again — search context does not persist across turns.
