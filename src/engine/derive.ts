import type { Container, Image, World } from './types';
import { hex, short } from './util';
import { diskFreeMB, diskUsedMB, hostCpuPct, hostMemUsedMB } from './world';

/**
 * Derived "Linux reality": everything here is computed from the semantic world,
 * never stored. Levels 3-5 of the inspector render these facts.
 */

export interface ProcNode {
  hostPid: number;
  nsPid?: number;
  name: string;
  container?: string;
  note?: string;
  children: ProcNode[];
}

export function processTree(w: World): ProcNode {
  const init: ProcNode = { hostPid: 1, name: 'systemd', children: [] };
  if (!w.host.online) return init;
  const mk = (hostPid: number, name: string, extra: Partial<ProcNode> = {}): ProcNode => ({ hostPid, name, children: [], ...extra });
  const dockerd = mk(w.daemons.dockerd.pid, 'dockerd');
  const containerd = mk(w.daemons.containerd.pid, 'containerd');
  if (w.daemons.dockerd.running) init.children.push(dockerd);
  if (w.daemons.containerd.running) init.children.push(containerd);
  for (const [port, name] of Object.entries(w.host.busyPorts)) init.children.push(mk(900 + (parseInt(port, 10) % 50), name, { note: `listens on :${port}` }));
  for (const c of Object.values(w.containers)) {
    if (c.state !== 'running' && c.state !== 'paused') continue;
    const shim = mk(c.pid - 3, 'containerd-shim-runc-v2', { container: c.name, note: 'parent of the container, independent of dockerd' });
    const main = mk(c.pid, c.process, { nsPid: 1, container: c.name, note: c.state === 'paused' ? 'frozen by the cgroup freezer' : undefined });
    for (const p of c.childProcs) main.children.push(mk(c.pid + p.nsPid, p.name, { nsPid: p.nsPid, container: c.name }));
    shim.children.push(main);
    init.children.push(shim);
    for (const p of c.ports) {
      dockerd.children.push(mk(c.pid + 40 + (p.host % 7), 'docker-proxy', { note: `-host-port ${p.host} -container-ip ${ipOf(c)} -container-port ${p.container}` }));
    }
  }
  return init;
}

export function ipOf(c: Container, net?: string): string {
  const n = net ?? Object.keys(c.networks)[0];
  return (n && c.networks[n]?.ip) || '';
}

const nsInode = (c: Container, type: string): number => 4026532000 + (parseInt(hex(`${c.name}:${type}`, 6), 16) % 9000);

export interface NsRow {
  type: string;
  inode: number;
  shared: boolean;
  note: string;
}

export interface KernelView {
  namespaces: NsRow[];
  cgroup: { path: string; files: [string, string][] };
  rootfs: { type: string; lowerdirs: string[]; upperdir: string; workdir: string; merged: string };
  mounts: { target: string; source: string; type: string; options: string }[];
  net: {
    interfaces: { name: string; ip: string; peer?: string; bridge?: string }[];
    routes: string[];
    resolv: string[];
  };
  iptables: string[];
  security: { capabilities: string[]; seccomp: string; apparmor: string; user: string; noNewPrivileges: boolean };
}

export const DEFAULT_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FSETID', 'FOWNER', 'MKNOD', 'NET_RAW', 'SETGID', 'SETUID', 'SETFCAP', 'SETPCAP', 'NET_BIND_SERVICE', 'SYS_CHROOT', 'KILL', 'AUDIT_WRITE'];
export const ALL_CAPS_COUNT = 41;

const mb = (n: number): string => String(Math.round(n * 1024 * 1024));

export function vethName(c: Container, net: string): string {
  return 'veth' + hex(`${c.id}:${net}`, 7);
}

