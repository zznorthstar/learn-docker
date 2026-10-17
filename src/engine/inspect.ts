import type { Container, Image, Level, Target, World, WorldEvent } from './types';
import { conceptsForTarget } from './conceptgraph';
import { CONCEPTS } from './concepts';
import { hostNet, kernelView, ociConfig, ociImage, processTree, type ProcNode, vethName } from './derive';
import { findByName, serve } from './probe';
import { diskFreeMB, diskUsedMB, hostCpuPct, hostMemUsedMB, networkMembers, volumeUsers } from './world';
import { fmtMB, own, parseTarget, plural, short } from './util';
import { registryCatalog } from './catalog';

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'info';

export interface Rel {
  target: Target;
  label: string;
}

export interface Relations {
  dependsOn: Rel[];
  dependedBy: Rel[];
  madeOf: Rel[];
  usedBy: Rel[];
}

export interface Section {
  title: string;
  rows?: [string, string][];
  lines?: string[];
  code?: string;
  note?: string;
  tone?: Tone;
}

export interface Inspection {
  target: Target;
  kind: string;
  title: string;
  subtitle: string;
  level: Level;
  status: { label: string; tone: Tone };
  /** one friendly sentence in the story metaphor (level 0) */
  story: string;
  sections: Section[];
  relations: Relations;
  concepts: string[];
  /** the beginner metaphor's honest correction, shown when going deeper */
  correction?: string;
}

/* ----------------------------------------------------------------- relations */

export function relations(w: World, target: Target): Relations {
  const r: Relations = { dependsOn: [], dependedBy: [], madeOf: [], usedBy: [] };
  const { kind, name } = parseTarget(target);
  if (kind === 'container') {
    const c = w.containers[name];
    if (!c) return r;
    r.dependsOn.push({ target: `image:${imageRefOf(w, c)}`, label: 'is started from' }, { target: 'host', label: 'runs on' }, { target: 'daemon:containerd', label: 'is managed by' });
    for (const n of Object.keys(c.networks)) r.dependsOn.push({ target: `network:${n}`, label: `attached to (${c.networks[n]!.ip || 'host stack'})` });
    for (const m of c.mounts) if (m.type === 'volume') r.dependsOn.push({ target: `volume:${m.source}`, label: `mounts at ${m.target}` });
    for (const need of c.workload.needs) {
      const t = findByName(w, need);
      r.dependsOn.push({ target: t ? `container:${t.name}` : `container:${need}`, label: `needs "${need}" by name` });
    }
    for (const o of Object.values(w.containers)) {
      if (o.name === c.name) continue;
      if (o.workload.needs.some((n) => findByName(w, n)?.name === c.name)) r.dependedBy.push({ target: `container:${o.name}`, label: 'calls it by name' });
    }
    r.madeOf.push({ target: `process:${c.process}`, label: 'PID 1' });
    for (const p of c.childProcs) r.madeOf.push({ target: `process:${p.name}`, label: `PID ${p.nsPid}` });
    for (const p of c.ports) r.usedBy.push({ target: 'host', label: `reachable on host :${p.host}` });
  } else if (kind === 'image') {
    const img = w.images[name];
    if (!img) return r;
    for (const d of img.layers) r.madeOf.push({ target: `layer:${d}`, label: w.layers[d]?.instr ?? 'layer' });
    r.dependsOn.push(...img.layers.slice(0, 1).map((d) => ({ target: `layer:${d}`, label: 'base layer' })));
    if (img.origin === 'registry') r.dependsOn.push({ target: 'registry:hub', label: 'pulled from' });
    for (const c of Object.values(w.containers)) if (c.imageId === img.id) r.dependedBy.push({ target: `container:${c.name}`, label: 'runs from it' });
    r.usedBy = [...r.dependedBy];
  } else if (kind === 'volume') {
    r.dependsOn.push({ target: 'host', label: 'stored on the host disk' });
    for (const u of volumeUsers(w, name)) r.dependedBy.push({ target: `container:${u}`, label: 'mounts it' });
    r.usedBy = [...r.dependedBy];
  } else if (kind === 'network') {
    r.dependsOn.push({ target: 'host', label: 'bridge lives in the host kernel' });
    for (const m of networkMembers(w, name)) r.dependedBy.push({ target: `container:${m}`, label: 'is attached' });
    r.usedBy = [...r.dependedBy];
  } else if (kind === 'host') {
    r.madeOf.push({ target: 'daemon:dockerd', label: 'Docker Engine' }, { target: 'daemon:containerd', label: 'container runtime' });
    for (const c of Object.values(w.containers)) r.dependedBy.push({ target: `container:${c.name}`, label: 'runs on it' });
    r.usedBy = [...r.dependedBy];
  } else if (kind === 'daemon') {
    if (name === 'dockerd') {
      r.dependsOn.push({ target: 'daemon:containerd', label: 'delegates containers to' }, { target: 'daemon:buildkit', label: 'delegates builds to' }, { target: 'host', label: 'runs on' });
      for (const x of Object.keys(w.networks)) r.dependedBy.push({ target: `network:${x}`, label: 'created and wired by it' });
    } else if (name === 'containerd') {
      r.dependsOn.push({ target: 'host', label: 'runs on' });
      r.dependedBy.push({ target: 'daemon:dockerd', label: 'is its client' });
      for (const c of Object.values(w.containers)) if (c.state === 'running') r.dependedBy.push({ target: `container:${c.name}`, label: 'holds it (via shim)' });
    }
    r.usedBy = [...r.dependedBy];
  } else if (kind === 'registry') {
    for (const img of Object.values(w.images)) if (img.origin === 'registry') r.dependedBy.push({ target: `image:${img.ref}`, label: 'was pulled from here' });
    r.dependsOn.push({ target: 'host', label: 'reached over the host network (DNS + TCP)' });
  }
  return r;
}

