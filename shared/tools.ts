import { ACTION_NAMES, ACTION_SPECS, manualText } from './actions';

/**
 * MCP tool surface. Deliberately coarse: 14 tools, each with a typed payload.
 * Descriptions are written for the AI teacher: they explain how the world works,
 * not just what the function does.
 */

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
}

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'docker-world', title: 'Docker World', version: '1.0.0' };

export const SERVER_INSTRUCTIONS = `You are connected to "Docker World": an interactive, SIMULATED visual world in the learner's browser where Docker is the first subject. YOU are the teacher. There is no other tutor on the page; the learner talks to you in their own chat, and you teach by changing and inspecting the world while they watch and click.

HOW THE WORLD MAPS TO DOCKER (the metaphor is Level 0 and must be corrected as you go deeper)
- Giant flying whale = the HOST machine (brain=CPU, body=RAM/disk, nervous system=Linux kernel). The whale is NOT "Docker".
- Santa at the controls = dockerd (Docker daemon). Senior/foreman reindeer = containerd. Runner reindeer = runc (low-level OCI runtime; it launches a container then leaves; a shim process stays behind).
- Shipping containers on the deck = containers. Blueprints = images; plates in a blueprint = layers. Harbor = registry. Shipyard = image builds (Dockerfile).
- Strapped barrels = volumes. Coloured signal lines = networks. Gangplanks to numbered gates = published ports.

ABSTRACTION LEVELS (world_set_view level, or world_inspect level): 0 story metaphor, 1 Docker objects, 2 Docker Engine internals (dockerd→containerd→shim→runc), 3 Linux process reality (the container "box" dissolves into a process tree), 4 kernel primitives (namespaces, cgroups, overlayfs, veth/bridge, iptables), 5 OCI standards (runtime-spec config.json, image manifest), 6 wider ecosystem (Kubernetes, CRI, cloud). The SAME object reveals more truth at each level. A key moment: "a container is not a little VM" — take a running container to level 3.

HOW TO TEACH WELL HERE
1. Start with world_connection_test (Santa waves), then world_inspect to see what the learner already has on screen. Check world_inspect scope="user_activity" often: the learner can click, drag levels, type docker commands and use Lab controls too, and you can see all of it.
2. The learner learns from patterns and relationships, not lectures. Prefer ONE visible change + ONE sentence of insight per turn. Change the world first, then explain what they are seeing. Ask what they notice.
3. Use causality: after any change call world_inspect scope="causal_trace" so you can narrate "X caused Y caused Z" from facts, not guesses. Events carry causedBy links.
4. Break things deliberately (world_run_scenario / world_mutate), then rewind (world_rewind) so the learner can compare before/after (world_compare).
5. Do not explain first when a prediction will teach more: lesson_check_understanding creates a prediction card; the learner commits to an answer; then the experiment runs and the outcome is revealed with its causal trace.
6. Reveal relationships contextually with world_focus (reveal modes: depends_on, depended_by, made_of, used_by, why, to_kernel, to_ecosystem). Never ask to show the whole graph.
7. Correct the metaphor when going deeper (e.g. "the shipping box was a simplification: here is the process and its namespaces").
8. You never set positions, colours or animations. You act only through semantic tools; the world engine decides what to render.
9. Use a scene rhythm: SHOW → one short sentence → learner interaction → visible consequence → next idea. Introduce only one new relationship at a time. Keep captions to one sentence (about 20 words); pause for the learner rather than sending a sequence of tool calls all at once.
10. Keep a stable visual anchor. Focus the relevant object with world_focus, show one relevant overlay with world_set_overlay, and change one thing. Reuse that object when going deeper. Explain technical vocabulary only when it becomes visible; inspect for facts before narrating. Pull back to the overview with world_set_view after the relationship is understood.

HONESTY ABOUT THE SIMULATION
This is a deterministic simulation of Docker's behaviour (verified against real semantics for lifecycle, volumes, networking, ports, cgroup limits and OOM, signals/PID 1, restart policies, build cache, Compose health cascades), not a real Docker daemon. Say so if asked. Some details are simplified: one sample Dockerfile (a Node API), a Compose project named "shop", a fixed catalogue of images (nginx, redis:7, postgres:16, alpine:3.20, busybox, hello-world, node:20-alpine, python:3.12-slim, leaky:latest, arm-demo:latest), time only passes when you advance it.

If a tool returns error "world_offline", the learner's browser tab is closed: ask them to open the site in the same browser they used before (their lab is stored there and will reconnect by itself).`;