export function kernelView(w: World, c: Container, img?: Image): KernelView {
  const live = c.state === 'running' || c.state === 'paused';
  const image = img ?? Object.values(w.images).find((i) => i.id === c.imageId);
  const hostNet = Object.keys(c.networks).some((n) => w.networks[n]?.driver === 'host');
  const ns: NsRow[] = [
    { type: 'pid', inode: nsInode(c, 'pid'), shared: false, note: 'process 1 here is PID ' + (c.pid || '—') + ' on the host' },
    { type: 'net', inode: hostNet ? 4026531840 : nsInode(c, 'net'), shared: hostNet, note: hostNet ? 'shares the host network stack' : 'private interfaces, routes, ports' },
    { type: 'mnt', inode: nsInode(c, 'mnt'), shared: false, note: 'private mount table (own /)' },
    { type: 'uts', inode: nsInode(c, 'uts'), shared: false, note: `hostname ${c.id.slice(0, 12)}` },
    { type: 'ipc', inode: nsInode(c, 'ipc'), shared: false, note: 'private SysV IPC / POSIX queues' },
    { type: 'cgroup', inode: nsInode(c, 'cgroup'), shared: false, note: 'sees its own cgroup as the root' },
    { type: 'user', inode: 4026531837, shared: true, note: 'not remapped: root inside is root outside (but with fewer capabilities)' },
  ];
  const cgPath = `/sys/fs/cgroup/system.slice/docker-${c.id}.scope`;
  const lim = c.limits;
  const usageMB = live ? c.usage.memMB : 0;
  const cgroup = {
    path: cgPath,
    files: [
      ['memory.max', lim.memoryMB === null ? 'max' : mb(lim.memoryMB)],
      ['memory.current', mb(usageMB)],
      ['memory.events', `oom_kill ${c.oomKilled ? 1 : 0}`],
      ['cpu.max', lim.cpus === null ? 'max 100000' : `${Math.round(lim.cpus * 100000)} 100000`],
      ['cpu.stat', `usage_usec ${Math.round(c.usage.cpuPct * 1e4)}`],
      ['pids.max', lim.pids === null ? 'max' : String(lim.pids)],
      ['pids.current', String(live ? 1 + c.childProcs.length : 0)],
      ['cgroup.freeze', c.state === 'paused' ? '1' : '0'],
    ] as [string, string][],
  };
  const lower = (image?.layers ?? []).slice().reverse().map((d) => `/var/lib/docker/overlay2/${short(d, 13)}/diff`);
  const rootfs = {
    type: 'overlay',
    lowerdirs: lower,
    upperdir: `/var/lib/docker/overlay2/${c.id.slice(0, 13)}/diff`,
    workdir: `/var/lib/docker/overlay2/${c.id.slice(0, 13)}/work`,
    merged: `/var/lib/docker/overlay2/${c.id.slice(0, 13)}/merged`,
  };
  const mounts: KernelView['mounts'] = [
    { target: '/', source: 'overlay', type: 'overlay', options: 'rw,lowerdir=…,upperdir=…,workdir=…' },
    { target: '/proc', source: 'proc', type: 'proc', options: 'rw,nosuid,nodev,noexec' },
    { target: '/dev', source: 'tmpfs', type: 'tmpfs', options: 'rw,nosuid,size=65536k,mode=755' },
    { target: '/sys', source: 'sysfs', type: 'sysfs', options: 'ro,nosuid,nodev,noexec' },
    { target: '/etc/resolv.conf', source: `/var/lib/docker/containers/${c.id.slice(0, 12)}…/resolv.conf`, type: 'bind', options: 'rw' },
    { target: '/etc/hosts', source: `/var/lib/docker/containers/${c.id.slice(0, 12)}…/hosts`, type: 'bind', options: 'rw' },
  ];
  for (const m of c.mounts) {
    mounts.push({
      target: m.target,
      source: m.type === 'volume' ? (w.volumes[m.source]?.mountpoint ?? `/var/lib/docker/volumes/${m.source}/_data`) : m.type === 'bind' ? m.source : 'tmpfs',
      type: m.type === 'tmpfs' ? 'tmpfs' : 'bind',
      options: m.readOnly ? 'ro' : 'rw',
    });
  }
  const ifs: KernelView['net']['interfaces'] = [{ name: 'lo', ip: '127.0.0.1' }];
  const routes: string[] = [];
  let i = 0;
  for (const [n, a] of Object.entries(c.networks)) {
    const net = w.networks[n];
    if (!net || net.driver !== 'bridge') continue;
    ifs.push({ name: `eth${i}`, ip: a.ip + '/16', peer: vethName(c, n), bridge: net.bridgeIf });
    if (i === 0) routes.push(`default via ${net.gateway} dev eth0`);
    routes.push(`${net.subnet} dev eth${i} proto kernel scope link src ${a.ip}`);
    i++;
  }
  const userDefined = Object.keys(c.networks).some((n) => w.networks[n]?.dns);
  const resolv = userDefined ? ['nameserver 127.0.0.11', 'options ndots:0   # Docker\'s embedded DNS, forwards unknown names upstream'] : ['nameserver 8.8.8.8   # copied from the host (default bridge has no embedded DNS)'];
  const rules: string[] = [];
  for (const p of c.ports) {
    const n = Object.keys(c.networks)[0];
    const net = n ? w.networks[n] : undefined;
    rules.push(`-t nat -A DOCKER ! -i ${net?.bridgeIf ?? 'docker0'} -p ${p.proto} --dport ${p.host} -j DNAT --to-destination ${ipOf(c)}:${p.container}`);
    rules.push(`-t filter -A DOCKER -d ${ipOf(c)}/32 ! -i ${net?.bridgeIf ?? 'docker0'} -o ${net?.bridgeIf ?? 'docker0'} -p ${p.proto} --dport ${p.container} -j ACCEPT`);
  }
  const caps = c.security.privileged ? Array.from({ length: ALL_CAPS_COUNT }, (_, k) => (k === 0 ? 'ALL (41 capabilities, --privileged)' : '')).filter(Boolean) : DEFAULT_CAPS.filter((x) => !c.security.capDrop.includes(x)).concat(c.security.capAdd);
  return {
    namespaces: ns,
    cgroup,
    rootfs,
    mounts,
    net: { interfaces: ifs, routes, resolv },
    iptables: rules,
    security: {
      capabilities: caps,
      seccomp: c.security.seccomp === 'default' ? 'docker default profile (blocks ~44 syscalls: mount, reboot, kexec_load…)' : 'unconfined (all syscalls allowed)',
      apparmor: c.security.privileged ? 'unconfined' : 'docker-default',
      user: c.security.user,
      noNewPrivileges: false,
    },
  };
}

