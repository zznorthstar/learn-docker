import type { App } from '../app/app';
import { ALL_OVERLAYS, LEVEL_NAMES, type Level, type Overlay, type WorldEvent } from '../engine/types';
import { LAYOUT, DECK_Y } from '../render/scene';
import { icon, whaleLogo, esc } from './h';
import { PAL } from '../render/palette';
import { REGION_LABEL } from '../render/camera';
import type { Region } from '../engine/types';

const LEVEL_SHORT = ['Story', 'Objects', 'Engine', 'Process', 'Kernel', 'OCI', 'World'];

/** The static skeleton. Everything inside the regions is rendered by the panels. */
export function renderShell(app: App): string {
  void app;
  return `
  <a class="skip" href="#side">Skip to the inspector</a>
  <header class="topbar" id="topbar"></header>
  <div class="main">
    <section class="left">
      <div class="stage-wrap">
        <div class="stage" id="stage" data-rive="loading" role="group" aria-label="The Docker world: a flying whale (the host) carrying containers">
          <img class="poster" src="/poster.webp" alt="" decoding="async" fetchpriority="high" />
          <canvas id="rive-canvas" aria-hidden="true"></canvas>
          <svg id="overlay" class="overlay" viewBox="0 0 ${LAYOUT.artboard.w} ${LAYOUT.artboard.h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"></svg>
          <div id="stage-dom" class="hits"></div>
          <div id="stage-msg"></div>
          <div id="stage-cam" class="stage-cam"></div>
          <div id="legend"></div>
        </div>
      </div>
      <div id="prediction" class="predict-slot"></div>
      <div id="overlay-row" class="overlay-row" role="group" aria-label="Overlays: show one system of relationships"></div>
      <div id="consequence"></div>
      <section class="dock" id="dock" aria-label="Timeline, events, terminal and lab">
        <div class="tabs" id="dock-tabs"></div>
        <div class="panel" data-panel="timeline" id="panel-timeline" role="tabpanel"></div>
        <div class="panel" data-panel="events" id="panel-events" role="tabpanel" hidden></div>
        <div class="panel flush" data-panel="terminal" role="tabpanel" hidden>
          <div class="term">
            <div class="term-out" id="term-out" tabindex="0" aria-label="Terminal output"></div>
            <div class="term-in">
              <div class="term-line"><span class="ps" aria-hidden="true">$</span><input id="term-input" data-live="term" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Docker command" placeholder="docker run -d --name web -p 8080:80 nginx" /></div>
              <div class="decomp" id="term-decomp" aria-live="polite"></div>
            </div>
          </div>
        </div>
        <div class="panel" data-panel="lab" id="panel-lab" role="tabpanel" hidden></div>
      </section>
    </section>
    <aside class="side" id="side" aria-label="Inspector" tabindex="-1"></aside>
  </div>
  <div id="modal"></div>
  <div class="toasts" id="toasts" aria-live="polite"></div>`;
}

