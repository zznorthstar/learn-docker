import type {
  Action,
  ActionResult,
  Container,
  EventSource,
  Image,
  Level,
  Mount,
  Network,
  PortMap,
  RestartPolicy,
  Severity,
  Target,
  Volume,
  World,
  WorldEvent,
} from './types';
import { apiWorkload, layerFor, METADATA_ONLY, registryCatalog } from './catalog';
import { evaluateHealth, externalService, findByName, probe, serve } from './probe';
import {
  containerLayerMB,
  diskFreeMB,
  diskUsedMB,
  getContainer,
  hostMemUsedMB,
  newContainerId,
  nextNsId,
  nextPid,
  shopCompose,
  volumeUsers,
} from './world';
import { autoName, clone, fmtMB, hex, normalizeRef, parseMemory, parseTarget, plural, short, sha } from './util';

/**
 * The reducer. `applyAction` is a pure function: (world, action) -> (world', events).
 *
 * Every state change goes through `Sim.ev()`, which records WHY it happened
 * (`causedBy`). That is the causal engine: the events form a forest that the AI
 * and the learner can walk from any symptom back to its root cause.
 */

export class SimError extends Error {}

/** Docker's own rules for container, network and volume names; also keeps hostile keys like __proto__ out of the tables */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const REF_RE = /^[a-z0-9][a-z0-9._/-]{0,100}(:[A-Za-z0-9_.-]{1,64})?$/;
function checkName(kind: string, n: string): string {
  if (!NAME_RE.test(n) || n in Object.prototype) throw new SimError(`Invalid ${kind} name (${n.slice(0, 40)}). Only [a-zA-Z0-9][a-zA-Z0-9_.-] are allowed`);
  return n;
}

export interface ApplyMeta {
  source: EventSource;
  step: number;
  firstEventId: number;
}

interface EvOpts {
  cause?: number | null;
  severity?: Severity;
  concepts?: string[];
  detail?: Record<string, unknown>;
  minLevel?: Level;
}

const KIND_LEVEL: [string, Level][] = [
  ['engine.', 2],
  ['kernel.', 3],
  ['oci.', 5],
];

export function applyAction(
  world: World,
  action: Action,
  meta: ApplyMeta,
): { world: World; result: ActionResult; nextEventId: number } {
  const sim = new Sim(clone(world), meta);
  let ok = true;
  let error: string | undefined;
  let output: string | undefined;
  let data: unknown;
  try {
    sim.w.tick += 1;
    const r = sim.exec(action);
    output = r?.output;
    data = r?.data;
  } catch (e) {
    if (e instanceof SimError) {
      ok = false;
      error = e.message;
      sim.ev('action.failed', sim.targetOf(action), e.message, { severity: 'error', concepts: [] });
    } else throw e;
  }
  if (ok) sim.settle();
  const summary = ok ? sim.lastSummary(action) : error!;
  return {
    world: sim.w,
    nextEventId: sim.nextId,
    result: { ok, error, summary, output: ok ? output : `Error response from daemon: ${error}`, events: sim.events, data },
  };
}

export class Sim {
  w: World;
  events: WorldEvent[] = [];
  nextId: number;
  private rootId: number | null = null;
  private cause: number | null = null;
  private restartDepth = 0;

  constructor(
    w: World,
    private meta: ApplyMeta,
  ) {
    this.w = w;
    this.nextId = meta.firstEventId;
  }

  /* ------------------------------------------------------------------ events */

  get tail(): number | null {
    return this.events.length ? this.events[this.events.length - 1]!.id : null;
  }

  ev(kind: string, target: Target, summary: string, o: EvOpts = {}): number {
    const id = this.nextId++;
    const cause = o.cause !== undefined ? o.cause : (this.cause ?? this.rootId);
    let minLevel: Level = o.minLevel ?? 0;
    if (o.minLevel === undefined) for (const [p, l] of KIND_LEVEL) if (kind.startsWith(p)) minLevel = l;
    const e: WorldEvent = {
      id,
      tick: this.w.tick,
      kind,
      target,
      summary,
      severity: o.severity ?? 'info',
      source: this.events.length === 0 ? this.meta.source : 'sim',
      causedBy: cause ?? null,
      concepts: o.concepts ?? [],
      minLevel,
      detail: o.detail,
      step: this.meta.step,
    };
    if (this.rootId === null) this.rootId = id;
    this.events.push(e);
    return id;
  }

  within<T>(cause: number | null, fn: () => T): T {
    const prev = this.cause;
    this.cause = cause;
    try {
      return fn();
    } finally {
      this.cause = prev;
    }
  }

  log(c: Container | string, msg: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    const name = typeof c === 'string' ? c : c.name;
    this.w.logs.push({ tick: this.w.tick, container: name, stream, msg });
    if (this.w.logs.length > 400) this.w.logs.splice(0, this.w.logs.length - 400);
  }

  targetOf(a: Action): Target {
    const x = a as Record<string, unknown>;
    if (typeof x.target === 'string') return x.target;
    if (typeof x.container === 'string') return x.container;
    if (typeof x.name === 'string') return (a.action.includes('network') ? 'network:' : a.action.includes('volume') ? 'volume:' : 'container:') + x.name;
    return 'host';
  }

  lastSummary(a: Action): string {
    const root = this.events.find((e) => e.id === this.rootId);
    return root?.summary ?? a.action;
  }

  /* --------------------------------------------------------------- dispatcher */

  exec(a: Action): { output?: string; data?: unknown } | void {
    const needsDaemon: Action['action'][] = [
      'pull_image',
      'run_container',
      'create_container',
      'start_container',
      'stop_container',
      'restart_container',
      'pause_container',
      'unpause_container',
      'remove_container',
      'remove_image',
      'create_network',
      'remove_network',
      'connect_network',
      'disconnect_network',
      'create_volume',
      'remove_volume',
      'set_resource_limit',
      'build_image',
      'compose_up',
      'compose_down',
      'compose_stop_service',
    ];
    if (needsDaemon.includes(a.action)) this.requireDaemon();

    switch (a.action) {
      case 'pull_image':
        return { output: this.pull(a.ref) };
      case 'run_container':
        return { output: this.runContainer(a) };
      case 'create_container':
        return { output: this.createContainer(a).id };
      case 'start_container':
        return { output: this.startNamed(a.target) };
      case 'stop_container':
        return { output: this.stopNamed(a.target) };
      case 'restart_container':
        return this.restartNamed(a.target);
      case 'pause_container':
        return this.pauseNamed(a.target, true);
      case 'unpause_container':
        return this.pauseNamed(a.target, false);
      case 'remove_container':
        return { output: this.removeNamed(a.target, !!a.force, !!a.volumes) };
      case 'kill_process':
        return this.killProcess(a.target, a.pid ?? 1, a.signal ?? 'SIGKILL');
      case 'remove_image':
        return { output: this.removeImage(a.target, !!a.force) };
      case 'create_network':
        return { output: this.createNetwork(a.name) };
      case 'remove_network':
        return { output: this.removeNetwork(a.name) };
      case 'connect_network':
        return this.connect(a.container, a.network);
      case 'disconnect_network':
        return this.disconnect(a.container, a.network);
      case 'create_volume':
        return { output: this.createVolume(a.name, null) };
      case 'remove_volume':
        return { output: this.removeVolume(a.name) };
      case 'set_resource_limit':
        return this.setLimit(a.target, a.resource, a.value);
      case 'stress':
        return this.stress(a.target, a.resource, a.amount);
      case 'write_data':
        return this.writeData(a.target, a.path, a.count ?? 100);
      case 'fill_disk':
        return this.fillDisk(a.mb);
      case 'free_disk':
        return this.freeDisk();
      case 'set_condition':
        return this.setCondition(a.condition, a.value);
      case 'restart_host':
        return this.restartHost();
      case 'stop_daemon':
        return this.stopDaemon(a.daemon);
      case 'start_daemon':
        return this.startDaemon(a.daemon);
      case 'build_image':
        return { output: this.build(a.tag) };
      case 'edit_dockerfile':
        return this.editDockerfile(a.step, a.change ?? 'touch', a.arg);
      case 'compose_up':
        return { output: this.composeUp() };
      case 'compose_down':
        return { output: this.composeDown() };
      case 'compose_stop_service':
        return this.composeStop(a.service);
      case 'send_request':
        return this.sendRequest(a.from, a.to, a.port, a.by);
      case 'advance_time':
        return this.advance(a.ticks ?? 1);
      case 'connection_test':
        return this.connectionTest();
      default: {
        const n: never = a;
        throw new SimError(`unknown action ${(n as { action: string }).action}`);
      }
    }
  }

  requireDaemon(): void {
    if (!this.w.host.online) throw new SimError('the machine is powered off');
    if (!this.w.daemons.dockerd.running) {
      throw new SimError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
    }
  }

  requireContainerd(): void {
    if (!this.w.daemons.containerd.running) {
      throw new SimError('failed to create task for container: failed to connect to containerd: dial unix /run/containerd/containerd.sock: connect: no such file or directory');
    }
  }

  c(target: string): Container {
    const c = getContainer(this.w, target) ?? findByName(this.w, parseTarget(target).name || target);
    if (!c) throw new SimError(`No such container: ${parseTarget(target).name || target}`);
    return c;
  }

  /* ------------------------------------------------------------------- images */

  imageLocal(ref: string): Image | undefined {
    const r = normalizeRef(ref);
    return this.w.images[r];
  }

