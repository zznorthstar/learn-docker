import type { App, DockTab, PokeArg } from '../app/app';
import { icon, esc } from './h';
import { dialLabel } from '../app/app';
import type { Parsed } from '../engine/terminal';
import type { Action, World, WorldEvent } from '../engine/types';
import { diskFreeMB } from '../engine/world';
import { friendly } from './shell';

export function renderDockTabs(app: App): string {
  const e = app.engine;
  const tabs: [DockTab, string, string][] = [
    ['timeline', 'Timeline', `<span class="count">${e.cursor}/${e.steps.length - 1}</span>`],
    ['events', 'Events & causes', `<span class="count">${e.visibleEvents.length}</span>`],
    ['terminal', 'Terminal', ''],
    ['lab', 'Lab', e.view.labMode ? '<span class="count" style="background:var(--lantern);color:#1b1205">on</span>' : ''],
  ];
  return `<div class="tablist" role="tablist" aria-label="Dock">${tabs.map(([k, l, extra]) => `<button role="tab" aria-selected="${app.ui.dock === k}" data-act="dock" data-arg="${k}">${l}${extra}</button>`).join('')}</div><span class="spacer"></span>
    <button class="btn small ghost" data-act="preset" data-arg="welcome" title="Reset to the first-cargo world">Reset</button>
    <button class="btn small ghost" data-act="dock-toggle" aria-expanded="${app.ui.dockOpen}" title="${app.ui.dockOpen ? 'Collapse' : 'Expand'} this panel">${app.ui.dockOpen ? '▾ Hide' : '▴ Show'}</button>`;
}

/* ================================================================ timeline */

export function renderTimeline(app: App): string {
  const e = app.engine;
  const n = e.steps.length;
  const cur = e.cursor;
  const dots = e.steps
    .map((s) => `<button class="${s.source}${s.ok ? '' : ' bad'}${s.index === cur ? ' cur' : ''}${s.index > cur ? ' future' : ''}" data-act="rewind" data-arg="${s.index}" aria-label="Step ${s.index}: ${esc(s.label)}" title="${s.index}: ${esc(s.label)}"></button>`)
    .join('');
  const list = e.steps
    .slice(Math.max(0, n - 14))
    .reverse()
    .map((s) => `<button class="${s.index === cur ? 'cur' : ''}" data-act="rewind" data-arg="${s.index}"><span class="i">${s.index}</span><span class="src ${s.source}">${s.source === 'user' ? 'you' : s.source === 'ai' ? 'AI' : 'setup'}</span><span class="lab" title="${esc(s.label)}">${esc(s.label)}</span>${s.ok ? '' : '<span class="pill bad">refused</span>'}</button>`)
    .join('');
  return `<div class="scrub">
      <button class="btn small" data-act="back" ${cur === 0 ? 'disabled' : ''} aria-label="Step back">${icon('back', 14)}</button>
      <input type="range" min="0" max="${n - 1}" value="${cur}" data-live="scrub" aria-label="Timeline position" aria-valuetext="step ${cur} of ${n - 1}: ${esc(e.steps[cur]!.label)}" />
      <button class="btn small" data-act="fwd" ${cur >= n - 1 ? 'disabled' : ''} aria-label="Step forward">${icon('fwd', 14)}</button>
      <button class="btn small" data-act="now" ${cur >= n - 1 ? 'disabled' : ''}>Now</button>
      <button class="btn small" data-act="compare" ${cur === 0 ? 'disabled' : ''} title="What changed in the last step?">Before / after</button>
    </div>
    <div style="margin:6px 0 0;color:var(--muted);font-size:12.5px">${cur < n - 1 ? '<span class="pill warn">viewing the past</span> ' : ''}Step <b style="color:var(--text)">${cur}</b>: <span class="mono">${esc(e.steps[cur]!.label)}</span> ${cur < n - 1 ? '<span style="color:var(--faint)">(make a change and the future branch is replaced)</span>' : ''}</div>
    <div class="steps" aria-label="Timeline steps">${dots}</div>
    <div class="steplist">${list}</div>`;
}

