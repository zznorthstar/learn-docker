import type { Container, World } from './types';
import { diskFreeMB, hostMemUsedMB } from './world';
import { fmtMB } from './util';

export interface DiffEntry {
  target: string;
  kind: 'added' | 'removed' | 'changed';
  what: string;
  before?: string;
  after?: string;
}

const fmtPorts = (c: Container): string => c.ports.map((p) => `${p.host}:${p.container}`).join(',') || '—';
const fmtMounts = (c: Container): string => c.mounts.map((m) => `${m.source || 'tmpfs'}→${m.target}`).join(',') || '—';
const fmtNets = (c: Container): string => Object.keys(c.networks).join(',') || '—';
const fmtLimits = (c: Container): string => `mem ${c.limits.memoryMB ?? '∞'} cpu ${c.limits.cpus ?? '∞'} pids ${c.limits.pids ?? '∞'}`;

/** Structured, human-readable difference between two worlds. */
export function diffWorlds(a: World, b: World): DiffEntry[] {
  const out: DiffEntry[] = [];
  const names = new Set([...Object.keys(a.containers), ...Object.keys(b.containers)]);
  for (const n of [...names].sort()) {
    const x = a.containers[n];
    const y = b.containers[n];
    const t = `container:${n}`;
    if (!x && y) out.push({ target: t, kind: 'added', what: `container ${n} appeared (${y.imageRef}, ${y.state})` });
    else if (x && !y) out.push({ target: t, kind: 'removed', what: `container ${n} was removed`, before: `${x.state}${x.layerData.items ? `, ${x.layerData.items} records in its writable layer` : ''}` });
    else if (x && y) {
      const ch = (what: string, before: string, after: string): void => {
        if (before !== after) out.push({ target: t, kind: 'changed', what, before, after });
      };
      ch('state', x.state + (x.exitCode !== null && x.state === 'exited' ? ` (${x.exitCode})` : ''), y.state + (y.exitCode !== null && y.state === 'exited' ? ` (${y.exitCode})` : ''));
      ch('OOM killed', String(x.oomKilled), String(y.oomKilled));
      ch('health', x.health, y.health);
      ch('reachable from outside', x.service, y.service);
      ch('PID', String(x.pid), String(y.pid));
      ch('limits', fmtLimits(x), fmtLimits(y));
      ch('ports', fmtPorts(x), fmtPorts(y));
      ch('mounts', fmtMounts(x), fmtMounts(y));
      ch('networks', fmtNets(x), fmtNets(y));
      ch('memory usage', `${Math.round(x.usage.memMB)} MB`, `${Math.round(y.usage.memMB)} MB`);
      ch('restarts', String(x.restartCount), String(y.restartCount));
      ch('writable layer records', String(x.layerData.items), String(y.layerData.items));
    }
  }
  const tables: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ['image', a.images, b.images],
    ['network', a.networks, b.networks],
    ['volume', a.volumes, b.volumes],
  ];
  for (const [kind, ta, tb] of tables) {
    for (const k of Object.keys(tb)) if (!(k in ta)) out.push({ target: `${kind}:${k}`, kind: 'added', what: `${kind} ${k} appeared` });
    for (const k of Object.keys(ta)) if (!(k in tb)) out.push({ target: `${kind}:${k}`, kind: 'removed', what: `${kind} ${k} was removed` });
  }
  for (const k of Object.keys(b.volumes)) {
    const x = a.volumes[k];
    const y = b.volumes[k];
    if (x && y && x.items !== y.items) out.push({ target: `volume:${k}`, kind: 'changed', what: 'records', before: String(x.items), after: String(y.items) });
  }
  const h = (what: string, before: string, after: string): void => {
    if (before !== after) out.push({ target: 'host', kind: 'changed', what, before, after });
  };
  h('online', String(a.host.online), String(b.host.online));
  h('DNS', String(a.host.net.dnsUp), String(b.host.net.dnsUp));
  h('registry reachable', String(a.host.net.registryReachable), String(b.host.net.registryReachable));
  h('latency', `${a.host.net.latencyMs} ms`, `${b.host.net.latencyMs} ms`);
  h('packet loss', `${a.host.net.packetLossPct}%`, `${b.host.net.packetLossPct}%`);
  h('bandwidth', `${a.host.net.bandwidthMbps} Mbps`, `${b.host.net.bandwidthMbps} Mbps`);
  h('free disk', fmtMB(Math.max(0, diskFreeMB(a))), fmtMB(Math.max(0, diskFreeMB(b))));
  h('memory used', `${Math.round(hostMemUsedMB(a))} MB`, `${Math.round(hostMemUsedMB(b))} MB`);
  h('dockerd', String(a.daemons.dockerd.running), String(b.daemons.dockerd.running));
  h('containerd', String(a.daemons.containerd.running), String(b.daemons.containerd.running));
  return out;
}