  pull(refIn: string): string {
    if (!REF_RE.test(normalizeRef(refIn).toLowerCase())) throw new SimError(`invalid reference format: ${String(refIn).slice(0, 60)}`);
    const ref = normalizeRef(refIn);
    const w = this.w;
    const start = this.ev('image.pull.started', `image:${ref}`, `docker pull ${ref}`, { concepts: ['image', 'registry', 'oci-distribution'] });
    return this.within(start, () => {
      const local = w.images[ref];
      const remote = registryCatalog().images[ref];
      const n = w.host.net;
      if (!remote) {
        if (local) {
          this.ev('image.pull.skipped', `image:${ref}`, `${ref} is a local-only image; nothing to pull`, { concepts: ['image', 'registry'] });
          return `Status: Image is local only: ${ref}`;
        }
        this.ev('image.pull.failed', `image:${ref}`, `pull access denied for ${ref.split(':')[0]}: repository does not exist or may require authorization`, {
          severity: 'error',
          concepts: ['registry', 'image'],
        });
        throw new SimError(`pull access denied for ${ref.split(':')[0]}, repository does not exist or may require 'docker login'`);
      }
      // the network path to the registry: DNS -> TCP -> TLS -> blobs
      if (!n.dnsUp) {
        const f = this.ev('image.pull.failed', `image:${ref}`, 'could not resolve registry-1.docker.io: DNS is down', { severity: 'error', concepts: ['dns', 'registry'] });
        throw new SimError('Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: Temporary failure in name resolution');
      }
      if (!n.registryReachable) {
        this.ev('image.pull.failed', `image:${ref}`, 'registry-1.docker.io is unreachable (connection timed out)', { severity: 'error', concepts: ['registry', 'oci-distribution'] });
        throw new SimError('Get "https://registry-1.docker.io/v2/": net/http: request canceled while waiting for connection (Client.Timeout exceeded)');
      }
      if (n.packetLossPct >= 60 || n.bandwidthMbps <= 0) {
        this.ev('image.pull.failed', `image:${ref}`, `pull stalled: ${n.packetLossPct}% packet loss, ${n.bandwidthMbps} Mbps`, { severity: 'error', concepts: ['registry', 'network'] });
        throw new SimError('error pulling image configuration: download failed after attempts=6: i/o timeout');
      }
      if (local && local.id === remote.id) {
        this.ev('image.pull.uptodate', `image:${ref}`, `${ref} is already up to date (manifest ${short(remote.manifestDigest)} unchanged)`, { concepts: ['image', 'digest', 'manifest'] });
        return `Status: Image is up to date for ${ref}`;
      }
      const mf = this.ev('oci.manifest.fetched', `image:${ref}`, `fetched manifest ${short(remote.manifestDigest)} (${remote.layers.length} layers, ${remote.arch})`, {
        concepts: ['manifest', 'digest', 'oci-distribution'],
        detail: { digest: remote.manifestDigest },
      });
      if (remote.arch !== w.host.arch) {
        this.ev('image.platform.mismatch', `image:${ref}`, `WARNING: ${ref} is linux/${remote.arch} but this host is linux/${w.host.arch}`, {
          severity: 'warn',
          concepts: ['platform', 'image'],
          cause: mf,
        });
      }
      const cat = registryCatalog();
      const missing = remote.layers.filter((d) => !w.layers[d]);
      const needMB = missing.reduce((a, d) => a + (cat.layers[d]?.sizeMB ?? 0), 0);
      if (diskFreeMB(w) < needMB) {
        this.ev('disk.full', 'host', `no space left on device: need ${fmtMB(needMB)}, only ${fmtMB(Math.max(0, diskFreeMB(w)))} free`, { severity: 'error', concepts: ['disk', 'layer'], cause: mf });
        throw new SimError('failed to register layer: write /var/lib/docker/overlay2: no space left on device');
      }
      for (const d of remote.layers) {
        const l = cat.layers[d]!;
        if (w.layers[d]) {
          this.ev('image.layer.exists', `image:${ref}`, `layer ${short(d)} already exists locally, shared with another image (${fmtMB(l.sizeMB)} saved)`, {
            concepts: ['layer', 'digest'],
            cause: mf,
          });
        } else {
          w.layers[d] = clone(l);
          const secs = Math.max(0.1, (l.sizeMB * 8) / Math.max(1, n.bandwidthMbps)) + n.latencyMs / 1000;
          this.ev('image.layer.pulled', `image:${ref}`, `pulled layer ${short(d)} (${fmtMB(l.sizeMB)}, ~${secs.toFixed(1)}s): ${l.instr}`, {
            concepts: ['layer', 'digest', 'registry'],
            cause: mf,
          });
        }
      }
      // replacing a tag keeps the old image around untagged if something still uses it
      if (local && local.id !== remote.id) this.untag(local);
      w.images[ref] = clone(remote);
      this.ev('image.pull.completed', `image:${ref}`, `${ref} is now local: ${fmtMB(remote.sizeMB)}, ${remote.layers.length} layers, digest ${short(remote.manifestDigest)}`, {
        concepts: ['image', 'tag', 'digest'],
        detail: { digest: remote.manifestDigest, id: remote.id },
      });
      return `Digest: ${remote.manifestDigest}\nStatus: Downloaded newer image for ${ref}`;
    });
  }

  private untag(img: Image): void {
    const inUse = Object.values(this.w.containers).some((c) => c.imageId === img.id);
    delete this.w.images[img.ref];
    if (inUse) this.w.images[`<none>:${short(img.id)}`] = { ...clone(img), ref: `<none>:${short(img.id)}` };
  }

  removeImage(targetIn: string, force: boolean): string {
    const name = targetIn.startsWith('image:') ? targetIn.slice(6) : targetIn;
    const ref = this.w.images[name] ? name : normalizeRef(name);
    const img = this.w.images[ref];
    if (!img) throw new SimError(`No such image: ${name}`);
    const users = Object.values(this.w.containers).filter((c) => c.imageId === img.id);
    if (users.length && !force) {
      this.ev('image.remove.failed', `image:${ref}`, `cannot remove ${ref}: used by ${users.map((u) => u.name).join(', ')}`, { severity: 'error', concepts: ['image', 'container'] });
      throw new SimError(`conflict: unable to remove repository reference "${ref}" (must force) - container ${users[0]!.id.slice(0, 12)} is using its referenced image ${short(img.id)}`);
    }
    const e = this.ev('image.removed', `image:${ref}`, `removed image ${ref}`, { concepts: ['image', 'layer'] });
    delete this.w.images[ref];
    this.within(e, () => {
      // garbage-collect layers nobody references any more
      const live = new Set<string>();
      for (const i of Object.values(this.w.images)) i.layers.forEach((d) => live.add(d));
      let freed = 0;
      for (const d of Object.keys(this.w.layers)) {
        if (!live.has(d)) {
          freed += this.w.layers[d]!.sizeMB;
          delete this.w.layers[d];
        }
      }
      this.ev('image.layers.collected', `image:${ref}`, `freed ${fmtMB(freed)} of layers no other image shares`, { concepts: ['layer', 'digest'] });
    });
    return `Untagged: ${ref}`;
  }

  /* -------------------------------------------------------------- containers */

  private parsePorts(specs: string[] | undefined): PortMap[] {
    const out: PortMap[] = [];
    for (const raw of specs ?? []) {
      const [main, protoRaw] = raw.split('/');
      const proto = protoRaw === 'udp' ? 'udp' : 'tcp';
      const parts = main!.split(':');
      let host: number;
      let cont: number;
      if (parts.length === 1) {
        cont = parseInt(parts[0]!, 10);
        host = 32768 + ((Object.keys(this.w.containers).length * 7 + out.length * 3 + this.w.tick) % 20000);
      } else {
        cont = parseInt(parts[parts.length - 1]!, 10);
        host = parseInt(parts[parts.length - 2]!, 10);
      }
      if (!Number.isFinite(host) || !Number.isFinite(cont) || host < 1 || host > 65535 || cont < 1 || cont > 65535) {
        throw new SimError(`invalid published port specification: ${raw}`);
      }
      out.push({ host, container: cont, proto });
    }
    return out;
  }

  private parseMounts(specs: string[] | undefined): Mount[] {
    const out: Mount[] = [];
    for (const raw of specs ?? []) {
      const parts = raw.split(':');
      if (parts.length === 1) {
        out.push({ type: 'volume', source: 'anon-' + hex(raw + this.w.tick, 10), target: parts[0]! });
        continue;
      }
      const [src, target, mode] = parts as [string, string, string | undefined];
      if (!target.startsWith('/')) throw new SimError(`invalid mount path: '${target}' mount path must be absolute`);
      const readOnly = mode === 'ro';
      if (src === 'tmpfs') out.push({ type: 'tmpfs', source: '', target });
      else if (src.startsWith('/') || src.startsWith('.') || src.startsWith('~')) out.push({ type: 'bind', source: src, target, readOnly });
      else out.push({ type: 'volume', source: src, target, readOnly });
    }
    return out;
  }