/* ================================================================== events */

export function renderEvents(app: App): string {
  const e = app.engine;
  const lvl = e.view.level;
  const byId = new Map(e.events.map((x) => [x.id, x]));
  const sel = app.ui.selectedEvent !== null ? byId.get(app.ui.selectedEvent) : undefined;
  const chain = new Set<number>();
  if (sel) for (let x: WorldEvent | undefined = sel; x; x = x.causedBy !== null ? byId.get(x.causedBy) : undefined) chain.add(x.id);
  let list = e.events.filter((x) => app.ui.showAllEvents || x.minLevel <= lvl);
  if (app.ui.onlyProblems) list = list.filter((x) => x.severity !== 'info');
  const shown = list.slice(-120).reverse();
  const rows = shown
    .map((x) => {
      const src = x.source === 'ai' ? '<span class="src ai">AI</span>' : x.source === 'user' ? '<span class="src user">you</span>' : '';
      const detail =
        sel && x.id === sel.id
          ? `<div class="cause"><b>What caused this?</b><ol>${[...chain].reverse().map((id) => `<li>${esc(byId.get(id)?.summary ?? '')}</li>`).join('')}</ol>${childrenOf(e.events, sel.id)}</div>`
          : '';
      return `<div><button class="ev ${x.step > e.cursor ? 'future' : ''} ${sel?.id === x.id ? 'sel' : ''} ${chain.has(x.id) && sel?.id !== x.id ? 'inchain' : ''}" data-act="event" data-arg="${x.id}"><span class="t">t${x.tick}</span><span class="sev ${x.severity}" aria-label="${x.severity}"></span><span>${esc(x.summary)} ${src}</span><span class="k">${esc(friendly(x))}</span></button>${detail}</div>`;
    })
    .join('');
  return `<div class="filters"><label><input type="checkbox" data-live="filter" data-arg="all" ${app.ui.showAllEvents ? 'checked' : ''}/> show every depth</label><label><input type="checkbox" data-live="filter" data-arg="problems" ${app.ui.onlyProblems ? 'checked' : ''}/> only problems</label><span style="color:var(--faint)">${shown.length} shown · level ${lvl} detail${lvl < 3 ? ' (go deeper to see engine and kernel events)' : ''}</span></div>
    <div class="events" role="log" aria-label="Events">${rows || '<div class="empty">No events yet. Do something in the world.</div>'}</div>`;
}

function childrenOf(events: WorldEvent[], id: number): string {
  const kids = events.filter((x) => x.causedBy === id);
  if (!kids.length) return '';
  return `<div style="margin-top:6px"><b>What it led to:</b> ${kids.slice(0, 6).map((k) => esc(friendly(k))).join(' · ')}${kids.length > 6 ? ' …' : ''}</div>`;
}

/* ================================================================ terminal */

export function renderTerminalOut(app: App): string {
  if (!app.term.out.length) return `<div class="dim" style="color:var(--faint)">Type a Docker command. It is parsed into its meaning (shown under the prompt), then run against the simulated world. Nothing touches a real Docker daemon.\nTry <span class="cmd">docker run -d --name web -p 8080:80 nginx</span> or <span class="cmd">help</span>.</div>`;
  return app.term.out.map((x) => (x.cmd !== undefined ? `<div class="cmd">$ ${esc(x.cmd)}</div>` : `<div class="${x.cls ?? ''}">${esc(x.out ?? '')}</div>`)).join('');
}

const SUGGEST = ['docker run -d --name web -p 8080:80 nginx', 'docker run -d --name db -v mydata:/var/lib/postgresql/data -m 256m postgres:16', 'docker ps -a', 'docker exec web cat /proc/1/cgroup', 'docker update --memory 8m web', 'docker network create appnet', 'curl localhost:8080', 'help'];

