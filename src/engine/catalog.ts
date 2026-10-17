import type { Arch, DockerfileStep, Image, Layer, Workload } from './types';
import { hex, sha } from './util';

/**
 * The simulated registry (think Docker Hub). Images share base layers the same
 * way real ones do, so "pulling" teaches content-addressed dedupe.
 */

interface LayerSpec {
  instr: string;
  sizeMB: number;
  changes: string[];
  /** same key => same digest across images (a shared layer) */
  key?: string;
}

const W = (p: Partial<Workload> & Pick<Workload, 'kind'>): Workload => ({
  listens: null,
  baseMemMB: 4,
  leakMBPerTick: 0,
  baseCpuPct: 1,
  dataDir: null,
  imageHasData: false,
  needs: [],
  procs: [],
  ...p,
});

function mkLayer(ref: string, i: number, spec: LayerSpec): Layer {
  return {
    digest: sha(`layer:${spec.key ?? `${ref}#${i}:${spec.instr}`}`),
    sizeMB: spec.sizeMB,
    instr: spec.instr,
    changes: spec.changes,
  };
}

interface ImageSpec {
  ref: string;
  arch?: Arch;
  layers: LayerSpec[];
  cmd: string[];
  entrypoint?: string[];
  env?: string[];
  exposed?: number[];
  workdir?: string;
  user?: string;
  workload: Workload;
}

function mkImage(spec: ImageSpec, local = false): { image: Image; layers: Layer[] } {
  const layers = spec.layers.map((l, i) => mkLayer(spec.ref, i, l));
  const arch = spec.arch ?? 'amd64';
  const id = sha(`image-config:${spec.ref}:${arch}`);
  const image: Image = {
    ref: spec.ref,
    id,
    manifestDigest: sha(`manifest:${spec.ref}:${arch}`),
    arch,
    os: 'linux',
    layers: layers.map((l) => l.digest),
    sizeMB: Math.round(layers.reduce((a, l) => a + l.sizeMB, 0) * 10) / 10,
    config: {
      cmd: spec.cmd,
      entrypoint: spec.entrypoint ?? [],
      env: spec.env ?? ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
      exposed: spec.exposed ?? [],
      workdir: spec.workdir ?? '/',
      user: spec.user ?? 'root',
    },
    history: spec.layers.map((l, i) => ({ instr: l.instr, layer: layers[i]!.digest })),
    workload: spec.workload,
    origin: local ? 'local-build' : 'registry',
    builtLocally: local,
  };
  return { image, layers };
}

const DEBIAN: LayerSpec = {
  instr: 'ADD rootfs.tar.xz / (debian:bookworm-slim)',
  sizeMB: 28.2,
  key: 'debian-bookworm-slim',
  changes: ['/bin', '/etc', '/lib', '/usr', '/var (Debian 12 userland)'],
};
const ALPINE: LayerSpec = {
  instr: 'ADD alpine-minirootfs.tar.gz / (alpine:3.20)',
  sizeMB: 7.8,
  key: 'alpine-3-20',
  changes: ['/bin/busybox', '/etc/apk', '/lib/ld-musl-x86_64.so.1 (Alpine 3.20 userland)'],
};

const SPECS: ImageSpec[] = [
  {
    ref: 'nginx:latest',
    layers: [
      DEBIAN,
      { instr: 'RUN apt-get install -y nginx', sizeMB: 61.4, changes: ['/usr/sbin/nginx', '/etc/nginx/nginx.conf', '/var/log/nginx'] },
      { instr: 'COPY docker-entrypoint.sh /', sizeMB: 0.1, changes: ['/docker-entrypoint.sh', '/docker-entrypoint.d/'] },
      { instr: 'COPY index.html /usr/share/nginx/html/', sizeMB: 0.2, changes: ['/usr/share/nginx/html/index.html'] },
    ],
    cmd: ['nginx', '-g', 'daemon off;'],
    entrypoint: ['/docker-entrypoint.sh'],
    exposed: [80],
    workload: W({
      kind: 'static-web',
      listens: 80,
      baseMemMB: 12,
      baseCpuPct: 1,
      dataDir: '/usr/share/nginx/html',
      imageHasData: true,
      procs: ['nginx: worker process', 'nginx: worker process'],
    }),
  },
  {
    ref: 'redis:7',
    layers: [
      DEBIAN,
      { instr: 'RUN groupadd redis && useradd -r redis', sizeMB: 0.3, changes: ['/etc/passwd', '/etc/group'] },
      { instr: 'RUN install redis-server', sizeMB: 32.6, changes: ['/usr/local/bin/redis-server', '/usr/local/bin/redis-cli'] },
      { instr: 'VOLUME /data', sizeMB: 0, changes: ['/data (declared as a volume)'] },
    ],
    cmd: ['redis-server'],
    entrypoint: ['docker-entrypoint.sh'],
    exposed: [6379],
    workdir: '/data',
    workload: W({ kind: 'cache', listens: 6379, baseMemMB: 9, dataDir: '/data' }),
  },
  {
    ref: 'postgres:16',
    layers: [
      DEBIAN,
      { instr: 'RUN install postgresql-16', sizeMB: 112.7, changes: ['/usr/lib/postgresql/16', '/usr/share/postgresql/16'] },
      { instr: 'COPY docker-entrypoint.sh /usr/local/bin/', sizeMB: 0.1, changes: ['/usr/local/bin/docker-entrypoint.sh'] },
      { instr: 'VOLUME /var/lib/postgresql/data', sizeMB: 0, changes: ['/var/lib/postgresql/data (declared as a volume)'] },
    ],
    cmd: ['postgres'],
    entrypoint: ['docker-entrypoint.sh'],
    env: ['PATH=/usr/lib/postgresql/16/bin:/usr/local/bin:/usr/bin', 'POSTGRES_PASSWORD='],
    exposed: [5432],
    workload: W({
      kind: 'database',
      listens: 5432,
      baseMemMB: 58,
      baseCpuPct: 2,
      dataDir: '/var/lib/postgresql/data',
      procs: ['postgres: checkpointer', 'postgres: walwriter', 'postgres: autovacuum launcher'],
    }),
  },
  {
    ref: 'alpine:3.20',
    layers: [ALPINE],
    cmd: ['/bin/sh'],
    workload: W({ kind: 'idle', baseMemMB: 1, exitsAfterStart: true }),
  },
  {
    ref: 'busybox:latest',
    layers: [{ instr: 'ADD busybox.tar.xz /', sizeMB: 4.3, changes: ['/bin/busybox (and 400 applet links)'] }],
    cmd: ['sh'],
    workload: W({ kind: 'idle', baseMemMB: 1, exitsAfterStart: true }),
  },
  {
    ref: 'hello-world:latest',
    layers: [{ instr: 'COPY hello /', sizeMB: 0.02, changes: ['/hello (a 1 KB static binary)'] }],
    cmd: ['/hello'],
    workload: W({ kind: 'job', baseMemMB: 1, exitsAfterStart: true }),
  },
  {
    ref: 'node:20-alpine',
    layers: [
      ALPINE,
      { instr: 'RUN addgroup -g 1000 node && adduser -u 1000 node', sizeMB: 0.1, changes: ['/etc/passwd', '/home/node'] },
      { instr: 'RUN apk add nodejs=20', sizeMB: 128.4, changes: ['/usr/local/bin/node', '/usr/local/lib/node_modules/npm'] },
      { instr: 'COPY docker-entrypoint.sh /usr/local/bin/', sizeMB: 0.1, changes: ['/usr/local/bin/docker-entrypoint.sh'] },
    ],
    cmd: ['node'],
    entrypoint: ['docker-entrypoint.sh'],
    workload: W({ kind: 'idle', baseMemMB: 30, exitsAfterStart: true }),
  },
  {
    ref: 'python:3.12-slim',
    layers: [
      DEBIAN,
      { instr: 'RUN install python3.12', sizeMB: 38.5, changes: ['/usr/local/bin/python3', '/usr/local/lib/python3.12'] },
    ],
    cmd: ['python3'],
    workload: W({ kind: 'idle', baseMemMB: 12, exitsAfterStart: true }),
  },
  {
    ref: 'leaky:latest',
    layers: [
      ALPINE,
      { instr: 'COPY leaky /usr/local/bin/', sizeMB: 6.2, changes: ['/usr/local/bin/leaky (a demo server that never frees memory)'] },
    ],
    cmd: ['/usr/local/bin/leaky'],
    exposed: [8080],
    workload: W({ kind: 'api', listens: 8080, baseMemMB: 40, leakMBPerTick: 14, baseCpuPct: 4 }),
  },
  {
    ref: 'arm-demo:latest',
    arch: 'arm64',
    layers: [
      { instr: 'ADD rootfs.tar.gz / (alpine arm64)', sizeMB: 7.6, key: 'alpine-3-20-arm64', changes: ['/bin/busybox (aarch64 ELF)'] },
      { instr: 'COPY demo /usr/local/bin/', sizeMB: 9.1, changes: ['/usr/local/bin/demo (aarch64 ELF)'] },
    ],
    cmd: ['/usr/local/bin/demo'],
    exposed: [8000],
    workload: W({ kind: 'static-web', listens: 8000, baseMemMB: 10 }),
  },
];

export interface Catalog {
  images: Record<string, Image>;
  layers: Record<string, Layer>;
}

let cache: Catalog | null = null;

/** Everything the registry can serve. */
export function registryCatalog(): Catalog {
  if (cache) return cache;
  const images: Record<string, Image> = {};
  const layers: Record<string, Layer> = {};
  for (const spec of SPECS) {
    const { image, layers: ls } = mkImage(spec);
    images[image.ref] = image;
    for (const l of ls) layers[l.digest] = l;
  }
  cache = { images, layers };
  return cache;
}

/** A build recipe we can edit and rebuild: the learner's "my-api". */
export function sampleDockerfile(): DockerfileStep[] {
  return [
    { instr: 'FROM', arg: 'node:20-alpine', inputVersion: 0, sizeMB: 0 },
    { instr: 'WORKDIR', arg: '/app', inputVersion: 0, sizeMB: 0.01 },
    { instr: 'COPY', arg: 'package*.json ./', inputVersion: 0, sizeMB: 0.3 },
    { instr: 'RUN', arg: 'npm ci --omit=dev', inputVersion: 0, sizeMB: 47.9 },
    { instr: 'COPY', arg: '. .', inputVersion: 0, sizeMB: 2.1 },
    { instr: 'EXPOSE', arg: '3000', inputVersion: 0, sizeMB: 0 },
    { instr: 'CMD', arg: '["node","server.js"]', inputVersion: 0, sizeMB: 0 },
  ];
}

export const METADATA_ONLY = new Set(['ENV', 'EXPOSE', 'CMD', 'USER']);

export function apiWorkload(): Workload {
  return W({
    kind: 'api',
    listens: 3000,
    baseMemMB: 88,
    baseCpuPct: 3,
    needs: ['db'],
    procs: ['node: worker'],
  });
}

export const BUILD_CONTEXT_FILES: Record<string, string[]> = {
  'package*.json ./': ['package.json', 'package-lock.json'],
  '. .': ['server.js', 'routes/', 'lib/'],
};

export function layerFor(instr: string, key: string, sizeMB: number, changes: string[]): Layer {
  return { digest: 'sha256:' + hex(`build-layer:${key}`), sizeMB, instr, changes };
}