  createContainer(a: {
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
    privileged?: boolean;
    readOnly?: boolean;
    compose?: { project: string; service: string };
  }): Container {
    const w = this.w;
    const ref = normalizeRef(a.image);
    let img = w.images[ref];
    if (!img) {
      const rem = registryCatalog().images[ref];
      if (!rem) {
        this.ev('image.pull.failed', `image:${ref}`, `Unable to find image '${ref}' locally and the registry has no such repository`, { severity: 'error', concepts: ['registry', 'image'] });
        throw new SimError(`pull access denied for ${ref.split(':')[0]}, repository does not exist or may require 'docker login'`);
      }
      const e = this.ev('image.missing', `image:${ref}`, `Unable to find image '${ref}' locally: docker run pulls it first`, { concepts: ['image', 'registry'] });
      this.within(e, () => this.pull(ref));
      img = w.images[ref]!;
    }
    const name = a.name ? checkName('container', a.name) : this.freeName();
    if (Object.prototype.hasOwnProperty.call(w.containers, name)) {
      this.ev('container.create.failed', `container:${name}`, `name "${name}" is already in use by container ${w.containers[name]!.id.slice(0, 12)}`, { severity: 'error', concepts: ['container'] });
      throw new SimError(`Conflict. The container name "/${name}" is already in use by container "${w.containers[name]!.id}". You have to remove (or rename) that container to be able to reuse that name.`);
    }
    const netName = a.network ?? 'bridge';
    const net = w.networks[netName];
    if (!net) {
      this.ev('container.create.failed', `container:${name}`, `network ${netName} not found`, { severity: 'error', concepts: ['network'] });
      throw new SimError(`network ${netName} not found`);
    }
    const mem = parseMemory(a.memory);
    if (mem !== null && (Number.isNaN(mem) || mem < 6)) throw new SimError(mem !== null && Number.isNaN(mem) ? `invalid size: '${String(a.memory)}'` : 'Minimum memory limit allowed is 6MB');
    const ports = this.parsePorts(a.ports);
    const mounts = this.parseMounts(a.volumes);
    const cmdOverride = a.cmd && a.cmd.length ? a.cmd : null;
    let workload = clone(img.workload);
    let cmd = cmdOverride ?? [...img.config.entrypoint, ...img.config.cmd];
    if (cmdOverride) {
      const first = cmdOverride[0] ?? '';
      if (workload.exitsAfterStart && ['sleep', 'tail', 'ping', 'top', 'watch', 'nc'].includes(first)) {
        workload = { ...workload, exitsAfterStart: false, kind: 'idle', baseMemMB: Math.max(1, workload.baseMemMB / 4) };
      }
    }
    if (a.compose && workload.kind === 'static-web') {
      const svc = w.compose?.services.find((s) => s.name === a.compose!.service);
      if (svc?.dependsOn.length) workload = { ...workload, needs: [...svc.dependsOn] };
    }
    const tick = w.tick;
    const c: Container = {
      name,
      id: newContainerId(name, tick),
      imageRef: ref,
      imageId: img.id,
      state: 'created',
      exitCode: null,
      oomKilled: false,
      error: '',
      pid: 0,
      createdTick: tick,
      startedTick: null,
      finishedTick: null,
      cmd,
      process: cmdOverride ? (cmdOverride[0] ?? 'sh') : (img.config.cmd[0] ?? img.config.entrypoint[0] ?? 'sh'),
      env: { ...Object.fromEntries(img.config.env.map((e) => e.split('=') as [string, string])), ...(a.env ?? {}) },
      ports,
      mounts,
      networks: {},
      limits: { memoryMB: mem, cpus: a.cpus ?? null, pids: a.pids ?? null },
      usage: { memMB: 0, cpuPct: 0 },
      stress: { memMB: 0, cpuPct: 0 },
      restartPolicy: a.restart ?? 'no',
      restartCount: 0,
      manuallyStopped: false,
      health: 'none',
      service: 'none',
      workload,
      layerData: { items: 0 },
      childProcs: [],
      security: {
        privileged: !!a.privileged,
        capAdd: [],
        capDrop: [],
        seccomp: a.privileged ? 'unconfined' : 'default',
        readOnlyRootfs: !!a.readOnly,
        user: img.config.user,
      },
      compose: a.compose,
    };
    w.containers[name] = c;
    const e = this.ev('container.created', `container:${name}`, `created container ${name} (${c.id.slice(0, 12)}) from ${ref}`, {
      concepts: ['container', 'image', 'writable-layer'],
      detail: { id: c.id },
    });
    this.within(e, () => {
      this.ev('engine.api', `container:${name}`, `dockerd handles POST /containers/create over /var/run/docker.sock`, { concepts: ['dockerd', 'docker-api'] });
      this.ev('kernel.overlay', `container:${name}`, `overlayfs mount prepared: ${img!.layers.length} read-only image layers + 1 empty writable upper layer`, {
        concepts: ['overlayfs', 'layer', 'writable-layer'],
      });
      for (const m of mounts) {
        if (m.type === 'volume') {
          const existed = !!w.volumes[m.source];
          if (!existed) this.createVolume(m.source, e, true);
          this.ev('volume.mounted', `volume:${m.source}`, `volume ${m.source} will be mounted at ${m.target}${m.readOnly ? ' (read-only)' : ''}`, {
            concepts: ['volume', 'mnt-ns'],
          });
        } else if (m.type === 'bind') {
          if (!w.host.paths[m.source]) {
            w.host.paths[m.source] = { exists: true, items: 0 };
            this.ev('bind.created_empty', `container:${name}`, `host path ${m.source} did not exist: Docker created an EMPTY directory for -v`, {
              severity: 'warn',
              concepts: ['bind-mount'],
            });
          } else {
            this.ev('bind.mounted', `container:${name}`, `host path ${m.source} will be bind-mounted at ${m.target} (${plural(w.host.paths[m.source]!.items, 'item')})`, {
              concepts: ['bind-mount', 'mnt-ns'],
            });
          }
        } else {
          this.ev('tmpfs.mounted', `container:${name}`, `tmpfs at ${m.target}: lives in RAM, vanishes when the container stops`, { concepts: ['tmpfs'] });
        }
      }
      this.attach(c, netName, e);
    });
    return c;
  }

  private freeName(): string {
    let n = Object.keys(this.w.containers).length + this.w.tick;
    for (let i = 0; i < 200; i++, n++) {
      const name = autoName(n);
      if (!this.w.containers[name]) return name;
    }
    return 'c' + this.w.tick;
  }

  private allocIp(netName: string): string {
    const w = this.w;
    const net = w.networks[netName]!;
    const base = net.subnet.split('/')[0]!.split('.').slice(0, 2).join('.');
    const n = (w.seq.ip[netName] = (w.seq.ip[netName] ?? 1) + 1);
    return `${base}.${Math.floor((n - 1) / 254)}.${((n - 1) % 254) + 1}`;
  }

  private attach(c: Container, netName: string, cause: number | null): void {
    const net = this.w.networks[netName];
    if (!net) throw new SimError(`network ${netName} not found`);
    if (net.driver !== 'bridge') {
      c.networks[netName] = { ip: net.driver === 'host' ? this.w.host.name : '' };
      return;
    }
    const ip = this.allocIp(netName);
    c.networks[netName] = { ip };
    this.ev('network.attached', `container:${c.name}`, `${c.name} attached to ${netName} with IP ${ip}`, {
      concepts: ['network', 'bridge', 'veth'],
      cause,
    });
  }

  runContainer(a: Extract<Action, { action: 'run_container' }>): string {
    const root = this.ev('container.run', this.targetOf(a), `docker run ${a.image}${a.name ? ` --name ${a.name}` : ''}`, { concepts: ['container', 'lifecycle'] });
    return this.within(root, () => {
      const c = this.createContainer(a);
      const ok = this.startContainer(c, root);
      if (a.detach === false) return this.foregroundOutput(c);
      void ok;
      return c.id;
    });
  }

  private foregroundOutput(c: Container): string {
    if (c.imageRef === 'hello-world:latest') return HELLO;
    return c.id;
  }

  startNamed(target: string): string {
    const c = this.c(target);
    if (c.state === 'running') return c.name;
    c.manuallyStopped = false;
    const e = this.ev('container.start', `container:${c.name}`, `docker start ${c.name}`, { concepts: ['container', 'lifecycle'] });
    this.within(e, () => this.startContainer(c, e));
    return c.name;
  }

  /**
   * Bring a container to life. Returns false (and leaves a precise reason) if
   * something in the real chain would refuse: ports, arch, memory, disk, containerd.
   */
  startContainer(c: Container, cause: number | null): boolean {
    const w = this.w;
    const img = Object.values(w.images).find((i) => i.id === c.imageId);
    const tgt = `container:${c.name}`;
    this.requireContainerd();

    // 1. port bindings are taken at start time (not create time)
    for (const p of c.ports) {
      const owner = Object.values(w.containers).find((o) => o !== c && (o.state === 'running' || o.state === 'paused') && o.ports.some((q) => q.host === p.host && q.proto === p.proto));
      const busy = w.host.busyPorts[p.host];
      if (owner || busy) {
        const who = owner ? `container ${owner.name}` : `host process ${busy}`;
        const e = this.ev('port.conflict', tgt, `host port ${p.host} is already allocated by ${who}`, {
          severity: 'error',
          concepts: ['port-publish', 'iptables'],
          cause,
          detail: { port: p.host, owner: owner?.name ?? busy },
        });
        c.error = `driver failed programming external connectivity on endpoint ${c.name}: Bind for 0.0.0.0:${p.host} failed: port is already allocated`;
        this.ev('container.start.failed', tgt, `${c.name} stays "${c.state}": ${c.error}`, { severity: 'error', concepts: ['container', 'lifecycle'], cause: e });
        throw new SimError(c.error);
      }
    }
    // 2. platform: the kernel cannot execute a foreign-architecture binary
    if (img && img.arch !== w.host.arch) {
      const e = this.ev('kernel.exec_failed', tgt, `exec format error: ${c.process} is a linux/${img.arch} binary, the host CPU is ${w.host.arch}`, {
        severity: 'error',
        concepts: ['platform', 'kernel', 'image'],
        cause,
      });
      this.provisionNamespaces(c);
      c.state = 'exited';
      c.exitCode = 255;
      c.error = `exec ${c.process}: exec format error`;
      c.finishedTick = w.tick;
      this.log(c, c.error, 'stderr');
      this.ev('container.exited', tgt, `${c.name} exited (255): wrong CPU architecture`, { severity: 'error', concepts: ['container', 'platform', 'exit-codes'], cause: e });
      this.maybeRestart(c, e);
      return false;
    }
    // 3. disk
    if (diskFreeMB(w) <= 0) {
      const e = this.ev('disk.full', 'host', 'no space left on device while preparing the container filesystem', { severity: 'error', concepts: ['disk', 'overlayfs'], cause });
      c.error = 'failed to create shim task: mkdir /var/lib/docker/overlay2: no space left on device';
      this.ev('container.start.failed', tgt, c.error, { severity: 'error', concepts: ['disk', 'container'], cause: e });
      throw new SimError(c.error);
    }
    // 4. the happy path through the engine, one hop at a time
    const e1 = this.ev('engine.api', tgt, 'dockerd handles POST /containers/start and asks containerd to create a task', { concepts: ['dockerd', 'containerd', 'docker-api'], cause });
    const e2 = this.ev('engine.containerd', tgt, 'containerd prepares the bundle (config.json + rootfs snapshot) and launches a shim', { concepts: ['containerd', 'oci-runtime', 'shim'], cause: e1 });
    const pid = nextPid(w, 17);
    const shimPid = pid - 3;
    const e3 = this.ev('engine.shim', tgt, `containerd-shim-runc-v2 (pid ${shimPid}) becomes the container's parent, independent of dockerd`, { concepts: ['shim', 'process'], cause: e2 });
    const e4 = this.ev('engine.runc', tgt, 'runc reads config.json, sets up namespaces/cgroups, then execs the entrypoint and exits', { concepts: ['runc', 'oci-runtime'], cause: e3 });
    this.provisionNamespaces(c, e4);
    // cgroup limits and the instant-OOM check
    const baseMem = c.workload.baseMemMB + c.stress.memMB;
    c.pid = pid;
    c.state = 'running';
    c.startedTick = w.tick;
    c.finishedTick = null;
    c.exitCode = null;
    c.oomKilled = false;
    c.error = '';
    c.usage = { memMB: baseMem, cpuPct: c.workload.baseCpuPct + c.stress.cpuPct };
    c.childProcs = c.workload.procs.map((name, i) => ({ nsPid: 7 + i, name }));
    const e5 = this.ev('process.started', tgt, `${c.process ?? 'process'} runs as PID 1 inside the container (PID ${pid} on the host)`, {
      concepts: ['process', 'pid1', 'pid-ns'],
      cause: e4,
      detail: { hostPid: pid, nsPid: 1 },
    });
    this.log(c, `${c.cmd.join(' ')}: started`);
    if (c.limits.pids !== null && c.childProcs.length + 1 > c.limits.pids) {
      const e = this.ev('kernel.pids_limit', tgt, `fork failed: the pids cgroup allows ${c.limits.pids}, but the app needs ${c.childProcs.length + 1} processes`, { severity: 'error', concepts: ['pids-limit', 'cgroups'], cause: e5 });
      this.exit(c, 1, e, 'fork: retry: Resource temporarily unavailable');
      return false;
    }
    if (c.limits.memoryMB !== null && baseMem > c.limits.memoryMB) {
      const e = this.ev('kernel.cgroup_memory', tgt, `memory.max=${c.limits.memoryMB}MB but ${c.name} needs ~${Math.round(baseMem)}MB just to boot`, { severity: 'warn', concepts: ['memory-limit', 'cgroups'], cause: e5 });
      this.oomKill(c, e, 'cgroup');
      return false;
    }
    this.ev('container.started', tgt, `${c.name} is running`, { concepts: ['container', 'lifecycle'], cause: e5 });
    if (c.workload.exitsAfterStart) {
      const e = this.ev('process.exited', tgt, `${c.process} finished its work and exited`, { concepts: ['process', 'pid1', 'lifecycle'], cause: e5 });
      if (c.imageRef === 'hello-world:latest') this.log(c, HELLO.split('\n')[0]!);
      else this.log(c, 'no foreground work to do (no TTY attached): process exits immediately');
      this.exit(c, 0, e, '');
      return true;
    }
    return true;
  }

