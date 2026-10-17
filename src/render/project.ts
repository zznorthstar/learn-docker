import type { Container, ViewState, World } from '../engine/types';
import { diskUsedMB, hostCpuPct, hostMemUsedMB } from '../engine/world';
import { imageTint, toRiveColor } from './palette';
import { SLOT_COUNT } from './scene';

/**
 * PROJECTION: semantic world -> visual inputs.
 *
 * This is the only place that knows how Docker state maps onto the Rive view
 * models. Rive never sees "container", "OOM" or "volume": only numbers,
 * booleans and colours. Swap the art and only this file changes.
 */

export interface SlotInputs {
  occupied: boolean;
  /** 0 created · 1 running · 2 exited · 3 failed · 4 paused · 5 running but unhealthy */
  status: number;
  hover: boolean;
  selected: boolean;
  reveal: number;
  pressure: number;
  hasVolume: number;
  published: number;
  networked: number;
  tint: number;
}

export interface WorldInputs {
  level: number;
  cpuLoad: number;
  memPressure: number;
  diskFill: number;
  storm: boolean;
  registryUp: number;
  building: number;
  santaMood: number;
  foreman: { working: boolean; glow: number };
  runner: { working: boolean; glow: number };
  slots: SlotInputs[];
}

/** how far the shipping-box shell has dissolved into "the process" at each level */
const REVEAL_BY_LEVEL = [0, 0, 0.18, 1, 1, 1, 1];

export function statusOf(c: Container): number {
  if (c.state === 'paused') return 4;
  if (c.state === 'created') return 0;
  if (c.state === 'exited') return c.oomKilled || (c.exitCode !== null && c.exitCode !== 0) ? 3 : 2;
  if (c.state === 'dead') return 3;
  return c.health === 'unhealthy' ? 5 : 1;
}

export function pressureOf(w: World, c: Container): number {
  if (c.state !== 'running' && c.state !== 'paused') return 0;
  const limit = c.limits.memoryMB ?? Math.min(w.host.ramMB, 512);
  return Math.max(0, Math.min(1, c.usage.memMB / limit));
}

export interface Transient {
  /** an error-class event happened recently */
  trouble: boolean;
  /** an action happened recently (crew look busy) */
  busy: boolean;
  /** a build happened recently */
  building: boolean;
  /** the engine itself is the centre of attention */
  engine: boolean;
}

export function project(w: World, view: ViewState, slotOf: Map<string, number>, hover: string | null, t: Transient): WorldInputs {
  const slots: SlotInputs[] = Array.from({ length: SLOT_COUNT }, () => ({
    occupied: false,
    status: 0,
    hover: false,
    selected: false,
    reveal: 0,
    pressure: 0,
    hasVolume: 0,
    published: 0,
    networked: 0,
    tint: 0xff4a7bd0,
  }));
  const reveal = REVEAL_BY_LEVEL[view.level] ?? 1;
  for (const c of Object.values(w.containers)) {
    const i = slotOf.get(c.name);
    if (i === undefined) continue;
    const target = `container:${c.name}`;
    slots[i] = {
      occupied: true,
      status: statusOf(c),
      hover: hover === target,
      selected: view.selected === target,
      reveal,
      pressure: pressureOf(w, c),
      hasVolume: c.mounts.some((m) => m.type === 'volume' || m.type === 'bind') ? 1 : 0,
      published: c.ports.length ? 1 : 0,
      networked: Object.keys(c.networks).some((n) => n !== 'bridge' && w.networks[n]?.driver === 'bridge') ? 1 : 0,
      tint: toRiveColor(imageTint(c.imageRef)),
    };
  }
  const memUsed = hostMemUsedMB(w);
  const diskFull = diskUsedMB(w) >= w.host.diskMB;
  const dockerdUp = w.daemons.dockerd.running && w.host.online;
  return {
    level: view.level,
    cpuLoad: Math.min(1, hostCpuPct(w) / 100),
    memPressure: Math.min(1, memUsed / w.host.ramMB),
    diskFill: Math.min(1, diskUsedMB(w) / w.host.diskMB),
    storm: t.trouble || !w.host.online || diskFull,
    registryUp: w.host.net.dnsUp && w.host.net.registryReachable ? 1 : 0,
    building: t.building ? 1 : 0,
    santaMood: !dockerdUp ? 3 : t.trouble ? 2 : t.busy ? 1 : 0,
    foreman: { working: w.daemons.containerd.running && t.busy, glow: w.daemons.containerd.running ? 0.35 : 0 },
    runner: { working: t.busy, glow: w.daemons.containerd.running ? 0.4 : 0.05 },
    slots,
  };
}
