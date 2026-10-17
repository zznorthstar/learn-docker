# Rive: how the world is built

The art is **authored as code** (`rive/gen/*.mjs`), emitted as RML, compiled by the `rive` CLI (v1.5.1) to `public/rive/docker-world.riv`. `rive/world/scene.rml` is the generated source (opens in the Rive editor via the `.rev` the CLI also writes into `rive/world/build/`).

```bash
npm run build:rive                         # verify, inspect for wiring problems, build, copy, write src/render/layout.generated.json
node rive/gen/build.mjs --only=cargo       # partial builds keep the output in rive/world/build/
node rive/gen/render.mjs --riv=public/rive/docker-world.riv --artboard=World --sm="World SM" \
  --out=/tmp/x.png --size=1600x900 --set="slot0.occupied=true,slot0.status=3,level=3,slot0.reveal=1"
node rive/gen/sheet.mjs --riv=… --artboard=Cargo --sm="Cargo SM" --out=sheet.png "label|key=val,key=val|waitMs|trigger" …
```
`render.mjs` loads a `.riv` in headless Chrome with the real web runtime, sets view-model values (dotted paths reach nested view models) and screenshots it; `sheet.mjs` tiles variants into one labelled image. That is how every state was reviewed.

## Files and artboards

| Artboard | Kind | View model | State machine layers |
|---|---|---|---|
| `World` (1600×900) | main | `World` | Weather (calm↔storm), Shudder (trigger), Pull (trigger), Build (trigger), Ambient (loops) |
| `Cargo` (180×134) | component ×6 | `Cargo` | Presence (empty→land→present), Health (6 states), Interaction (idle/hover/selected), Pulse (trigger), Ambient |
| `Santa` (200×240) | component | `Santa` | Mood (calm/working/panic/asleep), Wave (trigger), Blink |
| `Reindeer` (250×236) | component ×2 | `Reindeer` | Work (idle/busy), Nod (trigger), Ambient |

`World` contains nested instances bound with `dataBindPathIds` to nested view models (`slot0…slot5`, `santa`, `foreman`, `runner`). Each placement has a `NestedStateMachine`: without it nested binds still apply but state-machine transitions never fire (verified; this is silent).

### View-model contract (what the app writes; `src/render/project.ts`)

- **World**: `level` 0–6 (fades the whale's skin, fades in CPU/RAM/disk/kernel anatomy, dims the crew), `cpuLoad`, `memPressure` (RAM sticks fill), `diskFill` (storage drums fill), `storm` (bool), `registryUp` (lighthouse beam), `building`, triggers `pull` `build` `shake`.
- **Cargo**: `occupied`, `status` (0 created · 1 running · 2 exited · 3 failed · 4 paused · 5 unhealthy), `hover`, `selected`, `reveal` 0→1 (shell dissolves to a process core with namespace rings and a cgroup gauge that turns red past 75%), `pressure`, `hasVolume` (strap), `published` (gangplank + gate), `networked` (antenna), `tint` (colour from the image), trigger `pulse`.
- **Santa**: `mood`, trigger `wave`. **Reindeer**: `role` (0 foreman hard hat / 1 runner hi-vis), `working`, `glow`, `coat`, trigger `nod`.

Booleans/enums/numbers are never "Docker": the file has no idea what a volume is. Swap the art and only `project.ts` changes.

### Authoring facts that cost time (worth keeping)

- First declared sibling paints on top; the DSL takes children back-to-front and reverses.
- Drive machines from view-model properties, not (deprecated) inputs. Transitions on numbers use `TransitionValueNumberComparator`, triggers `BindablePropertyTrigger`.
- Each state animation keys the *same* set of properties, so crossfades between states are free.
- The web `Layout` min/max bounds are a rectangle *on the canvas*; a camera crop is `scale = canvasWidth / windowWidth` plus an offset (see `RiveWorld.setViewport`).
- No Luau scripts: unsigned scripts are rejected by web runtimes, and nothing here needs one.
- Vector only (feathers, radial gradients, additive blends instead of glow PNGs): 80 KB total.

## What the reference files taught (from ~/Downloads, inspected in the real runtime)

| File | Observed | Used as |
|---|---|---|
| `catcatcharacter-binding` | one root view model with 34 bool/number/trigger properties driving a whole character | the model for `World`/`Cargo`: state lives in data, not in dozens of inputs |
| `interactive-icon-set` | 42 component artboards, each with a one-input state machine | reusable components with a tiny contract (`Cargo`, `Reindeer`) |
| `cursor-meet-gaze` | 19 nested artboards + a view model on `Main` | nested instances bound to the parent view model |
| `onimotion-lp` | 82 animations, one machine with 65 inputs | what *not* to scale to: held-bool hover and one-shots informed the Interaction/Pulse layers instead |
| `messy-files` | 51 INTRO/EXIT artboards, 20 MB of raster | the INTRO idea (`Land`), and the warning to stay vector |
| `online-game-streaming` | 1.9 MB, 67 glow PNGs | replaced by feathered/additive vector glows |
| `hero-ui-animation`, `2d-girl`, `bird`, `translucent-window` | small single-machine files | reference for hover/idle layering and pivots; no assets were reused (none fit the world) |
