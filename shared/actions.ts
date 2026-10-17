/**
 * Typed action catalogue for `world_mutate`.
 *
 * One table drives three things: the instruction manual the AI reads in the
 * tool description, runtime validation of AI/user payloads, and the JSON schema.
 * Keep prose here honest: it is the AI's only briefing on how the world works.
 */

export type ParamType = 'string' | 'number' | 'boolean' | 'string[]' | 'object';

export interface Param {
  name: string;
  type: ParamType;
  required?: boolean;
  enum?: string[];
  desc: string;
}

export interface ActionSpec {
  group: 'lifecycle' | 'images' | 'networking' | 'storage' | 'resources' | 'host' | 'build' | 'compose' | 'observe' | 'lab';
  params: Param[];
  purpose: string;
  effect: string;
  concepts: string[];
  sideEffects: string;
  visual: string;
  teaching: string;
}

const target = (desc = 'container:<name>'): Param => ({ name: 'target', type: 'string', required: true, desc });

export const ACTION_SPECS: Record<string, ActionSpec> = {
  pull_image: {
    group: 'images',
    params: [{ name: 'ref', type: 'string', required: true, desc: 'image reference, e.g. "nginx", "redis:7", "postgres:16", "alpine:3.20", "node:20-alpine", "leaky:latest", "arm-demo:latest"' }],
    purpose: 'Download an image from the registry (the harbor).',
    effect: 'Fetches the manifest, then only the layers not already local (shared layers are reported as "already exists"). Fails with precise reasons if DNS, the registry, bandwidth or disk is broken.',
    concepts: ['image', 'layer', 'registry', 'digest', 'oci-distribution'],
    sideEffects: 'Uses disk. Wrong-architecture images pull with a warning but cannot run.',
    visual: 'A beam from the harbor lowers blueprint plates onto the whale; reused plates flash instead of travelling.',
    teaching: 'Show layer sharing (pull node:20-alpine then alpine:3.20) or combine with set_condition dns/registry to teach failure modes.',
  },
  run_container: {
    group: 'lifecycle',
    params: [
      { name: 'image', type: 'string', required: true, desc: 'image reference (pulled automatically if missing, like docker run)' },
      { name: 'name', type: 'string', desc: 'container name (auto-generated if omitted)' },
      { name: 'ports', type: 'string[]', desc: 'published ports like "8080:80" (host:container)' },
      { name: 'volumes', type: 'string[]', desc: 'mounts: "mydata:/data" (named volume), "/srv/site:/usr/share/nginx/html:ro" (bind), "tmpfs:/tmp"' },
      { name: 'network', type: 'string', desc: 'network name (default "bridge")' },
      { name: 'env', type: 'object', desc: 'environment variables' },
      { name: 'memory', type: 'string', desc: 'memory limit like "128MB" or "1g" (cgroup memory.max)' },
      { name: 'cpus', type: 'number', desc: 'CPU limit in cores, e.g. 0.5' },
      { name: 'pids', type: 'number', desc: 'process limit' },
      { name: 'restart', type: 'string', enum: ['no', 'on-failure', 'always', 'unless-stopped'], desc: 'restart policy' },
      { name: 'cmd', type: 'string[]', desc: 'command override, e.g. ["sleep","3600"] keeps alpine alive' },
      { name: 'privileged', type: 'boolean', desc: 'grant all capabilities and no seccomp' },
      { name: 'readOnly', type: 'boolean', desc: 'read-only root filesystem' },
    ],
    purpose: 'Create AND start a container from an image (docker run).',
    effect: 'Pulls if needed, creates the container, wires network/mounts/ports/limits, then walks dockerd → containerd → shim → runc. Fails realistically: port in use leaves the container in "created"; arch mismatch exits 255; a limit below boot memory is an instant OOM kill.',
    concepts: ['container', 'image', 'lifecycle', 'port-publish', 'volume', 'cgroups', 'namespaces', 'runc'],
    sideEffects: 'Allocates an IP, publishes iptables rules, may create volumes/bind directories implicitly, may create a crash loop with restart policies.',
    visual: 'A new shipping container is lowered onto a free deck slot; gangplank appears for ports, straps for volumes.',
    teaching: 'The core move. Start simple (nginx -p), then add one flag at a time to reveal what each does.',
  },
  create_container: {
    group: 'lifecycle',
    params: [
      { name: 'image', type: 'string', required: true, desc: 'image reference' },
      { name: 'name', type: 'string', desc: 'container name' },
      { name: 'ports', type: 'string[]', desc: 'published ports' },
      { name: 'volumes', type: 'string[]', desc: 'mounts' },
      { name: 'network', type: 'string', desc: 'network name' },
      { name: 'env', type: 'object', desc: 'environment' },
      { name: 'memory', type: 'string', desc: 'memory limit' },
      { name: 'restart', type: 'string', enum: ['no', 'on-failure', 'always', 'unless-stopped'], desc: 'restart policy' },
    ],
    purpose: 'Create a container WITHOUT starting it (docker create).',
    effect: 'Container exists in state "created": filesystem layers prepared, nothing running, no ports bound yet.',
    concepts: ['container', 'lifecycle', 'writable-layer'],
    sideEffects: 'Allocates an IP and a writable layer, but no process.',
    visual: 'A dark container sits on the deck, unlit.',
    teaching: 'Separates "exists" from "is running" — the root of many lifecycle misunderstandings.',
  },
  start_container: {
    group: 'lifecycle',
    params: [target()],
    purpose: 'Start a created or exited container (docker start).',
    effect: 'Runs the engine chain again; a new process (new PID) starts in the SAME container with its writable layer intact.',
    concepts: ['lifecycle', 'process', 'container'],
    sideEffects: 'Can fail on port conflicts or limits like run_container.',
    visual: 'The container lights up; its core pulses.',
    teaching: 'Pair with stop_container to show the writable layer surviving stop/start but not remove.',
  },
  stop_container: {
    group: 'lifecycle',
    params: [target()],
    purpose: 'Stop a running container gracefully (docker stop).',
    effect: 'SIGTERM → wait → SIGKILL. nginx/redis/postgres exit 0; a PID 1 with no SIGTERM handler (the Node API) ends with 137 after the grace period.',
    concepts: ['signals', 'pid1', 'exit-codes', 'lifecycle'],
    sideEffects: 'Marks it manually stopped, so restart policies leave it alone. Published ports go dead; dependants become unhealthy.',
    visual: 'The container dims; its gangplank retracts; dependants flicker amber.',
    teaching: 'Use on the api service to reveal why exit code 137 appears on "graceful" stops.',
  },
  restart_container: {
    group: 'lifecycle',
    params: [target()],
    purpose: 'Stop and start a container (docker restart).',
    effect: 'New process, same container id, same writable layer.',
    concepts: ['lifecycle', 'process'],
    sideEffects: 'Brief downtime for dependants.',
    visual: 'Container blinks dark then relights.',
    teaching: 'Contrast with remove+run (new container, empty writable layer).',
  },
  pause_container: {
    group: 'lifecycle',
    params: [target()],
    purpose: 'Freeze a container\'s processes (docker pause).',
    effect: 'cgroup freezer stops scheduling; memory stays; connections hang (timeouts, not refusals).',
    concepts: ['cgroups', 'process', 'lifecycle'],
    sideEffects: 'Requests to it time out; dependants become unhealthy.',
    visual: 'Frosted container, crew frozen.',
    teaching: 'Shows difference between "refused" (nothing listening) and "timeout" (listening but frozen).',
  },
  unpause_container: {
    group: 'lifecycle',
    params: [target()],
    purpose: 'Resume a paused container.',
    effect: 'The freezer is released; processes continue exactly where they stopped.',
    concepts: ['cgroups', 'lifecycle'],
    sideEffects: 'Dependants recover.',
    visual: 'Frost melts.',
    teaching: 'Undo for pause_container.',
  },
  remove_container: {
    group: 'lifecycle',
    params: [target(), { name: 'force', type: 'boolean', desc: 'kill it first if running' }, { name: 'volumes', type: 'boolean', desc: 'also remove anonymous volumes' }],
    purpose: 'Delete a container (docker rm).',
    effect: 'Without force a running container is refused. Its writable layer is destroyed (data_lost event if it held data); named volumes survive; the image is untouched.',
    concepts: ['writable-layer', 'volume', 'lifecycle', 'image'],
    sideEffects: 'Frees its IP, ports and name.',
    visual: 'The container is lifted off the whale; any strapped barrel stays aboard.',
    teaching: 'THE persistence lesson: ask the learner to predict what survives (lesson_check_understanding).',
  },
  kill_process: {
    group: 'lifecycle',
    params: [target(), { name: 'pid', type: 'number', desc: 'PID inside the container namespace (default 1 = main process; nginx workers are 7, 8…)' }, { name: 'signal', type: 'string', enum: ['SIGKILL', 'SIGTERM'], desc: 'default SIGKILL' }],
    purpose: 'Send a signal to a process inside a container.',
    effect: 'PID 1 dies → the PID namespace is torn down → container exits 137 (restart policies may revive it). A worker dies → the master respawns it, the container lives on.',
    concepts: ['pid1', 'pid-ns', 'signals', 'process', 'restart-policy'],
    sideEffects: 'Triggers service-unavailable chains and restart-policy behaviour.',
    visual: 'Scorched container; or a single flicker inside for a worker.',
    teaching: 'Contrast killing PID 1 vs PID 7 to teach "container life = PID 1 life".',
  },
  remove_image: {
    group: 'images',
    params: [target('image:<repo:tag>'), { name: 'force', type: 'boolean', desc: 'remove even if containers use it' }],
    purpose: 'Delete a local image (docker rmi).',
    effect: 'Refused while any container (even stopped) references it unless forced; otherwise untags it and garbage-collects layers no other image shares.',
    concepts: ['image', 'layer', 'digest'],
    sideEffects: 'Frees disk; next run must pull again.',
    visual: 'Blueprint plates fade from the shelf; shared plates stay.',
    teaching: 'Shows that layers are reference-counted and shared.',
  },
  create_network: {
    group: 'networking',
    params: [{ name: 'name', type: 'string', required: true, desc: 'network name' }],
    purpose: 'Create a user-defined bridge network.',
    effect: 'New Linux bridge, subnet, gateway and embedded DNS for name resolution.',
    concepts: ['network', 'bridge', 'dns', 'service-discovery'],
    sideEffects: 'None until containers attach.',
    visual: 'A new coloured signal line appears above the deck.',
    teaching: 'Show that names resolve here but not on the default bridge.',
  },
  remove_network: {
    group: 'networking',
    params: [{ name: 'name', type: 'string', required: true, desc: 'network name' }],
    purpose: 'Delete a network.',
    effect: 'Refused while containers are attached.',
    concepts: ['network'],
    sideEffects: 'Bridge removed from the kernel.',
    visual: 'The signal line fades.',
    teaching: 'Why "active endpoints" blocks deletion.',
  },
  connect_network: {
    group: 'networking',
    params: [{ name: 'container', type: 'string', required: true, desc: 'container:<name>' }, { name: 'network', type: 'string', required: true, desc: 'network name' }],
    purpose: 'Attach a container to an additional network.',
    effect: 'A second veth pair and IP; the container can now talk to that network\'s members (and bridges between networks).',
    concepts: ['network', 'veth', 'net-ns'],
    sideEffects: 'Can make previously failing requests succeed.',
    visual: 'A new line connects the container to the network bus.',
    teaching: 'The fix for isolated-network failures.',
  },
  disconnect_network: {
    group: 'networking',
    params: [{ name: 'container', type: 'string', required: true, desc: 'container:<name>' }, { name: 'network', type: 'string', required: true, desc: 'network name' }],
    purpose: 'Detach a container from a network.',
    effect: 'Veth pair removed: name lookups and routes to that network\'s members fail.',
    concepts: ['network', 'veth', 'service-discovery'],
    sideEffects: 'Dependants that need it by name become unhealthy.',
    visual: 'The line snaps and sparks.',
    teaching: 'Cut a dependency and watch health cascade.',
  },
  create_volume: {
    group: 'storage',
    params: [{ name: 'name', type: 'string', required: true, desc: 'volume name' }],
    purpose: 'Create a named volume.',
    effect: 'A directory under /var/lib/docker/volumes/<name>/_data, independent of any container.',
    concepts: ['volume'],
    sideEffects: 'None.',
    visual: 'A barrel appears in the hold.',
    teaching: 'Then run_container with volumes ["name:/path"].',
  },
  remove_volume: {
    group: 'storage',
    params: [{ name: 'name', type: 'string', required: true, desc: 'volume name' }],
    purpose: 'Delete a named volume and its data.',
    effect: 'Refused if any container (even stopped) references it; otherwise the data is deleted forever.',
    concepts: ['volume', 'container'],
    sideEffects: 'Permanent data loss.',
    visual: 'The barrel sinks.',
    teaching: 'Pair with prediction: "can we delete it while a stopped container uses it?"',
  },
  set_resource_limit: {
    group: 'resources',
    params: [target(), { name: 'resource', type: 'string', required: true, enum: ['memory', 'cpu', 'pids'], desc: 'which cgroup limit' }, { name: 'value', type: 'string', desc: 'memory "64MB"; cpu cores like 0.5; pids count; omit/null to remove' }],
    purpose: 'Change a live container\'s cgroup limit (docker update).',
    effect: 'memory: writes memory.max — below current usage the cgroup OOM killer fires (limit_changed → memory.exceeded → oom_kill → exit 137). cpu: throttles. pids: caps forks.',
    concepts: ['memory-limit', 'cpu-limit', 'pids-limit', 'cgroups', 'oom-killer'],
    sideEffects: 'May kill the container; its dependants and published port go down.',
    visual: 'The gauge ring around the container\'s core tightens; if exceeded, lightning strikes and the box is scorched.',
    teaching: 'The best causal-chain demo: limit → cgroup → OOM → exit → service down.',
  },
  stress: {
    group: 'resources',
    params: [target(), { name: 'resource', type: 'string', required: true, enum: ['memory', 'cpu'], desc: 'what to consume' }, { name: 'amount', type: 'number', required: true, desc: 'MB (memory) or % of one core (cpu)' }],
    purpose: 'Make the process inside a container consume more memory or CPU.',
    effect: 'Raises usage; may cross its memory limit (OOM) or the host\'s RAM (global OOM kills the biggest consumer); CPU over its quota is throttled, never killed.',
    concepts: ['process', 'memory-limit', 'cpu-limit', 'oom-killer'],
    sideEffects: 'Can kill containers.',
    visual: 'The gauge fills; heat glows on the container.',
    teaching: 'Pair with set_resource_limit, or show memory (kills) vs CPU (throttles).',
  },
  write_data: {
    group: 'storage',
    params: [target(), { name: 'path', type: 'string', required: true, desc: 'path inside the container, e.g. /data' }, { name: 'count', type: 'number', desc: 'number of records (default 100)' }],
    purpose: 'Make the app write records to a path.',
    effect: 'Records land in whichever mount covers the path: volume, bind mount, tmpfs (RAM) or — if none — the container\'s writable layer (lost on remove). Read-only mounts and a full disk refuse.',
    concepts: ['volume', 'bind-mount', 'tmpfs', 'writable-layer'],
    sideEffects: 'Uses disk (or RAM for tmpfs).',
    visual: 'Packets stream into the strapped barrel or the container floor.',
    teaching: 'Write to /data on two containers (volume vs none), then remove both.',
  },
  fill_disk: {
    group: 'host',
    params: [{ name: 'mb', type: 'number', required: true, desc: 'MB written by something outside Docker' }],
    purpose: 'Fill the host disk.',
    effect: 'At zero free space every write fails (ENOSPC): databases crash, caches stop accepting writes, web servers keep serving, pulls and builds fail.',
    concepts: ['disk', 'overlayfs'],
    sideEffects: 'Can crash containers.',
    visual: 'The hold below deck fills; storm gathers.',
    teaching: 'Shows that containers share one disk — there is no private storage.',
  },
  free_disk: {
    group: 'host',
    params: [],
    purpose: 'Remove the non-Docker disk usage.',
    effect: 'Free space returns.',
    concepts: ['disk'],
    sideEffects: 'None (crashed containers stay down).',
    visual: 'Hold empties; storm clears.',
    teaching: 'Recovery step after fill_disk.',
  },
  set_condition: {
    group: 'lab',
    params: [
      { name: 'condition', type: 'string', required: true, enum: ['latency', 'packet_loss', 'dns', 'bandwidth', 'registry', 'cpu_load', 'memory_pressure', 'disk_available', 'host_online'], desc: 'which environmental condition' },
      { name: 'value', type: 'number', required: true, desc: 'latency ms; packet_loss 0-100; bandwidth Mbps; cpu_load 0-100; memory_pressure MB held by another host process; disk_available free MB; dns/registry/host_online: 1=up 0=down' },
    ],
    purpose: 'Change the environment the Docker host lives in — the same dials the learner has in Lab mode.',
    effect: 'dns=0 breaks registry names but not container names; registry=0 breaks pulls but not local images; high packet loss times requests out; memory_pressure can trigger the HOST OOM killer; host_online=0 powers the machine off (restart policies apply on boot).',
    concepts: ['dns', 'registry', 'network', 'oom-killer', 'disk', 'host'],
    sideEffects: 'May kill containers or make requests fail.',
    visual: 'Weather on the whale: storm, fog, lightning depending on the condition.',
    teaching: 'Deliberately break the world so the learner sees dependencies; then restore it.',
  },
  restart_host: {
    group: 'host',
    params: [],
    purpose: 'Reboot the host machine.',
    effect: 'Containers get SIGTERM, dockerd stops, the machine boots, dockerd starts and restart policies decide who returns (always yes; unless-stopped unless stopped by hand; no never).',
    concepts: ['restart-policy', 'daemon-restart', 'host'],
    sideEffects: 'Downtime for everything.',
    visual: 'The whale dims and wakes up; cargo relights selectively.',
    teaching: 'The restart-policy exam question.',
  },
  stop_daemon: {
    group: 'host',
    params: [{ name: 'daemon', type: 'string', required: true, enum: ['dockerd', 'containerd'], desc: 'which daemon' }],
    purpose: 'Stop a Docker Engine component.',
    effect: 'dockerd: containers are stopped (no live-restore) and the CLI cannot connect. containerd: running containers KEEP RUNNING (their shims hold them) but no new container can start.',
    concepts: ['dockerd', 'containerd', 'shim', 'daemon-restart'],
    sideEffects: 'Blocks most other actions while dockerd is down.',
    visual: 'Santa or the foreman reindeer slumps; cargo stays lit if only containerd stopped.',
    teaching: 'Reveals the shim design: containerd is not a single point of failure for running containers.',
  },
  start_daemon: {
    group: 'host',
    params: [{ name: 'daemon', type: 'string', required: true, enum: ['dockerd', 'containerd'], desc: 'which daemon' }],
    purpose: 'Start a stopped daemon.',
    effect: 'dockerd: restart policies bring eligible containers back.',
    concepts: ['dockerd', 'containerd', 'restart-policy'],
    sideEffects: 'Containers restart.',
    visual: 'Santa/foreman perks up.',
    teaching: 'Recovery step.',
  },
  build_image: {
    group: 'build',
    params: [{ name: 'tag', type: 'string', desc: 'default my-api:latest' }],
    purpose: 'Build the sample Dockerfile (a Node API).',
    effect: 'Steps with unchanged inputs come from cache; a changed step invalidates every later step. Builds need DNS and the registry for FROM/RUN npm. Produces an image that shares the base image\'s layers.',
    concepts: ['dockerfile', 'build', 'build-cache', 'layer', 'buildkit'],
    sideEffects: 'Uses disk; replaces the previous tag (old image becomes <none>).',
    visual: 'Sparks at the shipyard; cached plates slide in, new ones are forged.',
    teaching: 'Build twice (all cached), edit one step, build again.',
  },
  edit_dockerfile: {
    group: 'build',
    params: [{ name: 'step', type: 'number', required: true, desc: 'step index, 0-based (0 FROM, 1 WORKDIR, 2 COPY package*.json, 3 RUN npm ci, 4 COPY . ., …)' }, { name: 'change', type: 'string', enum: ['touch', 'text'], desc: '"touch" = the files/command this step uses changed; "text" = change the instruction text (needs arg)' }, { name: 'arg', type: 'string', desc: 'new instruction argument when change="text"' }],
    purpose: 'Change something a Dockerfile step depends on, without rebuilding yet.',
    effect: 'That step and everything stacked after it can no longer come from cache.',
    concepts: ['dockerfile', 'build-cache', 'layer'],
    sideEffects: 'Next build_image re-runs from that step.',
    visual: 'The edited plate glows; plates above it crack.',
    teaching: 'Why Dockerfile order matters: dependencies before source.',
  },
  compose_up: {
    group: 'compose',
    params: [],
    purpose: 'Start the sample Compose project "shop": web (nginx) → api (my-api) → db (postgres).',
    effect: 'Creates network shop_default and volume shop_dbdata, starts services in dependency order. Requires my-api to be built first (build_image).',
    concepts: ['compose', 'service-discovery', 'volume', 'network'],
    sideEffects: 'Creates three containers.',
    visual: 'Three containers load in sequence, connected by one signal line.',
    teaching: 'The first multi-container view; then break db.',
  },
  compose_down: {
    group: 'compose',
    params: [],
    purpose: 'Tear the Compose project down.',
    effect: 'Removes containers and the project network; the database volume is KEPT.',
    concepts: ['compose', 'volume'],
    sideEffects: 'Containers deleted.',
    visual: 'Cargo lifts off; the barrel stays.',
    teaching: 'Why volumes survive down (but not down -v).',
  },
  compose_stop_service: {
    group: 'compose',
    params: [{ name: 'service', type: 'string', required: true, enum: ['web', 'api', 'db'], desc: 'service name' }],
    purpose: 'Stop one service of the Compose project.',
    effect: 'Dependants stay "running" but become unhealthy; the site returns 502.',
    concepts: ['compose', 'healthcheck', 'service-discovery'],
    sideEffects: 'Cascading health failures.',
    visual: 'One cargo box dims; amber ripples travel up the dependency line.',
    teaching: 'Running is not the same as working.',
  },
  send_request: {
    group: 'observe',
    params: [
      { name: 'from', type: 'string', required: true, desc: '"external", "host", or container:<name>' },
      { name: 'to', type: 'string', required: true, desc: 'container:<name>' },
      { name: 'port', type: 'number', desc: 'host port when from external/host; container port otherwise' },
      { name: 'by', type: 'string', enum: ['name', 'ip'], desc: 'container→container addressing (default name)' },
    ],
    purpose: 'Send a request and trace every hop.',
    effect: 'Walks client → DNS → iptables DNAT → bridge → veth → netns → socket → app, stopping at the first broken hop; returns the hop list and a reason.',
    concepts: ['port-publish', 'service-discovery', 'bridge', 'veth', 'iptables', 'net-ns'],
    sideEffects: 'None (adds a request record).',
    visual: 'A packet runs along the path; the failing hop flashes red.',
    teaching: 'The diagnostic move: after any break, send a request and read the failing hop.',
  },
  advance_time: {
    group: 'observe',
    params: [{ name: 'ticks', type: 'number', desc: 'simulated ticks to pass (1–60, default 1)' }],
    purpose: 'Let time pass.',
    effect: 'Leaky apps grow; limits and the host are re-checked each tick.',
    concepts: ['process', 'memory-limit', 'oom-killer'],
    sideEffects: 'Can trigger OOM kills.',
    visual: 'Gauges creep upward.',
    teaching: 'Needed for leak scenarios.',
  },
  connection_test: {
    group: 'observe',
    params: [],
    purpose: 'Harmless connection test: proves the AI can drive the world.',
    effect: 'No state change; emits a visible event.',
    concepts: ['dockerd'],
    sideEffects: 'None.',
    visual: 'Santa waves from the whale and a "Your AI is connected" banner appears.',
    teaching: 'Call once at the very start of a session.',
  },
};