export function renderTopbar(app: App): string {
  const e = app.engine;
  const v = e.view;
  const link = e.link;
  const relay = app.ui.relay;
  let label = 'Connect your AI';
  let dot = 'warn';
  let cls = 'btn primary';
  if (relay === 'connecting') {
    label = 'Connecting…';
    dot = 'warn pulse';
    cls = 'btn';
  } else if (relay === 'replaced') {
    label = 'Open in another tab';
    dot = 'bad';
    cls = 'btn';
  } else if (relay === 'rejected') {
    label = 'Key rejected';
    dot = 'bad';
    cls = 'btn';
  } else if (relay === 'offline') {
    label = 'Offline';
    dot = 'bad';
    cls = 'btn';
  } else if (link.agent) {
    label = link.lastMcpClient ? `AI connected · ${link.lastMcpClient}` : 'AI connected';
    dot = 'ok';
    cls = 'btn';
  }
  const levels = ([0, 1, 2, 3, 4, 5, 6] as Level[])
    .map((l) => `<button role="radio" aria-checked="${v.level === l}" data-act="level" data-arg="${l}" title="Level ${l}: ${esc(LEVEL_NAMES[l])}"><b>${l}</b>${LEVEL_SHORT[l]}</button>`)
    .join('');
  return `
    <button class="brand" data-act="modal" data-arg="about" aria-label="About Whale Lab">${whaleLogo(30)}<span>Whale Lab<small>Docker, as a living world</small></span></button>
    <div class="levels" role="radiogroup" aria-label="Abstraction level: how deep to look">${levels}</div>
    <label class="level-range"><span>Depth</span><input type="range" min="0" max="6" step="1" value="${v.level}" data-live="level" aria-label="Abstraction level" /><b>${v.level} · ${LEVEL_SHORT[v.level]}</b></label>
    <div class="top-actions">
      <button class="btn" data-act="modal" data-arg="scenarios" title="Break something on purpose"><span aria-hidden="true">${icon('bolt')}</span><span class="label">What if…</span></button>
      <button class="btn" data-act="lab-mode" aria-pressed="${v.labMode}" title="Show the experiment dials"><span aria-hidden="true">${icon('flask')}</span><span class="label">Lab</span></button>
      <button class="${cls}" data-act="modal" data-arg="connect"><span class="dot ${dot}" aria-hidden="true"></span><span class="label">${esc(label)}</span><span class="label-short">${esc(link.agent ? 'AI on' : relay === 'online' ? 'Connect AI' : label.slice(0, 11))}</span></button>
      <details class="menu"><summary class="btn ghost" aria-label="More">${icon('dots')}</summary>
        <div class="menu-pop">
          <button data-act="modal" data-arg="onboarding">Replay the intro</button>
          <button data-act="preset" data-arg="welcome">Reset: first cargo</button>
          <button data-act="preset" data-arg="persistence">Reset: data that survives</button>
          <button data-act="preset" data-arg="shop">Reset: Compose shop</button>
          <button data-act="preset" data-arg="empty">Reset: empty host</button>
          <hr />
          <button data-act="motion" data-arg="${app.prefs.reducedMotion === 'on' ? 'off' : 'on'}">Reduced motion: ${app.reduced ? 'on' : 'off'} (click to ${app.reduced ? 'allow motion' : 'reduce'})</button>
          <button data-act="quality" data-arg="${app.prefs.quality === 'low' ? 'auto' : 'low'}">Detail: ${app.prefs.quality === 'low' ? 'low (click for full on reload)' : 'full (click to lower, saves battery)'}</button>
          <button data-act="time-flow">Let simulated time flow: ${v.timeFlows ? 'on' : 'off'}</button>
          <button data-act="new-lab">New lab (new id and key)</button>
        </div>
      </details>
    </div>`;
}

interface Hit {
  target: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}


export function renderStageDom(app: App): string {
  const w = app.engine.world;
  const W = LAYOUT.artboard.w;
  const H = LAYOUT.artboard.h;
  const hits: Hit[] = [];
  // order matters: big things first so small things sit on top
  hits.push({ target: 'host', label: `Host machine ${w.host.name}: the whale`, x: 400, y: 420, w: 1020, h: 250 });
  hits.push({ target: 'registry:hub', label: 'Registry (Docker Hub): the harbor', x: 24, y: 560, w: 330, h: 250 });
  hits.push({ target: 'build:dockerfile', label: 'Dockerfile and image build: the shipyard', x: 1270, y: 610, w: 300, h: 200 });
  const crew = LAYOUT.crew;
  hits.push({ target: 'daemon:runc', label: 'runc, the low-level OCI runtime: the runner reindeer', x: crew.runner.x - 46, y: 290, w: 88, h: 104 });
  hits.push({ target: 'daemon:containerd', label: 'containerd: the foreman reindeer', x: crew.foreman.x - 46, y: 290, w: 88, h: 104 });
  hits.push({ target: 'daemon:dockerd', label: 'dockerd, the Docker daemon: Santa', x: crew.santa.x - 74, y: 254, w: 148, h: 140 });
  for (const s of app.scene.slots) {
    if (!s.name) continue;
    const c = w.containers[s.name]!;
    hits.push({ target: `container:${s.name}`, label: `Container ${s.name}, ${c.state}${c.health === 'unhealthy' ? ', unhealthy' : ''}, image ${c.imageRef}`, x: s.x - 54, y: DECK_Y - 84, w: 108, h: 104 });
  }
  for (const im of app.scene.images) hits.push({ target: `image:${im.ref}`, label: `Image ${im.ref}`, x: im.x - 36, y: im.y - 40, w: 72, h: 66 });
  for (const v of app.scene.volumes) hits.push({ target: `volume:${v.name}`, label: `Volume ${v.name}`, x: v.x - 30, y: v.y - 32, w: 60, h: 56 });
  for (const l of app.scene.lanes) hits.push({ target: `network:${l.name}`, label: `Network ${l.name}`, x: l.x1 - 60, y: l.y - 14, w: l.x2 - l.x1 + 120, h: 28 });
  const buttons = hits
    .map((h) => `<button data-act="select" data-arg="${esc(h.target)}" data-hover="${esc(h.target)}" data-box="${h.x},${h.y},${h.w},${h.h}" aria-label="${esc(h.label)}" aria-pressed="${app.engine.view.selected === h.target}"></button>`)
    .join('');
  const running = Object.values(w.containers).filter((c) => c.state === 'running').length;
  const summary = `<p class="sr-only">World summary: host ${esc(w.host.name)} is ${w.host.online ? 'online' : 'powered off'}. ${Object.keys(w.containers).length} containers, ${running} running: ${Object.values(w.containers).map((c) => esc(c.name) + ' ' + c.state).join(', ') || 'none'}. Abstraction level ${app.engine.view.level}: ${esc(LEVEL_NAMES[app.engine.view.level])}.</p>`;
  return summary + buttons;
}