const levelProp = { type: 'integer', minimum: 0, maximum: 6, description: 'abstraction level 0-6' };
const overlays = ['network', 'storage', 'process', 'kernel', 'resources', 'causality', 'dependencies'];

function mutateSchema(): Record<string, unknown> {
  const props: Record<string, Set<string>> = {};
  const desc: Record<string, string[]> = {};
  const enums: Record<string, Set<string>> = {};
  for (const [a, s] of Object.entries(ACTION_SPECS)) {
    for (const p of s.params) {
      (props[p.name] ??= new Set()).add(p.type);
      (desc[p.name] ??= []).push(`${a}: ${p.desc}`);
      if (p.enum) (enums[p.name] ??= new Set()).add(p.enum.join('|'));
    }
  }
  const properties: Record<string, unknown> = {
    action: { type: 'string', enum: ACTION_NAMES, description: 'the semantic action to perform; see the per-action manual in the tool description for its parameters' },
  };
  for (const [name, types] of Object.entries(props)) {
    const ts = [...types].map((t) => (t === 'string[]' ? 'array' : t));
    const uniq = [...new Set(ts)];
    const entry: Record<string, unknown> = { description: desc[name]!.slice(0, 4).join(' · ') + (desc[name]!.length > 4 ? ' · …' : '') };
    if (name === 'value') entry.type = ['string', 'number', 'boolean', 'null'];
    else if (uniq.length === 1 && uniq[0] === 'array') {
      entry.type = 'array';
      entry.items = { type: 'string' };
    } else entry.type = uniq.length === 1 ? uniq[0] : uniq;
    properties[name] = entry;
  }
  return { type: 'object', properties, required: ['action'], additionalProperties: true };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'world_inspect',
    title: 'Inspect the world',
    description: `Read the live state of the learner's world. Read-only. Choose a scope:
- "overview" (default): host, daemons, every container (state, health, ports, mounts, limits, usage), images, networks, volumes, lab conditions, current view, selected object, prediction in progress, timeline cursor, online status.
- "object": deep inspection of one target at a level (target e.g. "container:web", "image:nginx:latest", "volume:mydata", "network:appnet", "host", "daemon:containerd", "registry:hub", "build:dockerfile"). Returns facts, relations (depends on / depended by / made of / used by), and the level-appropriate truth.
- "selected": what the learner currently has selected and what concepts are visible.
- "events": recent semantic events (kind, target, summary, causedBy). Use since_event to read only new ones.
- "user_activity": what the LEARNER did recently (clicks, level changes, terminal commands, lab dial changes, predictions). Read this to react to them.
- "causal_trace": the causal chain behind an event (default: the most recent significant one): root cause → … → symptom, plus downstream effects.
- "why": why a target is in its current state (walks its latest event's causes).
- "view": abstraction level, overlays, region, lab mode, focus.
- "timeline": the steps with cursor, so you can rewind/compare.
- "requests": recent request traces with per-hop success/failure.
- "logs": container logs (target required).
- "kernel": level-4 view of a container (namespaces, cgroup files, mounts, veth/iptables).
The browser is authoritative; if its tab is closed this returns world_offline.`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['overview', 'object', 'selected', 'events', 'user_activity', 'causal_trace', 'why', 'view', 'timeline', 'requests', 'logs', 'kernel'] },
        target: { type: 'string', description: 'e.g. container:web' },
        level: levelProp,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'max items for events/user_activity (default 25)' },
        since_event: { type: 'integer', description: 'only events with id greater than this' },
        event_id: { type: 'integer', description: 'for causal_trace: the event to explain' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'world_focus',
    title: 'Focus the learner\'s attention',
    description: `Direct the learner's attention to an object or concept, with the world's own visual language (highlight, camera move, relationship reveal). Does not change Docker state.
- target: select/highlight an object ("container:web", "image:nginx:latest", "volume:mydata", "network:appnet", "host", "daemon:dockerd", "registry:hub", "build:dockerfile").
- reveal: show relationships contextually for target (or concept): depends_on (what it needs), depended_by (what breaks without it), made_of, used_by, why (why it exists + what causes/manages it), to_kernel (trace down to Linux primitives), to_ecosystem (trace out to Kubernetes/OCI/cloud), follow (direct connections). The world shows a small subgraph, never the whole graph.
- concept: a concept id from concept_inspect (e.g. "namespaces", "overlayfs", "oci-runtime").
- level: also set the abstraction level (0-6).
- region: move the camera: overview, whale, deck, engine-room, harbor, shipyard.
- say: a short caption shown to the learner next to the highlight (one sentence).
Returns what is now in focus, including the revealed relationships.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        concept: { type: 'string' },
        reveal: { type: 'string', enum: ['depends_on', 'depended_by', 'made_of', 'used_by', 'why', 'to_kernel', 'to_ecosystem', 'follow'] },
        level: levelProp,
        region: { type: 'string', enum: ['overview', 'whale', 'deck', 'engine-room', 'harbor', 'shipyard'] },
        say: { type: 'string', maxLength: 240 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'world_mutate',
    title: 'Change the world (semantic action)',
    description: `Perform ONE semantic action in the simulated Docker world. Never set positions or animations: describe what happens in Docker terms and the world renders it. Every action emits causally-linked events (read them with world_inspect scope="events" or "causal_trace"); every action is one step on the timeline, so it can be rewound. Failures are realistic and educational (port already allocated, volume in use, exec format error…) and are returned with ok=false plus the events that explain why.

Payload: { "action": "<name>", ...params }. Example: {"action":"set_resource_limit","target":"container:api","resource":"memory","value":"128MB"}.

ACTION MANUAL (purpose, effect, concepts, side effects, visual, how to teach with it; * = required):

${manualText()}`,
    inputSchema: mutateSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'world_run_scenario',
    title: 'Run an experiment ("what if I…")',
    description: `Run a deliberate experiment that breaks or changes the world, as a group of timeline steps. Three ways:
1. Built-in library: {"id":"reduce-memory"}. Use {"list":true} to see all ids, titles, "what if" prompts and which concepts each teaches. Built-ins: delete-container, volume-survives, delete-volume, kill-pid1, kill-worker, no-network, break-dns, fill-disk, reduce-memory, memory-leak, port-conflict, wrong-port, registry-down, wrong-mount, restart-service, restart-host, wrong-arch, rebuild-one-layer, cache-bust-order, delete-local-image, break-compose-dependency, containerd-down, cpu-throttle, isolated-networks, name-resolution, signal-handling, crash-loop.
2. Custom (you design it): {"title":"…","preset":"empty|welcome|persistence|shop","setup":[actions],"steps":[actions]} — "setup" builds the baseline, "steps" is the break; each action has the same shape as world_mutate. Use this to answer the learner's own "what if I…" questions.
3. As a prediction: add "predict":true to a built-in to create a prediction card INSTEAD of running immediately (the learner answers, then it runs).
By default the world is reset to the scenario's preset first (reset_first:false keeps the current world; the custom setup then applies on top). Returns the events and the causal trace of the break so you can narrate it.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        list: { type: 'boolean' },
        predict: { type: 'boolean' },
        reset_first: { type: 'boolean', description: 'default true' },
        title: { type: 'string' },
        preset: { type: 'string', enum: ['empty', 'welcome', 'persistence', 'shop'] },
        setup: { type: 'array', items: { type: 'object' } },
        steps: { type: 'array', items: { type: 'object' } },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'world_set_view',
    title: 'Set the learner\'s view',
    description: `Change how the world is presented (not what exists): abstraction level (0-6), camera region (overview, whale, deck, engine-room = the crew, harbor, shipyard) and zoom, Lab mode (shows the learner experiment dials: latency, packet loss, DNS, bandwidth, CPU load, memory pressure, disk, registry), whether simulated time flows by itself (time_flows), compare mode off/on, and reduced motion. Use level to move the SAME objects between metaphor and reality; use lab_mode to invite the learner to experiment themselves.`,
    inputSchema: {
      type: 'object',
      properties: {
        level: levelProp,
        region: { type: 'string', enum: ['overview', 'whale', 'deck', 'engine-room', 'harbor', 'shipyard'] },
        zoom: { type: 'number', minimum: 0.5, maximum: 4, description: 'camera zoom around the region (1 = default)' },
        lab_mode: { type: 'boolean' },
        time_flows: { type: 'boolean', description: 'advance simulated time automatically (leaks grow, limits bite)' },
        select: { type: 'string', description: 'select this target in the inspector' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'world_set_overlay',
    title: 'Toggle explanatory overlays',
    description: `Show or hide overlays that draw one SYSTEM of relationships on top of the world, in that system's colour: network (signal lines, veth/bridge at deeper levels), storage (volume straps, bind mounts, writable layers), process (PID tree), kernel (namespace rings, cgroup gauges), resources (CPU/RAM/disk pressure), causality (the causal chain of the latest events), dependencies (who depends on whom). Overlays stay readable because each is one system; combine at most 2-3.`,
    inputSchema: {
      type: 'object',
      properties: {
        overlays: { type: 'array', items: { type: 'string', enum: overlays } },
        mode: { type: 'string', enum: ['set', 'add', 'remove'], description: 'default set' },
      },
      required: ['overlays'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'world_compare',
    title: 'Compare before / after',
    description: `Diff two timeline steps (default: the step before the last change vs now) and return a structured list of what changed: containers added/removed/state changes, limits, ports, mounts, networks, volumes, images, host conditions, health/service status. With show:true the learner sees the before/after comparison panel. Use after any mutation or scenario to make the consequence concrete.`,
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'integer', description: 'earlier step index' }, b: { type: 'integer', description: 'later step index' }, show: { type: 'boolean' } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'world_rewind',
    title: 'Rewind or step through time',
    description: `Move along the timeline of semantic steps: to_step (absolute index), back (N steps), or forward (N steps). The world, inspector and renderer restore that exact earlier state; later steps stay available (redo) until a new action is performed. Use it to undo an experiment, replay it slowly, or let the learner scrub. Returns the restored step and its label.`,
    inputSchema: {
      type: 'object',
      properties: { to_step: { type: 'integer' }, back: { type: 'integer', minimum: 1 }, forward: { type: 'integer', minimum: 1 } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'world_reset',
    title: 'Reset to a preset world',
    description: `Start over from a known world (a new step on the timeline, so even this can be rewound): "empty" (clean host), "welcome" (nginx web on :8080), "persistence" (two redis containers: one with a volume, one without, 120 records each), "shop" (a built Compose app: web → api → db with a volume).`,
    inputSchema: { type: 'object', properties: { preset: { type: 'string', enum: ['empty', 'welcome', 'persistence', 'shop'] } }, required: ['preset'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'world_connection_test',
    title: 'Connection test (Santa waves)',
    description: `Harmless test that proves the connection works end to end: Santa visibly waves from the whale and the learner's page shows "Your AI is connected". Changes no Docker state. Call it first in every session.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'concept_inspect',
    title: 'Inspect a concept',
    description: `Read the Docker knowledge graph for one concept: summary, why it exists, what it is at each abstraction level, what it depends on / what depends on it / what it is made of / what implements it, its metaphor, common misconceptions, suggested experiments (scenario ids), relevant commands and Linux kernel primitives. Ids include: host, container, image, layer, tag, registry, dockerfile, build, build-cache, volume, bind-mount, tmpfs, writable-layer, network, port-publish, service-discovery, dns, compose, healthcheck, restart-policy, logs, lifecycle, exit-codes, docker-cli, docker-api, platform, disk, dockerd, containerd, shim, runc, buildkit, kernel, process, pid1, signals, namespaces, pid-ns, net-ns, mnt-ns, user-ns, cgroups, memory-limit, cpu-limit, pids-limit, oom-killer, overlayfs, veth, bridge, iptables, capabilities, seccomp, oci-image, oci-runtime, oci-distribution, manifest, digest, image-index, kubernetes, cri, pod, orchestration, podman, sandbox-runtimes, cloud-runtimes, ci-cd, supply-chain, observability, registry-products, daemon-restart. Pass {"list":true} for the full list with one-line summaries.`,
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, level: levelProp, list: { type: 'boolean' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'concept_trace_relationship',
    title: 'Trace relationships between concepts',
    description: `Walk the knowledge graph. direction: "depends_on" (what it needs), "depended_by" (what relies on it), "made_of", "used_by", "why", "down_to_kernel" (the shortest chains from this concept down to Linux kernel primitives — e.g. container → namespaces → pid-ns), "out_to_ecosystem" (chains out to Kubernetes/OCI/cloud), or "between" (the shortest relationship path from "from" to "to"). With show:true the learner sees the revealed subgraph in the world (contextually; never the whole graph).`,
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'concept id' },
        to: { type: 'string', description: 'concept id (direction "between")' },
        direction: { type: 'string', enum: ['depends_on', 'depended_by', 'made_of', 'used_by', 'why', 'down_to_kernel', 'out_to_ecosystem', 'between'] },
        show: { type: 'boolean' },
      },
      required: ['from'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'lesson_check_understanding',
    title: 'Prediction check',
    description: `Make the learner PREDICT before you reveal. action:
- "predict": create a prediction card: {question, options:[{id,label}], answer_id (hidden from the learner), explanation, concepts, and EITHER scenario:"<built-in id>" OR steps:[actions]}. The learner picks an option; then the experiment runs and the outcome + causal trace are revealed, marked right or wrong. Create ONE at a time.
- "status": the current prediction (state: open/answered/revealed, chosen option, correct?).
- "reveal": run the experiment now (even if unanswered) and reveal.
- "cancel": remove the open prediction.
Good predictions have 3-4 plausible options, one of which is the common misconception. After the reveal, read world_inspect scope="causal_trace" and teach from what actually happened.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['predict', 'status', 'reveal', 'cancel'] },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] } },
        answer_id: { type: 'string' },
        explanation: { type: 'string' },
        concepts: { type: 'array', items: { type: 'string' } },
        scenario: { type: 'string' },
        steps: { type: 'array', items: { type: 'object' } },
      },
      required: ['action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'lesson_get_progress',
    title: 'Learner progress',
    description: `What the learner has actually done and understood, tracked in their browser: concepts seen (and the deepest abstraction level they viewed each at), predictions made with right/wrong, scenarios run, levels visited, counts of their own actions vs yours, and suggestions for what to explore next. Use it to adapt: skip what they already got right, revisit predictions they missed.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** Messages the relay and browser exchange over the WebSocket. */
export type BrowserToRelay =
  | { t: 'hello'; lab: string; secret: string; app: string }
  | { t: 'result'; id: string; ok: boolean; value?: unknown; error?: string }
  | { t: 'ping' };

export type RelayToBrowser =
  | { t: 'ready'; lastMcpAt: number | null }
  | { t: 'call'; id: string; tool: string; args: Record<string, unknown> }
  | { t: 'mcp'; status: 'connected'; client: string; at: number }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong' };
