import type { App, PokeArg } from '../app/app';
import { inspectTarget, type Inspection, type Section } from '../engine/inspect';
import { LEVEL_NAMES, type Action, type Level, type RevealMode, type World } from '../engine/types';
import { CONCEPTS, conceptAt, conceptExact, type Concept } from '../engine/concepts';
import * as graph from '../engine/conceptgraph';
import { ROLE_COLOR } from '../render/palette';
import { SCENARIO_MAP } from '../engine/scenarios';
import { esc, tone } from './h';
import { friendly } from './shell';
import { parseTarget } from '../engine/util';

const SELECTABLE = new Set(['container', 'image', 'volume', 'network', 'host', 'daemon', 'registry', 'build']);

export function renderSide(app: App): string {
  const tabs: [string, string][] = [
    ['object', 'Object'],
    ['concept', 'Concepts'],
    ['progress', 'Progress'],
  ];
  const t = app.ui.side;
  const head = `<div class="tabs"><div class="tablist" role="tablist" aria-label="Inspector">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${t === k}" data-act="side" data-arg="${k}">${l}</button>`).join('')}</div><span class="spacer"></span><button class="btn small ghost" data-act="inspector-toggle" aria-label="Close inspector">×</button></div>`;
  const body = t === 'object' ? renderObject(app) : t === 'concept' ? renderConcept(app) : renderProgress(app);
  return `${head}<div class="panel">${app.engine.view.compare ? renderCompare(app) : ''}${body}</div>`;
}

/* ================================================================= object */

function renderObject(app: App): string {
  const e = app.engine;
  const w = e.world;
  const sel = e.view.selected;
  if (!sel) return emptyState(app);
  const ins = inspectTarget(w, sel, e.view.level);
  if (!ins) {
    return `<div class="empty"><h2>That is gone</h2><p>${esc(sel)} no longer exists in this moment of the timeline. Rewind to see it again, or pick something else.</p><button class="btn" data-act="select" data-arg="host">Look at the host</button> <button class="btn" data-act="back">Rewind a step</button></div>`;
  }
  const lvl = e.view.level;
  const why = app.ui.whyFor === sel ? renderWhy(app, sel) : '';
  return `<div class="insp">
    <h2>${esc(ins.title)}</h2>
    <div class="sub">${esc(ins.subtitle)} &nbsp; <span class="pill ${tone(ins.status.tone)}">${esc(ins.status.label)}</span></div>
    ${lvl <= 1 ? `<p class="story">${esc(ins.story.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? ins.story)}</p><details class="sec" data-disclosure="${esc(sel)}:story"><summary>The full picture</summary><p class="note">${esc(ins.story)}</p></details>` : ''}
    ${lvl >= 1 && ins.correction ? `<details class="sec" data-disclosure="${esc(sel)}:correction"><summary>What the metaphor hid</summary><div class="truth">${esc(ins.correction)}</div></details>` : ''}
    <div class="focus-actions">
      <button class="btn" data-act="why" data-arg="${esc(sel)}">Why?</button>
      <button class="btn" data-act="deeper" ${lvl === 6 ? 'disabled' : ''}>Show deeper ↓</button>
      <button class="btn small ghost" data-act="shallower" aria-label="Show shallower" ${lvl === 0 ? 'disabled' : ''}>↑</button>
    </div>
    ${renderPoke(app, sel, w)}
    <details class="sec" data-disclosure="${esc(sel)}:relationships">
      <summary>Explore connections</summary>
      <div class="acts" role="group" aria-label="Ask about this object">
        <button class="btn" data-act="reveal" data-arg="depends_on">Depends on</button>
        <button class="btn" data-act="reveal" data-arg="made_of">Made of</button>
        <button class="btn" data-act="reveal" data-arg="used_by">Used by</button>
        <button class="btn" data-act="reveal" data-arg="follow">Follow it</button>
        <button class="btn" data-act="compare">Before / after</button>
      </div>
      ${renderRelations(app, ins)}
    </details>
    ${why}
    ${ins.sections.map(s => renderSection(s, `${sel}:${s.title}`)).join('')}
    <details class="sec" data-disclosure="${esc(sel)}:concepts"><summary>Concepts behind this</summary><div class="chips">${ins.concepts.map((c) => `<button class="chip" data-act="concept" data-arg="${c}">${esc(CONCEPTS[c]?.name ?? c)}</button>`).join('')}</div></details>
  </div>`;
}

function emptyState(app: App): string {
  const w = app.engine.world;
  const names = Object.values(w.containers).slice(0, 4);
  return `<div class="empty">
    <h2>Follow your curiosity.</h2>
    <p>Click an object to see what it does.</p>
    <div class="chips" style="margin:16px 0">
      ${names.map((c) => `<button class="chip" data-act="select" data-arg="container:${esc(c.name)}">${esc(c.name)} · container</button>`).join('')}
      <button class="chip" data-act="select" data-arg="host">whale · your machine</button>
      <button class="chip" data-act="select" data-arg="daemon:dockerd">Santa · the pilot</button>
    </div>
    <button class="btn" data-act="side" data-arg="concept">Browse Docker concepts →</button>
  </div>`;
}

function renderWhy(app: App, sel: string): string {
  const w = app.whyOf(sel);
  const calm = w.chain.length <= 1 && !w.chain.some((c) => c.severity !== 'info');
  const items = w.chain.map((c) => `<li><button class="chip" data-act="event" data-arg="${c.id}">${esc(friendly(c))}</button> ${esc(c.summary)}</li>`).join('');
  const concept = graph.conceptsForTarget(sel)[0];
  const why = concept ? CONCEPTS[concept]!.why : '';
  return `<div class="why ${calm ? 'calm' : ''}"><b>Why is it like this?</b><div>${esc(w.headline)}</div>${w.chain.length > 1 ? `<ol>${items}</ol>` : ''}${why ? `<div class="note" style="margin-top:6px;color:var(--muted)"><b>Why it exists at all:</b> ${esc(why)}</div>` : ''}</div>`;
}

function renderRelations(app: App, ins: Inspection): string {
  const mode = app.engine.view.reveal?.mode;
  const group = (title: string, items: { target: string; label: string }[], hot: boolean): string => {
    if (!items.length) return '';
    return `<div class="rel" ${hot ? 'style="border-left:3px solid var(--lantern);padding-left:8px"' : ''}><h5>${title}</h5><div class="chips">${items
      .map((r) => {
        const k = parseTarget(r.target).kind;
        const name = r.target.length > 30 ? r.target.slice(0, 14) + '…' + r.target.slice(-12) : r.target;
        return SELECTABLE.has(k) ? `<button class="chip" data-act="select" data-arg="${esc(r.target)}" data-hover="${esc(r.target)}">${esc(name)} <small>${esc(r.label)}</small></button>` : `<span class="chip">${esc(name)} <small>${esc(r.label)}</small></span>`;
      })
      .join('')}</div></div>`;
  };
  const r = ins.relations;
  const out = [group('Depends on', r.dependsOn, mode === 'depends_on'), group('Depended on by', r.dependedBy, mode === 'depended_by'), group('Made of', r.madeOf, mode === 'made_of'), group('Used by', r.usedBy, mode === 'used_by')].join('');
  return out ? `<div class="sec"><h4>Connections</h4>${out}</div>` : '';
}

function renderSection(s: Section, key: string): string {
  const parts: string[] = [];
  if (s.rows) parts.push(`<dl class="kv">${s.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`);
  if (s.lines) parts.push(`<div class="lines">${s.lines.map((l) => esc(l)).join('\n')}</div>`);
  if (s.code) parts.push(`<pre>${esc(s.code)}</pre>`);
  if (s.note) parts.push(`<div class="note">${esc(s.note)}</div>`);
  return `<details class="sec ${s.tone === 'info' ? 'info' : ''}" data-disclosure="${esc(key)}"><summary>${esc(s.title)}</summary>${parts.join('')}</details>`;
}

/** human controls: the same semantic actions the AI has */
function pokes(w: World, target: string): { label: string; action: Action; tip: string }[] {
  const { kind, name } = parseTarget(target);
  const out: { label: string; action: Action; tip: string }[] = [];
  if (kind === 'container') {
    const c = w.containers[name];
    if (!c) return out;
    const t = `container:${name}`;
    if (c.state === 'running') {
      out.push({ label: 'Stop', action: { action: 'stop_container', target: t }, tip: 'SIGTERM, wait, SIGKILL' });
      out.push({ label: 'Restart', action: { action: 'restart_container', target: t }, tip: 'new process, same container' });
      out.push({ label: 'Pause', action: { action: 'pause_container', target: t }, tip: 'freeze with the cgroup freezer' });
      out.push({ label: 'Kill PID 1', action: { action: 'kill_process', target: t, pid: 1 }, tip: 'SIGKILL the main process' });
      if (c.childProcs[0]) out.push({ label: `Kill PID ${c.childProcs[0].nsPid}`, action: { action: 'kill_process', target: t, pid: c.childProcs[0].nsPid }, tip: 'kill a worker, not PID 1' });
      out.push({ label: 'Memory +60 MB', action: { action: 'stress', target: t, resource: 'memory', amount: 60 }, tip: 'the process allocates memory' });
      out.push({ label: 'Write 50 records', action: { action: 'write_data', target: t, path: c.workload.dataDir ?? '/data', count: 50 }, tip: `write to ${c.workload.dataDir ?? '/data'}: where does it land?` });
      if (c.ports[0]) out.push({ label: 'Send request', action: { action: 'send_request', from: 'external', to: t, port: c.ports[0].host }, tip: 'trace every hop of a request' });
    } else if (c.state === 'paused') out.push({ label: 'Unpause', action: { action: 'unpause_container', target: t }, tip: 'thaw' });
    else out.push({ label: 'Start', action: { action: 'start_container', target: t }, tip: 'start it again' });
    out.push({ label: 'Remove', action: { action: 'remove_container', target: t, force: true }, tip: 'docker rm -f' });
  } else if (kind === 'image') {
    out.push({ label: 'Remove image', action: { action: 'remove_image', target, force: false }, tip: 'refused while a container uses it' });
  } else if (kind === 'volume') {
    out.push({ label: 'Remove volume', action: { action: 'remove_volume', name }, tip: 'refused while any container references it' });
  } else if (kind === 'network') {
    out.push({ label: 'Remove network', action: { action: 'remove_network', name }, tip: 'refused while containers are attached' });
  } else if (kind === 'host') {
    out.push({ label: 'Reboot host', action: { action: 'restart_host' }, tip: 'restart policies decide who returns' });
    out.push({ label: 'Fill the disk', action: { action: 'fill_disk', mb: 30000 }, tip: 'something outside Docker eats the disk' });
    out.push({ label: 'Time passes ×5', action: { action: 'advance_time', ticks: 5 }, tip: 'leaky apps grow' });
  } else if (kind === 'daemon' && (name === 'dockerd' || name === 'containerd')) {
    const d = w.daemons[name];
    out.push(d.running ? { label: `Stop ${name}`, action: { action: 'stop_daemon', daemon: name }, tip: name === 'containerd' ? 'running containers survive (their shims hold them)' : 'containers stop with it' } : { label: `Start ${name}`, action: { action: 'start_daemon', daemon: name }, tip: 'bring it back' });
  } else if (kind === 'registry') {
    const up = w.host.net.registryReachable;
    out.push({ label: up ? 'Make registry unreachable' : 'Make registry reachable', action: { action: 'set_condition', condition: 'registry', value: !up }, tip: 'pulls fail, local images keep working' });
    out.push({ label: 'Pull redis:7', action: { action: 'pull_image', ref: 'redis:7' }, tip: 'watch which layers are shared' });
    out.push({ label: 'Pull node:20-alpine', action: { action: 'pull_image', ref: 'node:20-alpine' }, tip: 'base layers' });
  } else if (kind === 'build') {
    out.push({ label: 'Build', action: { action: 'build_image' }, tip: 'unchanged steps come from cache' });
    out.push({ label: 'Edit package.json (step 3)', action: { action: 'edit_dockerfile', step: 2 }, tip: 'busts the cache from step 3 on' });
    out.push({ label: 'Edit source (step 5)', action: { action: 'edit_dockerfile', step: 4 }, tip: 'npm ci stays cached' });
  }
  return out;
}

function renderPoke(app: App, sel: string, w: World): string {
  const list = pokes(w, sel);
  if (!list.length) return '';
  const buttons = list.map((p) => `<button class="btn small" title="${esc(p.tip)}" data-act="poke" data-arg='${esc(JSON.stringify({ action: p.action } as PokeArg))}'>${esc(p.label)}</button>`);
  return `<div class="sec"><h4>Try a change</h4><div class="poke">${buttons.slice(0, 2).join('')}</div>${buttons.length > 2 ? `<details data-disclosure="${esc(sel)}:actions"><summary>More experiments</summary><div class="poke">${buttons.slice(2).join('')}</div></details>` : ''}</div>`;

}

/* ================================================================ compare */

function renderCompare(app: App): string {
  const e = app.engine;
  const c = e.view.compare!;
  const a = e.stepAt(c.a);
  const b = e.stepAt(c.b);
  const diff = app.compareDiff();
  return `<div class="sec" style="border:1px solid var(--lantern);border-radius:12px;padding:10px 12px;margin-bottom:12px;background:rgba(255,180,84,.05)">
    <h4 style="color:var(--lantern)">Before / after</h4>
    <div class="note" style="margin:0 0 6px">step ${c.a} <i>${esc(a?.label ?? '')}</i> → step ${c.b} <i>${esc(b?.label ?? '')}</i></div>
    <div class="diff">${diff.length ? diff.map((d) => `<div class="d ${d.kind}"><b>${d.kind}</b><div>${esc(d.target)}: ${esc(d.what)}${d.before !== undefined ? ` <span class="arrow">${esc(d.before)} → ${esc(d.after ?? '')}</span>` : ''}</div></div>`).join('') : '<div class="note">No difference between these two moments.</div>'}</div>
    <div class="row" style="margin-top:8px;display:flex;gap:6px"><button class="btn small" data-act="rewind" data-arg="${c.a}">View before</button><button class="btn small" data-act="rewind" data-arg="${c.b}">View after</button><button class="btn small ghost" data-act="close-compare">Close</button></div>
  </div>`;
}

/* ================================================================ concepts */

function renderConcept(app: App): string {
  const e = app.engine;
  const id = app.conceptFocus();
  const c = id ? CONCEPTS[id] : undefined;
  if (!c) return conceptIndex(app);
  const lvl = e.view.level;
  const exact = conceptExact(c, lvl);
  const col = ROLE_COLOR[c.role];
  const mode = e.view.reveal?.mode ?? 'follow';
  const sub = graph.reveal(mode, c.id);
  const modes: [RevealMode, string][] = [
    ['depends_on', 'Depends on'],
    ['depended_by', 'Depended on by'],
    ['made_of', 'Made of'],
    ['used_by', 'Used by'],
    ['why', 'Why it exists'],
    ['to_kernel', 'Trace to the kernel'],
    ['to_ecosystem', 'Trace outward'],
  ];
  const chains = mode === 'to_kernel' ? graph.toKernel(c.id).chains : mode === 'to_ecosystem' ? graph.toEcosystem(c.id).chains : [];
  const levelTexts = (['s', 'o', 'e', 'p', 'k', 'i', 'w'] as const)
    .map((k, i) => (c.lv[k] ? `<div class="sec" style="padding:6px 0 2px"><h4>Level ${i} · ${esc(LEVEL_NAMES[i as Level])}${i === lvl ? ' (you are here)' : ''}</h4><div class="note" style="margin:0;color:${i === lvl ? 'var(--text)' : 'var(--muted)'}">${esc(c.lv[k]!)}</div></div>` : ''))
    .join('');
  return `<div class="concept">
    <div class="domain" style="color:${col}">${esc(c.domain)} · ${esc(c.role)}</div>
    <h2>${esc(c.name)}</h2>
    <p class="sum">${esc(c.summary)}</p>
    ${exact ? `<div class="truth"><b>At level ${lvl}:</b> ${esc(exact)}</div>` : `<div class="truth"><b>At level ${lvl}:</b> ${esc(conceptAt(c, lvl))}</div>`}
    <div class="revealbar" role="group" aria-label="Reveal relationships">${modes.map(([m, l]) => `<button class="btn small" data-act="reveal" data-arg="${m}" aria-pressed="${mode === m}">${l}</button>`).join('')}</div>
    ${chains.length ? `<div class="sec"><h4>${mode === 'to_kernel' ? 'Down to the kernel' : 'Out to the ecosystem'}</h4>${chains.map((ch) => `<div class="chips" style="margin:4px 0">${ch.map((n) => `<button class="chip" data-act="concept" data-arg="${n}">${esc(CONCEPTS[n]?.name ?? n)}</button>`).join('<span style="color:var(--faint)">→</span>')}</div>`).join('')}</div>` : ''}
    <details class="sec" data-disclosure="${esc(c.id)}:graph"><summary>Relationship map</summary>${conceptGraph(c, sub)}</details>
    <p class="note" style="color:var(--muted);font-size:12px">${esc(sub.caption)}${sub.truncated ? ` (${sub.truncated} more not shown, to keep this readable)` : ''}</p>
    <details class="sec" data-disclosure="${esc(c.id)}:notes"><summary>Why it exists & common misconceptions</summary>${c.misconceptions.map((m) => `<div class="misc"><b>Common misconception.</b> ${esc(m)}</div>`).join('')}
    <div class="sec"><h4>Why it exists</h4><div class="note" style="margin:0">${esc(c.why)}</div></div></details>
    ${c.experiments.filter((x) => SCENARIO_MAP[x]).length ? `<div class="sec"><h4>Try it</h4><div class="poke">${c.experiments.filter((x) => SCENARIO_MAP[x]).map((x) => `<button class="btn small" data-act="scenario-predict" data-arg="${x}" title="${esc(SCENARIO_MAP[x]!.whatIf)}">Predict: ${esc(SCENARIO_MAP[x]!.title)}</button>`).join('')}</div></div>` : ''}
    ${c.commands.length ? `<div class="sec"><h4>Commands</h4><div class="chips">${c.commands.map((x) => `<button class="chip mono" data-act="term-suggest" data-arg="${esc(x.startsWith('docker') && !x.includes('<') ? x : '')}" title="put it in the terminal">${esc(x)}</button>`).join('')}</div></div>` : ''}
    ${c.kernel.length ? `<div class="sec"><h4>Kernel primitives</h4><div class="chips">${c.kernel.map((x) => `<span class="chip mono" style="border-color:var(--kernel);color:var(--kernel)">${esc(x)}</span>`).join('')}</div></div>` : ''}
    <details class="sec"><summary style="cursor:pointer;color:var(--muted)">What this is at every level</summary>${levelTexts}</details>
  </div>`;
}

function conceptGraph(root: Concept, sub: graph.Subgraph): string {
  const W = 360;
  const H = 300;
  const nodes = sub.nodes;
  if (nodes.length <= 1) return '';
  const pos = new Map<string, { x: number; y: number }>();
  pos.set(root.id, { x: W / 2, y: H / 2 });
  const others = nodes.filter((n) => n !== root.id);
  const rings: string[][] = [others.slice(0, 7), others.slice(7)];
  rings.forEach((ring, ri) => {
    const R = ri === 0 ? 108 : 138;
    ring.forEach((n, i) => {
      const a = (i / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2 + ri * 0.35;
      pos.set(n, { x: W / 2 + Math.cos(a) * R * (ri === 0 ? 1.18 : 1.2), y: H / 2 + Math.sin(a) * R * (ri === 0 ? 0.92 : 0.98) });
    });
  });
  const edges = sub.edges
    .filter((e) => pos.has(e.from) && pos.has(e.to))
    .map((e) => {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="rgba(255,255,255,.28)" stroke-width="1.5" ${e.rel === 'relatesTo' || e.rel === 'outward' ? 'stroke-dasharray="4 4"' : ''}/>`;
    })
    .join('');
  const ns = nodes
    .map((id) => {
      const c = CONCEPTS[id];
      if (!c) return '';
      const p = pos.get(id)!;
      const isRoot = id === root.id;
      const label = c.name.length > 17 ? c.name.slice(0, 16) + '…' : c.name;
      return `<g class="node" data-act="concept" data-arg="${id}" tabindex="0" role="button" aria-label="${esc(c.name)}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isRoot ? 16 : 11}" fill="${ROLE_COLOR[c.role]}" fill-opacity="${isRoot ? 0.95 : 0.5}" stroke="${isRoot ? '#fff' : ROLE_COLOR[c.role]}" stroke-width="${isRoot ? 2.5 : 1.5}"/><text x="${p.x.toFixed(1)}" y="${(p.y + (isRoot ? 31 : 25)).toFixed(1)}" text-anchor="middle" ${isRoot ? 'font-weight="700"' : ''}>${esc(label)}</text></g>`;
    })
    .join('');
  return `<svg class="graph" viewBox="0 0 ${W} ${H}" role="group" aria-label="Relationship graph around ${esc(root.name)}">${edges}${ns}</svg>`;
}

