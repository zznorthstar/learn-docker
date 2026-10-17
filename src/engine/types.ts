/**
 * The semantic world model.
 *
 * Everything the renderer draws, everything the AI sees and everything the
 * timeline restores is a projection of `World`. It is plain JSON (cloneable,
 * diffable, serialisable) and contains NO visual data: no x/y, no colours, no
 * animation state. Visuals are derived in src/render.
 */

export type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const LEVEL_NAMES: Record<Level, string> = {
  0: 'Story metaphor',
  1: 'Docker objects',
  2: 'Docker Engine internals',
  3: 'Linux process reality',
  4: 'Kernel primitives',
  5: 'OCI standards',
  6: 'Wider ecosystem',
};

/** "kind:name", e.g. container:web, image:nginx:latest, volume:mydata, host. */
export type Target = string;

export type ContainerState = 'created' | 'running' | 'paused' | 'exited' | 'dead';
export type RestartPolicy = 'no' | 'on-failure' | 'always' | 'unless-stopped';
export type Health = 'none' | 'healthy' | 'unhealthy';
export type Arch = 'amd64' | 'arm64';

export interface PortMap {
  host: number;
  container: number;
  proto: 'tcp' | 'udp';
}

export interface Mount {
  type: 'volume' | 'bind' | 'tmpfs';
  /** volume name, host path, or '' for tmpfs */
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface Limits {
  memoryMB: number | null;
  cpus: number | null;
  pids: number | null;
}

/** How the software inside an image behaves. This is the simulation's "app". */
export interface Workload {
  kind: 'static-web' | 'cache' | 'database' | 'api' | 'idle' | 'job';
  /** container port the app listens on */
  listens: number | null;
  baseMemMB: number;
  /** memory growth per simulated tick (a leak) */
  leakMBPerTick: number;
  baseCpuPct: number;
  /** path inside the container where the app keeps data worth persisting */
  dataDir: string | null;
  /** the app serves/needs files at dataDir that exist in the image by default */
  imageHasData: boolean;
  /** hostnames this app must reach to be healthy (service discovery) */
  needs: string[];
  /** extra processes inside the container: name only; pids assigned at start */
  procs: string[];
  /** exits immediately (hello-world, one-shot jobs) */
  exitsAfterStart?: boolean;
}

export interface ImageConfig {
  cmd: string[];
  entrypoint: string[];
  env: string[];
  exposed: number[];
  workdir: string;
  user: string;
}

export interface HistoryStep {
  instr: string;
  /** layer digest produced, or null for metadata-only steps */
  layer: string | null;
}

export interface Image {
  ref: string; // repo:tag
  id: string; // sha256:<config digest>
  manifestDigest: string;
  arch: Arch;
  os: 'linux';
  layers: string[]; // digests, bottom -> top
  sizeMB: number;
  config: ImageConfig;
  history: HistoryStep[];
  workload: Workload;
  builtLocally?: boolean;
  /** which registry repo it came from */
  origin: 'registry' | 'local-build';
}

export interface Layer {
  digest: string;
  sizeMB: number;
  /** the Dockerfile instruction / filesystem change this layer represents */
  instr: string;
  /** summary of the changeset (files added/changed) for level-4 inspection */
  changes: string[];
}

export interface Network {
  name: string;
  driver: 'bridge' | 'host' | 'none';
  subnet: string;
  gateway: string;
  bridgeIf: string;
  builtin: boolean;
  /** user-defined networks get embedded DNS (name resolution) */
  dns: boolean;
  internal: boolean;
}

export interface Volume {
  name: string;
  driver: 'local';
  mountpoint: string;
  items: number; // records/files stored
  sizeMB: number;
  createdTick: number;
}

export interface ChildProc {
  /** pid inside the container's PID namespace */
  nsPid: number;
  name: string;
}

export interface Container {
  name: string;
  id: string; // 64 hex
  imageRef: string;
  imageId: string;
  state: ContainerState;
  exitCode: number | null;
  oomKilled: boolean;
  /** last failure message (docker's `Error` field) */
  error: string;
  /** host PID of the container's init process; 0 when not running */
  pid: number;
  createdTick: number;
  startedTick: number | null;
  finishedTick: number | null;
  cmd: string[];
  /** name of PID 1 after the entrypoint script exec()s into the real program */
  process: string;
  env: Record<string, string>;
  ports: PortMap[];
  mounts: Mount[];
  /** network name -> ip */
  networks: Record<string, { ip: string }>;
  limits: Limits;
  usage: { memMB: number; cpuPct: number };
  stress: { memMB: number; cpuPct: number };
  restartPolicy: RestartPolicy;
  restartCount: number;
  /** the user stopped it on purpose: restart policies must respect that */
  manuallyStopped: boolean;
  health: Health;
  /** is the published/served endpoint reachable from outside right now */
  service: 'up' | 'down' | 'none';
  workload: Workload;
  /** data living in the writable layer (dies with the container) */
  layerData: { items: number };
  childProcs: ChildProc[];
  security: {
    privileged: boolean;
    capAdd: string[];
    capDrop: string[];
    seccomp: 'default' | 'unconfined';
    readOnlyRootfs: boolean;
    user: string;
  };
  compose?: { project: string; service: string };
}

export interface Host {
  name: string;
  arch: Arch;
  os: string;
  kernel: string;
  cpuCores: number;
  ramMB: number;
  diskMB: number;
  online: boolean;
  bootCount: number;
  net: {
    dnsUp: boolean;
    latencyMs: number;
    packetLossPct: number;
    bandwidthMbps: number;
    registryReachable: boolean;
  };
  /** disk consumed by something that is not Docker */
  fillerDiskMB: number;
  /** memory used by non-container host processes */
  baseMemMB: number;
  /** extra memory pressure injected from outside (another noisy process) */
  memPressureMB: number;
  /** background host CPU load, 0..100 */
  cpuLoadPct: number;
  /** host directories that bind mounts can reference */
  paths: Record<string, { exists: boolean; items: number }>;
  /** host ports already taken by non-Docker processes */
  busyPorts: Record<number, string>;
}

export interface Daemon {
  running: boolean;
  pid: number;
  version: string;
}

export interface DockerfileStep {
  instr: 'FROM' | 'WORKDIR' | 'COPY' | 'RUN' | 'ENV' | 'EXPOSE' | 'CMD' | 'USER';
  arg: string;
  /** bumped when the files/command this step depends on change */
  inputVersion: number;
  sizeMB: number;
}

export interface BuildResultStep {
  index: number;
  instr: string;
  arg: string;
  cached: boolean;
  layer: string | null;
}

export interface BuildState {
  tag: string;
  steps: DockerfileStep[];
  /** cacheKey -> layer digest, survives across builds like BuildKit's cache */
  cache: Record<string, string>;
  last: { tag: string; steps: BuildResultStep[]; tick: number } | null;
}

export interface ComposeService {
  name: string;
  image: string;
  ports: string[];
  volumes: string[];
  dependsOn: string[];
  env: Record<string, string>;
  restart: RestartPolicy;
  memory?: number;
}

export interface ComposeProject {
  name: string;
  services: ComposeService[];
  up: boolean;
}

export interface LogLine {
  tick: number;
  container: string;
  stream: 'stdout' | 'stderr';
  msg: string;
}

export interface Hop {
  node: string;
  detail: string;
  status: 'ok' | 'fail' | 'skipped';
  /** semantic anchor the renderer can light up */
  anchor?: Target;
}

export interface RequestResult {
  id: number;
  tick: number;
  from: string;
  to: string;
  ok: boolean;
  status: number; // http-ish: 200, 403, 502, 0 = no connection
  latencyMs: number;
  hops: Hop[];
  reason: string;
}

export interface World {
  tick: number;
  host: Host;
  daemons: { dockerd: Daemon; containerd: Daemon; buildkit: Daemon; runc: { version: string } };
  images: Record<string, Image>;
  layers: Record<string, Layer>;
  containers: Record<string, Container>;
  networks: Record<string, Network>;
  volumes: Record<string, Volume>;
  build: BuildState;
  compose: ComposeProject | null;
  logs: LogLine[];
  requests: RequestResult[];
  /** monotonically increasing counters so ids stay deterministic */
  seq: { pid: number; ip: Record<string, number>; subnet: number; request: number; nsId: number };
}

/* ---------------------------------------------------------------------------
 * Events & causality
 * ------------------------------------------------------------------------- */

export type EventSource = 'user' | 'ai' | 'sim' | 'system';
export type Severity = 'info' | 'warn' | 'error';

export interface WorldEvent {
  id: number;
  tick: number;
  kind: string;
  target: Target;
  summary: string;
  severity: Severity;
  source: EventSource;
  causedBy: number | null;
  concepts: string[];
  /** lowest abstraction level at which this event is worth showing (0 = always) */
  minLevel: Level;
  detail?: Record<string, unknown>;
  /** timeline step that produced this event; -1 for read-only observations */
  step: number;
}

/* ---------------------------------------------------------------------------
 * Actions: the ONLY way the world changes. Typed, semantic, renderer-agnostic.
 * ------------------------------------------------------------------------- */

export type ConditionName =
  | 'latency'
  | 'packet_loss'
  | 'dns'
  | 'bandwidth'
  | 'registry'
  | 'cpu_load'
  | 'memory_pressure'
  | 'disk_available'
  | 'host_online';

export type Action =
  | { action: 'pull_image'; ref: string }
  | {
      action: 'run_container';
      image: string;
      name?: string;
      ports?: string[];
      volumes?: string[];
      network?: string;
      env?: Record<string, string>;
      memory?: number | string;
      cpus?: number;
      pids?: number;
      restart?: RestartPolicy;
      cmd?: string[];
      detach?: boolean;
      privileged?: boolean;
      readOnly?: boolean;
    }
  | { action: 'create_container'; image: string; name?: string; ports?: string[]; volumes?: string[]; network?: string; env?: Record<string, string>; memory?: number | string; restart?: RestartPolicy }
  | { action: 'start_container'; target: Target }
  | { action: 'stop_container'; target: Target }
  | { action: 'restart_container'; target: Target }
  | { action: 'pause_container'; target: Target }
  | { action: 'unpause_container'; target: Target }
  | { action: 'remove_container'; target: Target; force?: boolean; volumes?: boolean }
  | { action: 'kill_process'; target: Target; pid?: number; signal?: string }
  | { action: 'remove_image'; target: Target; force?: boolean }
  | { action: 'create_network'; name: string; driver?: 'bridge' }
  | { action: 'remove_network'; name: string }
  | { action: 'connect_network'; container: Target; network: string }
  | { action: 'disconnect_network'; container: Target; network: string }
  | { action: 'create_volume'; name: string }
  | { action: 'remove_volume'; name: string }
  | { action: 'set_resource_limit'; target: Target; resource: 'memory' | 'cpu' | 'pids'; value: number | string | null }
  | { action: 'stress'; target: Target; resource: 'memory' | 'cpu'; amount: number }
  | { action: 'write_data'; target: Target; path: string; count?: number }
  | { action: 'fill_disk'; mb: number }
  | { action: 'free_disk' }
  | { action: 'set_condition'; condition: ConditionName; value: number | boolean }
  | { action: 'restart_host' }
  | { action: 'stop_daemon'; daemon: 'dockerd' | 'containerd' }
  | { action: 'start_daemon'; daemon: 'dockerd' | 'containerd' }
  | { action: 'build_image'; tag?: string }
  | { action: 'edit_dockerfile'; step: number; change?: 'touch' | 'text'; arg?: string }
  | { action: 'compose_up' }
  | { action: 'compose_down' }
  | { action: 'compose_stop_service'; service: string }
  | { action: 'send_request'; from: Target | 'external' | 'host'; to: Target; port?: number; by?: 'name' | 'ip' }
  | { action: 'advance_time'; ticks?: number }
  | { action: 'connection_test' };

export type ActionName = Action['action'];

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** one-line human summary of what happened */
  summary: string;
  /** terminal-style stdout the action would print */
  output?: string;
  events: WorldEvent[];
  /** extra structured data (e.g. request result) */
  data?: unknown;
}

