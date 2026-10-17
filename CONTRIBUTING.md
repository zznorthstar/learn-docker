# Contributing to Whale Lab

Thanks for helping. Small, focused changes with tests are the easiest to merge.

## Setup

```bash
npm install
npm run dev:relay   # terminal 1
npm run dev         # terminal 2
```
Node 22+. You do not need the Rive CLI unless you change the art.

## Before you open a PR

```bash
npm test && npm run test:relay && npm run test:e2e
```
CI-style check: `npm run build` must typecheck cleanly.

## Where things live

| Area | Path | Rule of thumb |
|---|---|---|
| Docker behaviour | `src/engine/sim.ts`, `probe.ts` | Pure and deterministic: no `Date.now()`, no `Math.random()`. Every state change emits a caused event. |
| Teaching content | `concepts.ts`, `scenarios.ts`, `inspect.ts` | A scenario's stated answer must pass its `verify()`; tests enforce it. |
| Visual mapping | `src/render/project.ts` | The only place Docker state becomes Rive inputs. |
| MCP surface | `shared/`, `src/engine/tools.ts`, `worker/` | Coarse semantic tools; never expose positions or animation. |
| Art | `rive/gen/` | Generated; see [rive/README.md](rive/README.md). Commit the rebuilt `.riv`. |

## Good first contributions

- A new "what if…" scenario with a verified prediction.
- A concept (with per-level text and a misconception) in the concept graph.
- Accessibility or mobile polish, with an e2e assertion.

## Pull requests

- One topic per PR; explain *why* in the description.
- Add or update a test for behaviour changes.
- Keep the simulation honest: if real Docker would refuse something, so should the sim.
- By contributing you agree your work is released under the [MIT License](LICENSE).
