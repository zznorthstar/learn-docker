import { WorldEngine, type Persisted, type Cue } from '../engine/engine';
import { handleTool } from '../engine/tools';
import { parseCommand, runRead, helpText, type Parsed } from '../engine/terminal';
import { SCENARIO_MAP, SCENARIOS } from '../engine/scenarios';
import { diffWorlds } from '../engine/diff';
import { inspectTarget, whyObject } from '../engine/inspect';
import { CONCEPTS } from '../engine/concepts';
import * as graph from '../engine/conceptgraph';
import { PRESETS } from '../engine/world';
import type { Action, Level, Overlay, RevealMode, Target, ViewState, WorldEvent } from '../engine/types';
import { ALL_OVERLAYS } from '../engine/types';
import { RelayClient, type RelayState } from '../relay/client';
import { bearer, loadIdentity, resetIdentity, type LabIdentity } from './identity';
import { deleteLab, loadLab, loadPrefs, savePrefs, saveLab, type Prefs } from './storage';
import type { RiveWorld } from '../render/riveWorld';
import { project, type Transient } from '../render/project';
import { buildScene, SlotAllocator, type Scene } from '../render/scene';
import { overlaySvg } from '../render/overlay';
import { renderShell, renderTopbar, renderStageDom, renderLegend, renderConsequence, renderOverlayRow, renderCamera } from '../ui/shell';
import { Camera, regionRect, type Rect } from '../render/camera';
import { renderSide } from '../ui/inspector';
import { renderDockTabs, renderTimeline, renderEvents, renderTerminalOut, renderLab, renderTermInput } from '../ui/dock';
import { renderModal, snippet } from '../ui/modals';
import { renderPrediction } from '../ui/prediction';
import { esc } from '../ui/h';

export type DockTab = 'timeline' | 'events' | 'terminal' | 'lab';
export type SideTab = 'object' | 'concept' | 'progress';
export type ModalState = null | { kind: 'onboarding'; step: number } | { kind: 'connect' } | { kind: 'scenarios' } | { kind: 'about' };

export interface TermEntry {
  cmd?: string;
  out?: string;
  cls?: 'err' | 'ok' | 'dim';
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'ok' | 'bad';
  until: number;
}

export interface UiState {
  dock: DockTab;
  dockOpen: boolean;
  side: SideTab;
  modal: ModalState;
  hover: Target | null;
  toasts: Toast[];
  banner: { text: string; until: number } | null;
  selectedEvent: number | null;
  whyFor: Target | null;
  showAllEvents: boolean;
  onlyProblems: boolean;
  connectTab: 'claude-code' | 'json' | 'desktop' | 'prompt';
  keyVisible: boolean;
  selfTest: { state: 'idle' | 'running' | 'ok' | 'fail'; msg: string };
  relay: RelayState;
  riveState: 'loading' | 'ready' | 'failed';
  compareOpen: boolean;
  predExpanded: boolean;
  scenarioFilter: string;
}

export interface PokeArg {
  action: Action;
  label?: string;
}

const MCP_PATH = '/mcp';

export class App {
  engine!: WorldEngine;
  identity!: LabIdentity;
  prefs!: Prefs;
  relay: RelayClient | null = null;
  rive: RiveWorld | null = null;
  slots = new SlotAllocator();
  scene!: Scene;
  slotOf = new Map<string, number>();
  ui: UiState = {
    dock: 'timeline',
    dockOpen: true,
    side: 'object',
    modal: null,
    hover: null,
    toasts: [],
    banner: null,
    selectedEvent: null,
    whyFor: null,
    showAllEvents: false,
    onlyProblems: false,
    connectTab: 'claude-code',
    keyVisible: false,
    selfTest: { state: 'idle', msg: '' },
    relay: 'offline',
    riveState: 'loading',
    compareOpen: false,
    predExpanded: false,
    scenarioFilter: '',
  };
  term = { out: [] as TermEntry[], history: [] as string[], hi: -1, parsed: null as Parsed | null, running: false };
  private root!: HTMLElement;
  private raf = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheKeys = new Map<string, string>();
  private cuesSeen = 0;
  private toastId = 0;
  private lastToastedStep = -1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private dragging = false;
  reducedMq: MediaQueryList | null = null;
  fresh = false;
  camera = new Camera((r) => this.applyCamera(r));

  /* ============================================================== boot */