function conceptIndex(app: App): string {
  void app;
  const groups = new Map<string, Concept[]>();
  for (const c of Object.values(CONCEPTS)) (groups.get(c.domain) ?? groups.set(c.domain, []).get(c.domain)!).push(c);
  const titles: Record<string, string> = { docker: 'Docker objects', engine: 'Engine internals', linux: 'Linux & kernel', oci: 'OCI standards', ecosystem: 'Wider ecosystem' };
  return `<div class="empty"><h2>Concepts</h2><p>Pick one idea. Follow its connections.</p>
  ${[...groups.entries()].map(([d, list]) => `<details class="sec" data-disclosure="index:${esc(d)}" ${d === 'docker' ? 'open' : ''}><summary>${esc(titles[d] ?? d)}</summary><div class="chips">${list.map((c) => `<button class="chip" data-act="concept" data-arg="${c.id}" style="border-color:${ROLE_COLOR[c.role]}55">${esc(c.name)}</button>`).join('')}</div></details>`).join('')}</div>`;
}

/* ================================================================ progress */

function renderProgress(app: App): string {
  const p = app.engine.progress;
  const seen = Object.entries(p.concepts)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.maxLevel - a.maxLevel || b.seen - a.seen);
  const right = p.predictions.filter((x) => x.correct).length;
  return `<div class="insp">
    <h2>What you have explored</h2>
    <p class="sub">Tracked only in this browser. Your AI can read it to adapt what it teaches next.</p>
    <div class="sec"><h4>Depth reached</h4><div class="chips">${([0, 1, 2, 3, 4, 5, 6] as Level[]).map((l) => `<span class="pill ${p.levelsVisited.includes(l) ? 'ok' : 'idle'}">${l} ${esc(LEVEL_NAMES[l])}</span>`).join('')}</div></div>
    <div class="sec"><h4>Predictions</h4>${p.predictions.length ? `<div class="note" style="margin:0 0 6px">${right} of ${p.predictions.length} right</div>${p.predictions.map((x) => `<div class="misc" style="border-color:${x.correct ? 'rgba(126,231,135,.4)' : 'rgba(255,107,107,.35)'};background:${x.correct ? 'rgba(126,231,135,.06)' : 'rgba(255,107,107,.06)'}"><b style="color:${x.correct ? 'var(--ok)' : 'var(--failure)'}">${x.correct ? 'Right' : 'Missed'}.</b> ${esc(x.question)}<br><span style="color:var(--muted)">You said: ${esc(x.chosen)}${x.correct ? '' : ` · It was: ${esc(x.answer)}`}</span></div>`).join('')}` : '<div class="note">None yet. Try “What if…” and predict before you run.</div>'}</div>
    <div class="sec"><h4>Experiments run</h4>${p.scenarios.length ? `<div class="chips">${p.scenarios.map((s) => `<span class="chip">${esc(SCENARIO_MAP[s]?.title ?? s)}</span>`).join('')}</div>` : '<div class="note">None yet.</div>'}</div>
    <div class="sec"><h4>Concepts seen (${seen.length})</h4><div class="bars">${seen.slice(0, 24).map((s) => `<div class="bar"><button class="chip" data-act="concept" data-arg="${s.id}" style="justify-self:start">${esc(CONCEPTS[s.id]?.name ?? s.id)}</button><i title="deepest level ${s.maxLevel}"><span style="width:${(s.maxLevel / 6) * 100}%"></span></i></div>`).join('') || '<div class="note">Click around: this fills in as you go.</div>'}</div></div>
    <div class="sec"><h4>Who did what</h4><div class="note">You: ${p.userActions} actions · Your AI: ${p.aiActions} actions</div></div>
  </div>`;
}
