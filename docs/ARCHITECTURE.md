# Architecture and reference

An interactive learning world for Docker. The world is the diagram. **The visitor brings their own AI**, which connects over MCP and drives the world while it teaches: revealing internals, breaking things on purpose, rewinding, tracing causes, and reacting to whatever the learner clicks.

- No accounts. No hosted AI. No server-side lab state. A random lab id + secret live in the learner's browser.
- The browser owns the world (a deterministic Docker simulation). A thin Cloudflare Worker + Durable Object only relays MCP calls to the right tab.
- The same object reveals more truth at each of seven abstraction levels: story metaphor → Docker objects → engine internals → Linux processes → kernel primitives → OCI standards → the wider ecosystem. "The container is not a little VM" is a level-3 moment: the shipping box dissolves into a process.

```
USER'S AI ──MCP (HTTP, Bearer labId.secret)──▶ Worker /mcp ──▶ Lab Durable Object ──WebSocket──▶ BROWSER
                                                  │ validates sha256(secret)        │   semantic world engine
                                                  └ static site + /ws               │   ├─ causal events + timeline
                                                                                    │   ├─ concept graph, scenarios
learner clicks / terminal / lab dials ───────────────────────────────────────────▶ │   └─ projection ─▶ Rive (art) + SVG (relationships)
```

## Run it

```bash
npm install
npm run dev:relay            # Worker + Durable Object on :8787 (RELAY_PORT=8799 npm run dev:relay if taken)
npm run dev                  # Vite on :5173, proxies /mcp /ws to the relay (RELAY_PORT=… to match)
```
Open the site, finish (or skip) the intro, press **Connect your AI**, and either run the built-in **self-test** or add the endpoint to your AI client. Easiest end-to-end check without an AI: the self-test button calls your own `/mcp` through the relay and Santa waves.

```bash
npm run build                # typecheck + production bundle in dist/
npm test                     # 113 unit tests (engine, projection, identity, hardening)
npm run test:relay           # 9 tests: real workerd, MCP (incl. the official MCP SDK client) + browser socket
npm run test:e2e             # 37 tests: real Chrome + Rive + Worker (builds first)
npm run test:all
npm run build:rive           # regenerate public/rive/docker-world.riv from rive/gen/*.mjs (needs the `rive` CLI)
node tests/e2e/perf.mjs      # sizes, load timeline, CPU, fps, pause-when-hidden
```

## Connecting an AI

One shared endpoint, header auth, no URL secrets:

```
POST https://<your-site>/mcp
Authorization: Bearer <labId>.<secret>      # shown (masked) in the Connect dialog
```
`labId` is public routing, `secret` is a 256-bit capability token; the relay stores only `sha256(secret)`. A lab id alone grants nothing. The browser registers its WebSocket by sending the secret in its **first message** (never in the URL), and the first browser to register a (lab, secret) pair claims the lab.

Claude Code: `claude mcp add --transport http docker-world https://<site>/mcp --header "Authorization: Bearer <labId>.<secret>"`. Other clients: the Connect dialog has the JSON config, an `mcp-remote` bridge for stdio-only clients, and a prompt to paste. The server's `initialize` response carries the teaching manual (`instructions`), and each tool description documents purpose, effect, concepts, side effects, visuals and how to teach with it.

**Connection test.** `world_connection_test` (or the self-test button) makes Santa visibly wave and shows "Your AI is connected". A green dot alone proves nothing, so the test makes the world react. If the tab is closed, tools return `world_offline` with instructions; reopening the same browser reconnects automatically.

### MCP tool surface (14 tools, semantic only)

| Tool | Purpose |
|---|---|
| `world_inspect` | Read: `overview`, `object`, `selected`, `events`, `user_activity`, `causal_trace`, `why`, `view`, `timeline`, `requests`, `logs`, `kernel` |
| `world_focus` | Select/highlight, reveal relationships (`depends_on`, `depended_by`, `made_of`, `used_by`, `why`, `to_kernel`, `to_ecosystem`, `follow`), set level/region, caption |
| `world_mutate` | One typed semantic action (34: `run_container`, `set_resource_limit`, `connect_network`, `build_image`, `edit_dockerfile`, `compose_stop_service`, `send_request`, `set_condition`, …) |
| `world_run_scenario` | Built-in library (27), custom `setup`+`steps`, or `predict:true` |
| `world_set_view` / `world_set_overlay` | Level, camera region + zoom, Lab mode, time flow; network / storage / process / kernel / resources / causality / dependencies overlays |
| `world_compare` / `world_rewind` / `world_reset` | Before/after diff, timeline stepping, preset worlds |
| `world_connection_test` | Santa waves |
| `concept_inspect` / `concept_trace_relationship` | The knowledge graph (70 concepts): per-level text, misconceptions, experiments, commands, kernel primitives; `down_to_kernel`, `out_to_ecosystem`, `between` |
| `lesson_check_understanding` / `lesson_get_progress` | Prediction cards (answer hidden until commit) and what the learner has actually explored |

The AI can never set positions, opacity or frames; it only describes Docker-level actions. The renderer decides what that looks like.

## Architecture