export function renderTermInput(app: App, forced?: Parsed): string {
  const p = forced ?? app.term.parsed;
  if (!p) {
    return `<div class="suggest" aria-label="Suggestions">${SUGGEST.slice(0, 5)
      .map((s) => `<button data-act="term-suggest" data-arg="${esc(s)}">${esc(s.length > 52 ? s.slice(0, 50) + '…' : s)}</button>`)
      .join('')}</div>`;
  }
  if (p.error) return `<span class="err" style="color:var(--failure);font-family:var(--font-ui)">${esc(p.error)}</span>`;
  if (!p.segs.length) return '';
  return p.segs.map((s) => `<span class="seg ${s.role}" tabindex="0" data-tip="${esc(s.explain)}" aria-label="${esc(s.text)}: ${esc(s.label)}. ${esc(s.explain)}"><b>${esc(s.text)}</b><i>${esc(s.label)}</i></span>`).join('');
}

/* ===================================================================== lab */

function hintLatency(v: number): string {
  return v < 40 ? 'Snappy. Requests and pulls are quick.' : v < 200 ? 'Noticeable. Each round trip costs more.' : 'Fog. Every request and layer download crawls.';
}
function hintLoss(v: number): string {
  return v === 0 ? 'A clean line.' : v < 50 ? 'Retransmits: requests still arrive, but slower.' : 'Rain: connections time out; pulls fail.';
}
function hintBw(v: number): string {
  return v === 0 ? 'Pipe shut: pulls stall and fail.' : v < 10 ? 'A trickle: big layers take forever.' : 'Plenty of room for layer downloads.';
}
function hintCpu(v: number): string {
  return v < 50 ? 'Plenty of headroom.' : v < 85 ? 'Busy: responses get slower.' : 'Saturated: everything crawls (CPU is compressible, nothing is killed).';
}
function hintMem(v: number, w: World): string {
  const free = w.host.ramMB - w.host.baseMemMB - v;
  return v === 0 ? 'No outside memory pressure.' : free < 400 ? 'The host is nearly out of RAM: the kernel OOM killer may pick a container.' : 'Another process holds RAM that containers could have used.';
}
function hintDisk(v: number): string {
  return v > 2000 ? 'Room to spare.' : v > 0 ? 'Getting tight: writes and pulls may fail.' : 'Full: every write fails (ENOSPC). Databases crash first.';
}

function dial(app: App, o: { key: string; title: string; cls: string; min: number; max: number; step: number; value: number; hint: string }): string {
  return `<div class="dial ${o.cls}"><header><h4>${esc(o.title)}</h4><span class="val" data-val="${o.key}">${esc(dialLabel(o.key, o.value))}</span></header><input type="range" data-live="dial" data-arg="${o.key}" min="${o.min}" max="${o.max}" step="${o.step}" value="${o.value}" aria-label="${esc(o.title)}" /><div class="hint">${esc(o.hint)}</div></div>`;
}

function sw(label: string, on: boolean, a: Action, cls: string, hintOn: string, hintOff: string): string {
  return `<div class="dial ${cls}"><header><h4>${esc(label)}</h4><span class="switch"><button role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-act="poke" data-arg='${esc(JSON.stringify({ action: a } as PokeArg))}'></button></span></header><div class="hint">${esc(on ? hintOn : hintOff)}</div></div>`;
}