/* ---------------------------------------------------------------------------
 * View state (what the learner is looking at). Persisted in the browser.
 * ------------------------------------------------------------------------- */

export type Overlay = 'network' | 'storage' | 'process' | 'kernel' | 'resources' | 'causality' | 'dependencies';
export const ALL_OVERLAYS: Overlay[] = ['network', 'storage', 'process', 'kernel', 'resources', 'causality', 'dependencies'];

export type RevealMode =
  | 'depends_on'
  | 'depended_by'
  | 'made_of'
  | 'used_by'
  | 'why'
  | 'to_kernel'
  | 'to_ecosystem'
  | 'follow';

export type Region = 'overview' | 'whale' | 'deck' | 'engine-room' | 'harbor' | 'shipyard';

export interface ViewState {
  level: Level;
  selected: Target | null;
  /** concept in focus (may differ from the selected object) */
  focusConcept: string | null;
  reveal: { mode: RevealMode; root: string } | null;
  overlays: Overlay[];
  region: Region;
  /** camera zoom around the region (1 = region default) */
  zoom: number;
  labMode: boolean;
  /** compare two timeline steps (before/after) */
  compare: { a: number; b: number } | null;
  reducedMotion: boolean;
  timeFlows: boolean;
}

export const DEFAULT_VIEW: ViewState = {
  level: 0,
  selected: null,
  focusConcept: null,
  reveal: null,
  overlays: [],
  region: 'overview',
  zoom: 1,
  labMode: false,
  compare: null,
  reducedMotion: false,
  timeFlows: false,
};

/* ---------------------------------------------------------------------------
 * Predictions & progress
 * ------------------------------------------------------------------------- */

export interface PredictionOption {
  id: string;
  label: string;
}

export interface Prediction {
  id: string;
  question: string;
  options: PredictionOption[];
  /** hidden from the learner until revealed */
  answerId: string;
  explanation: string;
  /** built-in scenario id OR explicit steps to run when the learner commits */
  scenario?: string;
  steps?: Action[];
  concepts: string[];
  status: 'open' | 'answered' | 'revealed';
  /** the learner closed the card (kept for progress; hidden from the stage) */
  dismissed?: boolean;
  chosenId?: string;
  correct?: boolean;
  /** timeline step reached after running the experiment */
  resultStep?: number;
  /** event id of the root cause when revealed, for the causal trace */
  rootEventId?: number;
}

export interface Progress {
  concepts: Record<string, { seen: number; maxLevel: number }>;
  predictions: { id: string; question: string; chosen: string; answer: string; correct: boolean }[];
  scenarios: string[];
  levelsVisited: Level[];
  userActions: number;
  aiActions: number;
}