function imageRefOf(w: World, c: Container): string {
  const byId = Object.values(w.images).find((i) => i.id === c.imageId);
  return byId?.ref ?? c.imageRef;
}

/* ------------------------------------------------------------ "why?" answers */

export interface Why {
  headline: string;
  chain: WorldEvent[];
}

/** Why is this object in its current state? Walk the causal chain of its latest event. */
export function whyObject(w: World, target: Target, events: WorldEvent[]): Why {
  const byId = new Map(events.map((e) => [e.id, e]));
  const mine = events.filter((e) => e.target === target);
  const latest = mine[mine.length - 1];
  if (!latest) return { headline: 'Nothing has happened to this object yet.', chain: [] };
  // prefer the most recent warn/error, otherwise the most recent state-changing event
  const notable = [...mine].reverse().find((e) => e.severity !== 'info') ?? latest;
  const chain: WorldEvent[] = [];
  for (let e: WorldEvent | undefined = notable; e; e = e.causedBy !== null ? byId.get(e.causedBy) : undefined) chain.unshift(e);
  const root = chain[0]!;
  return { headline: chain.length > 1 ? `${notable.summary} — because: ${root.summary}` : notable.summary, chain };
}

/* ---------------------------------------------------------------- inspector */

const stateTone = (c: Container, h: string): Tone => (c.state === 'running' ? (h === 'unhealthy' ? 'warn' : 'ok') : c.state === 'paused' ? 'warn' : c.exitCode && c.exitCode !== 0 ? 'bad' : 'idle');

export function inspectTarget(w: World, target: Target, level: Level): Inspection | null {
  const { kind, name } = parseTarget(target);
  switch (kind) {
    case 'container':
      return own(w.containers, name) ? inspectContainer(w, w.containers[name]!, level) : null;
    case 'image':
      return own(w.images, name) ? inspectImage(w, w.images[name]!, level) : null;
    case 'volume':
      return own(w.volumes, name) ? inspectVolume(w, name, level) : null;
    case 'network':
      return own(w.networks, name) ? inspectNetwork(w, name, level) : null;
    case 'host':
      return inspectHost(w, level);
    case 'daemon':
      return inspectDaemon(w, name, level);
    case 'registry':
      return inspectRegistry(w, level);
    case 'build':
      return inspectBuild(w, level);
    default:
      return null;
  }
}

function base(w: World, target: Target, level: Level, p: Pick<Inspection, 'kind' | 'title' | 'subtitle' | 'status' | 'story' | 'sections'> & { correction?: string }): Inspection {
  return { target, level, relations: relations(w, target), concepts: conceptsForTarget(target), ...p };
}

const fmtLimit = (c: Container): string =>
  [c.limits.memoryMB !== null ? `memory ${c.limits.memoryMB} MB` : 'memory unlimited', c.limits.cpus ? `cpu ${c.limits.cpus} cores` : 'cpu unlimited', c.limits.pids ? `pids ${c.limits.pids}` : null].filter(Boolean).join(' · ');

function treeLines(n: ProcNode, depth = 0, only?: string): string[] {
  const out: string[] = [];
  const include = !only || n.container === only || depth === 0 || n.children.some((c) => hasContainer(c, only));
  if (!include) return out;
  const pid = n.nsPid !== undefined ? `${n.hostPid} (PID ${n.nsPid} inside)` : String(n.hostPid);
  out.push(`${'  '.repeat(depth)}${depth ? '└ ' : ''}${n.name}  [${pid}]${n.note ? '  — ' + n.note : ''}`);
  for (const c of n.children) out.push(...treeLines(c, depth + 1, only));
  return out;
}
function hasContainer(n: ProcNode, name: string): boolean {
  return n.container === name || n.children.some((c) => hasContainer(c, name));
}