/** What the host sees of Docker's networking: bridges, veth ends, NAT. */
export interface HostNet {
  bridges: { name: string; network: string; subnet: string; gateway: string; ports: { veth: string; container: string; ip: string }[] }[];
  nat: string[];
}

export function hostNet(w: World): HostNet {
  const bridges: HostNet['bridges'] = [];
  const nat: string[] = [];
  for (const n of Object.values(w.networks)) {
    if (n.driver !== 'bridge') continue;
    const ports = Object.values(w.containers)
      .filter((c) => n.name in c.networks && (c.state === 'running' || c.state === 'paused'))
      .map((c) => ({ veth: vethName(c, n.name), container: c.name, ip: c.networks[n.name]!.ip }));
    bridges.push({ name: n.bridgeIf, network: n.name, subnet: n.subnet, gateway: n.gateway, ports });
    nat.push(`-t nat -A POSTROUTING -s ${n.subnet} ! -o ${n.bridgeIf} -j MASQUERADE`);
  }
  for (const c of Object.values(w.containers)) {
    if (c.state !== 'running' && c.state !== 'paused') continue;
    nat.push(...kernelView(w, c).iptables.filter((r) => r.startsWith('-t nat')));
  }
  return { bridges, nat };
}

/** The OCI runtime-spec config.json containerd hands runc (excerpt, derived from state). */
export function ociConfig(w: World, c: Container): Record<string, unknown> {
  const kv = kernelView(w, c);
  return {
    ociVersion: '1.1.0',
    process: {
      terminal: false,
      user: { uid: 0, gid: 0 },
      args: c.cmd,
      env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`),
      cwd: Object.values(w.images).find((i) => i.id === c.imageId)?.config.workdir ?? '/',
      capabilities: { bounding: kv.security.capabilities.slice(0, 14) },
      noNewPrivileges: false,
    },
    root: { path: 'rootfs', readonly: c.security.readOnlyRootfs },
    hostname: c.id.slice(0, 12),
    mounts: kv.mounts.map((m) => ({ destination: m.target, type: m.type, source: m.source, options: m.options.split(',') })),
    linux: {
      namespaces: kv.namespaces.filter((n) => !n.shared && n.type !== 'user').map((n) => ({ type: n.type })),
      resources: {
        memory: c.limits.memoryMB === null ? undefined : { limit: Math.round(c.limits.memoryMB * 1024 * 1024) },
        cpu: c.limits.cpus === null ? undefined : { quota: Math.round(c.limits.cpus * 100000), period: 100000 },
        pids: c.limits.pids === null ? undefined : { limit: c.limits.pids },
      },
      cgroupsPath: `system.slice:docker:${c.id}`,
      seccomp: { defaultAction: 'SCMP_ACT_ERRNO', note: c.security.seccomp },
    },
  };
}

/** OCI image manifest + config for an image (excerpt, derived). */
export function ociImage(w: World, img: Image): { manifest: Record<string, unknown>; config: Record<string, unknown> } {
  return {
    manifest: {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: img.id, size: 1580 + img.layers.length * 90 },
      layers: img.layers.map((d) => ({
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        digest: d,
        size: Math.round((w.layers[d]?.sizeMB ?? 0) * 1024 * 1024 * 0.42),
      })),
    },
    config: {
      architecture: img.arch,
      os: img.os,
      config: { Cmd: img.config.cmd, Entrypoint: img.config.entrypoint.length ? img.config.entrypoint : undefined, Env: img.config.env, ExposedPorts: Object.fromEntries(img.config.exposed.map((p) => [`${p}/tcp`, {}])), WorkingDir: img.config.workdir, User: img.config.user === 'root' ? undefined : img.config.user },
      rootfs: { type: 'layers', diff_ids: img.layers.map((d) => 'sha256:' + hex('diffid:' + d)) },
      history: img.history.map((h) => ({ created_by: h.instr, empty_layer: h.layer ? undefined : true })),
    },
  };
}

/** one-screen host summary used by stats views and the AI */
export function hostSummary(w: World) {
  return {
    cpuPct: Math.round(hostCpuPct(w)),
    memUsedMB: Math.round(hostMemUsedMB(w)),
    memTotalMB: w.host.ramMB,
    diskUsedMB: Math.round(diskUsedMB(w)),
    diskTotalMB: w.host.diskMB,
    diskFreeMB: Math.round(diskFreeMB(w)),
  };
}
