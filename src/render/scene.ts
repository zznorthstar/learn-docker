import layoutJson from './layout.generated.json';
import type { Container, Target, World } from '../engine/types';

/**
 * Scene layout: WHERE things are in the 1600x900 artboard. Positions of the
 * Rive-drawn parts come from layout.generated.json (written by the art
 * generator, so art and overlay can never drift apart). Positions of the
 * overlay-drawn objects (images, volumes, network lanes) are computed here
 * from semantic state.
 */

export interface Pt {
  x: number;
  y: number;
}

export const LAYOUT = layoutJson as unknown as {
  artboard: { w: number; h: number };
  slots: { index: number; x: number; y: number; w: number; h: number }[];
  crew: Record<'runner' | 'foreman' | 'santa', { x: number; s: number }>;
  anchors: Record<string, Pt>;
  vm: Record<string, string>;
};

export const SLOT_COUNT = LAYOUT.slots.length;
export const DECK_Y = LAYOUT.slots[0]!.y;

export interface SlotPlace {
  index: number;
  name: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImagePlace {
  ref: string;
  x: number;
  y: number;
  layers: number;
}

export interface VolumePlace {
  name: string;
  x: number;
  y: number;
  users: string[];
}

export interface LanePlace {
  name: string;
  y: number;
  x1: number;
  x2: number;
  members: { name: string; x: number }[];
  index: number;
}

export interface Scene {
  slots: SlotPlace[];
  overflow: string[];
  images: ImagePlace[];
  volumes: VolumePlace[];
  lanes: LanePlace[];
  bindDirs: { path: string; x: number; y: number; users: string[] }[];
}

/** keeps a container in the same deck slot for as long as it exists */
export class SlotAllocator {
  private map = new Map<string, number>();

  assign(w: World): { slotOf: Map<string, number>; overflow: string[] } {
    const names = Object.values(w.containers)
      .sort((a, b) => a.createdTick - b.createdTick || a.name.localeCompare(b.name))
      .map((c) => c.name);
    for (const n of [...this.map.keys()]) if (!names.includes(n)) this.map.delete(n);
    const used = new Set(this.map.values());
    const overflow: string[] = [];
    for (const n of names) {
      if (this.map.has(n)) continue;
      let free = -1;
      for (let i = 0; i < SLOT_COUNT; i++) if (!used.has(i)) {
        free = i;
        break;
      }
      if (free < 0) overflow.push(n);
      else {
        this.map.set(n, free);
        used.add(free);
      }
    }
    // containers that were overflowing earlier may now fit
    return { slotOf: new Map(this.map), overflow: names.filter((n) => !this.map.has(n)) };
  }
}

export function buildScene(w: World, slotOf: Map<string, number>, overflow: string[]): Scene {
  const byIndex = new Map<number, string>();
  for (const [n, i] of slotOf) byIndex.set(i, n);
  const slots: SlotPlace[] = LAYOUT.slots.map((s) => ({ index: s.index, name: byIndex.get(s.index) ?? null, x: s.x, y: s.y, w: s.w, h: s.h }));

  // image rack under the whale
  const imgs = Object.values(w.images)
    .filter((i) => !i.ref.startsWith('<none>'))
    .sort((a, b) => a.ref.localeCompare(b.ref))
    .slice(0, 7);
  const images: ImagePlace[] = imgs.map((img, i) => ({ ref: img.ref, x: 540 + i * 104, y: 706, layers: img.layers.length }));

  // volumes: barrels in a net at the right of the rack
  const vols = Object.values(w.volumes).slice(0, 6);
  const volumes: VolumePlace[] = vols.map((v, i) => ({
    name: v.name,
    x: 700 + i * 96,
    y: 806,
    users: Object.values(w.containers)
      .filter((c) => c.mounts.some((m) => m.type === 'volume' && m.source === v.name))
      .map((c) => c.name),
  }));

  // bind-mount directories show up as pier stubs next to the volumes
  const paths = new Map<string, string[]>();
  for (const c of Object.values(w.containers)) for (const m of c.mounts) if (m.type === 'bind') (paths.get(m.source) ?? paths.set(m.source, []).get(m.source)!).push(c.name);
  const bindDirs = [...paths.entries()].slice(0, 3).map(([path, users], i) => ({ path, users, x: 1140 + i * 0, y: 760 + i * 34 }));

  // network lanes above the cargo; the default bridge is the lowest lane
  const nets = Object.values(w.networks).filter((n) => n.driver === 'bridge');
  const lanes: LanePlace[] = [];
  nets.forEach((n, idx) => {
    const members = Object.values(w.containers)
      .filter((c) => n.name in c.networks && slotOf.has(c.name))
      .map((c) => ({ name: c.name, x: LAYOUT.slots[slotOf.get(c.name)!]!.x }))
      .sort((a, b) => a.x - b.x);
    if (!members.length) return;
    lanes.push({ name: n.name, y: 0, x1: members[0]!.x, x2: members[members.length - 1]!.x, members, index: 0 });
  });
  lanes.sort((a, b) => (a.name === 'bridge' ? -1 : b.name === 'bridge' ? 1 : a.name.localeCompare(b.name)));
  lanes.forEach((l, i) => {
    l.index = i;
    l.y = 306 - i * 24;
  });
  return { slots, overflow, images, volumes, lanes, bindDirs };
}

/** where an object is, in artboard coordinates (for highlights, arrows and packets) */
export function anchorOf(w: World, scene: Scene, target: Target, slotOf: Map<string, number>): Pt | null {
  const i = target.indexOf(':');
  const kind = i < 0 ? target : target.slice(0, i);
  const name = i < 0 ? '' : target.slice(i + 1);
  const A = LAYOUT.anchors;
  switch (kind) {
    case 'container': {
      const s = slotOf.get(name);
      if (s === undefined) return { x: 1040, y: 360 };
      const p = LAYOUT.slots[s]!;
      return { x: p.x, y: p.y - 38 };
    }
    case 'host':
      return A.whale!;
    case 'daemon':
      return name === 'containerd' ? A.foreman! : name === 'runc' ? A.runner! : name === 'buildkit' ? A.shipyard! : A.santa!;
    case 'registry':
      return A.harbor!;
    case 'build':
      return A.shipyard!;
    case 'compose':
      return A.gates!;
    case 'image': {
      const p = scene.images.find((x) => x.ref === name);
      return p ? { x: p.x, y: p.y } : A.harbor!;
    }
    case 'volume': {
      const p = scene.volumes.find((x) => x.name === name);
      return p ? { x: p.x, y: p.y } : A.hold!;
    }
    case 'network': {
      const l = scene.lanes.find((x) => x.name === name);
      return l ? { x: (l.x1 + l.x2) / 2, y: l.y } : { x: 700, y: 310 };
    }
    default:
      return null;
  }
}

export function containersOf(w: World): Container[] {
  return Object.values(w.containers);
}