function inspectContainer(w: World, c: Container, level: Level): Inspection {
  const t = `container:${c.name}`;
  const health = c.health;
  const live = c.state === 'running' || c.state === 'paused';
  const statusLabel = c.state === 'running' ? (health === 'unhealthy' ? 'running · unhealthy' : 'running') : c.state === 'exited' ? `exited (${c.exitCode})${c.oomKilled ? ' · OOM killed' : ''}` : c.state;
  const serveInfo = live ? serve(w, c) : null;
  const img = Object.values(w.images).find((i) => i.id === c.imageId);
  const kv = kernelView(w, c, img);
  const sections: Section[] = [];
  const story =
    c.state === 'running'
      ? `A shipping container on the deck, humming. ${c.ports.length ? `A gangplank leads to gate ${c.ports[0]!.host}. ` : ''}${c.mounts.some((m) => m.type === 'volume') ? 'Strapped cargo is lashed to it. ' : ''}${health === 'unhealthy' ? 'Its warning lamp is lit.' : ''}`
      : c.state === 'paused'
        ? 'A container frozen mid-motion: the crew is still, nothing inside moves.'
        : c.state === 'created'
          ? 'A container bolted down but never opened: it exists, nothing inside is running.'
          : c.oomKilled
            ? 'The box is scorched: lightning struck it when memory ran out.'
            : c.exitCode === 0
              ? 'An empty box: its work finished and the lights went out.'
              : 'A cracked box: its process died with an error.';

  if (level === 0) {
    sections.push({
      title: 'On the deck',
      rows: [
        ['Cargo box', c.name],
        ['Blueprint it was stamped from', imageRefOf(w, c)],
        ['Gangplanks (published ports)', c.ports.length ? c.ports.map((p) => `:${p.host} → :${p.container}`).join(', ') : 'none'],
        ['Strapped cargo (volumes)', c.mounts.filter((m) => m.type === 'volume').map((m) => `${m.source}`).join(', ') || 'none'],
        ['Signal lines (networks)', Object.keys(c.networks).join(', ') || 'none'],
      ],
    });
    sections.push({ title: 'Careful', note: 'The box is only a metaphor. Go one level deeper to see what is really running.', tone: 'info' });
  }
  if (level >= 1) {
    sections.push({
      title: 'Container',
      rows: [
        ['Name', c.name],
        ['ID', c.id.slice(0, 12) + '…'],
        ['Image', imageRefOf(w, c) + (img ? `  (${short(img.id)})` : '')],
        ['State', statusLabel],
        ['Health', health === 'none' ? 'no healthcheck status' : health + (serveInfo && serveInfo.status >= 400 ? ` — ${serveInfo.reason}` : '')],
        ['Reachable from outside', c.ports.length ? (c.service === 'up' ? 'yes' : 'NO') : 'nothing published'],
        ['Command', c.cmd.join(' ') || '—'],
        ['Restart policy', `${c.restartPolicy}${c.restartCount ? ` (restarted ${c.restartCount}×)` : ''}`],
        ['Published ports', c.ports.map((p) => `${p.host}:${p.container}/${p.proto}`).join(', ') || 'none'],
        ['Mounts', c.mounts.map((m) => `${m.type} ${m.source || 'tmpfs'} → ${m.target}${m.readOnly ? ' (ro)' : ''}`).join('; ') || 'none (only the writable layer)'],
        ['Networks', Object.entries(c.networks).map(([n, a]) => `${n}${a.ip ? ' ' + a.ip : ''}`).join(', ') || 'none'],
        ['Limits', fmtLimit(c)],
        ['Usage', live ? `${Math.round(c.usage.memMB)} MB RAM · ${Math.round(c.usage.cpuPct)}% CPU` : 'not running'],
        ['Writable layer', c.layerData.items ? `${plural(c.layerData.items, 'record')} (lost on remove)` : 'empty'],
      ],
    });
    if (c.error) sections.push({ title: 'Last error', lines: [c.error], tone: 'bad' });
  }
  if (level >= 2) {
    sections.push({
      title: 'How the Engine got it running',
      lines: [
        `docker CLI → POST /containers/create + /start → dockerd (pid ${w.daemons.dockerd.pid})`,
        `dockerd → gRPC → containerd (pid ${w.daemons.containerd.pid}): creates a task from an OCI bundle`,
        live ? `containerd → starts containerd-shim-runc-v2 (pid ${c.pid - 3}), the container's parent` : 'containerd → (no shim: the container is not running)',
        'shim → runc create/start: sets up namespaces, cgroup, rootfs, then exec()s the entrypoint and runc EXITS',
        `bundle: /run/containerd/io.containerd.runtime.v2.task/moby/${c.id.slice(0, 12)}…/ (config.json + rootfs)`,
        `logs: stdout/stderr of PID 1 → shim → dockerd → json-file driver  (docker logs ${c.name})`,
      ],
      note: 'dockerd is only the coordinator. If containerd or dockerd restarts, the shim keeps the process alive.',
    });
  }
  if (level >= 3) {
    sections.push({
      title: 'The box dissolves: this is a process tree',
      lines: live ? treeLines(processTree(w), 0, c.name) : ['(no process: the container is not running)'],
      note: 'The same process has two PIDs: 1 inside the container, a large PID on the host. `ps` on the host shows it like any other program.',
      tone: 'info',
    });
  }
  if (level >= 4) {
    sections.push({
      title: 'Isolation: namespaces (what it can SEE)',
      rows: kv.namespaces.map((n) => [n.type, `${n.inode}${n.shared ? ' (shared with host)' : ''} — ${n.note}`] as [string, string]),
    });
    sections.push({ title: `Resources: cgroup ${kv.cgroup.path.replace('/sys/fs/cgroup', '')}`, rows: kv.cgroup.files, note: 'These files are the limits and the meters. `docker stats` just reads them.' });
    sections.push({
      title: 'Filesystem: overlayfs',
      lines: [`merged = lowerdir (${kv.rootfs.lowerdirs.length} read-only image layers) + upperdir (this container only)`, `upperdir  ${kv.rootfs.upperdir}`, ...kv.rootfs.lowerdirs.slice(0, 4).map((d) => `lowerdir  ${d}`), kv.rootfs.lowerdirs.length > 4 ? `… ${kv.rootfs.lowerdirs.length - 4} more lower layers` : ''].filter(Boolean),
    });
    sections.push({ title: 'Mount table inside the mount namespace', lines: kv.mounts.map((m) => `${m.source}  →  ${m.target}  (${m.type}, ${m.options})`) });
    sections.push({
      title: 'Network namespace',
      lines: [...kv.net.interfaces.map((i) => `${i.name} ${i.ip}${i.peer ? `  ⇄ ${i.peer} on ${i.bridge}` : ''}`), ...kv.net.routes, ...kv.net.resolv, ...kv.iptables.map((r) => 'iptables ' + r)],
    });
    sections.push({
      title: 'Security: what it may DO',
      rows: [
        ['capabilities', `${kv.security.capabilities.length} of 41: ${kv.security.capabilities.join(', ')}`],
        ['seccomp', kv.security.seccomp],
        ['apparmor', kv.security.apparmor],
        ['user', kv.security.user],
      ],
    });
  }
  if (level >= 5) {
    sections.push({ title: 'OCI runtime-spec config.json (what runc reads)', code: JSON.stringify(ociConfig(w, c), null, 2), note: 'Any OCI runtime (runc, crun, gVisor, Kata) can consume this same document.' });
  }
  if (level >= 6) {
    sections.push({
      title: 'In the wider ecosystem',
      lines: [
        'Kubernetes: this container would live in a Pod; the kubelet asks containerd over CRI to create it — the same runc underneath.',
        `ports (${c.ports.map((p) => p.host).join(', ') || 'none'}) → a Service / Ingress; restart policy "${c.restartPolicy}" → Deployment controller; limits → resources.limits (${fmtLimit(c)}).`,
        c.mounts.some((m) => m.type === 'volume') ? 'volumes → PersistentVolumeClaims backed by a network disk.' : 'no volumes → a stateless Pod you can replace freely.',
        'networks → CNI plugin; healthcheck → readiness/liveness probes (which DO trigger restarts, unlike plain Docker).',
        'Managed platforms (Fargate, Cloud Run) run the same image inside a microVM boundary.',
      ],
    });
  }
  return base(w, t, level, {
    kind: 'container',
    title: c.name,
    subtitle: `container · ${imageRefOf(w, c)}`,
    status: { label: statusLabel, tone: stateTone(c, health) },
    story,
    sections,
    correction: 'Not a little VM: it has no kernel of its own. It is a process on the host with restricted visibility (namespaces) and resources (cgroups).',
  });
}

