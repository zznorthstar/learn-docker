import { describe, expect, it } from 'vitest';
import { WorldEngine } from '../../src/engine/engine';
import { project, statusOf } from '../../src/render/project';
import { SlotAllocator, buildScene, anchorOf, SLOT_COUNT, LAYOUT } from '../../src/render/scene';
import { regionRect } from '../../src/render/camera';
import { imageTint, toRiveColor } from '../../src/render/palette';
import { bearer, loadIdentity, newLabId, newSecret } from '../../src/app/identity';
import { DEFAULT_VIEW } from '../../src/engine/types';

const T = { trouble: false, busy: false, building: false, engine: false };
const eng = () => new WorldEngine(() => 1);

describe('projection: semantic state -> Rive inputs', () => {
  it('maps container state to the visual status code (and nothing Docker-specific leaks through)', () => {
    const e = eng();
    e.reset('welcome');
    const c = () => e.world.containers.web!;
    expect(statusOf(c())).toBe(1);
    e.dispatch({ action: 'pause_container', target: 'container:web' });
    expect(statusOf(c())).toBe(4);
    e.dispatch({ action: 'unpause_container', target: 'container:web' });
    e.dispatch({ action: 'stop_container', target: 'container:web' });
    expect(statusOf(c())).toBe(2); // clean exit
    e.dispatch({ action: 'start_container', target: 'container:web' });
    e.dispatch({ action: 'set_resource_limit', target: 'container:web', resource: 'memory', value: '6MB' });
    expect(statusOf(c())).toBe(3); // OOM: failure look
  });

  it('derives attachments from relationships: volume strap, gangplank, signal line, tint', () => {
    const e = eng();
    e.reset('empty');
    e.dispatch({ action: 'create_network', name: 'appnet' });
    e.dispatch({ action: 'run_container', image: 'redis:7', name: 'cache', volumes: ['d:/data'], ports: ['6379:6379'], network: 'appnet' });
    const slots = new SlotAllocator();
    const { slotOf } = slots.assign(e.world);
    const p = project(e.world, DEFAULT_VIEW, slotOf, null, T).slots[slotOf.get('cache')!]!;
    expect(p).toMatchObject({ occupied: true, status: 1, hasVolume: 1, published: 1, networked: 1 });
    expect(p.tint).toBe(toRiveColor(imageTint('redis:7')));
  });

  it('the abstraction level dissolves the box: reveal follows the level', () => {
    const e = eng();
    e.reset('welcome');
    const { slotOf } = new SlotAllocator().assign(e.world);
    const rev = (level: number) => project(e.world, { ...DEFAULT_VIEW, level: level as never }, slotOf, null, T).slots[0]!.reveal;
    expect(rev(0)).toBe(0);
    expect(rev(1)).toBe(0);
    expect(rev(2)).toBeGreaterThan(0);
    expect(rev(3)).toBe(1);
  });

  it('host conditions drive the weather and the registry lighthouse', () => {
    const e = eng();
    e.reset('welcome');
    const { slotOf } = new SlotAllocator().assign(e.world);
    const calm = project(e.world, DEFAULT_VIEW, slotOf, null, T);
    expect(calm.storm).toBe(false);
    expect(calm.registryUp).toBe(1);
    e.dispatch({ action: 'set_condition', condition: 'registry', value: false });
    expect(project(e.world, DEFAULT_VIEW, slotOf, null, T).registryUp).toBe(0);
    e.dispatch({ action: 'set_condition', condition: 'host_online', value: false });
    const down = project(e.world, DEFAULT_VIEW, slotOf, null, T);
    expect(down.storm).toBe(true);
    expect(down.santaMood).toBe(3); // dockerd is down: Santa sleeps
    expect(project(e.world, DEFAULT_VIEW, slotOf, null, { ...T, trouble: true }).storm).toBe(true);
  });

  it('memory pressure against a limit becomes the cgroup gauge', () => {
    const e = eng();
    e.reset('welcome');
    e.dispatch({ action: 'set_resource_limit', target: 'container:web', resource: 'memory', value: '24MB' });
    const { slotOf } = new SlotAllocator().assign(e.world);
    const pr = project(e.world, DEFAULT_VIEW, slotOf, null, T).slots[0]!.pressure;
    expect(pr).toBeGreaterThan(0.4);
    expect(pr).toBeLessThanOrEqual(1);
  });
});

describe('scene layout', () => {
  it('a container keeps its deck slot while it exists; overflow beyond the deck is reported, not lost', () => {
    const e = eng();
    e.reset('empty');
    for (let i = 0; i < SLOT_COUNT + 2; i++) e.dispatch({ action: 'run_container', image: 'busybox', name: `c${i}`, cmd: ['sleep', '9'] });
    const slots = new SlotAllocator();
    const a = slots.assign(e.world);
    expect(a.overflow).toEqual(['c6', 'c7']);
    const where = a.slotOf.get('c2');
    e.dispatch({ action: 'remove_container', target: 'container:c0', force: true });
    const b = slots.assign(e.world);
    expect(b.slotOf.get('c2')).toBe(where); // nothing shifts around
    expect(b.slotOf.get('c6')).toBe(0); // the freed slot is reused by the next overflowing container
    expect(b.overflow).toEqual(['c7']);
  });

  it('every semantic target has an anchor the overlay can draw to', () => {
    const e = eng();
    e.reset('shop');
    const { slotOf, overflow } = new SlotAllocator().assign(e.world);
    const scene = buildScene(e.world, slotOf, overflow);
    for (const t of ['host', 'daemon:dockerd', 'daemon:containerd', 'daemon:runc', 'registry:hub', 'build:dockerfile', 'container:shop-db-1', 'volume:shop_dbdata', 'network:shop_default', 'image:nginx:latest']) {
      expect(anchorOf(e.world, scene, t, slotOf), t).not.toBeNull();
    }
    expect(scene.lanes.find((l) => l.name === 'shop_default')!.members).toHaveLength(3);
    expect(LAYOUT.slots).toHaveLength(SLOT_COUNT);
  });

  it('camera regions stay inside the artboard and keep 16:9', () => {
    for (const r of ['overview', 'whale', 'deck', 'engine-room', 'harbor', 'shipyard'] as const) {
      for (const z of [0.7, 1, 2, 3]) {
        const c = regionRect(r, z);
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.x + c.w).toBeLessThanOrEqual(1600.001);
        expect(c.y + c.h).toBeLessThanOrEqual(900.001);
        expect(c.w / c.h).toBeCloseTo(16 / 9, 2);
      }
    }
  });
});

describe('lab identity', () => {
  const memStore = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it('generates well-formed, unique, high-entropy ids and secrets', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newLabId()));
    const secrets = new Set(Array.from({ length: 200 }, () => newSecret()));
    expect(ids.size).toBe(200);
    expect(secrets.size).toBe(200);
    for (const s of secrets) expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const i of ids) expect(i).toMatch(/^w_[a-z0-9]{10}$/);
  });
  it('persists across loads (same lab on refresh) and ignores corrupted storage', () => {
    const st = memStore();
    const a = loadIdentity(st);
    expect(a.fresh).toBe(true);
    const b = loadIdentity(st);
    expect(b.fresh).toBe(false);
    expect(b.identity).toEqual(a.identity);
    const bad = memStore();
    bad.setItem('dockerworld.lab.v1', '{"labId":"nope","secret":"x"}');
    expect(loadIdentity(bad).fresh).toBe(true);
    expect(bearer(a.identity)).toBe(`${a.identity.labId}.${a.identity.secret}`);
  });
});
