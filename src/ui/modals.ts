import type { App, UiState } from '../app/app';
import { SCENARIOS } from '../engine/scenarios';
import { CONCEPTS } from '../engine/concepts';
import { esc, icon, ago, whaleLogo } from './h';

/** What gets copied. Built at click time so the secret is never stored in the DOM unless the user chose to reveal it. */
export function snippet(app: App, kind: string): string {
  const url = app.mcpUrl;
  const key = app.bearerKey;
  switch (kind) {
    case 'ai-agent':
      return `Connect to my Whale Lab and teach me Docker through the visual world open in my browser.

Server name: docker-world
Transport: MCP Streamable HTTP (POST JSON-RPC)
Endpoint: ${url}
Authorization header: Bearer ${key}

Use these credentials only for this lab. Keep the key in the Authorization header, never in a URL.

If you can configure an MCP connection, add this server with the endpoint and header above. Otherwise, use your HTTP tool to POST JSON-RPC directly to the endpoint, with Content-Type: application/json and Accept: application/json, text/event-stream.

First initialize:
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"${kind}","version":"1"}}}
Then send {"jsonrpc":"2.0","method":"notifications/initialized"} and list the tools with {"jsonrpc":"2.0","id":2,"method":"tools/list"}.
Call {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"world_connection_test","arguments":{}}}. Santa should wave. Keep my browser tab open.

Inspect the world before teaching. Show one change, explain it in one short sentence, let me try, then show the consequence. Start with my question or selected object. Use the existing prediction and rewind tools to help me learn.`;
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
3. Teach one idea at a time: show → one short sentence → let me try → show the consequence. Wait for my response before the next idea. Teach by changing the world: one visible change, one sentence of insight. Break things on purpose, trace causes (world_inspect scope "causal_trace"), rewind, and ask me to predict before you reveal (lesson_check_understanding).
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
  return `<div class="scrim" data-act="close-modal-scrim"><div class="modal ${wide ? 'wide' : ''} ${m.kind === 'onboarding' ? 'onboarding' : ''}" role="dialog" aria-modal="true" aria-label="${m.kind}" data-act="noop">${m.kind !== 'onboarding' ? `<button class="btn ghost small x" data-act="close-modal" aria-label="Close">${icon('x')}</button>` : ''}${inner}</div></div>`;
}

/* ============================================================== onboarding */

function onboarding(app: App, step: number): string {
  const dots = `<div class="dots" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>`;
  const nav = (last = false): string =>
    `<div class="nav">${step > 0 ? '<button class="btn ghost" data-act="onb-back">Back</button>' : ''}<span class="grow"></span><button class="btn ghost" data-act="onb-skip">Skip</button><button class="btn primary" data-act="onb-next">${last ? 'Start exploring' : 'Next'}</button></div>`;
  switch (step) {
    case 0:
      return `<p class="eyebrow">A note from the maker</p><h1>Hey, I'm Hamdi.</h1>
        <p>I'm learning Docker too, and normal lessons never fit how my head works. I need to see how things connect before I really understand them, so I built this.</p>${dots}${nav()}`;
    case 1:
      return `<p class="eyebrow">See it. Try it.</p><h1>Docker, as a living system.</h1>
        <p>The whale is your machine. Containers ride on its back.</p>
        <p>Click an object. Try a change. Watch what happens.</p>${dots}${nav()}`;
    case 2:
      return `<p class="eyebrow">Bring your own teacher</p><h1>Better side by side.</h1>
        <p>For now, the best setup is two tabs next to each other: your AI in one, Whale Lab in the other.</p>
        <p>Leave full screen. Use your browser’s split view, or drag one tab into a second window.</p>
        ${sideBySideDemo()}
        <p class="setup-hint">Chat with your AI. Watch it change the world.</p>${dots}${nav()}`;
    default:
      return `<p class="eyebrow">One quick connection</p><h1>Connect your AI.</h1><p>Choose your agent and give it the setup prompt. It can connect and make Santa wave.</p>${connectBody(app, true)}${dots}<div class="nav"><button class="btn ghost" data-act="onb-back">Back</button><span class="grow"></span><button class="btn primary" data-act="onb-next">Start exploring</button></div>`;
  }

}

/** A short, self-contained illustration; real world/Rive state stays untouched. */
function sideBySideDemo(): string {
  return `<div class="side-by-side-demo" role="img" aria-label="Whale Lab leaves full screen. An AI tab opens beside it. You ask the AI to start a container, and one appears on the whale.">
    <div class="demo-browser demo-world">
      <div class="demo-browser-bar"><span class="demo-traffic" aria-hidden="true">•••</span><span>Whale Lab</span><svg class="demo-restore" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M3 6h7v7H3z"/></svg></div>
      <div class="demo-world-content"><svg viewBox="0 0 220 120" aria-hidden="true"><path d="M29 74 12 52 41 62C63 36 144 31 181 51c22 12 30 31 9 43-22 14-75 17-110 5C52 90 39 86 29 74Z" fill="#345b9c"/><path d="M91 99c-6 11-19 12-26 7l-3-12" fill="#2a487b"/><circle cx="176" cy="64" r="4" fill="#eef2fa"/><circle cx="177" cy="64" r="2" fill="#101725"/><path d="M49 47h119" stroke="#607492" stroke-width="3"/><rect x="72" y="28" width="27" height="18" rx="2" fill="#7698c9"/><g class="demo-new-container"><rect x="105" y="28" width="28" height="18" rx="2" fill="#ffb454"/><path d="M112 31v12m6-12v12m6-12v12" stroke="#a96c27"/></g></svg><span class="demo-world-status">Container running <i aria-hidden="true"></i></span></div>
    </div>
    <div class="demo-browser demo-ai">
      <div class="demo-browser-bar"><span class="demo-traffic" aria-hidden="true">•••</span><span>Your AI</span></div>
      <div class="demo-conversation"><div class="demo-question">Start a container.</div><div class="demo-answer">Watch the whale.</div><div class="demo-tool">↗ Container started</div></div>
    </div>
  </div>`;
}

/* =================================================================== connect */

function connect(app: App): string {
  return `<h2>Connect your AI</h2>
    <div class="promise">Let your AI teach by changing the world on your screen.</div>
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
    const text = s === 'online' ? 'Ready for your AI' : s === 'connecting' ? 'Connecting your world…' : s === 'replaced' ? 'This lab is open in another tab' : s === 'rejected' ? 'The relay rejected this lab key' : 'Not connected (will retry)';
    return `<div class="row"><span class="dot ${ok ? 'ok' : s === 'connecting' ? 'warn pulse' : 'bad'}"></span><b>Your world</b><span>${text}</span></div>`;
  })();
  const aiRow = `<div class="row"><span class="dot ${link.agent ? 'ok' : 'warn'}"></span><b>Your AI</b><span>${link.agent ? `connected${link.lastMcpClient ? ` as “${esc(link.lastMcpClient)}”` : ''}${link.lastMcpAt ? ` · last heard ${ago(link.lastMcpAt)}` : ''}` : 'Waiting for a connection'}</span></div>`;
  const key = ui.keyVisible ? app.bearerKey : mask(app.bearerKey);
  const tabs: [UiState['connectTab'], string][] = [
    ['ai-agent', 'Ai-Agent (meta muse, grok bot...)'],
    ['claude-code', 'Claude Code'],
    ['json', 'Cursor / VS Code / JSON'],
    ['desktop', 'Claude Desktop'],
    ['prompt', 'Teaching prompt'],
  ];
  const code = (kind: string, show: string, label = 'Copy'): string => `<div class="codebox"><button class="btn small copy" data-act="copy" data-arg="${kind}" aria-label="${esc(label === 'Copy' ? 'Copy this snippet' : label)}">${icon('copy', 13)} ${esc(label)}</button>${esc(show)}</div>`;
  const shown = (kind: string): string => {
    const real = snippet(app, kind);
    return ui.keyVisible ? real : real.split(app.bearerKey).join(mask(app.bearerKey));
  };
  const tab = ui.connectTab;
  const agentPrompt = tab === 'ai-agent';
  const snippetBox =
    agentPrompt
      ? `<p class="setup-hint">Paste this into a private chat with your agent. Copy includes the endpoint, full lab key, and connection steps.</p>${code(tab, shown(tab).split('\n').filter(line => /^(Endpoint:|Authorization header:)/.test(line)).join('\n'), 'Copy setup + key')}`
      : tab === 'claude-code'
      ? `<p style="font-size:14px;margin:4px 0">Run this once in a terminal:</p>${code('cc', shown('cc'))}`
      : tab === 'json'
        ? `<p class="setup-hint">Paste into your AI’s MCP server settings:</p>${code('json', shown('json'))}`
        : tab === 'desktop'
          ? `<p class="setup-hint">Add this to Claude Desktop’s configuration:</p>${code('desktop', shown('desktop'))}`
          : `<p style="font-size:14px;margin:4px 0">Once connected, paste this to your AI so it knows how to teach here:</p>${code('prompt', snippet(app, 'prompt'))}`;
  const test = `<div class="status" aria-live="polite">${relayRow}${aiRow}</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn" data-act="selftest" ${ui.selfTest.state === 'running' ? 'disabled' : ''}>${icon('plug', 14)} Test connection</button>
    <span style="font-size:13px;color:${ui.selfTest.state === 'ok' ? 'var(--ok)' : ui.selfTest.state === 'fail' ? 'var(--failure)' : 'var(--muted)'}">${esc(ui.selfTest.msg || 'Santa waves when the test reaches this world.')}</span></div>
    <p class="setup-hint">Then ask your AI: <b>“Call world_connection_test.”</b></p>`;
  const credentials = `<div class="keyrow"><span>Endpoint</span><code>${esc(app.mcpUrl)}</code><button class="btn small" data-act="copy" data-arg="endpoint" aria-label="Copy the endpoint URL">${icon('copy', 13)}</button></div>
    <div class="keyrow"><span>Lab key</span><code id="labkey" aria-label="Lab key (secret)">${esc(key)}</code><button class="btn small" data-act="key-toggle" aria-pressed="${ui.keyVisible}" title="${ui.keyVisible ? 'Hide' : 'Show'} the key">${icon(ui.keyVisible ? 'eyeoff' : 'eye', 14)}</button><button class="btn small" data-act="copy" data-arg="key" aria-label="Copy the lab key">${icon('copy', 13)}</button></div>
    <p class="setup-hint">Keep your key private. Anyone with it can control this lab. It travels in the Authorization header, never in a URL.</p>`;
  return `<label class="client-select">Your AI<select data-live="connect-client" aria-label="Your AI">${tabs.map(([k, l]) => `<option value="${k}" ${tab === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${snippetBox}
    <details class="connection-key ${tab === 'prompt' ? 'needs-key' : ''}" data-disclosure="connection-key"><summary>Endpoint & private lab key<small>${tab === 'prompt' ? 'Click to get these' : 'Show details'}</small></summary><div class="credentials">${credentials}</div></details>
    ${test}`;

}

/* ================================================================ scenarios */

function scenarios(app: App): string {
  const done = new Set(app.engine.progress.scenarios);
  return `<h2>What if I…?</h2><p style="font-size:14.5px">Pick an experiment. Make a prediction. Watch the result. You can always rewind.</p>
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