function inspectImage(w: World, img: Image, level: Level): Inspection {
  const t = `image:${img.ref}`;
  const users = Object.values(w.containers).filter((c) => c.imageId === img.id);
  const sections: Section[] = [];
  if (level === 0) {
    sections.push({
      title: 'In the harbor',
      rows: [
        ['Blueprint', img.ref],
        ['Plates in the stack', String(img.layers.length)],
        ['Stamped into containers', users.map((u) => u.name).join(', ') || 'none right now'],
      ],
    });
    sections.push({ title: 'Careful', note: 'A blueprint is only a plan, never a running thing. Go deeper to see what it is made of.', tone: 'info' });
  }
  if (level >= 1) {
    sections.push({
      title: 'Image',
      rows: [
        ['Reference', img.ref],
        ['ID (config digest)', short(img.id, 19)],
        ['Size', fmtMB(img.sizeMB)],
        ['Platform', `${img.os}/${img.arch}${img.arch !== w.host.arch ? '  ⚠ does not match this host (' + w.host.arch + ')' : ''}`],
        ['Default command', [...img.config.entrypoint, ...img.config.cmd].join(' ') || '—'],
        ['Exposed ports (documentation only)', img.config.exposed.join(', ') || 'none'],
        ['Used by', users.map((u) => u.name).join(', ') || 'no container'],
      ],
    });
  }
  if (level >= 2) {
    sections.push({
      title: 'The blueprint separates: Dockerfile steps → layers',
      lines: img.history.map((h, i) => `${i + 1}. ${h.instr}${h.layer ? `  →  layer ${short(h.layer)} (${fmtMB(w.layers[h.layer]?.sizeMB ?? 0)})` : '  (metadata only)'}`),
      note: 'Each filesystem-changing instruction produced one layer. BuildKit cached the ones whose inputs did not change.',
    });
  }
  if (level >= 3) {
    sections.push({ title: 'Not a process', lines: ['An image runs nothing. It is files on disk under /var/lib/docker/overlay2 (and blobs in containerd\'s content store).', 'A container is what you get when a process is started on top of it.'], tone: 'info' });
  }
  if (level >= 4) {
    sections.push({
      title: 'Layers = filesystem changesets (stacked by overlayfs)',
      lines: img.layers
        .map((d, i) => {
          const l = w.layers[d];
          const shared = Object.values(w.images).filter((x) => x.layers.includes(d)).length;
          return `#${i + 1} ${short(d)}  ${fmtMB(l?.sizeMB ?? 0)}  ${l?.instr ?? ''}${shared > 1 ? `   ⤷ shared by ${shared} images` : ''}\n     changes: ${(l?.changes ?? []).join(', ')}`;
        })
        .reverse(),
      note: 'Top of the list is the top layer. A container adds one more, writable, layer above all of these.',
    });
  }
  if (level >= 5) {
    const o = ociImage(w, img);
    sections.push({ title: 'OCI manifest (the table of contents; its sha256 is the image digest)', code: JSON.stringify(o.manifest, null, 2) });
    sections.push({ title: 'OCI image config', code: JSON.stringify(o.config, null, 2), note: `manifest digest ${img.manifestDigest}` });
  }
  if (level >= 6) {
    sections.push({
      title: 'In the wider ecosystem',
      lines: [
        'Registries: pushed/pulled with the OCI Distribution API (Docker Hub, GHCR, ECR, Harbor).',
        'Supply chain: scanned for CVEs, an SBOM listed, signed with cosign; deployments should pin the digest, not the tag.',
        `Multi-arch: ${img.ref.split(':')[0]} is usually published as an image index with a manifest per platform.`,
        'CI/CD: build once, test that exact digest, deploy the same digest everywhere.',
      ],
    });
  }
  return base(w, t, level, {
    kind: 'image',
    title: img.ref,
    subtitle: `image · ${fmtMB(img.sizeMB)} · ${img.layers.length} layers`,
    status: { label: img.arch === w.host.arch ? 'local' : `local · wrong arch (${img.arch})`, tone: img.arch === w.host.arch ? 'ok' : 'warn' },
    story: 'A blueprint kept in the harbor warehouse. You can stamp out as many identical cargo boxes from it as you like, and it never changes.',
    sections,
    correction: 'Not a template file you edit: an image is immutable and content-addressed. Change anything and you get a different image with a different digest.',
  });
}