  private provisionNamespaces(c: Container, cause?: number): void {
    const ns = nextNsId(this.w);
    this.ev('kernel.namespaces', `container:${c.name}`, `kernel creates PID, NET, MNT, UTS, IPC namespaces (net ns ${ns}) for ${c.name}`, {
      concepts: ['namespaces', 'pid-ns', 'net-ns', 'mnt-ns', 'kernel'],
      cause: cause ?? null,
      detail: { netns: ns },
    });
    if (Object.keys(c.networks).length) {
      this.ev('kernel.veth', `container:${c.name}`, `veth pair created: one end becomes eth0 inside the netns, the other joins the bridge on the host`, {
        concepts: ['veth', 'bridge', 'net-ns'],
        cause: cause ?? null,
      });
    }
    for (const p of c.ports) {
      this.ev('port.published', `container:${c.name}`, `iptables DNAT rule: host :${p.host} → container :${p.container}`, { concepts: ['port-publish', 'iptables'], cause: cause ?? null });
    }
    this.ev('kernel.cgroup', `container:${c.name}`, `cgroup created${c.limits.memoryMB !== null ? `: memory.max=${c.limits.memoryMB}MB` : ': no memory limit (can use all host RAM)'}${c.limits.cpus ? `, cpu.max=${c.limits.cpus * 100}%` : ''}`, {
      concepts: ['cgroups', 'memory-limit', 'cpu-limit'],
      cause: cause ?? null,
    });
  }

  /** a process of the container ends: record, tidy up, apply the restart policy */
  exit(c: Container, code: number, cause: number | null, reason: string, oom = false): void {
    const tgt = `container:${c.name}`;
    c.state = 'exited';
    c.exitCode = code;
    c.oomKilled = oom;
    c.pid = 0;
    c.finishedTick = this.w.tick;
    c.childProcs = [];
    c.usage = { memMB: 0, cpuPct: 0 };
    c.health = 'none';
    if (reason) c.error = reason;
    const meaning =
      code === 0 ? 'clean exit' : code === 137 ? 'SIGKILL (128+9): killed, often by the OOM killer or docker kill' : code === 143 ? 'SIGTERM (128+15)' : code === 255 ? 'exec/boot failure' : `error code ${code}`;
    const e = this.ev('container.exited', tgt, `${c.name} exited with code ${code} — ${meaning}`, {
      severity: code === 0 ? 'info' : 'warn',
      concepts: ['container', 'exit-codes', 'lifecycle', ...(oom ? ['oom-killer'] : [])],
      cause,
      detail: { exitCode: code, oomKilled: oom },
    });
    this.maybeRestart(c, e);
  }

  maybeRestart(c: Container, cause: number | null): void {
    const tgt = `container:${c.name}`;
    const p = c.restartPolicy;
    if (p === 'no' || c.manuallyStopped) return;
    const want = p === 'always' || p === 'unless-stopped' || (p === 'on-failure' && c.exitCode !== 0);
    if (!want) return;
    if (this.restartDepth >= 3 || c.restartCount >= 6) {
      this.ev('container.restart.backoff', tgt, `restart policy "${p}" is backing off after ${c.restartCount} restarts: this is a crash loop`, {
        severity: 'warn',
        concepts: ['restart-policy', 'container'],
        cause,
      });
      return;
    }
    c.restartCount += 1;
    const e = this.ev('container.restarting', tgt, `restart policy "${p}" brings ${c.name} back (restart #${c.restartCount})`, { concepts: ['restart-policy', 'lifecycle'], cause });
    this.restartDepth += 1;
    try {
      this.within(e, () => this.startContainer(c, e));
    } catch (err) {
      if (!(err instanceof SimError)) throw err;
    } finally {
      this.restartDepth -= 1;
    }
  }

  stopNamed(target: string): string {
    const c = this.c(target);
    if (c.state !== 'running' && c.state !== 'paused') {
      this.ev('container.stop.noop', `container:${c.name}`, `${c.name} is not running`, { concepts: ['lifecycle'] });
      return c.name;
    }
    c.manuallyStopped = true;
    const e = this.ev('container.stop', `container:${c.name}`, `docker stop ${c.name}: send SIGTERM, wait 10s, then SIGKILL`, { concepts: ['signals', 'lifecycle', 'pid1'] });
    this.within(e, () => this.terminate(c, e));
    return c.name;
  }

  /** SIGTERM semantics: PID 1 only dies of SIGTERM if the program handles it. */
  terminate(c: Container, cause: number): void {
    const tgt = `container:${c.name}`;
    if (c.state === 'paused') c.state = 'running';
    const handles = c.workload.kind === 'static-web' || c.workload.kind === 'cache' || c.workload.kind === 'database';
    if (handles) {
      const e = this.ev('process.signal', tgt, `SIGTERM → ${c.process} handles it and shuts down gracefully`, { concepts: ['signals', 'pid1'], cause });
      this.exit(c, 0, e, '');
    } else {
      const e1 = this.ev('process.signal', tgt, `SIGTERM → ${c.process} (PID 1) has no handler, so the kernel ignores it`, { severity: 'warn', concepts: ['signals', 'pid1'], cause });
      const e2 = this.ev('engine.timeout', tgt, 'dockerd waited 10s, then sent SIGKILL', { concepts: ['signals', 'dockerd'], cause: e1 });
      this.exit(c, 137, e2, '');
    }
  }

  restartNamed(target: string): { output: string } {
    const c = this.c(target);
    const e = this.ev('container.restart', `container:${c.name}`, `docker restart ${c.name}`, { concepts: ['lifecycle', 'container'] });
    this.within(e, () => {
      c.manuallyStopped = true; // we start it ourselves: the restart policy must not race us
      if (c.state === 'running' || c.state === 'paused') this.terminate(c, e);
      c.manuallyStopped = false;
      this.startContainer(c, e);
    });
    return { output: c.name };
  }

  pauseNamed(target: string, pause: boolean): { output: string } {
    const c = this.c(target);
    if (pause) {
      if (c.state !== 'running') throw new SimError(`Container ${c.id} is not running`);
      c.state = 'paused';
      this.ev('container.paused', `container:${c.name}`, `${c.name} paused: the cgroup freezer stops scheduling its processes, memory stays allocated`, { concepts: ['cgroups', 'process', 'lifecycle'] });
    } else {
      if (c.state !== 'paused') throw new SimError(`Container ${c.id} is not paused`);
      c.state = 'running';
      this.ev('container.unpaused', `container:${c.name}`, `${c.name} unpaused`, { concepts: ['cgroups', 'lifecycle'] });
    }
    return { output: c.name };
  }

  removeNamed(target: string, force: boolean, volumes: boolean): string {
    const c = this.c(target);
    const tgt = `container:${c.name}`;
    if ((c.state === 'running' || c.state === 'paused') && !force) {
      this.ev('container.remove.failed', tgt, `cannot remove running container ${c.name}: stop it first or use -f`, { severity: 'error', concepts: ['container', 'lifecycle'] });
      throw new SimError(`cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`);
    }
    const root = this.ev('container.remove', tgt, `docker rm${force ? ' -f' : ''} ${c.name}`, { concepts: ['container', 'lifecycle'] });
    this.within(root, () => {
      if (c.state === 'running' || c.state === 'paused') {
        c.manuallyStopped = true;
        const e = this.ev('process.signal', tgt, `SIGKILL → ${c.process}: forced removal does not wait`, { severity: 'warn', concepts: ['signals'] });
        this.exit(c, 137, e, '');
      }
      if (c.layerData.items > 0) {
        this.ev('container.data_lost', tgt, `${plural(c.layerData.items, 'record')} written to the writable layer are deleted with the container`, {
          severity: 'warn',
          concepts: ['writable-layer', 'volume', 'overlayfs'],
          detail: { items: c.layerData.items },
        });
      }
      for (const m of c.mounts) {
        if (m.type === 'volume') {
          if (m.source.startsWith('anon-') && volumes) {
            delete this.w.volumes[m.source];
            this.ev('volume.removed', `volume:${m.source}`, `anonymous volume ${m.source} removed together with the container (-v)`, { concepts: ['volume'] });
          } else {
            this.ev('volume.survives', `volume:${m.source}`, `volume ${m.source} survives: it holds ${plural(this.w.volumes[m.source]?.items ?? 0, 'record')} and is independent of the container`, {
              concepts: ['volume', 'writable-layer'],
            });
          }
        }
      }
      for (const n of Object.keys(c.networks)) this.ev('network.detached', `container:${c.name}`, `${c.name} left ${n}`, { concepts: ['network', 'veth'] });
      delete this.w.containers[c.name];
      this.ev('container.removed', tgt, `container ${c.name} is gone (image ${c.imageRef} is untouched)`, { concepts: ['container', 'image'] });
    });
    return c.name;
  }

  killProcess(target: string, pid: number, signal: string): { output: string } {
    const c = this.c(target);
    const tgt = `container:${c.name}`;
    if (c.state !== 'running') throw new SimError(`Container ${c.name} is not running`);
    const e = this.ev('process.kill', tgt, `kill -${signal.replace('SIG', '')} ${pid} (in the container's PID namespace)`, { concepts: ['signals', 'process', 'pid-ns'] });
    this.within(e, () => {
      if (pid === 1) {
        if (signal === 'SIGTERM') {
          this.terminate(c, e);
          return;
        }
        const k = this.ev('process.killed', tgt, `PID 1 (${c.process}) is dead: when PID 1 ends, the kernel tears down the whole PID namespace`, {
          severity: 'warn',
          concepts: ['pid1', 'pid-ns', 'process'],
        });
        this.exit(c, 137, k, '');
        return;
      }
      const child = c.childProcs.find((p) => p.nsPid === pid);
      if (!child) throw new SimError(`no such process ${pid} in container ${c.name}`);
      const k = this.ev('process.killed', tgt, `${child.name} (PID ${pid}) killed; the container keeps running because PID 1 is still alive`, { severity: 'warn', concepts: ['process', 'pid1'] });
      if (c.workload.kind === 'static-web' || c.workload.kind === 'database') {
        const newPid = Math.max(...c.childProcs.map((p) => p.nsPid)) + 1;
        child.nsPid = newPid;
        this.ev('process.respawned', tgt, `the master process respawns the worker as PID ${newPid}`, { concepts: ['process', 'pid1'], cause: k });
      } else {
        c.childProcs = c.childProcs.filter((p) => p !== child);
      }
    });
    return { output: '' };
  }