  async boot(root: HTMLElement): Promise<void> {
    this.root = root;
    this.prefs = loadPrefs();
    const { identity, fresh } = loadIdentity();
    this.identity = identity;
    this.fresh = fresh;
    this.ui.dock = (this.prefs.dockTab as DockTab) || 'timeline';
    this.ui.side = (this.prefs.sideTab as SideTab) || 'object';
    this.reducedMq = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;

    // restore the lab from this browser (or start fresh)
    let engine: WorldEngine | null = null;
    const saved = fresh ? null : await loadLab(identity.labId);
    if (saved) {
      try {
        engine = WorldEngine.restore(saved);
      } catch {
        engine = null;
      }
    }
    if (!engine) {
      engine = new WorldEngine();
      if (this.prefs.onboarded) engine.reset('welcome', 'system', 'Starter world');
    }
    this.engine = engine;
    this.engine.setView({ reducedMotion: this.reduced }, 'system');
    this.cuesSeen = this.engine.cues.length;
    if (!this.prefs.onboarded) this.ui.modal = { kind: 'onboarding', step: 0 };

    root.innerHTML = renderShell(this);
    this.bind();
    this.engine.subscribe((r) => {
      if (r === 'cue') this.onCue();
      if (r === 'world' || r === 'timeline') this.onStep();
      this.schedule();
      if (r !== 'link' && r !== 'toast') this.queueSave();
    });
    this.render();
    root.removeAttribute('data-booting');
    this.startRive();
    this.startRelay();
    this.tickTimer = setInterval(() => this.housekeeping(), 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.schedule();
    });
    this.reducedMq?.addEventListener?.('change', () => this.applyReducedMotion());
    this.applyReducedMotion();
  }

  get reduced(): boolean {
    if (this.prefs?.reducedMotion === 'on') return true;
    if (this.prefs?.reducedMotion === 'off') return false;
    return !!this.reducedMq?.matches;
  }

  applyReducedMotion(): void {
    document.documentElement.classList.toggle('reduce-motion', this.reduced);
    this.engine.setView({ reducedMotion: this.reduced }, 'system');
    this.rive?.setReducedMotion(this.reduced);
    this.schedule();
  }

  /* ============================================================ rive/relay */

  private startRive(): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>('#rive-canvas');
    if (!canvas) return;
    const start = async (): Promise<void> => {
      // the Rive runtime is ~0.5 MB: load it after first paint, behind the poster
      const { RiveWorld } = await import('../render/riveWorld');
      this.rive = new RiveWorld({
        canvas,
        src: '/rive/docker-world.riv',
        reducedMotion: () => this.reduced,
        onSlow: () => {
          if (this.prefs.quality !== 'low') {
            this.rive?.lowerDetail();
            this.toast('Frames were falling behind, so the scene switched to low detail.', 'info');
          }
        },
        onReady: () => {
          if (this.prefs.quality === 'low') this.rive?.lowerDetail();
          this.ui.riveState = 'ready';
          this.root.querySelector('.stage')?.setAttribute('data-rive', 'ready');
          this.schedule();
        },
        onFail: () => {
          this.ui.riveState = 'failed';
          this.root.querySelector('.stage')?.setAttribute('data-rive', 'failed');
          this.schedule();
        },
      });
    };
    // the poster is already on screen: load the runtime when the browser is idle
    if ('requestIdleCallback' in window) (window as unknown as { requestIdleCallback: (f: () => void, o: { timeout: number }) => void }).requestIdleCallback(() => void start(), { timeout: 1200 });
    else setTimeout(() => void start(), 200);
  }

  startRelay(): void {
    this.relay?.stop();
    const base = location.origin.replace(/^http/, 'ws');
    this.relay = new RelayClient({
      base,
      lab: this.identity.labId,
      secret: this.identity.secret,
      onCall: (tool, args) => {
        if (!this.selfTestActive) {
          this.engine.link.agent = true;
          this.engine.link.lastMcpAt = Date.now();
        }
        const r = handleTool(this.engine, tool, args);
        this.engine.emit('link');
        return { text: JSON.stringify(r.data), isError: r.isError };
      },
      onState: (s) => {
        this.ui.relay = s;
        this.engine.link.state = s === 'online' ? 'online' : s === 'connecting' ? 'connecting' : 'offline';
        this.schedule();
      },
      onMcp: (client, at) => {
        if (this.selfTestActive) return;
        this.engine.link.agent = true;
        this.engine.link.lastMcpAt = at;
        this.engine.link.lastMcpClient = client;
        this.toast(`${client} connected to your lab`, 'ok');
        this.engine.emit('link');
      },
      onReady: (last) => {
        if (last) {
          this.engine.link.lastMcpAt = last;
          this.engine.link.agent = true;
        }
      },
    });
    this.relay.start();
  }

  get mcpUrl(): string {
    return location.origin + MCP_PATH;
  }

  get bearerKey(): string {
    return bearer(this.identity);
  }

  /* ============================================================= effects */

  private onStep(): void {
    const e = this.engine;
    if (e.view.selected && e.atEnd && !inspectTarget(e.world, e.view.selected, 0)) e.setView({ selected: null }, 'system');
    const last = e.steps[e.steps.length - 1]!;
    if (e.cursor === e.steps.length - 1 && last.index !== this.lastToastedStep && last.index > 0) {
      this.lastToastedStep = last.index;
      this.lastActionAt = Date.now();
      const evs = e.events.filter((x) => x.step === last.index);
      if (evs.some((x) => x.severity === 'error')) this.troubleUntil = Date.now() + 5000;
      if (last.ops.some((o) => o.type === 'action' && o.action.action === 'build_image')) this.buildUntil = Date.now() + 3200;
      if (last.source === 'ai') this.toast(`AI: ${last.label}`, last.ok ? 'info' : 'bad');
      const live = document.getElementById('live');
      if (live && evs.length) live.textContent = `${last.source === 'ai' ? 'AI: ' : ''}${last.label}. ${evs.slice(-2).map((x) => x.summary).join(' ')}`;
    }
  }

  /** true while the page is calling its own MCP endpoint (so it is not mistaken for a real AI) */
  selfTestActive = false;
  lastActionAt = 0;
  troubleUntil = 0;
  buildUntil = 0;
  showRequestUntil = 0;

  private onCue(): void {
    const cues = this.engine.cues;
    for (let i = this.cuesSeen; i < cues.length; i++) this.playCue(cues[i]!);
    this.cuesSeen = cues.length;
  }

  private playCue(c: Cue): void {
    switch (c.kind) {
      case 'wave':
        this.rive?.fire('santa/wave');
        this.ui.banner = this.selfTestActive
          ? { text: 'Self-test passed: browser → relay → this page → Santa.', until: Date.now() + 5000 }
          : { text: 'Your AI is connected. Santa says hi.', until: Date.now() + 6500 };
        break;
      case 'pull':
        this.rive?.fire('pull');
        break;
      case 'build':
        this.rive?.fire('build');
        break;
      case 'shake':
        this.rive?.fire('shake');
        break;
      case 'netpulse':
        this.showRequestUntil = Date.now() + 7000;
        break;
      case 'focus':
        if (c.target?.startsWith('container:')) {
          const i = this.slotOf.get(c.target.slice(10));
          if (i !== undefined) this.rive?.fire(`slot${i}/pulse`);
        }
        break;
    }
  }

  toast(text: string, tone: Toast['tone'] = 'info'): void {
    this.ui.toasts.push({ id: ++this.toastId, text, tone, until: Date.now() + 4200 });
    if (this.ui.toasts.length > 4) this.ui.toasts.shift();
    this.schedule();
  }

  private housekeeping(): void {
    const now = Date.now();
    const before = this.ui.toasts.length;
    this.ui.toasts = this.ui.toasts.filter((t) => t.until > now);
    let changed = before !== this.ui.toasts.length;
    if (this.ui.banner && this.ui.banner.until < now) {
      this.ui.banner = null;
      changed = true;
    }
    if (this.engine.caption && now - this.engine.caption.at > 15000) {
      this.engine.caption = null;
      changed = true;
    }
    const wasTrouble = this.troubleUntil > 0 && this.troubleUntil < now;
    if (wasTrouble || (this.lastActionAt && now - this.lastActionAt > 2600 && now - this.lastActionAt < 3700)) {
      if (wasTrouble) this.troubleUntil = 0;
      changed = true;
    }
    if (this.engine.view.timeFlows && this.engine.atEnd) {
      this.engine.dispatch({ action: 'advance_time', ticks: 1 }, 'system', 'time passes');
      changed = false;
    }
    if (changed) this.schedule();
  }

  /* =========================================================== persistence */

  private queueSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void saveLab(this.identity.labId, this.engine.serialize() as Persisted), 500);
  }

  setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
    this.prefs = { ...this.prefs, [k]: v };
    savePrefs(this.prefs);
  }

  /* ============================================================== render */

  schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private cameraStarted = false;

  /** the visible window moved: update the Rive viewport, the SVG overlay and the hit targets together */
  private applyCamera(r: Rect): void {
    this.root?.querySelector('#overlay')?.setAttribute('viewBox', `${r.x.toFixed(1)} ${r.y.toFixed(1)} ${r.w.toFixed(1)} ${r.h.toFixed(1)}`);
    this.rive?.setViewport(r);
    this.layoutHits(r);
  }

  private layoutHits(r: Rect): void {
    this.root?.querySelectorAll<HTMLElement>('.hits button[data-box]').forEach((b) => {
      const [x, y, w, h] = b.dataset.box!.split(',').map(Number) as [number, number, number, number];
      const st = b.style;
      st.left = `${(((x - r.x) / r.w) * 100).toFixed(3)}%`;
      st.top = `${(((y - r.y) / r.h) * 100).toFixed(3)}%`;
      st.width = `${((w / r.w) * 100).toFixed(3)}%`;
      st.height = `${((h / r.h) * 100).toFixed(3)}%`;
    });
  }

  /** render now (cancels any pending frame) */
  flush(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.render();
  }

  /** set innerHTML only when it actually changed; keeps keyboard focus where the user left it */
  private put(id: string, html: string): void {
    if (this.cacheKeys.get(id) === html) return;
    const el = this.root.querySelector(id.startsWith('#') ? id : '#' + id);
    if (!el) return;
    const ae = document.activeElement as HTMLElement | null;
    let key: { sel: string } | null = null;
    if (ae && ae !== document.body && el.contains(ae)) {
      const d = ae.dataset;
      if (d.hover && d.act) key = { sel: `[data-hover="${CSS.escape(d.hover)}"][data-act="${d.act}"]` };
      else if (d.act) key = { sel: `[data-act="${d.act}"]${d.arg !== undefined ? `[data-arg="${CSS.escape(d.arg)}"]` : ''}` };
      else if (d.live) key = { sel: `[data-live="${d.live}"]${d.arg ? `[data-arg="${CSS.escape(d.arg)}"]` : ''}` };
      else if (ae.getAttribute('role') === 'radio' || ae.getAttribute('role') === 'tab') key = null;
    }
    el.innerHTML = html;
    this.cacheKeys.set(id, html);
    if (key) (el.querySelector(key.sel) as HTMLElement | null)?.focus({ preventScroll: true });
  }

  get transient(): Transient {
    const now = Date.now();
    return {
      trouble: this.troubleUntil > now,
      busy: now - this.lastActionAt < 2600,
      building: this.buildUntil > now,
      engine: false,
    };
  }

  get compact(): boolean {
    return this.root.clientWidth < 760;
  }

  render(): void {
    const e = this.engine;
    const w = e.world;
    const { slotOf, overflow } = this.slots.assign(w);
    this.slotOf = slotOf;
    this.scene = buildScene(w, slotOf, overflow);

    if (!this.dragging) this.put('#topbar', renderTopbar(this));
    this.put('#side', renderSide(this));
    this.put('#dock-tabs', renderDockTabs(this));
    this.put('#consequence', renderConsequence(this));
    this.put('#legend', renderLegend(this));
    this.put('#overlay-row', renderOverlayRow(this));
    this.put('#stage-cam', renderCamera(this));
    this.root.querySelector('#dock')?.classList.toggle('collapsed', !this.ui.dockOpen);
    this.put('#prediction', renderPrediction(this));
    this.put('#stage-dom', renderStageDom(this));
    this.renderCaption();
    const modal = renderModal(this);
    this.put('#modal', modal);

    // dock panels: persistent containers, only the visible one renders
    const tab = this.ui.dock;
    this.root.querySelectorAll<HTMLElement>('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
    if (tab === 'timeline' && !this.dragging) this.put('#panel-timeline', renderTimeline(this));
    if (tab === 'events') this.put('#panel-events', renderEvents(this));
    if (tab === 'lab' && !this.dragging) this.put('#panel-lab', renderLab(this));
    if (tab === 'terminal') {
      this.put('#term-out', renderTerminalOut(this));
      const out = this.root.querySelector('#term-out');
      if (out && this.cacheKeys.get('#term-scroll') !== String(this.term.out.length)) {
        out.scrollTop = out.scrollHeight;
        this.cacheKeys.set('#term-scroll', String(this.term.out.length));
      }
    }
    this.put('#toasts', this.ui.toasts.map((t) => `<div class="toast ${t.tone}" role="status">${esc(t.text)}</div>`).join(''));

    // stage: overlay svg + rive inputs
    const svg = this.root.querySelector<SVGSVGElement>('#overlay');
    if (svg) {
      const markup = overlaySvg({ w, view: e.view, scene: this.scene, slotOf, recent: e.visibleEvents.filter((x) => x.step === e.cursor), hover: this.ui.hover, compact: this.compact, showRequest: this.showRequestUntil > Date.now() });
      if (this.cacheKeys.get('#overlay') !== markup) {
        svg.innerHTML = markup;
        this.cacheKeys.set('#overlay', markup);
      }
    }
    this.camera.set(regionRect(e.view.region, e.view.zoom), this.reduced || !this.cameraStarted);
    this.cameraStarted = true;
    this.layoutHits(this.camera.cur);
    this.rive?.apply(project(w, e.view, slotOf, this.ui.hover, this.transient));
    this.scheduleExpiry();
  }

  private renderCaption(): void {
    const c = this.engine.caption;
    const b = this.ui.banner;
    const html = `${b ? `<div class="banner" role="status"><span class="dot ok pulse"></span>${esc(b.text)}</div>` : ''}${c ? `<div class="caption" role="status"><span class="who">your AI</span><span>${esc(c.text)}</span></div>` : ''}`;
    this.put('#stage-msg', html);
  }

  private scheduleExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    const now = Date.now();
    const next = Math.min(...[this.troubleUntil, this.buildUntil, this.lastActionAt + 2700, this.showRequestUntil].filter((t) => t > now).concat([now + 60000]));
    this.expiry = setTimeout(() => this.schedule(), Math.max(80, next - now + 30));
  }

  /* ========================================================== interaction */

  private bind(): void {
    const r = this.root;
    r.addEventListener('click', (ev) => {
      const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
      if (!el) return;
      const act = el.dataset.act!;
      const arg = el.dataset.arg;
      this.act(act, arg, el, ev);
      this.flush(); // user clicks render immediately: no frame of stale UI
    });
    r.addEventListener('input', (ev) => {
      const el = ev.target as HTMLInputElement;
      if (el.dataset.live === 'term') this.onTermInput(el.value);
      if (el.dataset.live === 'dial') this.onDialInput(el);
      if (el.dataset.live === 'level') this.engine.setView({ level: Number(el.value) as Level });
      if (el.dataset.live === 'scrub') this.engine.rewind(Number(el.value));
    });
    r.addEventListener('change', (ev) => {
      const el = ev.target as HTMLInputElement;
      if (el.dataset.live === 'dial') this.onDialCommit(el);
      this.dragging = false;
      if (el.dataset.live === 'filter') {
        if (el.dataset.arg === 'all') this.ui.showAllEvents = el.checked;
        if (el.dataset.arg === 'problems') this.ui.onlyProblems = el.checked;
        this.schedule();
      }
    });
    r.addEventListener('pointerdown', (ev) => {
      if ((ev.target as HTMLElement).matches?.('input[type=range]')) this.dragging = true;
    });
    window.addEventListener('pointerup', () => {
      if (this.dragging) {
        this.dragging = false;
        this.schedule();
      }
    });
    document.addEventListener('keydown', (ev) => this.onKey(ev));
    r.addEventListener('mouseover', (ev) => {
      const el = (ev.target as Element).closest<HTMLElement>('[data-hover]');
      const t = el?.dataset.hover ?? null;
      if (t !== this.ui.hover) {
        this.ui.hover = t;
        this.schedule();
      }
    });
    r.addEventListener('mouseleave', () => {
      if (this.ui.hover) {
        this.ui.hover = null;
        this.schedule();
      }
    });
    r.addEventListener('focusin', (ev) => {
      const el = (ev.target as Element).closest<HTMLElement>('[data-hover]');
      if (el) {
        this.ui.hover = el.dataset.hover ?? null;
        this.schedule();
      }
    });
    window.addEventListener('resize', () => {
      this.cacheKeys.delete('#overlay');
      this.schedule();
    });
  }

  private onKey(ev: KeyboardEvent): void {
    const tgt = ev.target as HTMLElement;
    const typing = tgt.matches?.('input[type=text], input:not([type]), textarea');
    if (ev.key === 'Escape') {
      if (this.ui.modal) this.closeModal();
      else if (this.engine.view.compare) this.engine.setView({ compare: null });
      else if (this.engine.view.selected) this.engine.select(null);
      return;
    }
    if (typing) {
      if (tgt.dataset.live === 'term') this.onTermKey(ev);
      return;
    }
    if (this.ui.modal) return;
    if (ev.key === '[') this.setLevel(Math.max(0, this.engine.view.level - 1) as Level);
    else if (ev.key === ']') this.setLevel(Math.min(6, this.engine.view.level + 1) as Level);
    else if (ev.key === ',') this.engine.stepBack();
    else if (ev.key === '.') this.engine.stepForward();
    else if (ev.key === '0') this.engine.setView({ region: 'overview', zoom: 1 });
    else if (ev.key === '/') {
      ev.preventDefault();
      this.openTerminal();
    }
  }

  act(name: string, arg: string | undefined, el: HTMLElement, ev?: Event): void {
    const e = this.engine;
    switch (name) {
      case 'select':
        e.select(arg as Target);
        this.ui.side = 'object';
        this.ui.whyFor = null;
        this.setPref('sideTab', 'object');
        break;
      case 'deselect':
        e.select(null);
        break;
      case 'level':
        this.setLevel(Number(arg) as Level);
        break;
      case 'region':
        e.setView({ region: arg as ViewState['region'], zoom: 1 });
        e.note('view', `moved the camera to ${arg}`);
        break;
      case 'zoom':
        e.setView({ zoom: Math.max(0.5, Math.min(4, e.view.zoom * (Number(arg) > 0 ? 1.4 : 1 / 1.4))) });
        break;
      case 'deeper':
        this.setLevel(Math.min(6, e.view.level + 1) as Level);
        break;
      case 'shallower':
        this.setLevel(Math.max(0, e.view.level - 1) as Level);
        break;
      case 'dock-toggle':
        this.ui.dockOpen = !this.ui.dockOpen;
        this.schedule();
        setTimeout(() => this.rive?.resize(), 50);
        break;
      case 'dock':
        this.ui.dockOpen = true;
        this.ui.dock = arg as DockTab;
        this.setPref('dockTab', arg!);
        this.schedule();
        if (arg === 'terminal') setTimeout(() => this.root.querySelector<HTMLInputElement>('#term-input')?.focus(), 30);
        break;
      case 'side':
        this.ui.side = arg as SideTab;
        this.setPref('sideTab', arg!);
        this.schedule();
        break;
      case 'lab-mode':
        e.setView({ labMode: !e.view.labMode });
        if (e.view.labMode) {
          this.ui.dock = 'lab';
          this.setPref('dockTab', 'lab');
        }
        break;
      case 'overlay': {
        const o = arg as Overlay;
        const cur = new Set(e.view.overlays);
        cur.has(o) ? cur.delete(o) : cur.add(o);
        e.setOverlays(ALL_OVERLAYS.filter((x) => cur.has(x)));
        break;
      }
      case 'rewind':
        e.rewind(Number(arg));
        break;
      case 'back':
        e.stepBack();
        break;
      case 'fwd':
        e.stepForward();
        break;
      case 'now':
        e.rewind(e.steps.length - 1);
        break;
      case 'poke': {
        const p = JSON.parse(arg!) as PokeArg;
        const r = e.dispatch(p.action, 'user', p.label);
        if (!r.ok) this.toast(r.error ?? 'That did not work', 'bad');
        this.ui.dock = this.ui.dock === 'lab' ? 'lab' : 'events';
        break;
      }
      case 'why':
        this.ui.whyFor = (arg || e.view.selected) as Target;
        this.ui.side = 'object';
        e.note('inspect', `asked WHY about ${this.ui.whyFor}`, this.ui.whyFor ?? undefined);
        this.schedule();
        break;
      case 'reveal': {
        const mode = arg as RevealMode;
        const sel = e.view.selected;
        const root = e.view.focusConcept ?? (sel ? graph.conceptsForTarget(sel)[0] : undefined) ?? 'container';
        e.setView({ reveal: { mode, root }, focusConcept: root });
        e.touchConcept(root, e.view.level, true);
        for (const n of graph.reveal(mode, root).nodes) e.touchConcept(n, e.view.level, false);
        e.note('focus', `revealed "${mode.replace('_', ' ')}" from ${root}`, root);
        if (mode === 'depends_on' || mode === 'depended_by' || mode === 'used_by' || mode === 'follow') {
          if (sel && !e.view.overlays.includes('dependencies')) e.setOverlays([...e.view.overlays, 'dependencies']);
        }
        this.ui.side = mode === 'used_by' || mode === 'depends_on' || mode === 'follow' || mode === 'depended_by' ? 'object' : 'concept';
        if (mode === 'why' || mode === 'made_of' || mode === 'to_kernel' || mode === 'to_ecosystem') this.ui.side = 'concept';
        this.schedule();
        break;
      }
      case 'concept':
        e.setView({ focusConcept: arg!, reveal: { mode: e.view.reveal?.mode ?? 'follow', root: arg! } });
        e.touchConcept(arg!, e.view.level, true);
        this.ui.side = 'concept';
        break;
      case 'compare':
        e.setView({ compare: { a: Math.max(0, e.cursor - 1), b: e.cursor } });
        this.ui.compareOpen = true;
        this.schedule();
        break;
      case 'close-compare':
        e.setView({ compare: null });
        this.ui.compareOpen = false;
        break;
      case 'event': {
        const id = Number(arg);
        this.ui.selectedEvent = this.ui.selectedEvent === id ? null : id;
        const ev0 = e.events.find((x) => x.id === id);
        if (ev0 && (ev0.target === 'host' || /^(container|image|volume|network|daemon|registry|build):/.test(ev0.target))) e.setView({ selected: ev0.target });
        this.schedule();
        break;
      }
      case 'modal':
        this.ui.modal = arg === 'onboarding' ? { kind: 'onboarding', step: 0 } : ({ kind: arg } as ModalState);
        if (arg === 'connect') this.ui.selfTest = { state: 'idle', msg: '' };
        this.schedule();
        break;
      case 'close-modal':
        this.closeModal();
        break;
      case 'onb-next': {
        const m = this.ui.modal;
        if (m?.kind === 'onboarding') {
          const next = m.step + 1;
          if (next >= 4) this.finishOnboarding();
          else {
            this.ui.modal = { kind: 'onboarding', step: next };
            if (next === 1 && Object.keys(e.world.containers).length === 0) e.reset('welcome', 'system', 'Starter world');
          }
        }
        this.schedule();
        break;
      }
      case 'onb-back': {
        const m = this.ui.modal;
        if (m?.kind === 'onboarding') this.ui.modal = { kind: 'onboarding', step: Math.max(0, m.step - 1) };
        this.schedule();
        break;
      }
      case 'onb-skip':
        this.finishOnboarding();
        break;
      case 'connect-tab':
        this.ui.connectTab = arg as UiState['connectTab'];
        this.schedule();
        break;
      case 'key-toggle':
        this.ui.keyVisible = !this.ui.keyVisible;
        this.schedule();
        break;
      case 'copy':
        void this.copy(snippet(this, arg ?? ''), el);
        break;
      case 'close-modal-scrim':
        if (this.ui.modal?.kind !== 'onboarding') this.closeModal();
        break;
      case 'copy-id':
        void this.copy(el.dataset.text ?? '', el);
        break;
      case 'selftest':
        void this.selfTest();
        break;
      case 'new-lab':
        void this.newLab();
        break;
      case 'preset':
        e.reset(arg!, 'user');
        this.toast(`World reset: ${PRESETS[arg!]?.label ?? arg}`);
        break;
      case 'scenario-run':
        this.runScenario(arg!, false);
        break;
      case 'scenario-predict':
        this.runScenario(arg!, true);
        break;
      case 'predict-pick':
        e.answerPrediction(el.dataset.pid!, arg!);
        break;
      case 'predict-run':
        this.ui.predExpanded = false;
        e.runPrediction(arg!, 'user');
        break;
      case 'pred-expand':
        this.ui.predExpanded = !this.ui.predExpanded;
        break;
      case 'predict-dismiss':
        e.cancelPrediction();
        break;
      case 'predict-rewind': {
        const p = e.predictions.find((x) => x.id === arg);
        if (p?.resultStep !== undefined) e.rewind(Math.max(0, p.resultStep - 1));
        break;
      }
      case 'quality':
        this.setPref('quality', arg as Prefs['quality']);
        if (arg === 'low') this.rive?.lowerDetail();
        else this.toast('Full detail applies on the next reload.');
        break;
      case 'motion':
        this.setPref('reducedMotion', (arg as Prefs['reducedMotion']) ?? 'auto');
        this.applyReducedMotion();
        break;
      case 'time-flow':
        e.setView({ timeFlows: !e.view.timeFlows });
        break;
      case 'term-suggest': {
        const inp = this.root.querySelector<HTMLInputElement>('#term-input');
        if (inp) {
          inp.value = arg ?? '';
          this.onTermInput(inp.value);
          inp.focus();
        }
        break;
      }
      case 'term-clear':
        this.term.out = [];
        this.schedule();
        break;
      case 'say-clear':
        e.say(null);
        break;
      case 'noop':
        break;
      default:
        break;
    }
    void ev;
  }

  setLevel(l: Level): void {
    this.engine.setView({ level: l });
  }

  closeModal(): void {
    if (this.ui.modal?.kind === 'onboarding') this.finishOnboarding();
    else {
      this.ui.modal = null;
      this.schedule();
    }
  }

  private finishOnboarding(): void {
    this.setPref('onboarded', true);
    this.ui.modal = null;
    if (Object.keys(this.engine.world.containers).length === 0 && this.engine.steps.length <= 1) this.engine.reset('welcome', 'system', 'Starter world');
    this.schedule();
  }

  openTerminal(): void {
    this.ui.dock = 'terminal';
    this.setPref('dockTab', 'terminal');
    this.schedule();
    setTimeout(() => this.root.querySelector<HTMLInputElement>('#term-input')?.focus(), 30);
  }

  async copy(text: string, el: HTMLElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* ignore */
      }
      ta.remove();
    }
    const prev = el.innerHTML;
    el.setAttribute('aria-live', 'polite');
    el.textContent = 'Copied';
    setTimeout(() => (el.innerHTML = prev), 1200);
  }

  /** a real end-to-end test through the relay: the page plays the role of an MCP client */
  async selfTest(): Promise<void> {
    this.ui.selfTest = { state: 'running', msg: 'Calling your own MCP endpoint through the relay…' };
    this.selfTestActive = true;
    this.schedule();
    const post = async (body: unknown): Promise<{ status: number; json: any }> => {
      const r = await fetch(this.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.bearerKey}` }, body: JSON.stringify(body) });
      const t = await r.text();
      return { status: r.status, json: t ? JSON.parse(t) : null };
    };
    try {
      if (this.ui.relay !== 'online') throw new Error('The browser is not connected to the relay yet (see the status above).');
      const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'whale-lab self-test', version: '1' } } });
      if (init.status !== 200) throw new Error(`initialize returned HTTP ${init.status}`);
      const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'world_connection_test', arguments: {} } });
      if (call.status !== 200 || call.json?.result?.isError) throw new Error('tool call failed: ' + JSON.stringify(call.json).slice(0, 160));
      this.ui.selfTest = { state: 'ok', msg: 'Round trip works: HTTP → relay → this browser → Santa waved.' };
    } catch (e) {
      this.ui.selfTest = { state: 'fail', msg: (e as Error).message };
    } finally {
      setTimeout(() => (this.selfTestActive = false), 800);
    }
    this.schedule();
  }

  async newLab(): Promise<void> {
    if (!confirm('Start a brand-new lab? This creates a new lab id and key. Your current lab stays in this browser only until you clear it, but your AI will need the new key.')) return;
    await deleteLab(this.identity.labId);
    this.identity = resetIdentity();
    this.engine = new WorldEngine();
    this.engine.reset('welcome', 'system', 'Starter world');
    this.engine.subscribe((r) => {
      if (r === 'cue') this.onCue();
      if (r === 'world' || r === 'timeline') this.onStep();
      this.schedule();
      this.queueSave();
    });
    this.slots = new SlotAllocator();
    this.cuesSeen = 0;
    this.startRelay();
    this.toast('New lab created. Copy the new key from Connect.', 'ok');
    this.schedule();
  }

  runScenario(id: string, predict: boolean): void {
    const s = SCENARIO_MAP[id];
    if (!s) return;
    this.ui.modal = null;
    if (predict) {
      this.engine.createPrediction({ question: s.ask.question, options: s.ask.options, answerId: s.ask.answer, explanation: s.ask.explanation, scenario: s.id, concepts: s.concepts }, 'user');
      this.toast('The baseline is set. Make your prediction on the stage.');
    } else {
      this.engine.runScenario(s, { source: 'user' });
      this.ui.dock = 'events';
      this.toast(`Ran: ${s.title}`);
    }
    this.schedule();
  }

  /* =============================================================== lab */

  private onDialInput(el: HTMLInputElement): void {
    const out = this.root.querySelector<HTMLElement>(`[data-val="${el.dataset.arg}"]`);
    if (out) out.textContent = dialLabel(el.dataset.arg!, Number(el.value));
  }

  private onDialCommit(el: HTMLInputElement): void {
    const key = el.dataset.arg!;
    const v = Number(el.value);
    const map: Record<string, Action> = {
      latency: { action: 'set_condition', condition: 'latency', value: v },
      loss: { action: 'set_condition', condition: 'packet_loss', value: v },
      bandwidth: { action: 'set_condition', condition: 'bandwidth', value: v },
      cpu: { action: 'set_condition', condition: 'cpu_load', value: v },
      mem: { action: 'set_condition', condition: 'memory_pressure', value: v },
      disk: { action: 'set_condition', condition: 'disk_available', value: v },
    };
    const a = map[key];
    if (a) this.engine.dispatch(a, 'user');
    else if (key.startsWith('ctr-mem:')) {
      const c = key.slice(8);
      this.engine.dispatch({ action: 'set_resource_limit', target: `container:${c}`, resource: 'memory', value: v === 0 ? null : `${v}MB` }, 'user');
    } else if (key.startsWith('ctr-cpu:')) {
      this.engine.dispatch({ action: 'set_resource_limit', target: `container:${key.slice(8)}`, resource: 'cpu', value: v === 0 ? null : v }, 'user');
    }
    this.dragging = false;
  }

  /* ========================================================== terminal */

  private onTermInput(value: string): void {
    this.term.parsed = value.trim() ? parseCommand(this.engine.world, value) : null;
    const decomp = this.root.querySelector<HTMLElement>('#term-decomp');
    if (decomp) decomp.innerHTML = renderTermInput(this);
  }

  private onTermKey(ev: KeyboardEvent): void {
    const input = ev.target as HTMLInputElement;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void this.runTerminal(input.value);
      input.value = '';
      this.term.parsed = null;
      this.onTermInput('');
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      const h = this.term.history;
      this.term.hi = Math.min(h.length - 1, this.term.hi + 1);
      input.value = h[h.length - 1 - this.term.hi] ?? input.value;
      this.onTermInput(input.value);
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      const h = this.term.history;
      this.term.hi = Math.max(-1, this.term.hi - 1);
      input.value = this.term.hi < 0 ? '' : (h[h.length - 1 - this.term.hi] ?? '');
      this.onTermInput(input.value);
    }
  }

  /** Execute: highlight each semantic part in turn, then perform the plan against the world. */
  async runTerminal(line: string): Promise<void> {
    const raw = line.trim();
    if (!raw) return;
    const e = this.engine;
    this.term.history.push(raw);
    this.term.hi = -1;
    const parsed = parseCommand(e.world, raw);
    e.note('terminal', `ran in the terminal: ${raw}`);
    this.term.out.push({ cmd: raw });
    if (parsed.local === 'clear') {
      this.term.out = [];
      this.schedule();
      return;
    }
    if (parsed.local === 'help') {
      this.term.out.push({ out: helpText(), cls: 'dim' });
      this.schedule();
      return;
    }
    if (parsed.error) {
      this.term.out.push({ out: parsed.error, cls: 'err' });
      this.schedule();
      return;
    }
    // light up each part of the command in order (skipped under reduced motion)
    if (!this.reduced && parsed.segs.length) {
      this.term.running = true;
      const decomp = this.root.querySelector<HTMLElement>('#term-decomp');
      decomp?.replaceChildren();
      if (decomp) decomp.innerHTML = renderTermInput(this, parsed);
      const chips = decomp?.querySelectorAll<HTMLElement>('.seg') ?? [];
      for (const c of chips) {
        c.classList.add('lit');
        await new Promise((r) => setTimeout(r, 130));
      }
      await new Promise((r) => setTimeout(r, 160));
      this.term.running = false;
    }
    if (parsed.read) {
      const out = runRead(e.world, parsed, e.visibleEvents);
      this.term.out.push({ out: out || '(nothing to show)' });
      e.note('inspect', `read-only: ${raw}`);
      this.schedule();
      return;
    }
    if (parsed.plan.length) {
      const results = e.dispatchMany(raw, parsed.plan, 'user');
      for (const r of results) {
        if (r.ok) this.term.out.push({ out: r.output ?? '', cls: 'ok' });
        else this.term.out.push({ out: `Error response from daemon: ${r.error}`, cls: 'err' });
      }
      if (parsed.autoRemove) {
        const name = (parsed.plan[0] as { name?: string }).name;
        if (name && e.world.containers[name]?.state === 'exited') e.dispatch({ action: 'remove_container', target: `container:${name}` }, 'user', `docker rm ${name} (--rm)`);
      }
      const w = e.world;
      void w;
      this.ui.dock = 'terminal';
    }
    this.schedule();
  }

  /* ====================================================== derived views */

  /** why-block for the selected/asked object */
  whyOf(t: Target): { headline: string; chain: WorldEvent[] } {
    return whyObject(this.engine.world, t, this.engine.visibleEvents);
  }

  compareDiff(): ReturnType<typeof diffWorlds> {
    const c = this.engine.view.compare;
    if (!c) return [];
    const a = this.engine.stepAt(c.a);
    const b = this.engine.stepAt(c.b);
    return a && b ? diffWorlds(a.world, b.world) : [];
  }

  conceptFocus(): string | null {
    const v = this.engine.view;
    return v.focusConcept ?? (v.selected ? (graph.conceptsForTarget(v.selected)[0] ?? null) : null);
  }

  scenarios = SCENARIOS;
  concepts = CONCEPTS;
}

export function dialLabel(key: string, v: number): string {
  switch (key) {
    case 'latency':
      return `${v} ms`;
    case 'loss':
      return `${v}%`;
    case 'bandwidth':
      return v >= 100 ? `${v} Mbps` : `${v} Mbps`;
    case 'cpu':
      return `${v}%`;
    case 'mem':
      return `${v} MB`;
    case 'disk':
      return v >= 1024 ? `${(v / 1024).toFixed(1)} GB free` : `${v} MB free`;
    default:
      if (key.startsWith('ctr-mem:')) return v === 0 ? 'no limit' : `${v} MB`;
      if (key.startsWith('ctr-cpu:')) return v === 0 ? 'no limit' : `${v} cores`;
      return String(v);
  }
}