function inspectVolume(w: World, name: string, level: Level): Inspection {
  const v = w.volumes[name]!;
  const users = volumeUsers(w, name);
  const sections: Section[] = [];
  if (level === 0) sections.push({ title: 'Strapped cargo', rows: [['Barrel', name], ['Lashed to', users.join(', ') || 'nothing (it floats free in the hold)'], ['Inside', plural(v.items, 'record')]] });
  if (level >= 1)
    sections.push({
      title: 'Volume',
      rows: [
        ['Name', name],
        ['Driver', v.driver],
        ['Records', String(v.items)],
        ['Size', fmtMB(v.sizeMB)],
        ['Mounted by', users.map((u) => `${u} (${w.containers[u]!.state})`).join(', ') || 'no container — still exists, still holds data'],
      ],
    });
  if (level >= 2) sections.push({ title: 'Engine', lines: ['dockerd owns volume objects and records which containers reference them.', 'The built-in "local" driver just creates a directory; plugins can back volumes with NFS, cloud disks, etc.', 'Removing a volume that any container references (even a stopped one) is refused.'] });
  if (level >= 3) sections.push({ title: 'On the host', lines: [`directory: ${v.mountpoint}`, 'The container sees this same directory at its mount target. There is no copy.'], tone: 'info' });
  if (level >= 4) sections.push({ title: 'Kernel', lines: ['A bind mount in the container\'s mount namespace: mount --bind /var/lib/docker/volumes/<name>/_data <rootfs>/<target>', 'Bind mounts bypass the overlayfs, so writes go straight to the host filesystem, outside the container\'s writable layer.'] });
  if (level >= 5)
    sections.push({
      title: 'OCI runtime-spec mount entry',
      code: JSON.stringify({ destination: users[0] ? (w.containers[users[0]]!.mounts.find((m) => m.source === name)?.target ?? '/data') : '/data', type: 'bind', source: v.mountpoint, options: ['rbind', 'rw'] }, null, 2),
    });
  if (level >= 6) sections.push({ title: 'In the wider ecosystem', lines: ['Kubernetes: PersistentVolume + PersistentVolumeClaim, usually a network-attached disk (EBS, Persistent Disk, Ceph).', 'Cloud container platforms mount managed file storage (EFS, Filestore) the same way.'] });
  return base(w, `volume:${name}`, level, {
    kind: 'volume',
    title: name,
    subtitle: `volume · ${plural(v.items, 'record')}`,
    status: { label: users.length ? `in use by ${users.length}` : 'unattached', tone: users.length ? 'ok' : 'idle' },
    story: 'A barrel lashed to the whale. Cut the container loose and the barrel stays aboard.',
    sections,
    correction: 'Not part of any container: a volume is a directory on the host that Docker lets containers mount.',
  });
}