  /* ---------------------------------------------------------------- networks */

  createNetwork(name: string): string {
    checkName('network', name);
    if (Object.prototype.hasOwnProperty.call(this.w.networks, name)) {
      this.ev('network.create.failed', `network:${name}`, `network ${name} already exists`, { severity: 'error', concepts: ['network'] });
      throw new SimError(`network with name ${name} already exists`);
    }
    const s = this.w.seq.subnet++;
    const net: Network = {
      name,
      driver: 'bridge',
      subnet: `172.${s}.0.0/16`,
      gateway: `172.${s}.0.1`,
      bridgeIf: `br-${hex(name, 12)}`,
      builtin: false,
      dns: true,
      internal: false,
    };
    this.w.networks[name] = net;
    this.w.seq.ip[name] = 1;
    const e = this.ev('network.created', `network:${name}`, `network ${name} created: ${net.subnet}, bridge ${net.bridgeIf}`, { concepts: ['network', 'bridge', 'dns'] });
    this.ev('kernel.bridge', `network:${name}`, `kernel creates Linux bridge ${net.bridgeIf} with gateway ${net.gateway}`, { concepts: ['bridge', 'kernel', 'iptables'], cause: e });
    this.ev('engine.dns', `network:${name}`, `embedded DNS (127.0.0.11) will resolve container names on ${name}`, { concepts: ['dns', 'service-discovery'], cause: e });
    return hex('net:' + name, 64);
  }

  removeNetwork(name: string): string {
    const n = this.w.networks[name];
    if (!n) throw new SimError(`network ${name} not found`);
    if (n.builtin) throw new SimError(`${name} is a pre-defined network and cannot be removed`);
    const members = Object.values(this.w.containers).filter((c) => name in c.networks);
    if (members.length) {
      this.ev('network.remove.failed', `network:${name}`, `network ${name} still has ${plural(members.length, 'endpoint')}: ${members.map((m) => m.name).join(', ')}`, { severity: 'error', concepts: ['network'] });
      throw new SimError(`error while removing network: network ${name} has active endpoints`);
    }
    delete this.w.networks[name];
    this.ev('network.removed', `network:${name}`, `network ${name} removed; bridge ${n.bridgeIf} deleted from the kernel`, { concepts: ['network', 'bridge'] });
    return name;
  }

  connect(container: string, network: string): { output: string } {
    const c = this.c(container);
    if (!this.w.networks[network]) throw new SimError(`network ${network} not found`);
    if (network in c.networks) throw new SimError(`endpoint with name ${c.name} already exists in network ${network}`);
    const e = this.ev('network.connect', `container:${c.name}`, `docker network connect ${network} ${c.name}`, { concepts: ['network', 'veth', 'net-ns'] });
    this.within(e, () => {
      this.attach(c, network, e);
      if (c.state === 'running') this.ev('kernel.veth', `container:${c.name}`, `a second veth pair adds eth${Object.keys(c.networks).length - 1} inside ${c.name}'s network namespace`, { concepts: ['veth', 'bridge', 'net-ns'] });
    });
    return { output: '' };
  }

  disconnect(container: string, network: string): { output: string } {
    const c = this.c(container);
    if (!(network in c.networks)) throw new SimError(`container ${c.name} is not connected to network ${network}`);
    const e = this.ev('network.disconnect', `container:${c.name}`, `docker network disconnect ${network} ${c.name}`, { concepts: ['network', 'veth'] });
    this.within(e, () => {
      delete c.networks[network];
      this.ev('kernel.veth', `container:${c.name}`, `veth pair for ${network} removed from ${c.name}'s network namespace`, { concepts: ['veth', 'net-ns'] });
    });
    return { output: '' };
  }

  /* ----------------------------------------------------------------- volumes */

  createVolume(name: string, cause: number | null, implicit = false): string {
    if (!name.startsWith('anon-')) checkName('volume', name);
    if (Object.prototype.hasOwnProperty.call(this.w.volumes, name)) {
      if (!implicit) this.ev('volume.exists', `volume:${name}`, `volume ${name} already exists (reused)`, { concepts: ['volume'] });
      return name;
    }
    const v: Volume = { name, driver: 'local', mountpoint: `/var/lib/docker/volumes/${name}/_data`, items: 0, sizeMB: 0.1, createdTick: this.w.tick };
    this.w.volumes[name] = v;
    this.ev('volume.created', `volume:${name}`, `volume ${name} created at ${v.mountpoint}`, { concepts: ['volume'], ...(implicit ? { cause } : {}) });
    return name;
  }

  removeVolume(name: string): string {
    const v = this.w.volumes[name];
    if (!v) throw new SimError(`get ${name}: no such volume`);
    const users = volumeUsers(this.w, name);
    if (users.length) {
      this.ev('volume.remove.failed', `volume:${name}`, `volume ${name} is in use by ${users.join(', ')} (even stopped containers keep a reference)`, { severity: 'error', concepts: ['volume', 'container'] });
      throw new SimError(`remove ${name}: volume is in use - [${users.map((u) => this.w.containers[u]!.id).join(', ')}]`);
    }
    delete this.w.volumes[name];
    this.ev('volume.removed', `volume:${name}`, `volume ${name} removed: ${plural(v.items, 'record')} are permanently deleted`, { severity: 'warn', concepts: ['volume'] });
    return name;
  }

  /* --------------------------------------------------------------- resources */

  setLimit(target: string, resource: 'memory' | 'cpu' | 'pids', value: number | string | null): { output: string } {
    const c = this.c(target);
    const tgt = `container:${c.name}`;
    if (resource === 'memory') {
      const mb = parseMemory(value);
      if (mb !== null && (Number.isNaN(mb) || mb < 6)) throw new SimError('Minimum memory limit allowed is 6MB');
      const e = this.ev('cgroup.limit_changed', tgt, mb === null ? `docker update: memory limit removed from ${c.name}` : `docker update --memory ${mb}m ${c.name}: the kernel writes memory.max=${mb}MB into the cgroup`, {
        concepts: ['memory-limit', 'cgroups'],
        detail: { limitMB: mb },
      });
      c.limits.memoryMB = mb;
      if (c.state === 'running') this.within(e, () => this.checkOomFor(c, e));
    } else if (resource === 'cpu') {
      const n = typeof value === 'string' ? parseFloat(value) : value;
      c.limits.cpus = n && n > 0 ? n : null;
      this.ev('cgroup.limit_changed', tgt, c.limits.cpus ? `CPU quota ${c.limits.cpus} cores written to cpu.max: the container is throttled, never killed` : `CPU limit removed from ${c.name}`, { concepts: ['cpu-limit', 'cgroups'] });
    } else {
      const n = typeof value === 'string' ? parseInt(value, 10) : value;
      c.limits.pids = n && n > 0 ? n : null;
      const e = this.ev('cgroup.limit_changed', tgt, c.limits.pids ? `pids.max=${c.limits.pids} for ${c.name}: fork() fails beyond that` : `PID limit removed from ${c.name}`, { concepts: ['pids-limit', 'cgroups'] });
      if (c.state === 'running' && c.limits.pids !== null && c.childProcs.length + 1 > c.limits.pids) {
        this.within(e, () => {
          const k = this.ev('kernel.pids_limit', tgt, `${c.name} already runs ${c.childProcs.length + 1} processes; new forks are refused (EAGAIN)`, { severity: 'warn', concepts: ['pids-limit', 'process'] });
          c.childProcs = c.childProcs.slice(0, Math.max(0, c.limits.pids! - 1));
          this.ev('process.killed', tgt, `workers can no longer spawn; ${c.name} degrades but PID 1 survives`, { severity: 'warn', cause: k, concepts: ['process'] });
        });
      }
    }
    return { output: c.name };
  }

  stress(target: string, resource: 'memory' | 'cpu', amountIn: number): { output: string } {
    const amount = Math.max(-100_000, Math.min(100_000, amountIn));
    const c = this.c(target);
    if (c.state !== 'running') throw new SimError(`${c.name} is not running`);
    const tgt = `container:${c.name}`;
    if (resource === 'memory') {
      c.stress.memMB = Math.max(0, c.stress.memMB + amount);
      c.usage.memMB = Math.max(0, c.usage.memMB + amount);
      const e = this.ev('process.memory', tgt, `${c.name}'s process allocates ${amount >= 0 ? '+' : ''}${amount}MB (usage ${Math.round(c.usage.memMB)}MB${c.limits.memoryMB ? ` of ${c.limits.memoryMB}MB limit` : ', no limit'})`, {
        concepts: ['process', 'memory-limit', 'cgroups'],
      });
      this.within(e, () => this.checkOomFor(c, e));
    } else {
      c.stress.cpuPct = Math.max(0, c.stress.cpuPct + amount);
      c.usage.cpuPct = c.workload.baseCpuPct + c.stress.cpuPct;
      const e = this.ev('process.cpu', tgt, `${c.name} burns ${Math.round(c.usage.cpuPct)}% CPU`, { concepts: ['process', 'cpu-limit'] });
      if (c.limits.cpus && c.usage.cpuPct > c.limits.cpus * 100) {
        this.ev('cgroup.cpu.throttled', tgt, `cpu.max throttles ${c.name} to ${c.limits.cpus * 100}%: it is slowed, never killed`, { severity: 'warn', concepts: ['cpu-limit', 'cgroups'], cause: e });
        c.usage.cpuPct = c.limits.cpus * 100;
      }
    }
    return { output: '' };
  }

  checkOomFor(c: Container, cause: number | null): void {
    if (c.state !== 'running' || c.limits.memoryMB === null) return;
    if (c.usage.memMB > c.limits.memoryMB) {
      const e = this.ev('cgroup.memory.exceeded', `container:${c.name}`, `usage ${Math.round(c.usage.memMB)}MB exceeds memory.max=${c.limits.memoryMB}MB and nothing can be reclaimed`, {
        severity: 'warn',
        concepts: ['memory-limit', 'cgroups', 'oom-killer'],
        cause,
      });
      this.oomKill(c, e, 'cgroup');
    }
  }