const LEGEND: Record<Level, string> = {
  0: '<span class="metaphor">A cartoon on purpose.</span> Whale, pilot, crew: a story that is useful and deliberately wrong in places. Go deeper to see what it hides.',
  1: 'The same scene, named the way Docker names things: host, containers, images, volumes, networks.',
  2: 'Docker Engine internals: <b>dockerd</b> takes orders, <b>containerd</b> organises, a <b>shim</b> holds each container, <b>runc</b> launches it and leaves.',
  3: '<span class="metaphor">The box dissolves.</span> A container is not a little VM: it is a <b>process</b> on the host.',
  4: 'Kernel primitives: <b>namespaces</b> hide, <b>cgroups</b> limit, <b>overlayfs</b> stacks layers, <b>veth + bridge + iptables</b> connect.',
  5: 'Open standards: images, runtimes and registries are <b>OCI specifications</b>, which is why any tool can plug in.',
  6: 'The wider world: where Docker sits among <b>Kubernetes</b>, other engines, managed clouds and CI/CD.',
};

const OVERLAY_LABEL: Record<Overlay, [string, string]> = {
  network: ['Network', PAL.network!],
  storage: ['Storage', PAL.storage!],
  process: ['Process', PAL.runtime!],
  kernel: ['Kernel', PAL.kernel!],
  resources: ['Resources', PAL.resource!],
  causality: ['Causality', PAL.failure!],
  dependencies: ['Depends on', PAL.registry!],
};

export function renderLegend(app: App): string {
  const v = app.engine.view;
  const tools = ALL_OVERLAYS.map((o) => {
    const [label, color] = OVERLAY_LABEL[o];
    return `<button class="btn small" data-act="overlay" data-arg="${o}" aria-pressed="${v.overlays.includes(o)}" style="${v.overlays.includes(o) ? `border-color:${color};color:${color}` : ''}">${label}</button>`;
  }).join('');
  return `<div class="stage-legend" aria-live="polite"><b>Level ${v.level} · ${esc(LEVEL_NAMES[v.level])}.</b> ${LEGEND[v.level]}</div><div class="stage-tools" role="group" aria-label="Overlays: show one system of relationships">${tools}</div>`;
}

export function renderCamera(app: App): string {
  const v = app.engine.view;
  const regions = Object.keys(REGION_LABEL) as Region[];
  return `<div role="group" aria-label="Camera" class="cam">${regions.map((r) => `<button class="btn small" data-act="region" data-arg="${r}" aria-pressed="${v.region === r}">${REGION_LABEL[r]}</button>`).join('')}<span class="zoom"><button class="btn small" data-act="zoom" data-arg="-1" aria-label="Zoom out">−</button><button class="btn small" data-act="zoom" data-arg="1" aria-label="Zoom in">+</button></span></div>`;
}

export function renderOverlayRow(app: App): string {
  const v = app.engine.view;
  return ALL_OVERLAYS.map((o) => {
    const [label, color] = OVERLAY_LABEL[o];
    return `<button class="btn small" data-act="overlay" data-arg="${o}" aria-pressed="${v.overlays.includes(o)}" style="${v.overlays.includes(o) ? `border-color:${color};color:${color}` : ''}">${label}</button>`;
  }).join('');
}