function inspectNetwork(w: World, name: string, level: Level): Inspection {
  const n = w.networks[name]!;
  const members = networkMembers(w, name);
  const hn = hostNet(w).bridges.find((b) => b.network === name);
  const sections: Section[] = [];
  if (level === 0) sections.push({ title: 'Signal line', rows: [['Line', name], ['Boxes on this line', members.join(', ') || 'none']], note: n.dns ? 'Boxes on this line can call each other by name.' : 'The default line: boxes can only call each other by IP address.' });
  if (level >= 1)
    sections.push({
      title: 'Network',
      rows: [
        ['Name', name],
        ['Driver', n.driver],
        ['Subnet', n.subnet || '—'],
        ['Gateway', n.gateway || '—'],
        ['Name resolution', n.dns ? 'yes: embedded DNS (127.0.0.11)' : 'no (default bridge: use IPs)'],
        ['Members', members.map((m) => `${m} ${w.containers[m]!.networks[name]?.ip ?? ''}`).join(', ') || 'none'],
      ],
    });
  if (level >= 2) sections.push({ title: 'Engine', lines: ['dockerd\'s libnetwork creates the bridge, allocates IPs from the subnet (IPAM), programs iptables and runs the embedded DNS.', n.builtin ? 'Built-in network: created when Docker starts.' : 'User-defined bridge: created on demand and isolated from other bridges.'] });
  if (level >= 3 && hn) sections.push({ title: 'On the host', lines: [`bridge ${hn.name}  ${hn.gateway}/16`, ...hn.ports.map((p) => `  ⇄ ${p.veth}  ↔ ${p.container} (${p.ip})`)] });
  if (level >= 4 && hn)
    sections.push({
      title: 'Kernel: bridge + veth + netfilter',
      lines: [`ip link add ${hn.name} type bridge   # an in-kernel Layer-2 switch`, ...hn.ports.map((p) => `ip link add ${p.veth} type veth peer name eth0 netns <${p.container}>   # one end inside the container, one on the bridge`), `iptables -t nat -A POSTROUTING -s ${n.subnet} ! -o ${hn.name} -j MASQUERADE   # outbound NAT`, 'iptables -t filter DOCKER-ISOLATION chains drop traffic between different bridges'],
    });
  if (level >= 5) sections.push({ title: 'OCI', lines: ['The runtime spec only requires a network namespace (linux.namespaces: net). Plugging it in is NOT in the spec: Docker\'s libnetwork or a CNI plugin does it via hooks/prestart steps.'] });
  if (level >= 6) sections.push({ title: 'In the wider ecosystem', lines: ['Kubernetes uses CNI plugins (Calico, Cilium, Flannel) so every Pod gets a routable IP; kube-proxy / eBPF implements Services.', 'Docker Swarm uses overlay networks (VXLAN) to span hosts.'] });
  return base(w, `network:${name}`, level, {
    kind: 'network',
    title: name,
    subtitle: `network · ${n.driver}${n.subnet ? ' · ' + n.subnet : ''}`,
    status: { label: members.length ? `${members.length} attached` : 'empty', tone: members.length ? 'ok' : 'idle' },
    story: 'A coloured signal line strung between cargo boxes. Only boxes on the same line can hear each other.',
    sections,
    correction: 'Not a cable run: it is a Linux bridge (a virtual switch) plus veth pairs, NAT rules and a DNS server, all inside one kernel.',
  });
}