  oomKill(c: Container, cause: number | null, scope: 'cgroup' | 'host'): void {
    const tgt = `container:${c.name}`;
    const e1 = this.ev('kernel.oom_kill', tgt, scope === 'cgroup' ? `kernel OOM killer picks PID ${c.pid} (${c.process}) inside ${c.name}'s cgroup` : `host is out of memory: the kernel OOM killer picks ${c.process} (PID ${c.pid}), the biggest consumer`, {
      severity: 'error',
      concepts: ['oom-killer', 'kernel', 'memory-limit'],
      cause,
    });
    const e2 = this.ev('process.killed', tgt, `SIGKILL delivered to PID ${c.pid}: it cannot catch or ignore it`, { severity: 'error', concepts: ['signals', 'process', 'oom-killer'], cause: e1 });
    this.log(c, `Out of memory: Killed process ${c.pid} (${c.process})`, 'stderr');
    this.exit(c, 137, e2, 'OOMKilled', true);
  }

  writeData(target: string, path: string, countIn: number): { output: string } {
    const count = Math.max(1, Math.min(1_000_000, Math.round(countIn) || 1));
    const c = this.c(target);
    const tgt = `container:${c.name}`;
    if (c.state !== 'running') throw new SimError(`${c.name} is not running`);
    const m: Mount | undefined = [...c.mounts].filter((x) => path === x.target || path.startsWith(x.target.replace(/\/$/, '') + '/')).sort((a, b) => b.target.length - a.target.length)[0] as Mount | undefined;
    const where = m?.type ?? 'layer';
    if (m?.readOnly) {
      this.ev('write.denied', tgt, `write to ${path} refused: ${m.target} is mounted read-only (EROFS)`, { severity: 'error', concepts: ['mnt-ns', m.type === 'volume' ? 'volume' : 'bind-mount'] });
      throw new SimError(`${path}: Read-only file system`);
    }
    if (c.security.readOnlyRootfs && where === 'layer') {
      this.ev('write.denied', tgt, `write to ${path} refused: the container rootfs is read-only`, { severity: 'error', concepts: ['writable-layer'] });
      throw new SimError(`${path}: Read-only file system`);
    }
    if (diskFreeMB(this.w) <= count * 0.01) {
      const e = this.ev('disk.full', 'host', `write of ${count} records failed: no space left on device (ENOSPC)`, { severity: 'error', concepts: ['disk', 'overlayfs'] });
      this.within(e, () => this.diskFullFallout(e));
      throw new SimError('write: no space left on device');
    }
    const e = this.ev('data.written', tgt, `${c.name} wrote ${plural(count, 'record')} to ${path}`, { concepts: ['writable-layer'] });
    this.within(e, () => {
      if (m?.type === 'volume') {
        const v = this.w.volumes[m.source]!;
        v.items += count;
        v.sizeMB += count * 0.01;
        this.ev('volume.data_written', `volume:${v.name}`, `the records live in volume ${v.name} (${v.mountpoint}), outside the container's own layer`, { concepts: ['volume', 'mnt-ns'] });
      } else if (m?.type === 'bind') {
        const p = this.w.host.paths[m.source]!;
        p.items += count;
        this.ev('bind.data_written', `container:${c.name}`, `the records are real files in the host directory ${m.source}`, { concepts: ['bind-mount'] });
      } else if (m?.type === 'tmpfs') {
        c.usage.memMB += count * 0.01;
        this.ev('tmpfs.data_written', tgt, `tmpfs data is held in RAM (+${(count * 0.01).toFixed(1)}MB) and disappears on stop`, { concepts: ['tmpfs'] });
        this.checkOomFor(c, e);
      } else {
        c.layerData.items += count;
        this.ev('layer.data_written', tgt, `the records went into ${c.name}'s writable layer — they will vanish when the container is removed`, {
          severity: 'warn',
          concepts: ['writable-layer', 'overlayfs', 'volume'],
        });
      }
    });
    return { output: `${count} records written to ${path}` };
  }

  fillDisk(mbIn: number): { output: string } {
    const w = this.w;
    const mb = Math.max(0, Math.min(w.host.diskMB * 2, mbIn));
    w.host.fillerDiskMB = Math.min(w.host.diskMB * 2, w.host.fillerDiskMB + mb);
    const free = diskFreeMB(w);
    const e = this.ev('disk.filled', 'host', `something outside Docker wrote ${fmtMB(mb)}; free space on / is now ${fmtMB(Math.max(0, free))}`, { severity: free <= 0 ? 'error' : 'warn', concepts: ['disk'] });
    if (free <= 0) {
      const f = this.ev('disk.full', 'host', 'the filesystem is full: every write now fails with ENOSPC', { severity: 'error', concepts: ['disk', 'overlayfs'], cause: e });
      this.diskFullFallout(f);
    }
    return { output: '' };
  }

  freeDisk(): { output: string } {
    this.w.host.fillerDiskMB = 0;
    this.ev('disk.freed', 'host', `cleared non-Docker files; ${fmtMB(diskFreeMB(this.w))} free`, { concepts: ['disk'] });
    return { output: '' };
  }

  diskFullFallout(cause: number): void {
    if (diskFreeMB(this.w) > 0) return;
    for (const c of Object.values(this.w.containers)) {
      if (c.state !== 'running') continue;
      const tgt = `container:${c.name}`;
      if (c.workload.kind === 'database') {
        const e = this.ev('app.write_failed', tgt, `${c.process} cannot flush its write-ahead log: ENOSPC`, { severity: 'error', concepts: ['disk', 'process'], cause });
        this.log(c, 'PANIC: could not write to file "pg_wal": No space left on device', 'stderr');
        this.exit(c, 1, e, 'PANIC: no space left on device');
      } else if (c.workload.kind === 'cache') {
        this.ev('app.write_failed', tgt, `${c.process} cannot save its RDB snapshot: it now refuses writes (MISCONF) but keeps serving reads`, { severity: 'warn', concepts: ['disk'], cause });
      } else if (c.workload.kind === 'static-web') {
        this.ev('app.write_failed', tgt, `${c.process} cannot write its access log, but serving static files still works`, { severity: 'warn', concepts: ['disk', 'logs'], cause });
      }
    }
  }

  /* ----------------------------------------------------------- host & daemons */

  setCondition(name: string, value: number | boolean): { output: string } {
    const w = this.w;
    const n = w.host.net;
    const num = typeof value === 'number' ? value : value ? 1 : 0;
    switch (name) {
      case 'latency':
        n.latencyMs = Math.max(0, num);
        this.ev('host.condition', 'host', `network latency set to ${n.latencyMs} ms`, { concepts: ['network', 'registry'] });
        break;
      case 'packet_loss':
        n.packetLossPct = Math.min(100, Math.max(0, num));
        this.ev('host.condition', 'host', `packet loss set to ${n.packetLossPct}%`, { severity: n.packetLossPct >= 50 ? 'warn' : 'info', concepts: ['network'] });
        break;
      case 'dns':
        n.dnsUp = !!value;
        this.ev('host.condition', 'host', n.dnsUp ? 'upstream DNS restored' : 'upstream DNS is down: names outside Docker no longer resolve (container-to-container names still do)', {
          severity: n.dnsUp ? 'info' : 'warn',
          concepts: ['dns', 'service-discovery'],
        });
        break;
      case 'bandwidth':
        n.bandwidthMbps = Math.max(0, num);
        this.ev('host.condition', 'host', `bandwidth limited to ${n.bandwidthMbps} Mbps`, { concepts: ['network', 'registry'] });
        break;
      case 'registry':
        n.registryReachable = !!value;
        this.ev('host.condition', 'host', n.registryReachable ? 'the registry is reachable' : 'the registry is unreachable: pulls and builds that need it will fail, local images keep working', {
          severity: n.registryReachable ? 'info' : 'warn',
          concepts: ['registry', 'oci-distribution'],
        });
        break;
      case 'cpu_load':
        w.host.cpuLoadPct = Math.min(100, Math.max(0, num));
        this.ev('host.condition', 'host', `host CPU background load ${w.host.cpuLoadPct}%`, { concepts: ['cpu-limit', 'process'] });
        break;
      case 'memory_pressure': {
        w.host.memPressureMB = Math.max(0, num);
        const e = this.ev('host.condition', 'host', `another host process now holds ${Math.round(w.host.memPressureMB)}MB of RAM (${Math.round(hostMemUsedMB(w))}MB of ${w.host.ramMB}MB used)`, {
          severity: hostMemUsedMB(w) > w.host.ramMB ? 'warn' : 'info',
          concepts: ['memory-limit', 'oom-killer', 'kernel'],
        });
        this.within(e, () => this.hostOom(e));
        break;
      }
      case 'disk_available': {
        const dockerUsed = diskUsedMB(w) - w.host.fillerDiskMB;
        w.host.fillerDiskMB = Math.max(0, w.host.diskMB - dockerUsed - Math.max(0, num));
        const free = diskFreeMB(w);
        const e = this.ev('host.condition', 'host', `free disk space is now ${fmtMB(Math.max(0, free))}`, { severity: free <= 0 ? 'error' : 'info', concepts: ['disk'] });
        if (free <= 0) this.within(e, () => this.diskFullFallout(e));
        break;
      }
      case 'host_online':
        if (!value) this.powerOff();
        else this.boot();
        break;
      default:
        throw new SimError(`unknown condition ${name}`);
    }
    return { output: '' };
  }

  hostOom(cause: number | null): void {
    const w = this.w;
    for (let guard = 0; guard < 8; guard++) {
      if (hostMemUsedMB(w) <= w.host.ramMB) return;
      const victim = Object.values(w.containers)
        .filter((c) => c.state === 'running')
        .sort((a, b) => b.usage.memMB - a.usage.memMB)[0];
      if (!victim) {
        this.ev('kernel.oom_kill', 'host', 'the host is out of memory and no container is left to blame', { severity: 'error', concepts: ['oom-killer', 'kernel'], cause });
        return;
      }
      this.oomKill(victim, cause, 'host');
    }
  }

  powerOff(): void {
    const w = this.w;
    if (!w.host.online) return;
    const e = this.ev('host.powered_off', 'host', 'power lost: every process on the machine stops without a clean shutdown', { severity: 'error', concepts: ['host', 'kernel'] });
    w.host.online = false;
    w.daemons.dockerd.running = false;
    w.daemons.containerd.running = false;
    this.within(e, () => {
      for (const c of Object.values(w.containers)) {
        if (c.state === 'running' || c.state === 'paused') {
          c.state = 'exited';
          c.exitCode = 255;
          c.pid = 0;
          c.childProcs = [];
          c.usage = { memMB: 0, cpuPct: 0 };
          c.finishedTick = w.tick;
          this.ev('container.exited', `container:${c.name}`, `${c.name} exited (255): the host lost power`, { severity: 'warn', concepts: ['container', 'exit-codes', 'host'] });
        }
      }
    });
  }