| Layer | Where | Notes |
|---|---|---|
| Semantic world | `src/engine/types.ts`, `world.ts`, `catalog.ts` | Normalized JSON: host, daemons, images/layers, containers, networks, volumes, build cache, Compose, logs, requests. No visual data. |
| Reducer + causal engine | `sim.ts`, `probe.ts` | `applyAction(world, action) → world'` is pure and deterministic. Every state change emits an event with `causedBy`. Realistic refusals (port allocated leaves the container `created`; volume in use; exec format error; OOM → restart-policy crash loop). |
| Timeline | `engine.ts` | Event-sourced: persisted form is the op list; replay rebuilds every snapshot and event exactly. Rewind, step, branch-on-new-action, before/after diff (`diff.ts`). |
| Knowledge | `concepts.ts`, `conceptgraph.ts`, `inspect.ts`, `derive.ts` | Per-level truth: process tree, namespaces, cgroup files, overlay mounts, veth/bridge/iptables, OCI `config.json`, image manifest, all derived from state. |
| Experiments | `scenarios.ts` | 27 "what if…" scenarios; each carries a prediction whose stated answer is **machine-verified against the simulator** in tests. |
| MCP | `shared/*.ts`, `src/engine/tools.ts`, `worker/` | Tools run in the browser; the Worker/DO is a rendezvous. |
| Projection | `src/render/project.ts` | The only place that maps Docker state to visual inputs (numbers/bools/colours for Rive). |
| Rendering | `src/render/riveWorld.ts`, `overlay.ts`, `camera.ts` | Rive draws characters, containers, whale and effects; an SVG layer draws relationships and the truth under the metaphor; real DOM buttons sit on top for keyboard/screen-reader access. |
| UI | `src/ui/`, `src/app/` | Vanilla TypeScript (no framework). Inspector, concepts, timeline, causal events, terminal, lab dials, predictions, onboarding, connect. |

**Why the split between Rive and SVG.** Rive does what it is best at (characters, state-machine reactions, abstraction dissolves, weather). Relationship lines, labels at each level and per-hop request traces are data-driven and need crisp text, so they are SVG over the same 1600×900 coordinates (the art generator writes `layout.generated.json` so the two can never drift).

## Rive

One file, `public/rive/docker-world.riv` (80 KB, vector only), authored as code in `rive/gen/` and compiled with the `rive` CLI. Details in [rive/README.md](rive/README.md). In short:

- `World` artboard (whale, deck, harbor, shipyard, weather, internals) with a root view model; reusable **component** artboards `Cargo` (×6 slots), `Santa`, `Reindeer` (×2: foreman = containerd, runner = runc), each with its own state machine layers and view model, bound through nested view models.
- Semantic logic stays out of Rive: the app writes `status`, `reveal`, `pressure`, `hasVolume`… and Rive crossfades.
- Verified in the real web runtime with screenshots of every state (see `rive/gen/sheet.mjs`).

## What it teaches (initial scope)

A container is a process · image vs container · pull/run/stop/remove lifecycle · Dockerfile, layers and build cache · volumes and persistence (and what dies with the container) · networks, DNS, isolation · port publishing · dockerd / containerd / shim / runc · Linux process reality (PID 1, signals) · namespaces · cgroups and the OOM killer · registries · Compose and health cascades · debugging and inspection (request tracing, events, terminal) · OCI standards · the Kubernetes/cloud/CI bridge.

## Accessibility, motion, responsiveness

Every stage object is a real button with an accessible name; level, timeline, terminal and dials are keyboard-operable (`[` `]` level, `,` `.` timeline, `/` terminal, `0` reset camera, `Esc`). Meaning is never animation-only: status is text in the inspector, consequence strip and events, and actions are announced in a live region. `prefers-reduced-motion` (or the menu toggle) freezes the scene after each state change and skips sequences. axe-core WCAG 2 A/AA runs clean on five views. Narrow screens stack stage → overlays → consequence → inspector → dock and drop non-essential labels.

## Deploying (Cloudflare)

One Worker serves the static site, `/mcp` and `/ws`, with one SQLite-backed Durable Object per lab (stores only a hash and the live socket).

```bash
npm run build
npx wrangler login
npm run deploy:relay        # wrangler deploy
```
Add a custom route/domain in the dashboard or `wrangler.jsonc`. `public/_headers` ships a strict CSP (only `wasm-unsafe-eval` for the Rive runtime), nosniff, no-referrer and cache rules. Cost profile: the static assets are free-tier friendly; Durable Objects bill only while a lab is active (WebSocket hibernation is used; keep-alive pings are auto-answered without waking the object). If abused, put Cloudflare rate limiting/Turnstile in front of `/ws` (see Limitations).

## Verified

Unit (113), relay (9), end-to-end (37, real Chrome + real workerd), axe audit, performance measurements and a `wrangler deploy --dry-run`.

## Limitations worth knowing

- It is a faithful **simulation**, not a Docker daemon (by design). One sample Dockerfile (a Node API), one Compose project (`shop`), a fixed image catalogue. A live-Docker adapter is architected for (everything flows through the typed `Action` reducer) but not built.
- Six deck slots; extra containers show as an overflow chip (still fully inspectable).
- The relay has no rate limiting. Lab ids are 50 bits and secrets 256 bits, so guessing is not a concern, but anyone can open sockets for random labs; add Cloudflare rate limiting before a large public launch.
- Rive was verified in headless Chrome with software GL (60 fps, ~68% main-thread busy; pauses to 0% when hidden). On real GPUs the cost is lower; the app lowers detail automatically if frames fall behind. No real-phone test was possible.
