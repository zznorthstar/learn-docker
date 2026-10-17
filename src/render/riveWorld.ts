import { Alignment, Fit, Layout, Rive, RuntimeLoader, type ViewModelInstance } from '@rive-app/canvas-lite';
import wasmUrl from '@rive-app/canvas-lite/rive.wasm?url';
import { SLOT_COUNT } from './scene';
import type { WorldInputs } from './project';
import type { Rect } from './camera';

/**
 * The Rive bridge. It owns ONE Rive instance (the whole scene) and writes
 * view-model properties derived from semantic state. It knows nothing about
 * Docker. Numbers that should glide (level, reveal, pressure, loads) are
 * tweened here; booleans, enums and colours are written straight through.
 */

RuntimeLoader.setWasmUrl(wasmUrl);

type Tweened = { cur: number; target: number };

const TWEEN_KEYS = (() => {
  const k = ['level', 'cpuLoad', 'memPressure', 'diskFill'];
  for (let i = 0; i < SLOT_COUNT; i++) k.push(`slot${i}/reveal`, `slot${i}/pressure`);
  return new Set(k);
})();

export interface RiveWorldOptions {
  canvas: HTMLCanvasElement;
  src: string;
  reducedMotion: () => boolean;
  onReady?: () => void;
  onFail?: (e: unknown) => void;
  /** frames are consistently late: the app may lower the detail */
  onSlow?: () => void;
}

export class RiveWorld {
  rive: Rive | null = null;
  vmi: ViewModelInstance | null = null;
  ready = false;
  failed = false;
  private last = new Map<string, number | boolean>();
  private tween = new Map<string, Tweened>();
  private raf = 0;
  private frozenTimer: ReturnType<typeof setTimeout> | null = null;
  private visible = true;
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private pending: WorldInputs | null = null;
  private viewport: Rect | null = null;
  private onVis = (): void => this.updatePlayState();
  /** device-pixel-ratio cap: lowered when the scene cannot keep up */
  dprCap = 1.75;
  private watch = { raf: 0, frames: 0, t0: 0, slow: 0, fired: false };

  constructor(private o: RiveWorldOptions) {
    try {
      this.rive = new Rive({
        src: o.src,
        canvas: o.canvas,
        autoplay: true,
        autoBind: true,
        artboard: 'World',
        stateMachines: 'World SM',
        layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
        onLoad: () => this.onLoad(),
        onLoadError: (e) => this.fail(e),
      });
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    this.failed = true;
    this.o.onFail?.(e);
  }

  private onLoad(): void {
    const r = this.rive;
    if (!r) return;
    this.vmi = r.viewModelInstance;
    this.ready = true;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.o.canvas);
    this.io = new IntersectionObserver((es) => {
      this.visible = es.some((e) => e.isIntersecting);
      this.updatePlayState();
    });
    this.io.observe(this.o.canvas);
    document.addEventListener('visibilitychange', this.onVis);
    if (this.viewport) this.setViewport(this.viewport);
    if (this.pending) this.apply(this.pending);
    this.o.onReady?.();
    this.updatePlayState();
  }