  boot(): void {
    const w = this.w;
    if (w.host.online && w.daemons.dockerd.running) return;
    w.host.online = true;
    w.host.bootCount += 1;
    const e = this.ev('host.booted', 'host', `host booted (boot #${w.host.bootCount}); systemd starts containerd, then dockerd`, { concepts: ['host', 'kernel', 'daemon-restart'] });
    w.daemons.containerd = { ...w.daemons.containerd, running: true, pid: 640 };
    w.daemons.dockerd = { ...w.daemons.dockerd, running: true, pid: 812 };
    this.within(e, () => {
      this.ev('engine.dockerd', 'daemon:dockerd', 'dockerd is up and reloads its container database from /var/lib/docker', { concepts: ['dockerd', 'daemon-restart'] });
      this.restartPolicyPass(e);
    });
  }

  /** after dockerd comes back, restart policies decide which containers return */
  restartPolicyPass(cause: number): void {
    for (const c of Object.values(this.w.containers).sort((a, b) => a.createdTick - b.createdTick)) {
      if (c.state !== 'exited') continue;
      const p = c.restartPolicy;
      const eligible = p === 'always' || (p === 'unless-stopped' && !c.manuallyStopped);
      if (eligible) {
        const e = this.ev('container.restarting', `container:${c.name}`, `restart policy "${p}" starts ${c.name} again after the daemon came back`, { concepts: ['restart-policy', 'daemon-restart'], cause });
        try {
          this.within(e, () => this.startContainer(c, e));
        } catch (err) {
          if (!(err instanceof SimError)) throw err;
        }
      } else if (c.finishedTick === this.w.tick) {
        this.ev('container.stays_down', `container:${c.name}`, `${c.name} stays down: restart policy is "${p}"${c.manuallyStopped ? ' and it was stopped by hand' : ''}`, { concepts: ['restart-policy', 'daemon-restart'], cause });
      }
    }
  }

  restartHost(): { output: string } {
    const w = this.w;
    const e = this.ev('host.reboot', 'host', 'sudo reboot: systemd stops dockerd gracefully, the machine restarts', { concepts: ['host', 'daemon-restart'] });
    this.within(e, () => {
      for (const c of Object.values(w.containers)) if (c.state === 'running' || c.state === 'paused') this.terminate(c, e);
      w.daemons.dockerd.running = false;
      w.host.online = false;
      this.boot();
    });
    return { output: '' };
  }

  stopDaemon(which: 'dockerd' | 'containerd'): { output: string } {
    const w = this.w;
    if (!w.daemons[which].running) throw new SimError(`${which} is not running`);
    const e = this.ev('daemon.stopping', `daemon:${which}`, `systemctl stop ${which}`, { concepts: [which, 'daemon-restart'] });
    this.within(e, () => {
      if (which === 'dockerd') {
        for (const c of Object.values(w.containers)) if (c.state === 'running' || c.state === 'paused') this.terminate(c, e);
        w.daemons.dockerd.running = false;
        this.ev('daemon.stopped', 'daemon:dockerd', 'dockerd is down: the docker CLI cannot connect, and without live-restore its containers were stopped with it', { severity: 'warn', concepts: ['dockerd', 'docker-api', 'daemon-restart'] });
      } else {
        w.daemons.containerd.running = false;
        const live = Object.values(w.containers).filter((c) => c.state === 'running').length;
        this.ev('daemon.stopped', 'daemon:containerd', `containerd is down, but ${plural(live, 'container')} keep running: each has its own shim process holding it. Only NEW containers cannot start.`, {
          severity: 'warn',
          concepts: ['containerd', 'shim', 'process'],
        });
      }
    });
    return { output: '' };
  }

  startDaemon(which: 'dockerd' | 'containerd'): { output: string } {
    const w = this.w;
    if (w.daemons[which].running) throw new SimError(`${which} is already running`);
    const e = this.ev('daemon.starting', `daemon:${which}`, `systemctl start ${which}`, { concepts: [which, 'daemon-restart'] });
    this.within(e, () => {
      w.daemons[which].running = true;
      this.ev('daemon.started', `daemon:${which}`, `${which} is running again`, { concepts: [which] });
      if (which === 'dockerd') this.restartPolicyPass(e);
    });
    return { output: '' };
  }

  /* ------------------------------------------------------------------- build */

