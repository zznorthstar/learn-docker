import type { App, UiState } from '../app/app';
import { SCENARIOS } from '../engine/scenarios';
import { CONCEPTS } from '../engine/concepts';
import { esc, icon, ago, whaleLogo } from './h';

/** What gets copied. Built at click time so the secret is never stored in the DOM unless the user chose to reveal it. */
export function snippet(app: App, kind: string): string {
  const url = app.mcpUrl;
  const key = app.bearerKey;
  switch (kind) {
    case 'endpoint':
      return url;
    case 'key':
      return key;
    case 'cc':
      return `claude mcp add --transport http docker-world ${url} --header "Authorization: Bearer ${key}"`;
    case 'json':
      return JSON.stringify({ mcpServers: { 'docker-world': { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
    case 'desktop':
      return JSON.stringify({ mcpServers: { 'docker-world': { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${DOCKER_WORLD_AUTH}'], env: { DOCKER_WORLD_AUTH: `Bearer ${key}` } } } }, null, 2);
    case 'prompt':
      return `You are connected to my "docker-world" MCP server: an interactive visual simulation of Docker on my screen. You are my Docker teacher; the page has no other tutor.

1. Call world_connection_test first (Santa should wave on my screen).
2. Call world_inspect to see what I can already see, and world_inspect with scope "user_activity" to see what I have been clicking.
3. I learn from patterns and relationships, not lectures. Teach by changing the world: one visible change, one sentence of insight. Break things on purpose, trace causes (world_inspect scope "causal_trace"), rewind, and ask me to predict before you reveal (lesson_check_understanding).
4. Start from my question or from what I have selected. Take me deeper through the abstraction levels (world_set_view level 0-6) so the cartoon never becomes a false model.`;
    default:
      return '';
  }
}

const mask = (k: string): string => k.replace(/\.(.{4}).*$/, '.$1••••••••••••••••••••••••••••••••');

export function renderModal(app: App): string {
  const m = app.ui.modal;
  if (!m) return '';
  let inner = '';
  let wide = false;
  switch (m.kind) {
    case 'onboarding':
      inner = onboarding(app, m.step);
      break;
    case 'connect':
      inner = connect(app);
      break;
    case 'scenarios':
      inner = scenarios(app);
      wide = true;
      break;
    case 'about':
      inner = about();
      break;
  }
  return `<div class="scrim" data-act="close-modal-scrim"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${m.kind}" data-act="noop">${m.kind !== 'onboarding' ? `<button class="btn ghost small x" data-act="close-modal" aria-label="Close">${icon('x')}</button>` : ''}${inner}</div></div>`;
}

/* ============================================================== onboarding */

function onboarding(app: App, step: number): string {
  const dots = `<div class="dots" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>`;
  const nav = (last = false): string =>
    `<div class="nav">${step > 0 ? '<button class="btn ghost" data-act="onb-back">Back</button>' : ''}<span class="grow"></span><button class="btn ghost" data-act="onb-skip">Skip</button><button class="btn primary" data-act="onb-next">${last ? 'Start exploring' : 'Next'}</button></div>`;
  switch (step) {
    case 0:
      return `<p class="lead" style="margin:0 0 4px">Hey,</p><h1>I'm Hamdi.</h1>
        <p>I'm learning Docker too, and the normal tutorials never fit how my head works. I can't absorb “this is a container, this is a network, this is a volume” one box at a time. I need to <i>see</i> how the pieces lean on each other before any of it clicks.</p>
        <p>So I built this.</p>${dots}${nav()}`;
    case 1:
      return `<h1>Docker, as a living system.</h1>
        <p>That whale is your machine. Santa flies it (he's <b>dockerd</b>). His reindeer crew do the real work. Containers ride on the deck, images wait in the harbor, volumes are strapped cargo, and the coloured lines are networks.</p>
        <p>It's a cartoon on purpose, and it can't be allowed to stay a lie. Go deeper and the cartoon peels away: past Docker's objects, through the engine, down to plain Linux processes and the kernel, and out to Kubernetes. <b>Click the container behind this window, then press “deeper”.</b></p>${dots}${nav()}`;
    case 2:
      return `<h1>The unusual part.</h1>
        <p>You don't have to read any of it. <b>Bring your own AI.</b> Connect it and it can drive this world while it teaches you: reveal internals, break things on purpose, rewind, trace what caused what, and react to whatever you click.</p>
        <p class="lead">You explore. Your AI teaches. The world becomes the diagram.</p>
        <div class="promise">No account. No hosted AI. Your agent stays your agent; this page simply gives it a world to teach through.</div>${dots}${nav()}`;
    default:
      return `<h1>Connect your AI.</h1><p>Add this server to any MCP-capable AI (Claude, Cursor, VS Code, anything that speaks MCP). It takes a minute, and you can skip it and explore on your own.</p>${connectBody(app, true)}${dots}<div class="nav"><button class="btn ghost" data-act="onb-back">Back</button><span class="grow"></span><button class="btn primary" data-act="onb-next">Start exploring</button></div>`;
  }
}

/* =================================================================== connect */

function connect(app: App): string {
  return `<h2>Connect your AI</h2>
    <div class="promise">No account. No hosted AI. Your agent stays your agent. This page simply gives it a world to teach through.</div>
    ${connectBody(app, false)}
    <div class="nav"><button class="btn ghost small" data-act="new-lab" title="Creates a new lab id and key">Reset lab key…</button><span class="grow"></span><button class="btn" data-act="close-modal">Done</button></div>`;
}

function connectBody(app: App, compact: boolean): string {
  const ui = app.ui;
  const e = app.engine;
  const link = e.link;
  const relayRow = (() => {
    const s = ui.relay;
    const ok = s === 'online';
    const text = s === 'online' ? 'This tab is registered with the relay' : s === 'connecting' ? 'Connecting to the relay…' : s === 'replaced' ? 'This lab is open in another tab' : s === 'rejected' ? 'The relay rejected this lab key' : 'Not connected (will retry)';
    return `<div class="row"><span class="dot ${ok ? 'ok' : s === 'connecting' ? 'warn pulse' : 'bad'}"></span><b>Your world</b><span>${text}</span></div>`;
  })();
  const aiRow = `<div class="row"><span class="dot ${link.agent ? 'ok' : 'warn'}"></span><b>Your AI</b><span>${link.agent ? `connected${link.lastMcpClient ? ` as “${esc(link.lastMcpClient)}”` : ''}${link.lastMcpAt ? ` · last heard ${ago(link.lastMcpAt)}` : ''}` : 'not seen yet: add the server below, then run the test'}</span></div>`;
  const key = ui.keyVisible ? app.bearerKey : mask(app.bearerKey);
  const tabs: [UiState['connectTab'], string][] = [
    ['claude-code', 'Claude Code'],
    ['json', 'Cursor / VS Code / JSON'],
    ['desktop', 'Claude Desktop (stdio)'],
    ['prompt', 'Prompt to paste'],
  ];
  const code = (kind: string, show: string): string => `<div class="codebox"><button class="btn small copy" data-act="copy" data-arg="${kind}" aria-label="Copy this snippet">${icon('copy', 13)} Copy</button>${esc(show)}</div>`;
  const shown = (kind: string): string => {
    const real = snippet(app, kind);
    return ui.keyVisible ? real : real.split(app.bearerKey).join(mask(app.bearerKey));
  };
  const tab = ui.connectTab;
  const snippetBox =
    tab === 'claude-code'
      ? `<p style="font-size:14px;margin:4px 0">Run this once in a terminal:</p>${code('cc', shown('cc'))}`
      : tab === 'json'
        ? `<p style="font-size:14px;margin:4px 0">Add to your client's MCP config (Streamable HTTP, header auth):</p>${code('json', shown('json'))}`
        : tab === 'desktop'
          ? `<p style="font-size:14px;margin:4px 0">For clients that only speak stdio, bridge with <code>mcp-remote</code>:</p>${code('desktop', shown('desktop'))}`
          : `<p style="font-size:14px;margin:4px 0">Once connected, paste this to your AI so it knows how to teach here:</p>${code('prompt', snippet(app, 'prompt'))}`;
  const test = `<div class="status" aria-live="polite">${relayRow}${aiRow}</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn" data-act="selftest" ${ui.selfTest.state === 'running' ? 'disabled' : ''}>${icon('plug', 14)} Run the self-test</button>
    <span style="font-size:13px;color:${ui.selfTest.state === 'ok' ? 'var(--ok)' : ui.selfTest.state === 'fail' ? 'var(--failure)' : 'var(--muted)'}">${esc(ui.selfTest.msg || 'Sends a real request through the relay to this page. Santa should wave.')}</span></div>
    <p style="font-size:13px;color:var(--muted);margin:8px 0 0">Or ask your AI: <b>“call world_connection_test”</b>. When it works, Santa waves and this page says <b>Your AI is connected</b>. (A green dot alone proves nothing, so the test makes the world react.)</p>`;
  return `${compact ? '' : ''}
    <div class="keyrow"><span style="min-width:74px;color:var(--muted)">Endpoint</span><code>${esc(app.mcpUrl)}</code><button class="btn small" data-act="copy" data-arg="endpoint" aria-label="Copy the endpoint URL">${icon('copy', 13)}</button></div>
    <div class="keyrow"><span style="min-width:74px;color:var(--muted)">Lab key</span><code id="labkey" aria-label="Lab key (secret)">${esc(key)}</code><button class="btn small" data-act="key-toggle" aria-pressed="${ui.keyVisible}" title="${ui.keyVisible ? 'Hide' : 'Show'} the key">${icon(ui.keyVisible ? 'eyeoff' : 'eye', 14)}</button><button class="btn small" data-act="copy" data-arg="key" aria-label="Copy the lab key">${icon('copy', 13)}</button></div>
    <p style="font-size:12.5px;color:var(--muted);margin:2px 0 8px">${icon('lock', 12)} The key is a capability token, not an identity: sent only in the <code>Authorization</code> header, never in a URL. Lab id <code>${esc(app.identity.labId)}</code> alone grants nothing. Anyone holding the key can steer this lab, so keep it out of screenshots.</p>
    <div class="tabs inline" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-act="connect-tab" data-arg="${k}">${l}</button>`).join('')}</div>
    ${snippetBox}
    <h2 style="font-size:19px;margin:14px 0 6px">Test it</h2>${test}`;
}

/* ================================================================ scenarios */

function scenarios(app: App): string {
  const done = new Set(app.engine.progress.scenarios);
  return `<h2>What if I…?</h2><p style="font-size:14.5px">Deliberately break Docker, then see exactly why it broke. <b>Predict first</b> is the best way to learn: commit to an answer, then watch the world prove you right or wrong. Every experiment can be rewound.</p>
    <div class="scen-grid">${SCENARIOS.map(
      (s) => `<div class="scen ${done.has(s.id) ? 'done' : ''}"><h3>${esc(s.title)}${done.has(s.id) ? ' <span class="pill ok">done</span>' : ''}</h3><p>${esc(s.whatIf)}</p><div class="chips">${s.concepts.slice(0, 3).map((c) => `<span class="chip" style="font-size:11px">${esc(CONCEPTS[c]?.name ?? c)}</span>`).join('')}</div><div class="row"><button class="btn small primary" data-act="scenario-predict" data-arg="${s.id}">Predict, then run</button><button class="btn small" data-act="scenario-run" data-arg="${s.id}">Just run it</button></div></div>`,
    ).join('')}</div>`;
}

/* ===================================================================== about */

function about(): string {
  return `<div style="display:flex;gap:12px;align-items:center;margin-bottom:8px">${whaleLogo(44)}<div><h2 style="margin:0">Whale Lab</h2><div style="color:var(--muted)">Docker, as a living world. Built by Hamdi, who is learning it too.</div></div></div>
    <p>A visual, interactive simulation of Docker. The world is the diagram; <b>your own AI is the teacher</b>, driving it over MCP while you click, drag, break and rewind.</p>
    <p><b>How it works.</b> Your browser owns the world (a deterministic simulation: lifecycle, volumes, networks, port publishing, cgroup limits and the OOM killer, signals and PID 1, restart policies, build cache, Compose health cascades). Rive draws it; an SVG layer draws the relationships; a thin relay only forwards your AI's calls to this tab. No account, no hosted AI, no server-side lab state.</p>
    <p><b>What is simulated.</b> This is not a real Docker daemon: it is a faithful model of its behaviour, so experiments are safe and repeatable. When it simplifies, the deeper levels say so.</p>
    <p><b>Keyboard.</b> <kbd>[</kbd> <kbd>]</kbd> shallower / deeper · <kbd>,</kbd> <kbd>.</kbd> step the timeline · <kbd>/</kbd> terminal · <kbd>Esc</kbd> close or deselect. Everything on the stage is also a real button, reachable with Tab.</p>
    <p style="color:var(--muted);font-size:13px">Your lab id and key, the world timeline and your progress are stored in this browser only.</p>`;
}