  resize(): void {
    const c = this.o.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    const w = Math.max(2, Math.round(c.clientWidth * dpr));
    const h = Math.max(2, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this.rive?.resizeDrawingSurfaceToCanvas(dpr);
    if (this.viewport) this.setViewport(this.viewport);
  }

  /** count frames while the scene runs; three slow seconds in a row means "lower the detail" */
  private startWatch(): void {
    const w = this.watch;
    if (w.raf || w.fired) return;
    w.frames = 0;
    w.t0 = performance.now();
    const tick = (now: number): void => {
      w.frames++;
      if (now - w.t0 >= 1000) {
        const fps = (w.frames * 1000) / (now - w.t0);
        w.slow = fps < 36 ? w.slow + 1 : 0;
        w.frames = 0;
        w.t0 = now;
        if (w.slow >= 3 && !w.fired) {
          w.fired = true;
          this.o.onSlow?.();
        }
      }
      w.raf = w.fired ? 0 : requestAnimationFrame(tick);
    };
    w.raf = requestAnimationFrame(tick);
  }

  private stopWatch(): void {
    if (this.watch.raf) cancelAnimationFrame(this.watch.raf);
    this.watch.raf = 0;
    this.watch.slow = 0;
  }

  /** pause when hidden/offscreen; with reduced motion only run briefly after a change */
  private updatePlayState(): void {
    const r = this.rive;
    if (!r) return;
    const shouldRun = this.visible && !document.hidden;
    if (!shouldRun) {
      r.pause();
      this.stopWatch();
      return;
    }
    if (this.o.reducedMotion()) this.settleThenFreeze();
    else {
      r.play();
      this.startWatch();
    }
  }

  /** reduced motion: let state transitions finish (<=700ms) then hold still */
  private settleThenFreeze(): void {
    const r = this.rive;
    if (!r) return;
    r.play();
    if (this.frozenTimer) clearTimeout(this.frozenTimer);
    this.frozenTimer = setTimeout(() => this.rive?.pause(), 700);
  }

  setReducedMotion(on: boolean): void {
    void on;
    this.updatePlayState();
  }

  /** Write the visual inputs for the current semantic state. Cheap when nothing changed. */
  apply(inp: WorldInputs): void {
    if (!this.ready) {
      this.pending = inp;
      return;
    }
    this.set('registryUp', inp.registryUp);
    this.set('building', inp.building);
    this.set('storm', inp.storm);
    this.set('level', inp.level);
    this.set('cpuLoad', inp.cpuLoad);
    this.set('memPressure', inp.memPressure);
    this.set('diskFill', inp.diskFill);
    this.set('santa/mood', inp.santaMood);
    this.set('foreman/working', inp.foreman.working);
    this.set('foreman/glow', inp.foreman.glow);
    this.set('runner/working', inp.runner.working);
    this.set('runner/glow', inp.runner.glow);
    inp.slots.forEach((s, i) => {
      const p = `slot${i}/`;
      this.set(p + 'occupied', s.occupied);
      this.set(p + 'status', s.status);
      this.set(p + 'hover', s.hover);
      this.set(p + 'selected', s.selected);
      this.set(p + 'reveal', s.reveal);
      this.set(p + 'pressure', s.pressure);
      this.set(p + 'hasVolume', s.hasVolume);
      this.set(p + 'published', s.published);
      this.set(p + 'networked', s.networked);
      this.setColor(p + 'tint', s.tint);
    });
    if (this.o.reducedMotion()) this.settleThenFreeze();
  }

  private set(path: string, value: number | boolean): void {
    if (this.last.get(path) === value) return;
    const first = !this.last.has(path);
    this.last.set(path, value);
    const v = this.vmi;
    if (!v) return;
    if (typeof value === 'boolean') {
      const p = v.boolean(path);
      if (p) p.value = value;
      return;
    }
    if (TWEEN_KEYS.has(path) && !first && !this.o.reducedMotion()) {
      const t = this.tween.get(path) ?? { cur: v.number(path)?.value ?? value, target: value };
      t.target = value;
      this.tween.set(path, t);
      this.kick();
      return;
    }
    const p = v.number(path);
    if (p) p.value = value;
    this.tween.delete(path);
  }

  private setColor(path: string, argb: number): void {
    if (this.last.get(path) === argb) return;
    this.last.set(path, argb);
    const p = this.vmi?.color(path);
    if (p) p.value = argb;
  }

  private kick(): void {
    if (this.raf) return;
    let prev = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(64, now - prev);
      prev = now;
      const k = 1 - Math.exp(-dt / 140); // ~140 ms time constant
      let live = false;
      for (const [path, t] of this.tween) {
        t.cur += (t.target - t.cur) * k;
        if (Math.abs(t.target - t.cur) < 0.002) {
          t.cur = t.target;
          this.tween.delete(path);
        } else live = true;
        const p = this.vmi?.number(path);
        if (p) p.value = t.cur;
      }
      this.raf = live ? requestAnimationFrame(step) : 0;
    };
    this.raf = requestAnimationFrame(step);
  }

  /**
   * Show only this window of the artboard (the camera). Rive's Layout bounds are
   * the rectangle ON THE CANVAS that the artboard is fitted into, so a crop is:
   * scale the whole artboard up by canvasWidth / windowWidth and shift it so the
   * window's origin lands on the canvas origin.
   */
  setViewport(r: Rect): void {
    this.viewport = r;
    if (!this.rive) return;
    const c = this.o.canvas;
    const s = c.width / r.w;
    const full = r.w >= 1599;
    this.rive.layout = new Layout({
      fit: Fit.Contain,
      alignment: Alignment.Center,
      ...(full ? {} : { minX: -r.x * s, minY: -r.y * s, maxX: (-r.x + 1600) * s, maxY: (-r.y + 900) * s }),
    });
  }

  /** one-shot visual cues; ignored under reduced motion (the caption/toast carries the meaning) */
  fire(name: 'pull' | 'build' | 'shake' | 'santa/wave' | `slot${number}/pulse`): void {
    if (!this.ready || this.o.reducedMotion()) return;
    this.vmi?.trigger(name)?.trigger();
  }

  /** lower the render resolution (cheaper, still sharp enough for vector art) */
  lowerDetail(): void {
    this.dprCap = 1;
    this.resize();
  }

  destroy(): void {
    this.stopWatch();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.io?.disconnect();
    document.removeEventListener('visibilitychange', this.onVis);
    this.rive?.cleanup();
    this.rive = null;
  }
}