  build(tagIn?: string): string {
    const w = this.w;
    const tag = normalizeRef(tagIn ?? w.build.tag);
    const steps = w.build.steps;
    const root = this.ev('build.started', `image:${tag}`, `docker build -t ${tag} . (BuildKit)`, { concepts: ['build', 'dockerfile', 'buildkit'] });
    return this.within(root, () => {
      const from = steps[0];
      if (!from || from.instr !== 'FROM') throw new SimError('Dockerfile must start with FROM');
      let base = w.images[normalizeRef(from.arg)];
      if (!base) {
        const rem = registryCatalog().images[normalizeRef(from.arg)];
        if (!rem) throw new SimError(`failed to solve: ${from.arg}: not found`);
        const n = w.host.net;
        if (!n.dnsUp || !n.registryReachable) {
          this.ev('build.failed', `image:${tag}`, `step 1/${steps.length} FROM ${from.arg}: cannot resolve the base image (${!n.dnsUp ? 'DNS down' : 'registry unreachable'})`, { severity: 'error', concepts: ['build', 'registry', 'dns'] });
          throw new SimError(`failed to solve: failed to resolve source metadata for docker.io/library/${from.arg}: ${!n.dnsUp ? 'lookup registry-1.docker.io: no such host' : 'dial tcp: i/o timeout'}`);
        }
        this.pull(from.arg);
        base = w.images[normalizeRef(from.arg)]!;
      }
      const layers = [...base.layers];
      const history = base.history.map((h) => ({ ...h }));
      const config = clone(base.config);
      let key = base.id;
      const results = [{ index: 0, instr: 'FROM', arg: from.arg, cached: true, layer: null as string | null }];
      this.ev('build.step', `image:${tag}`, `[1/${steps.length}] FROM ${from.arg} → ${base.layers.length} base layers`, { concepts: ['layer', 'build-cache'] });
      let invalidated = false;
      for (let i = 1; i < steps.length; i++) {
        const s = steps[i]!;
        key = sha(`${key}|${s.instr}|${s.arg}|${s.inputVersion}`);
        const metaOnly = METADATA_ONLY.has(s.instr);
        let layer: string | null = null;
        let cached = false;
        if (metaOnly) {
          cached = true;
          if (s.instr === 'EXPOSE') config.exposed = [parseInt(s.arg, 10)];
          if (s.instr === 'CMD') config.cmd = JSON.parse(s.arg.replace(/'/g, '"')) as string[];
          if (s.instr === 'USER') config.user = s.arg;
          history.push({ instr: `${s.instr} ${s.arg}`, layer: null });
          this.ev('build.step', `image:${tag}`, `[${i + 1}/${steps.length}] ${s.instr} ${s.arg} (metadata only, no layer)`, { concepts: ['dockerfile', 'oci-image'] });
        } else if (w.build.cache[key] && w.layers[w.build.cache[key]!]) {
          layer = w.build.cache[key]!;
          cached = true;
          layers.push(layer);
          history.push({ instr: `${s.instr} ${s.arg}`, layer });
          this.ev('build.step.cached', `image:${tag}`, `[${i + 1}/${steps.length}] ${s.instr} ${s.arg} → CACHED (layer ${short(layer)})`, { concepts: ['build-cache', 'layer', 'digest'] });
        } else {
          if (!invalidated && i > 1) invalidated = true;
          if (s.instr === 'RUN' && /npm|apk|apt|pip/.test(s.arg) && (!w.host.net.dnsUp || !w.host.net.registryReachable)) {
            this.ev('build.failed', `image:${tag}`, `[${i + 1}/${steps.length}] ${s.instr} ${s.arg} failed: no network inside the build container (${!w.host.net.dnsUp ? 'DNS down' : 'registry unreachable'})`, {
              severity: 'error',
              concepts: ['build', 'dns', 'network'],
            });
            throw new SimError(`process "/bin/sh -c ${s.arg}" did not complete successfully: exit code: 1 (npm ERR! network request failed)`);
          }
          if (diskFreeMB(w) < s.sizeMB) {
            this.ev('disk.full', 'host', `build step needs ${fmtMB(s.sizeMB)} but the disk is full`, { severity: 'error', concepts: ['disk', 'build'] });
            throw new SimError('failed to solve: write /var/lib/docker/buildkit: no space left on device');
          }
          const l = layerFor(`${s.instr} ${s.arg}`, key, s.sizeMB, BUILD_CHANGES[s.instr + ' ' + s.arg] ?? [`${s.instr} ${s.arg}`]);
          w.layers[l.digest] = l;
          layer = l.digest;
          layers.push(layer);
          w.build.cache[key] = layer;
          history.push({ instr: `${s.instr} ${s.arg}`, layer });
          this.ev('build.step', `image:${tag}`, `[${i + 1}/${steps.length}] ${s.instr} ${s.arg} → NEW layer ${short(layer)} (${fmtMB(s.sizeMB)})${invalidated ? ' — cache was invalidated by an earlier change' : ''}`, {
            concepts: ['layer', 'build-cache', 'dockerfile'],
          });
        }
        results.push({ index: i, instr: s.instr, arg: s.arg, cached, layer });
      }
      const old = w.images[tag];
      if (old) this.untag(old);
      const id = sha(`image-config:${tag}:${layers.join(',')}:${JSON.stringify(config)}`);
      const sizeMB = Math.round(layers.reduce((a, d) => a + (w.layers[d]?.sizeMB ?? 0), 0) * 10) / 10;
      w.images[tag] = {
        ref: tag,
        id,
        manifestDigest: sha(`manifest:${id}`),
        arch: w.host.arch,
        os: 'linux',
        layers,
        sizeMB,
        config,
        history,
        workload: apiWorkload(),
        builtLocally: true,
        origin: 'local-build',
      };
      w.build.last = { tag, steps: results, tick: w.tick };
      const hits = results.filter((r) => r.cached && !METADATA_ONLY.has(r.instr) && r.index > 0).length;
      this.ev('build.completed', `image:${tag}`, `built ${tag}: ${layers.length} layers, ${fmtMB(sizeMB)} (${hits} steps came from cache)`, {
        concepts: ['image', 'layer', 'build-cache', 'digest'],
        detail: { id, layers: layers.length },
      });
      return `Successfully tagged ${tag}`;
    });
  }

  editDockerfile(step: number, change: 'touch' | 'text', arg?: string): { output: string } {
    const s = this.w.build.steps[step];
    if (!s) throw new SimError(`Dockerfile has no step ${step}`);
    if (step === 0 && change === 'touch') throw new SimError('step 0 is FROM: change the base image with change="text"');
    if (change === 'text' && arg !== undefined) s.arg = arg;
    else s.inputVersion += 1;
    const after = this.w.build.steps.slice(step + 1).filter((x) => !METADATA_ONLY.has(x.instr)).length;
    this.ev(
      'dockerfile.edited',
      `image:${this.w.build.tag}`,
      `edited step ${step + 1} (${s.instr} ${s.arg}): its layer — and the ${plural(after, 'layer')} stacked on top — can no longer come from cache`,
      { concepts: ['dockerfile', 'build-cache', 'layer'], severity: 'info' },
    );
    return { output: '' };
  }

  /* ----------------------------------------------------------------- compose */

  composeUp(): string {
    const w = this.w;
    if (!w.compose) w.compose = shopCompose();
    const p = w.compose;
    const root = this.ev('compose.up', 'compose:' + p.name, `docker compose up -d (project ${p.name})`, { concepts: ['compose', 'lifecycle'] });
    this.within(root, () => {
      const netName = `${p.name}_default`;
      if (!w.networks[netName]) this.createNetwork(netName);
      for (const svc of p.services) {
        for (const v of svc.volumes) {
          const src = v.split(':')[0]!;
          if (!src.startsWith('/') && src !== 'tmpfs') this.createVolume(`${p.name}_${src}`, root, true);
        }
      }
      const order = this.depOrder(p.services.map((s) => ({ name: s.name, deps: s.dependsOn })));
      for (const sname of order) {
        const svc = p.services.find((s) => s.name === sname)!;
        const cname = `${p.name}-${svc.name}-1`;
        const existing = w.containers[cname];
        if (existing) {
          if (existing.state !== 'running') {
            existing.manuallyStopped = false;
            this.startContainer(existing, root);
          }
          continue;
        }
        if (!w.images[normalizeRef(svc.image)] && !registryCatalog().images[normalizeRef(svc.image)]) {
          this.ev('compose.service.failed', `container:${cname}`, `service ${svc.name}: image ${svc.image} does not exist locally or in the registry — run a build first`, { severity: 'error', concepts: ['compose', 'image'] });
          throw new SimError(`service "${svc.name}" depends on image "${svc.image}" which was not found (build it first)`);
        }
        const ev = this.ev('compose.service', `container:${cname}`, `starting service ${svc.name}${svc.dependsOn.length ? ` (after ${svc.dependsOn.join(', ')})` : ''}`, { concepts: ['compose', 'service-discovery'] });
        this.within(ev, () => {
          const c = this.createContainer({
            image: svc.image,
            name: cname,
            ports: svc.ports,
            volumes: svc.volumes.map((v) => {
              const [src, ...rest] = v.split(':');
              return src!.startsWith('/') || src === 'tmpfs' ? v : [`${p.name}_${src}`, ...rest].join(':');
            }),
            network: netName,
            env: svc.env,
            restart: svc.restart,
            memory: svc.memory,
            compose: { project: p.name, service: svc.name },
          });
          try {
            this.startContainer(c, ev);
          } catch (err) {
            if (!(err instanceof SimError)) throw err;
          }
        });
      }
      p.up = true;
    });
    return `[+] Running ${p.services.length}/${p.services.length}`;
  }

  composeDown(): string {
    const w = this.w;
    const p = w.compose;
    if (!p) throw new SimError('no compose project is defined');
    const root = this.ev('compose.down', 'compose:' + p.name, `docker compose down (project ${p.name}): remove containers and network, keep volumes`, { concepts: ['compose', 'lifecycle', 'volume'] });
    this.within(root, () => {
      for (const svc of [...p.services].reverse()) {
        const cname = `${p.name}-${svc.name}-1`;
        if (w.containers[cname]) this.removeNamed(cname, true, false);
      }
      const netName = `${p.name}_default`;
      if (w.networks[netName]) this.removeNetwork(netName);
      p.up = false;
    });
    return '';
  }

  composeStop(service: string): { output: string } {
    const p = this.w.compose;
    if (!p) throw new SimError('no compose project is defined');
    const svc = p.services.find((s) => s.name === service);
    if (!svc) throw new SimError(`no such service: ${service}`);
    const cname = `${p.name}-${svc.name}-1`;
    const dependents = p.services.filter((s) => s.dependsOn.includes(service)).map((s) => s.name);
    const e = this.ev('compose.stop', `container:${cname}`, `docker compose stop ${service}${dependents.length ? ` — ${dependents.join(', ')} depend${dependents.length === 1 ? 's' : ''} on it` : ''}`, { concepts: ['compose', 'service-discovery'] });
    this.within(e, () => this.stopNamed(cname));
    return { output: '' };
  }

  private depOrder(nodes: { name: string; deps: string[] }[]): string[] {
    const done = new Set<string>();
    const out: string[] = [];
    const visit = (n: string, stack: string[]): void => {
      if (done.has(n) || stack.includes(n)) return;
      const node = nodes.find((x) => x.name === n);
      for (const d of node?.deps ?? []) visit(d, [...stack, n]);
      done.add(n);
      out.push(n);
    };
    nodes.forEach((n) => visit(n.name, []));
    return out;
  }

  /* ---------------------------------------------------------------- requests */

  sendRequest(from: string, to: string, port?: number, by: 'name' | 'ip' = 'name'): { output: string; data: unknown } {
    const w = this.w;
    const toName = parseTarget(to).name || to;
    const fromName = from === 'external' || from === 'host' ? from : parseTarget(from).name || from;
    const res = probe(w, fromName, toName, port, by);
    const id = ++w.seq.request;
    const rr = { ...res, id, tick: w.tick, from: fromName, to: toName };
    w.requests.push(rr);
    if (w.requests.length > 12) w.requests.shift();
    this.ev(
      res.ok ? 'request.ok' : 'request.failed',
      `container:${toName}`,
      res.ok ? `request ${fromName} → ${toName}: HTTP 200 in ${res.latencyMs} ms${res.reason !== 'ok' ? ` (${res.reason})` : ''}` : `request ${fromName} → ${toName} failed: ${res.reason}`,
      {
        severity: res.ok ? 'info' : 'error',
        concepts: ['port-publish', 'network', 'dns', 'iptables', 'veth', 'bridge'],
        detail: { hops: res.hops, status: res.status, latencyMs: res.latencyMs },
      },
    );
    return { output: res.ok ? `HTTP/1.1 200 OK (${res.latencyMs} ms)` : `curl: ${res.reason}`, data: rr };
  }

  /* --------------------------------------------------------------------- time */

  advance(ticks: number): { output: string } {
    const w = this.w;
    const n = Math.max(1, Math.min(60, Math.round(ticks)));
    const e = this.ev('time.advanced', 'host', `time passes: ${plural(n, 'tick')}`, { concepts: ['process', 'memory-limit'] });
    this.within(e, () => {
      for (let i = 0; i < n; i++) {
        w.tick += i === 0 ? 0 : 1;
        for (const c of Object.values(w.containers)) {
          if (c.state !== 'running') continue;
          if (c.workload.leakMBPerTick > 0) {
            c.usage.memMB += c.workload.leakMBPerTick;
            this.log(c, `heap ${Math.round(c.usage.memMB)}MB (growing)`);
            this.checkOomFor(c, e);
          }
        }
        this.hostOom(e);
      }
    });
    return { output: '' };
  }

  connectionTest(): { output: string } {
    this.ev('lab.connection_test', 'daemon:dockerd', 'Your AI is connected: Santa waves from the whale.', { concepts: ['dockerd'] });
    return { output: 'connected' };
  }

  /* ------------------------------------------------------------------- settle */

  /** derive the consequences of the new state: health, service reachability, host pressure */
  settle(): void {
    const w = this.w;
    if (this.events.length === 0) return;
    // host level memory exhaustion
    this.hostOom(this.tail);
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      const anchor = this.tail;
      for (const c of Object.values(w.containers).sort((a, b) => a.name.localeCompare(b.name))) {
        const tgt = `container:${c.name}`;
        const health = evaluateHealth(w, c);
        if (health !== c.health) {
          const prev = c.health;
          c.health = health;
          if (!(prev === 'none' && health === 'healthy')) {
            this.ev('container.health', tgt, health === 'unhealthy' ? `${c.name} is now UNHEALTHY: ${shortReason(w, c)}` : health === 'healthy' ? `${c.name} is healthy again` : `${c.name} has no health status`, {
              severity: health === 'unhealthy' ? 'warn' : 'info',
              concepts: ['healthcheck', 'service-discovery'],
              cause: anchor,
            });
          }
          changed = true;
        }
        const svc: Container['service'] = c.ports.length === 0 ? 'none' : c.state === 'running' && externalService(w, c).ok ? 'up' : 'down';
        if (svc !== c.service) {
          const prev = c.service;
          c.service = svc;
          if ((prev === 'up' && svc === 'down') || (prev === 'down' && svc === 'up')) {
            const why = svc === 'down' ? externalService(w, c).reason : '';
            this.ev(svc === 'down' ? 'service.unavailable' : 'service.recovered', tgt, svc === 'down' ? `${c.name} is no longer reachable on :${c.ports[0]!.host} — ${why}` : `${c.name} is reachable on :${c.ports[0]!.host} again`, {
              severity: svc === 'down' ? 'error' : 'info',
              concepts: ['port-publish', 'service-discovery'],
              cause: anchor,
            });
          }
          changed = true;
        }
      }
      if (!changed) break;
    }
    // layerData sanity for removed containers etc. nothing else to derive
    void containerLayerMB;
  }
}

function shortReason(w: World, c: Container): string {
  const r = evaluateReason(w, c);
  return r.length > 140 ? r.slice(0, 137) + '…' : r;
}

function evaluateReason(w: World, c: Container): string {
  return serve(w, c).reason;
}

const BUILD_CHANGES: Record<string, string[]> = {
  'WORKDIR /app': ['/app (directory created)'],
  'COPY package*.json ./': ['/app/package.json', '/app/package-lock.json'],
  'RUN npm ci --omit=dev': ['/app/node_modules (412 packages, 47.9 MB)'],
  'COPY . .': ['/app/server.js', '/app/routes/', '/app/lib/'],
};

const HELLO = `Hello from Docker!
This message shows that your installation appears to be working correctly.

To generate this message, Docker took the following steps:
 1. The Docker client contacted the Docker daemon.
 2. The Docker daemon pulled the "hello-world" image from the Docker Hub.
 3. The Docker daemon created a new container from that image which runs the
    executable that produces the output you are currently reading.
 4. The Docker daemon streamed that output to the Docker client.`;
