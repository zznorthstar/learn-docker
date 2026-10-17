# Repair and UX verification — 2026-10-17

Live: https://learndocker.hamdibouzidi.com

Deployed Worker version: `c744096b-ed9f-4142-a52e-0a2250e1d6b3`.

## MCP root cause and repair

The existing `worker/src/index.ts` already exported the POST handler, and its
Durable Object already implemented authentication and browser forwarding.
The deployed version's assets configuration had `raw_run_worker_first: false`.
At the edge, a POST with `Sec-Fetch-Mode: navigate` was intercepted by the SPA
asset path and returned an empty 405 with static-asset headers. A plain POST
returned the existing JSON 401. This distinction was observed with real HTTP
requests, rather than inferred from the source. Local Wrangler did not reproduce
that edge interception, so a deployed smoke test is necessary.

`wrangler.jsonc` now explicitly sets:

```json
"run_worker_first": ["/mcp", "/ws", "/health"]
```

The shadowed duplicate `routes` key was removed, preserving the active
`learndocker.hamdibouzidi.com` custom domain. `deploy:relay` builds before
deploying, and `typecheck` now checks the Worker too. The existing MCP server,
lab-key format, Durable Object, browser relay, simulation and Rive assets remain
in use. GET `/mcp` still intentionally returns the endpoint's POST-only 405.

## Checks completed

- **113 unit tests**, **10 relay tests**, **45 browser tests** passed. The four
  focused-learning browser tests were also rerun after the final input/focus refinements.
- Frontend and Worker typechecks, production build, deployment dry-run and
  `git diff --check` passed.
- Production smoke: 12 auth/header combinations; absent, malformed and wrong
  keys return 401; valid keys return 200, including navigation-shaped requests.
- Real MCP initialization returns 200, initialized notification returns 202,
  and tools can be listed and called.
- The app's **Test connection** button completes its own HTTP round trip without
  falsely marking an external AI connected.
- `world_connection_test` travels through the deployed Worker, correct lab's
  WebSocket and real browser world; its HTTP response reports success. The
  existing `santa/wave` trigger fires, and captured frames show Santa's waving
  arm and sparkle. An independent second lab receives no wave.
- Browser suite verifies semantic-to-Rive inputs, process/kernel depth,
  object interactions, predictions, causal events, rewind, persistence,
  reconnection, reduced motion, and five axe accessibility views.
- Production UI check: real command creation, stopping the resulting container,
  then reload restores the same lab and stopped state. No page errors.
- Production widths **320, 390, 768, 1366, 1440** have no horizontal overflow.
  Phone/tablet layouts have no independently scrolling vertical panels.

Screenshots from the live deployment are in `/tmp/docker-final-production-ui/`
and `/tmp/docker-final-production-mcp/`. Browser checks use headless Chromium;
phone sizes are emulated, not physical-device tests.

## Substantial files

- `wrangler.jsonc`, `package.json`: API routing and deployment/check commands.
- `src/app/app.ts`: workspace disclosure, caption pacing, terminal interaction.
- `src/ui/shell.ts`, `src/ui/dock.ts`, `src/ui/inspector.ts`, `src/ui/modals.ts`:
  existing world shell, terminal, layered information and short onboarding.
- `src/styles.css`: world priority, larger terminal, calmer controls, responsive layout.
- `src/render/overlay.ts`: presentation-only focus dimming using semantic selection.
- `src/engine/terminal.ts`: short token labels; parser and execution semantics preserved.
- `shared/tools.ts`: teaching instructions for the existing external AI flow.
- Tests: updated existing assertions and added focused learning and deployable
  MCP smoke checks. README and teaching-study documents record usage and evidence.

See [TEACHING-STUDY.md](TEACHING-STUDY.md) for the local Whisper workflow,
timestamped transcript, frame observations and how they informed the interface.

No known failures remain in the requested flows covered by these checks.

## External AI onboarding follow-up

The current UI uses self-hosted Host Grotesk, Fragment Mono and JetBrains Mono.
In-app chat, sign-in, composer, lesson rail, availability messaging and related
code have been removed. The original 14 MCP world tools and capability-token
model remain intact.

Three agent choices have been merged into **Ai-Agent (meta muse, grok bot...)**.
Its copied prompt still contains the full endpoint, lab key and connection steps,
while the visible key is masked. Only the separate Teaching prompt nudges the
credentials disclosure.

The third onboarding screen recommends two tabs next to each other outside full
screen. A 4.8-second illustration plays once: the Whale Lab browser restores
down, an AI window opens beside it, a short exchange appears, and a container is
added to the whale. Reduced motion shows the completed layout immediately.
It is an illustration, independent of the actual semantic/Rive world.

Current substantial follow-up files: `src/styles.css`, `src/ui/shell.ts`,
`src/app/app.ts`, `src/ui/modals.ts`, `tests/e2e/onboarding.e2e.test.ts`,
`tests/e2e/learning.e2e.test.ts`, `tests/e2e/app.e2e.test.ts`, README and architecture docs.


Final verification for this update: 113 unit tests, 10 relay tests and all 45
browser tests pass. Frontend/Worker typechecks, production build and diff checks
pass. The onboarding animation was inspected at its full-window, side-by-side and
container-created stages, plus 320/390/768px layouts. A separate onboarding axe
check reports no serious or critical issues; reduced motion shows the final state.
Local screenshots are in `/tmp/docker-side-by-side-ui/`.

Live checks passed on the deployed version: the merged selector has five options,
its clipboard prompt includes the endpoint and full key while the DOM stays masked,
and the new onboarding illustration appears. In-app chat and sign-in are absent.
The production MCP smoke passes auth (12 header/key combinations), initialization,
tool listing, self-test, lab isolation and the Rive wave with zero browser errors.
Production screenshots are in `/tmp/docker-side-by-side-production/`.
