import type { Region } from '../engine/types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const W = 1600;
const H = 900;
export const FULL: Rect = { x: 0, y: 0, w: W, h: H };

/** where each named region is centred (artboard coordinates) and how wide it is at zoom 1 */
const REGIONS: Record<Region, { cx: number; cy: number; w: number }> = {
  overview: { cx: 800, cy: 450, w: 1600 },
  whale: { cx: 900, cy: 500, w: 1200 },
  deck: { cx: 790, cy: 350, w: 800 },
  'engine-room': { cx: 1190, cy: 330, w: 520 },
  harbor: { cx: 260, cy: 640, w: 520 },
  shipyard: { cx: 1340, cy: 700, w: 520 },
};

export const REGION_LABEL: Record<Region, string> = {
  overview: 'Overview',
  whale: 'Whale',
  deck: 'Deck',
  'engine-room': 'Crew',
  harbor: 'Harbor',
  shipyard: 'Shipyard',
};

/** 16:9 viewport for a region at a zoom, kept inside the artboard */
export function regionRect(region: Region, zoom = 1): Rect {
  const r = REGIONS[region] ?? REGIONS.overview;
  const w = Math.min(W, Math.max(240, r.w / Math.max(0.5, Math.min(4, zoom))));
  const h = (w * 9) / 16;
  const x = Math.max(0, Math.min(W - w, r.cx - w / 2));
  const y = Math.max(0, Math.min(H - h, r.cy - h / 2));
  return { x, y, w, h };
}

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** tweens the visible window of the world */
export class Camera {
  cur: Rect = { ...FULL };
  private from: Rect = { ...FULL };
  private to: Rect = { ...FULL };
  private t0 = 0;
  private dur = 0;
  private raf = 0;

  constructor(private onFrame: (r: Rect) => void) {}

  set(target: Rect, instant: boolean): void {
    if (same(target, this.to)) return;
    this.to = target;
    if (instant) {
      this.cur = { ...target };
      this.stop();
      this.onFrame(this.cur);
      return;
    }
    this.from = { ...this.cur };
    this.t0 = performance.now();
    this.dur = 620;
    if (!this.raf) this.raf = requestAnimationFrame((n) => this.step(n));
  }

  private step(now: number): void {
    const k = Math.min(1, (now - this.t0) / this.dur);
    const e = ease(k);
    this.cur = { x: lerp(this.from.x, this.to.x, e), y: lerp(this.from.y, this.to.y, e), w: lerp(this.from.w, this.to.w, e), h: lerp(this.from.h, this.to.h, e) };
    this.onFrame(this.cur);
    this.raf = k < 1 ? requestAnimationFrame((n) => this.step(n)) : 0;
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const same = (a: Rect, b: Rect): boolean => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5;