function inspectHost(w: World, level: Level): Inspection {
  const h = w.host;
  const sections: Section[] = [];
  const memUsed = hostMemUsedMB(w);
  if (level === 0) sections.push({ title: 'The whale', rows: [['Brain (CPU)', `${Math.round(hostCpuPct(w))}% busy · ${h.cpuCores} cores`], ['Body (RAM)', `${Math.round(memUsed)} of ${h.ramMB} MB`], ['Hold (disk)', `${fmtMB(diskUsedMB(w))} of ${fmtMB(h.diskMB)}`], ['Cargo aboard', `${Object.keys(w.containers).length} containers`]] });
  if (level >= 1)
    sections.push({
      title: 'Host',
      rows: [
        ['Name', `${h.name}  (${h.os})`],
        ['State', h.online ? `online · boot #${h.bootCount}` : 'POWERED OFF'],
        ['CPU', `${h.cpuCores} cores · ${Math.round(hostCpuPct(w))}% busy`],
        ['Memory', `${Math.round(memUsed)} / ${h.ramMB} MB`],
        ['Disk', `${fmtMB(diskUsedMB(w))} used · ${fmtMB(Math.max(0, diskFreeMB(w)))} free`],
        ['Network', `latency ${h.net.latencyMs} ms · loss ${h.net.packetLossPct}% · ${h.net.bandwidthMbps} Mbps · DNS ${h.net.dnsUp ? 'up' : 'DOWN'} · registry ${h.net.registryReachable ? 'reachable' : 'UNREACHABLE'}`],
      ],
    });
  if (level >= 2)
    sections.push({
      title: 'Docker Engine on this host',
      rows: [
        ['dockerd', `${w.daemons.dockerd.running ? 'running' : 'STOPPED'} · pid ${w.daemons.dockerd.pid} · v${w.daemons.dockerd.version}`],
        ['containerd', `${w.daemons.containerd.running ? 'running' : 'STOPPED'} · pid ${w.daemons.containerd.pid} · v${w.daemons.containerd.version}`],
        ['buildkit', `running · v${w.daemons.buildkit.version}`],
        ['runc', `v${w.daemons.runc.version} (a short-lived tool, not a daemon)`],
      ],
    });
  if (level >= 3) sections.push({ title: 'Everything is a process', lines: treeLines(processTree(w)), note: 'There is no hidden VM layer: containers are ordinary processes under this tree.', tone: 'info' });
  if (level >= 4) sections.push({ title: 'One kernel for all', lines: [`Linux ${h.kernel}`, `${Object.values(w.containers).filter((c) => c.state === 'running').length} containers × (pid, net, mnt, uts, ipc, cgroup namespaces) all inside THIS kernel`, 'uname -r inside any container prints the host kernel version.', ...hostNet(w).nat.slice(0, 6)] });
  if (level >= 5) sections.push({ title: 'OCI', lines: ['The OCI runtime spec defines what a runtime must do on a Linux host: create namespaces, apply cgroups, mount the rootfs, drop capabilities, run the process.'] });
  if (level >= 6) sections.push({ title: 'In the wider ecosystem', lines: ['In Kubernetes this is a Node; the kubelet + containerd replace dockerd.', 'In the cloud it is typically a VM (EC2, GCE) — or a Firecracker microVM under Fargate/Cloud Run.'] });
  return base(w, 'host', level, {
    kind: 'host',
    title: h.name,
    subtitle: `host · ${h.os}`,
    status: { label: h.online ? 'online' : 'powered off', tone: h.online ? 'ok' : 'bad' },
    story: 'The giant flying whale: brain for CPU, a body full of RAM and storage, and a nervous system (the kernel) that every cargo box answers to.',
    sections,
    correction: 'The whale is not "Docker". It is the whole machine and its Linux kernel; Docker is software running on it.',
  });
}

function inspectDaemon(w: World, name: string, level: Level): Inspection {
  const who: Record<string, { title: string; role: string; story: string; concept: string }> = {
    dockerd: { title: 'dockerd', role: 'Docker daemon', story: 'Santa at the controls: takes orders over the radio, plans, delegates to the foreman, keeps the books.', concept: 'dockerd' },
    containerd: { title: 'containerd', role: 'container runtime daemon', story: 'The senior reindeer foreman: takes Santa\'s orders and sends the runner reindeer to do the work.', concept: 'containerd' },
    buildkit: { title: 'BuildKit', role: 'build engine', story: 'The shipyard foreman: turns construction notes into finished plates, reusing ones already made.', concept: 'buildkit' },
    runc: { title: 'runc', role: 'low-level OCI runtime', story: 'The worker reindeer who bolts a container to the deck and then walks away.', concept: 'runc' },
  };
  const d = who[name] ?? who.dockerd!;
  const dm = name === 'runc' ? undefined : (w.daemons as unknown as Record<string, { running: boolean; pid: number; version: string }>)[name];
  const sections: Section[] = [];
  const c = CONCEPTS[d.concept]!;
  if (level === 0) sections.push({ title: 'Crew', note: d.story });
  if (level >= 1) sections.push({ title: d.title, rows: [['Role', d.role], ['State', dm ? (dm.running ? 'running' : 'STOPPED') : 'on demand'], ['Version', dm?.version ?? w.daemons.runc.version], ['PID', dm ? String(dm.pid) : 'exits after starting each container']] });
  if (level >= 2) sections.push({ title: 'What it does', lines: [c.lv.e ?? c.summary], note: c.summary });
  if (level >= 3) sections.push({ title: 'As a process', lines: treeLines(processTree(w)).filter((l) => l.includes(d.title) || /containerd-shim|systemd/.test(l)) });
  if (level >= 4 && c.kernel.length) sections.push({ title: 'Kernel primitives it relies on', lines: c.kernel });
  if (level >= 5) sections.push({ title: 'Standards', lines: [name === 'runc' ? 'Implements the OCI Runtime Spec (create/start/kill/delete + config.json).' : name === 'containerd' ? 'Generates the OCI bundle and drives any OCI runtime; pulls OCI images from OCI registries.' : name === 'buildkit' ? 'Emits OCI images and image indexes.' : 'Speaks the Docker Engine API; delegates runtime work to OCI-compliant components.'] });
  if (level >= 6) sections.push({ title: 'In the wider ecosystem', lines: [c.lv.w ?? 'Shared across the ecosystem.'] });
  return base(w, `daemon:${name}`, level, {
    kind: 'daemon',
    title: d.title,
    subtitle: d.role,
    status: dm ? { label: dm.running ? 'running' : 'stopped', tone: dm.running ? 'ok' : 'bad' } : { label: 'on demand', tone: 'idle' },
    story: d.story,
    sections,
  });
}