export function renderLab(app: App): string {
  const w = app.engine.world;
  const h = w.host;
  const free = Math.max(0, Math.min(h.diskMB, Math.round(diskFreeMB(w) / 500) * 500));
  const sel = app.engine.view.selected?.startsWith('container:') ? w.containers[app.engine.view.selected.slice(10)] : undefined;
  const last = app.engine.events.filter((x) => x.step === app.engine.cursor && x.source !== 'ai').slice(-4);
  return `<p style="margin:0 0 10px;color:var(--muted);font-size:13px">These dials are the same semantic controls your AI has. Change one and watch the consequences ripple (below the stage and in <b>Events</b>). Your AI sees every change you make.</p>
  <div class="lab-grid">
    ${dial(app, { key: 'latency', title: 'Network fog (latency)', cls: 'network', min: 0, max: 1000, step: 10, value: h.net.latencyMs, hint: hintLatency(h.net.latencyMs) })}
    ${dial(app, { key: 'loss', title: 'Network rain (packet loss)', cls: 'network', min: 0, max: 100, step: 5, value: h.net.packetLossPct, hint: hintLoss(h.net.packetLossPct) })}
    ${dial(app, { key: 'bandwidth', title: 'Pipe width (bandwidth)', cls: 'network', min: 0, max: 1000, step: 10, value: h.net.bandwidthMbps, hint: hintBw(h.net.bandwidthMbps) })}
    ${sw('DNS (names)', h.net.dnsUp, { action: 'set_condition', condition: 'dns', value: !h.net.dnsUp }, 'network', 'Upstream DNS answers. Registry names resolve.', 'DNS is down: pulls fail. Container names on user networks still resolve (Docker answers those itself).')}
    ${sw('Registry reachable', h.net.registryReachable, { action: 'set_condition', condition: 'registry', value: !h.net.registryReachable }, 'registry', 'The harbor lighthouse is lit.', 'The harbor is dark: new pulls and builds fail; local images still run.')}
    ${dial(app, { key: 'cpu', title: 'Host CPU load', cls: 'resource', min: 0, max: 100, step: 5, value: h.cpuLoadPct, hint: hintCpu(h.cpuLoadPct) })}
    ${dial(app, { key: 'mem', title: 'Memory pressure (outside process)', cls: 'resource', min: 0, max: 3600, step: 100, value: h.memPressureMB, hint: hintMem(h.memPressureMB, w) })}
    ${dial(app, { key: 'disk', title: 'Free disk space', cls: 'storage', min: 0, max: h.diskMB, step: 500, value: free, hint: hintDisk(free) })}
    ${sw('Power', h.online, { action: 'set_condition', condition: 'host_online', value: !h.online }, 'runtime', 'The whale is flying.', 'The machine is powered off: nothing runs until it boots; restart policies decide who returns.')}
  </div>
  ${
    sel
      ? `<h4 style="margin:16px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted)">Selected container: ${esc(sel.name)}</h4><div class="lab-grid">
    ${dial(app, { key: `ctr-mem:${sel.name}`, title: 'Memory limit (cgroup memory.max)', cls: 'resource', min: 0, max: 1024, step: 8, value: sel.limits.memoryMB ?? 0, hint: sel.limits.memoryMB ? `Capped at ${sel.limits.memoryMB} MB: over it, the kernel OOM-kills a process (exit 137).` : '0 = no limit: it can use as much RAM as the host has.' })}
    ${dial(app, { key: `ctr-cpu:${sel.name}`, title: 'CPU limit (cpu.max)', cls: 'resource', min: 0, max: 4, step: 0.25, value: sel.limits.cpus ?? 0, hint: sel.limits.cpus ? 'Over the quota it is throttled, never killed.' : '0 = no limit.' })}
    <div class="dial runtime"><header><h4>Make it misbehave</h4></header><div class="poke" style="margin-top:6px">
      <button class="btn small" data-act="poke" data-arg='${esc(JSON.stringify({ action: { action: 'stress', target: `container:${sel.name}`, resource: 'memory', amount: 60 } } as PokeArg))}'>+60 MB memory</button>
      <button class="btn small" data-act="poke" data-arg='${esc(JSON.stringify({ action: { action: 'stress', target: `container:${sel.name}`, resource: 'cpu', amount: 150 } } as PokeArg))}'>+150% CPU</button>
      <button class="btn small" data-act="poke" data-arg='${esc(JSON.stringify({ action: { action: 'advance_time', ticks: 5 } } as PokeArg))}'>5 ticks pass</button>
    </div><div class="hint">Pair it with a limit above to watch the cgroup act.</div></div></div>`
      : `<p style="margin-top:14px;color:var(--faint);font-size:12.5px">Select a container on the stage to get its own dials (memory and CPU limits).</p>`
  }
  ${last.length ? `<div class="sec" style="margin-top:14px"><h4>What your last change did</h4><div class="lines" style="font-family:var(--font-ui)">${last.map((x) => `• ${esc(x.summary)}`).join('\n')}</div></div>` : ''}`;
}