const FRIENDLY: Record<string, string> = {
  'cgroup.limit_changed': 'limit changed',
  'cgroup.memory.exceeded': 'memory.max exceeded',
  'kernel.oom_kill': 'OOM killer',
  'process.killed': 'process killed',
  'process.signal': 'signal sent',
  'process.kill': 'kill sent',
  'process.started': 'process started',
  'process.memory': 'memory grows',
  'process.cpu': 'CPU burns',
  'container.exited': 'container exited',
  'container.created': 'created',
  'container.started': 'started',
  'container.run': 'docker run',
  'container.stop': 'docker stop',
  'container.remove': 'docker rm',
  'container.removed': 'removed',
  'container.restarting': 'restart policy',
  'container.restart.backoff': 'crash loop',
  'container.health': 'health changed',
  'container.data_lost': 'writable layer lost',
  'service.unavailable': 'service unreachable',
  'service.recovered': 'service back',
  'port.conflict': 'port conflict',
  'port.published': 'port published',
  'image.pull.started': 'pull',
  'image.pull.completed': 'image pulled',
  'image.pull.failed': 'pull failed',
  'image.layer.exists': 'layer shared',
  'image.layer.pulled': 'layer pulled',
  'request.ok': 'request ok',
  'request.failed': 'request failed',
  'action.failed': 'refused',
  'engine.api': 'dockerd API',
  'engine.containerd': 'containerd',
  'engine.shim': 'shim',
  'engine.runc': 'runc',
  'kernel.namespaces': 'namespaces',
  'kernel.cgroup': 'cgroup',
  'kernel.veth': 'veth pair',
  'host.condition': 'condition changed',
  'disk.full': 'disk full',
  'disk.filled': 'disk fills',
  'build.step.cached': 'cache hit',
  'build.step': 'build step',
  'build.completed': 'build done',
  'network.created': 'network created',
  'volume.survives': 'volume survives',
  'volume.remove.failed': 'volume in use',
  'daemon.stopped': 'daemon stopped',
  'host.reboot': 'reboot',
  'lab.connection_test': 'AI connected',
};

export const friendly = (e: WorldEvent): string => FRIENDLY[e.kind] ?? e.kind.split('.').slice(-1)[0]!.replace(/_/g, ' ');

/** the causal chain of the last step: what caused what */
export function lastChain(app: App): { events: WorldEvent[]; label: string } | null {
  const e = app.engine;
  const step = e.steps[e.cursor];
  if (!step || e.cursor === 0) return null;
  const evs = e.events.filter((x) => x.step === e.cursor);
  if (!evs.length) return null;
  const byId = new Map(evs.map((x) => [x.id, x]));
  const focus = [...evs].reverse().find((x) => x.severity === 'error') ?? [...evs].reverse().find((x) => x.severity === 'warn') ?? evs[evs.length - 1]!;
  const chain: WorldEvent[] = [];
  for (let x: WorldEvent | undefined = focus; x; x = x.causedBy !== null ? byId.get(x.causedBy) : undefined) chain.unshift(x);
  // drop engine/kernel plumbing at shallow levels so the chain stays readable
  const lvl = e.view.level;
  const shown = chain.filter((x, i) => x.minLevel <= Math.max(lvl, 1) || i === 0 || i === chain.length - 1);
  return { events: shown.slice(-7), label: step.label };
}

export function renderConsequence(app: App): string {
  const c = lastChain(app);
  if (!c) return `<div class="conseq" aria-label="What just happened"><span class="lab">What just happened</span><span style="color:var(--faint)">Nothing yet. Click a container, or ask your AI to change something.</span></div>`;
  const nodes = c.events.map((x) => `<button class="node ${x.severity === 'info' ? '' : x.severity}" data-act="event" data-arg="${x.id}" title="${esc(x.summary)}">${esc(friendly(x))}</button>`).join('<span class="arr" aria-hidden="true">→</span>');
  const future = !app.engine.atEnd ? ' <span class="pill warn">viewing the past</span>' : '';
  return `<div class="conseq" aria-label="What just happened"><span class="lab">What just happened</span><span class="step" title="timeline step ${app.engine.cursor}">${esc(c.label.length > 54 ? c.label.slice(0, 52) + '…' : c.label)}</span><span class="chain">${nodes}</span>${future}<span style="flex:1"></span><button class="btn small ghost" data-act="dock" data-arg="events">Why?</button><button class="btn small ghost" data-act="back" title="Undo this step (rewind)">${icon('back', 14)} Rewind</button></div>`;
}