function inspectRegistry(w: World, level: Level): Inspection {
  const cat = registryCatalog();
  const sections: Section[] = [];
  const up = w.host.net.dnsUp && w.host.net.registryReachable;
  if (level === 0) sections.push({ title: 'The harbor', note: 'Warehouses of blueprints. A pull is a crane lowering copies onto the whale.' });
  if (level >= 1) sections.push({ title: 'Registry (Docker Hub)', rows: [['Reachable', up ? 'yes' : `NO (${!w.host.net.dnsUp ? 'DNS down' : 'unreachable'})`], ['Host', 'registry-1.docker.io'], ['Images available', Object.keys(cat.images).join(', ')], ['Already local', Object.keys(w.images).filter((r) => cat.images[r]).join(', ') || 'none']] });
  if (level >= 2) sections.push({ title: 'Engine', lines: ['dockerd → containerd → HTTPS to the registry: authenticate, fetch manifest, fetch missing layer blobs in parallel, verify digests, unpack.'] });
  if (level >= 3) sections.push({ title: 'Process view', lines: ['Just an HTTPS server somewhere. Locally the pull is a containerd thread downloading and unpacking tar streams.'] });
  if (level >= 4) sections.push({ title: 'Kernel', lines: ['DNS lookup, TCP connect, TLS handshake — all through the host network stack. Break any of them and pulls fail while local images keep working.'] });
  if (level >= 5) sections.push({ title: 'OCI Distribution Spec', lines: ['GET /v2/<name>/manifests/<tag|digest>', 'GET /v2/<name>/blobs/<digest>', 'GET /v2/<name>/tags/list', 'POST/PUT /v2/<name>/blobs/uploads/ (push)'] });
  if (level >= 6) sections.push({ title: 'In the wider ecosystem', lines: ['ghcr.io, ECR, GAR, ACR, Harbor, Quay: all implement the same API. Private registries add auth, scanning, signing and replication.'] });
  return base(w, 'registry:hub', level, {
    kind: 'registry',
    title: 'Docker Hub',
    subtitle: 'registry · registry-1.docker.io',
    status: { label: up ? 'reachable' : 'unreachable', tone: up ? 'ok' : 'bad' },
    story: 'The harbor on the left: warehouses full of blueprint plates. Pulling is a crane lowering copies onto the deck.',
    sections,
  });
}

function inspectBuild(w: World, level: Level): Inspection {
  const b = w.build;
  const sections: Section[] = [];
  const last = b.last;
  if (level === 0) sections.push({ title: 'Shipyard', note: 'Construction notes go in, a finished blueprint comes out. Plates already made are reused.' });
  if (level >= 1)
    sections.push({
      title: `Dockerfile → ${b.tag}`,
      lines: b.steps.map((s, i) => {
        const r = last?.steps.find((x) => x.index === i);
        const tag = !last ? '' : r ? (r.layer === null && i > 0 ? '  ·metadata' : r.cached ? '  ✓ CACHED' : '  ● built') : '';
        return `${i + 1}. ${s.instr} ${s.arg}${tag}`;
      }),
      note: last ? `last build at tick ${last.tick}` : 'not built yet',
    });
  if (level >= 2) sections.push({ title: 'BuildKit', lines: ['Each step is hashed with its parent layer (and, for COPY, the file contents). Same hash → reuse the layer. Different → run the step, snapshot the filesystem diff, make a new layer.', 'A change invalidates that step AND everything stacked after it.'] });
  if (level >= 4) sections.push({ title: 'Layers produced', lines: (last?.steps ?? []).filter((s) => s.layer).map((s) => `${short(s.layer!)}  ${s.instr} ${s.arg}`) });
  if (level >= 5) sections.push({ title: 'OCI', lines: ['The Dockerfile is NOT in the image. Its results are: layers (blobs), the config history and the manifest.'] });
  if (level >= 6) sections.push({ title: 'In the wider ecosystem', lines: ['CI builds this once; the pushed digest is what gets deployed. Buildah, Kaniko and Cloud Native Buildpacks produce the same OCI output.'] });
  return base(w, 'build:dockerfile', level, {
    kind: 'build',
    title: 'Dockerfile',
    subtitle: `build recipe · ${b.tag}`,
    status: { label: last ? 'built' : 'not built', tone: last ? 'ok' : 'idle' },
    story: 'The shipyard\'s construction notes: do step 1, then 2, then 3, recording each result as a plate.',
    sections,
  });
}

/* ------------------------------------------------------------- summaries */

export function vethFor(c: Container, net: string): string {
  return vethName(c, net);
}