export const ACTION_NAMES = Object.keys(ACTION_SPECS);

/** Validate a loose payload against the table. Returns the cleaned action or an error. */
export function validateAction(input: unknown): { ok: true; action: Record<string, unknown> & { action: string } } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'payload must be an object with an "action" field' };
  const raw = input as Record<string, unknown>;
  const name = raw.action;
  if (typeof name !== 'string' || !(name in ACTION_SPECS)) {
    return { ok: false, error: `unknown action "${String(name)}". Valid actions: ${ACTION_NAMES.join(', ')}` };
  }
  const spec = ACTION_SPECS[name]!;
  const out: Record<string, unknown> = { action: name };
  for (const p of spec.params) {
    let v = raw[p.name];
    if (v === undefined || v === null || v === '') {
      if (p.required) return { ok: false, error: `${name}: missing required parameter "${p.name}" (${p.desc})` };
      if (v === null && (p.name === 'value')) out[p.name] = null;
      continue;
    }
    switch (p.type) {
      case 'string':
        if (typeof v === 'number') v = String(v);
        if (typeof v !== 'string') return { ok: false, error: `${name}: "${p.name}" must be a string` };
        if (p.enum && !p.enum.includes(v)) return { ok: false, error: `${name}: "${p.name}" must be one of ${p.enum.join(', ')}` };
        break;
      case 'number': {
        const n = typeof v === 'string' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, error: `${name}: "${p.name}" must be a number` };
        v = n;
        break;
      }
      case 'boolean':
        if (typeof v === 'number') v = v !== 0;
        if (typeof v !== 'boolean') return { ok: false, error: `${name}: "${p.name}" must be true or false` };
        break;
      case 'string[]':
        if (typeof v === 'string') v = [v];
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return { ok: false, error: `${name}: "${p.name}" must be an array of strings` };
        break;
      case 'object':
        if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `${name}: "${p.name}" must be an object` };
        break;
    }
    out[p.name] = v;
  }
  // set_condition: booleans for dns/registry/host_online arrive as numbers
  if (name === 'set_condition') {
    const c = out.condition as string;
    if (['dns', 'registry', 'host_online'].includes(c)) out.value = !!out.value;
    else if (typeof out.value !== 'number') return { ok: false, error: `set_condition: "${c}" needs a numeric value` };
  }
  if (name === 'set_resource_limit' && out.resource === 'memory' && 'value' in out && typeof out.value === 'number') out.value = String(out.value) + 'MB';
  return { ok: true, action: out as Record<string, unknown> & { action: string } };
}

/** Compact manual text for tool descriptions. */
export function manualText(): string {
  const groups = new Map<string, string[]>();
  for (const [name, s] of Object.entries(ACTION_SPECS)) {
    const params = s.params.map((p) => `${p.name}${p.required ? '*' : ''}`).join(', ');
    const block = [`• ${name}(${params}) — ${s.purpose}`, `   effect: ${s.effect}`, `   concepts: ${s.concepts.join(', ')}. side effects: ${s.sideEffects}`, `   visual: ${s.visual}`, `   teach: ${s.teaching}`].join('\n');
    (groups.get(s.group) ?? groups.set(s.group, []).get(s.group)!).push(block);
  }
  return [...groups.entries()].map(([g, items]) => `[${g.toUpperCase()}]\n${items.join('\n')}`).join('\n\n');
}
