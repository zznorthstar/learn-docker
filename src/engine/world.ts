import type { Action, Container, ComposeProject, Network, World } from './types';
import { sampleDockerfile } from './catalog';
import { hex, own, parseTarget } from './util';

export function emptyWorld(): World {
  const bridge: Network = {
    name: 'bridge',
    driver: 'bridge',
    subnet: '172.17.0.0/16',
    gateway: '172.17.0.1',
    bridgeIf: 'docker0',
    builtin: true,
    dns: false,
    internal: false,
  };
  return {
    tick: 0,
    host: {
      name: 'whale-01',
      arch: 'amd64',
      os: 'Ubuntu 24.04 LTS',
      kernel: '6.8.0-45-generic',
      cpuCores: 4,
      ramMB: 4096,
      diskMB: 20480,
      online: true,
      bootCount: 1,
      net: { dnsUp: true, latencyMs: 12, packetLossPct: 0, bandwidthMbps: 100, registryReachable: true },
      fillerDiskMB: 2200,
      baseMemMB: 640,
      memPressureMB: 0,
      cpuLoadPct: 6,
      paths: {
        '/srv/site': { exists: true, items: 14 },
        '/srv/app/data': { exists: true, items: 220 },
      },
      busyPorts: { 22: 'sshd', 5353: 'avahi-daemon' },
    },
    daemons: {
      dockerd: { running: true, pid: 812, version: '27.3.1' },
      containerd: { running: true, pid: 640, version: '1.7.22' },
      buildkit: { running: true, pid: 815, version: '0.16.0' },
      runc: { version: '1.1.14' },
    },
    images: {},
    layers: {},
    containers: {},
    networks: {
      bridge,
      host: { name: 'host', driver: 'host', subnet: '', gateway: '', bridgeIf: '', builtin: true, dns: false, internal: false },
      none: { name: 'none', driver: 'none', subnet: '', gateway: '', bridgeIf: '', builtin: true, dns: false, internal: false },
    },
    volumes: {},
    build: { tag: 'my-api:latest', steps: sampleDockerfile(), cache: {}, last: null },
    compose: null,
    logs: [],
    requests: [],
    seq: { pid: 4100, ip: { bridge: 1 }, subnet: 18, request: 0, nsId: 4026531900 },
  };
}

export function shopCompose(): ComposeProject {
  return {
    name: 'shop',
    up: false,
    services: [
      { name: 'web', image: 'nginx:latest', ports: ['8080:80'], volumes: [], dependsOn: ['api'], env: {}, restart: 'unless-stopped' },
      { name: 'api', image: 'my-api:latest', ports: [], volumes: [], dependsOn: ['db'], env: { DB_HOST: 'db' }, restart: 'on-failure' },
      {
        name: 'db',
        image: 'postgres:16',
        ports: [],
        volumes: ['dbdata:/var/lib/postgresql/data'],
        dependsOn: [],
        env: { POSTGRES_PASSWORD: 'example' },
        restart: 'unless-stopped',
      },
    ],
  };
}

export interface Preset {
  id: string;
  label: string;
  blurb: string;
  actions: Action[];
  /** compose definition to install before running actions */
  compose?: boolean;
}

export const PRESETS: Record<string, Preset> = {
  empty: { id: 'empty', label: 'Empty host', blurb: 'A clean machine with Docker installed and nothing running.', actions: [] },
  welcome: {
    id: 'welcome',
    label: 'First cargo',
    blurb: 'nginx pulled from the harbor and running as `web`, published on port 8080.',
    actions: [{ action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:80'], detach: true }],
  },
  persistence: {
    id: 'persistence',
    label: 'Data that survives',
    blurb: 'Two redis containers: `cache-vol` keeps data on a volume, `cache-tmp` keeps it in its own writable layer.',
    actions: [
      { action: 'run_container', image: 'redis:7', name: 'cache-vol', volumes: ['mydata:/data'], detach: true },
      { action: 'run_container', image: 'redis:7', name: 'cache-tmp', detach: true },
      { action: 'write_data', target: 'container:cache-vol', path: '/data', count: 120 },
      { action: 'write_data', target: 'container:cache-tmp', path: '/data', count: 120 },
    ],
  },
  shop: {
    id: 'shop',
    label: 'Compose shop',
    blurb: 'A three-service Compose app: web → api → db, with a named volume for the database.',
    compose: true,
    actions: [{ action: 'build_image' }, { action: 'compose_up' }],
  },
};

/* ---------------------------------------------------------------------------
 * Pure queries shared by the simulator, the inspector and the renderer
 * ------------------------------------------------------------------------- */

export function getContainer(w: World, target: string): Container | undefined {
  const { kind, name } = parseTarget(target);
  if (kind === 'container') return own(w.containers, name);
  return own(w.containers, target); // allow bare names
}

export function running(w: World): Container[] {
  return Object.values(w.containers).filter((c) => c.state === 'running' || c.state === 'paused');
}

export function imageSizeOnDisk(w: World): number {
  // layers are shared: count each unique local layer once
  const seen = new Set<string>();
  let total = 0;
  for (const img of Object.values(w.images)) {
    for (const d of img.layers) {
      if (seen.has(d)) continue;
      seen.add(d);
      total += w.layers[d]?.sizeMB ?? 0;
    }
  }
  return total;
}

export function containerLayerMB(c: Container): number {
  return c.layerData.items * 0.04 + 0.1;
}

export function diskUsedMB(w: World): number {
  let used = w.host.fillerDiskMB + imageSizeOnDisk(w);
  for (const c of Object.values(w.containers)) used += containerLayerMB(c);
  for (const v of Object.values(w.volumes)) used += v.sizeMB;
  used += w.logs.length * 0.002;
  return used;
}

export function diskFreeMB(w: World): number {
  return w.host.diskMB - diskUsedMB(w);
}

export function hostMemUsedMB(w: World): number {
  let used = w.host.baseMemMB + w.host.memPressureMB;
  for (const c of Object.values(w.containers)) if (c.state === 'running' || c.state === 'paused') used += c.usage.memMB;
  return used;
}

export function hostCpuPct(w: World): number {
  let pct = w.host.cpuLoadPct;
  for (const c of Object.values(w.containers)) if (c.state === 'running') pct += c.usage.cpuPct / w.host.cpuCores;
  return Math.min(100, pct);
}

/** Deterministic container id (64 hex) from name + creation tick. */
export function newContainerId(name: string, tick: number): string {
  return hex(`container:${name}:${tick}`);
}

export function nextPid(w: World, step = 1): number {
  w.seq.pid += step;
  return w.seq.pid;
}

export function nextNsId(w: World): number {
  w.seq.nsId += 1;
  return w.seq.nsId;
}

/** user-visible names for all containers using a given volume (running or not) */
export function volumeUsers(w: World, volume: string): string[] {
  return Object.values(w.containers)
    .filter((c) => c.mounts.some((m) => m.type === 'volume' && m.source === volume))
    .map((c) => c.name);
}

export function networkMembers(w: World, network: string): string[] {
  return Object.values(w.containers)
    .filter((c) => network in c.networks)
    .map((c) => c.name);
}

/** the first host port a container publishes, if any */
export function firstPublished(c: Container): { host: number; container: number } | null {
  const p = c.ports[0];
  return p ? { host: p.host, container: p.container } : null;
}
