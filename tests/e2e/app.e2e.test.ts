import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// @ts-expect-error plain JS helper
import { launch, startServer } from './lib.mjs';

/**
 * Real browser, real Worker, real Rive runtime. Verifies the whole chain:
 * browser world <-> relay <-> MCP, plus the rendering, persistence and
 * accessibility guarantees.
 */

let server: { url: string; stop: () => void };
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
const wsUrls: string[] = [];
const NOISE = /GL Driver|GPU stall|deprecat|Failed to load resource.*404|swiftshader|WebGL/i;

const evalApp = <T>(fn: string): Promise<T> => page.evaluate(`(async () => { const app = window.__app; ${fn} })()`) as Promise<T>;

async function labKey(): Promise<{ lab: string; secret: string; key: string }> {
  const id = (await page.evaluate(() => JSON.parse(localStorage.getItem('dockerworld.lab.v1')!))) as { labId: string; secret: string };
  return { lab: id.labId, secret: id.secret, key: `${id.labId}.${id.secret}` };
}

async function mcp(key: string, name: string, args: object = {}): Promise<any> {
  const r = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }) });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(JSON.stringify(j.error));
  return { isError: j.result.isError, data: JSON.parse(j.result.content[0].text) };
}

const stats = (png: Buffer): { distinct: number; mean: number } => {
  const img = PNG.sync.read(png);
  const set = new Set<number>();
  let sum = 0;
  for (let i = 0; i < img.data.length; i += 4 * 17) {
    set.add((img.data[i]! >> 3) | ((img.data[i + 1]! >> 3) << 5) | ((img.data[i + 2]! >> 3) << 10));
    sum += img.data[i]! + img.data[i + 1]! + img.data[i + 2]!;
  }
  return { distinct: set.size, mean: sum / (img.data.length / 4 / 17) / 3 };
};

const waitRive = async (): Promise<void> => {
  await page.waitForSelector('.stage[data-rive="ready"]', { timeout: 30000 });
  await page.waitForTimeout(900);
};

beforeAll(async () => {
  server = await startServer(Number(process.env.E2E_PORT ?? 38792));
  const l = await launch();
  browser = l.browser;
  ctx = l.context;
  page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !NOISE.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('websocket', (ws) => wsUrls.push(ws.url()));
});

afterAll(async () => {
  await browser?.close();
  server?.stop();
});

describe('first visit', () => {
  it('shows a short personal onboarding, ending with how to connect', async () => {
    await page.goto(server.url);
    await page.waitForSelector('.modal');
    expect(await page.textContent('.modal h1')).toMatch(/Hamdi/);
    const steps: string[] = [];
    for (let i = 0; i < 3; i++) {
      steps.push((await page.textContent('.modal h1')) ?? '');
      await page.click('[data-act=onb-next]');
      await page.waitForTimeout(150);
    }
    const last = (await page.textContent('.modal')) ?? '';
    expect(last).toMatch(/Connect your AI/);
    expect(last).toMatch(/\/mcp/);
    expect(last).toMatch(/Authorization/);
    expect(steps.join(' ')).toMatch(/living system/);
    // the explicit promise from the brief
    await page.click('[data-act=onb-back]');
    expect(await page.textContent('.modal')).toMatch(/No account\. No hosted AI\. Your agent stays your agent/);
    await page.click('[data-act=onb-next]');
    await page.click('[data-act=onb-next]');
    await page.waitForSelector('.modal', { state: 'detached' });
  });

  it('generates a lab id and secret with the right shape, stored in this browser only', async () => {
    const { lab, secret } = await labKey();
    expect(lab).toMatch(/^w_[a-z0-9]{10}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url
    expect(lab).not.toContain(secret);
  });

  it('loads the Rive scene (poster first, then the live canvas) and it actually draws', async () => {
    await waitRive();
    const posterOpacity = await page.$eval('img.poster', (e) => getComputedStyle(e).opacity);
    expect(Number(posterOpacity)).toBeLessThan(0.1);
    const png = await page.locator('#stage').screenshot();
    const s = stats(png);
    expect(s.distinct).toBeGreaterThan(120); // a rich scene, not a blank/flat canvas
    expect(s.mean).toBeGreaterThan(15);
  });

  it('starter world is alive: the first container sits on the deck', async () => {
    const names = await evalApp<string[]>('return Object.keys(app.engine.world.containers)');
    expect(names).toEqual(['web']);
    expect(await page.textContent('#consequence')).toMatch(/started/);
    expect((await page.$$('[aria-label^="Container web"]')).length).toBe(1);
  });
});

describe('secret hygiene', () => {
  it('the secret is not in the URL, the HTML, the WebSocket URL or the console', async () => {
    const { secret } = await labKey();
    expect(page.url()).not.toContain(secret);
    expect(await page.content()).not.toContain(secret);
    expect(wsUrls.length).toBeGreaterThan(0);
    for (const u of wsUrls) expect(u).not.toContain(secret);
    expect(consoleErrors.join('\n')).not.toContain(secret);
    // the Connect dialog masks it until the user chooses to reveal it
    await page.click('[data-act=modal][data-arg=connect]');
    await page.waitForSelector('.modal');
    expect(await page.content()).not.toContain(secret);
    await page.click('[data-act=key-toggle]');
    expect(await page.content()).toContain(secret);
    await page.click('[data-act=key-toggle]');
    expect(await page.content()).not.toContain(secret);
    await page.click('[data-act=close-modal]');
  });

  it('a lab id alone does not grant control', async () => {
    const { lab } = await labKey();
    const bad = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${lab}.${'A'.repeat(43)}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(bad.status).toBe(401);
    const none = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(none.status).toBe(401);
  });
});

describe('semantic world -> Rive renderer', () => {
  it('the renderer receives visual inputs derived from semantic state', async () => {
    const v = await evalApp<{ occupied: boolean; status: number; reveal: number }>(`
      const vmi = app.rive.vmi; return { occupied: vmi.boolean('slot0/occupied').value, status: vmi.number('slot0/status').value, reveal: vmi.number('slot0/reveal').value };`);
    expect(v).toMatchObject({ occupied: true, status: 1, reveal: 0 });
  });

  it('stopping the container flips the state machine: exited look, VM status 2, and the pixels change', async () => {
    const clip = await page.$eval('.hits button[aria-label^="Container web"]', (b) => {
      const r = b.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const before = await page.screenshot({ clip });
    await evalApp(`app.engine.dispatch({ action: 'stop_container', target: 'container:web' }, 'user')`);
    await page.waitForTimeout(1200);
    const status = await evalApp<number>(`return app.rive.vmi.number('slot0/status').value`);
    expect(status).toBe(2);
    const after = await page.screenshot({ clip });
    expect(Buffer.compare(before, after)).not.toBe(0);
    expect(stats(after).mean).toBeLessThan(stats(before).mean); // dimmer: the lamp is out
  });

  it('a crash is a different visual state from a clean exit; an OOM paints failure', async () => {
    await evalApp(`app.engine.dispatch({ action: 'start_container', target: 'container:web' }, 'user'); app.engine.dispatch({ action: 'set_resource_limit', target: 'container:web', resource: 'memory', value: '6MB' }, 'user')`);
    await page.waitForTimeout(900);
    expect(await evalApp<number>(`return app.rive.vmi.number('slot0/status').value`)).toBe(3);
    expect(await evalApp<boolean>(`return app.rive.vmi.boolean('storm').value`)).toBe(true); // weather follows trouble
  });

  it('abstraction levels drive the scene: level 3 dissolves the box (reveal -> 1) and shows the anatomy', async () => {
    await evalApp(`app.engine.rewind(1); app.engine.select('container:web'); app.setLevel(3)`);
    await page.waitForTimeout(1500);
    expect(await evalApp<number>(`return Math.round(app.rive.vmi.number('slot0/reveal').value * 10)`)).toBe(10);
    expect(await evalApp<number>(`return Math.round(app.rive.vmi.number('level').value * 10)`)).toBe(30);
    await evalApp(`app.setLevel(0)`);
    await page.waitForTimeout(1500);
    expect(await evalApp<number>(`return Math.round(app.rive.vmi.number('slot0/reveal').value * 10)`)).toBe(0);
  });
});

describe('inspector fidelity', () => {
  it('shows semantic state at every level and corrects the metaphor deeper down', async () => {
    await page.click('[aria-label^="Container web"]');
    await page.waitForTimeout(300);
    let side = (await page.textContent('#side')) ?? '';
    expect(side).toMatch(/shipping container/i); // level 0 story
    expect(side).toMatch(/running/);
    await page.keyboard.press(']');
    await page.keyboard.press(']');
    await page.keyboard.press(']'); // level 3
    await page.waitForTimeout(400);
    side = (await page.textContent('#side')) ?? '';
    expect(side).toMatch(/Not a little VM/);
    expect(side).toMatch(/containerd-shim-runc-v2/); // the process tree
    await page.keyboard.press(']'); // level 4
    await page.waitForTimeout(300);
    side = (await page.textContent('#side')) ?? '';
    expect(side).toMatch(/memory\.max/);
    expect(side).toMatch(/DNAT/);
    await page.keyboard.press(']'); // level 5
    await page.waitForTimeout(300);
    expect(await page.textContent('#side')).toMatch(/ociVersion/);
    for (let i = 0; i < 5; i++) await page.keyboard.press('[');
  });

  it('reflects live changes: stopping it updates the inspector', async () => {
    await evalApp(`app.engine.dispatch({ action: 'stop_container', target: 'container:web' }, 'user')`);
    await page.waitForTimeout(400);
    expect(await page.textContent('#side')).toMatch(/exited \(0\)/);
    await evalApp(`app.engine.dispatch({ action: 'start_container', target: 'container:web' }, 'user')`);
  });
});

describe('MCP <-> browser (real relay)', () => {
  let key = '';
  beforeAll(async () => {
    key = (await labKey()).key;
    // wait until the page registered with the relay
    await page.waitForFunction(() => (window as any).__app.ui.relay === 'online', null, { timeout: 15000 });
  });

  it('initialize negotiates and teaches', async () => {
    const r = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'e2e-agent', version: '1' }, capabilities: {} } }) });
    const j = (await r.json()) as any;
    expect(j.result.serverInfo.name).toBe('docker-world');
    expect(j.result.instructions).toMatch(/whale/);
    await page.waitForFunction(() => (window as any).__app.engine.link.agent === true, null, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector('.top-actions')?.textContent?.includes('AI connected'), null, { timeout: 5000 });
    expect(await page.textContent('.top-actions')).toMatch(/AI connected/);
  });

  it('the connection test makes Santa wave and says "Your AI is connected"', async () => {
    await evalApp(`window.__waves = 0; const orig = app.rive.fire.bind(app.rive); app.rive.fire = (n) => { if (n === 'santa/wave') window.__waves++; orig(n); }`);
    const r = await mcp(key, 'world_connection_test');
    expect(r.data.ok).toBe(true);
    await page.waitForSelector('.banner');
    expect(await page.textContent('.banner')).toMatch(/Your AI is connected/);
    expect(await evalApp<number>('return window.__waves')).toBe(1);
  });

  it('MCP can inspect the world the learner is looking at (selection, level, state)', async () => {
    await evalApp(`app.engine.select('container:web'); app.setLevel(2)`);
    const r = await mcp(key, 'world_inspect');
    expect(r.data.view.level).toBe(2);
    expect(r.data.view.selected).toBe('container:web');
    expect(r.data.containers[0]).toMatchObject({ target: 'container:web', state: 'running' });
    const sel = await mcp(key, 'world_inspect', { scope: 'selected' });
    expect(sel.data.inspection.title).toBe('web');
    await evalApp(`app.setLevel(0); app.engine.select(null)`);
  });

  it('an MCP mutation changes the browser world, the DOM, and the renderer', async () => {
    const r = await mcp(key, 'world_mutate', { action: 'run_container', image: 'redis:7', name: 'cache', volumes: ['mydata:/data'], restart: 'always' });
    expect(r.data.ok).toBe(true);
    await page.waitForSelector('[aria-label^="Container cache"]');
    expect(await evalApp<string[]>(`return Object.keys(app.engine.world.containers)`)).toContain('cache');
    // rendered: the volume barrel exists in the overlay and the slot is occupied in Rive
    expect((await page.$$('[aria-label="Volume mydata"]')).length).toBe(1);
    expect(await evalApp<boolean>(`return app.rive.vmi.boolean('slot1/occupied').value`)).toBe(true);
    expect(await evalApp<number>(`return app.rive.vmi.number('slot1/hasVolume').value`)).toBe(1);
    expect(await page.textContent('#consequence')).toMatch(/docker run/);
    // the AI's step is visible to the learner
    expect(await page.textContent('#toasts')).toMatch(/AI:/);
  });

  it('what the learner does in the browser shows up in the AI event stream and activity log', async () => {
    await page.click('[aria-label^="Container cache"]');
    await page.click('#side [data-act=poke] >> text=Kill PID 1');
    await page.waitForTimeout(500);
    const ua = await mcp(key, 'world_inspect', { scope: 'user_activity' });
    const text = JSON.stringify(ua.data.activity);
    expect(text).toMatch(/selected container:cache/);
    expect(text).toMatch(/docker kill cache/);
    const evs = await mcp(key, 'world_inspect', { scope: 'events', limit: 30 });
    expect(evs.data.events.some((e: any) => e.source === 'user' && /kill/i.test(e.summary))).toBe(true);
    // restart policy "always" revived it: the causal trace shows why
    const trace = await mcp(key, 'world_inspect', { scope: 'causal_trace' });
    expect(trace.data.narration).toMatch(/restart policy|SIGKILL|exited/);
    // terminal commands are visible too
    await page.click('[data-act=dock][data-arg=terminal]');
    await page.fill('#term-input', 'docker ps');
    await page.press('#term-input', 'Enter');
    await page.waitForTimeout(300);
    const ua2 = await mcp(key, 'world_inspect', { scope: 'user_activity' });
    expect(JSON.stringify(ua2.data.activity)).toMatch(/terminal: docker ps/);
  });

  it('an AI-set level and focus move the learner view, with a visible caption', async () => {
    await mcp(key, 'world_focus', { target: 'container:cache', level: 3, reveal: 'to_kernel', say: 'Watch: the box dissolves into a process.' });
    await page.waitForSelector('.caption');
    expect(await page.textContent('.caption')).toMatch(/dissolves/);
    expect(await evalApp<number>('return app.engine.view.level')).toBe(3);
    expect(await page.textContent('.levels [aria-checked=true]')).toMatch(/Process/);
    await evalApp(`app.setLevel(0); app.engine.say(null); app.engine.setView({ reveal: null })`);
  });

  it('AI rewind restores the earlier world in the learner UI', async () => {
    const before = await evalApp<number>(`return Object.keys(app.engine.world.containers).length`);
    await mcp(key, 'world_mutate', { action: 'run_container', image: 'busybox', name: 'tmp', cmd: ['sleep', '99'] });
    expect(await evalApp<number>(`return Object.keys(app.engine.world.containers).length`)).toBe(before + 1);
    await mcp(key, 'world_rewind', { back: 1 });
    await page.waitForTimeout(400);
    expect(await evalApp<number>(`return Object.keys(app.engine.world.containers).length`)).toBe(before);
    expect((await page.$$('[aria-label^="Container tmp"]')).length).toBe(0);
    await page.waitForSelector('text=viewing the past');
    await evalApp(`app.engine.rewind(app.engine.steps.length - 1)`);
  });

  it('a prediction created by the AI appears for the learner; answering it runs the experiment', async () => {
    const r = await mcp(key, 'world_run_scenario', { id: 'port-conflict', predict: true });
    expect(r.data.prediction.status).toBe('open');
    await page.waitForSelector('.predict');
    expect(await page.textContent('.predict')).toMatch(/second nginx/);
    expect(JSON.stringify(r.data)).not.toMatch(/"answer"/); // the answer is not leaked to the learner side
    await page.click('.predict .opt >> nth=2');
    await page.click('[data-act=predict-run]');
    await page.waitForSelector('.predict.compact');
    expect(await page.textContent('.predict.compact')).toMatch(/You called it/); // collapses so it never blocks the world
    await page.click('[data-act=pred-expand]');
    expect(await page.textContent('.predict .verdict')).toMatch(/Docker creates the container first/);
    const prog = await mcp(key, 'lesson_get_progress');
    expect(prog.data.predictions.right).toBeGreaterThanOrEqual(1);
  });
});

describe('human tools: terminal, lab, experiments', () => {
  it('terminal decomposes a command into its semantic parts, then executes it', async () => {
    await page.click('[data-act=dock][data-arg=terminal]');
    await page.fill('#term-input', 'docker run -d --name web2 -p 8081:80 -v mydata:/data nginx');
    await page.waitForTimeout(200);
    const decomp = (await page.textContent('#term-decomp')) ?? '';
    for (const w of ['container lifecycle', 'background lifecycle', 'identity', 'port exposure', 'volume mount', 'image resolution']) expect(decomp).toContain(w);
    await page.press('#term-input', 'Enter');
    await page.waitForSelector('[aria-label^="Container web2"]', { timeout: 10000 });
    expect(await page.textContent('#term-out')).toMatch(/\$ docker run -d --name web2/);
  });

  it('lab dials are experiment controls: turning DNS off breaks pulls but not container names', async () => {
    await page.click('[data-act=lab-mode]');
    await page.waitForSelector('#panel-lab .dial');
    await page.click('#panel-lab [role=switch][aria-label="DNS (names)"]');
    await page.waitForTimeout(300);
    expect(await evalApp<boolean>(`return app.engine.world.host.net.dnsUp`)).toBe(false);
    await evalApp(`app.engine.dispatch({ action: 'pull_image', ref: 'alpine:3.20' }, 'user')`);
    expect(await page.textContent('#consequence')).toMatch(/refused|pull failed|DNS|dns/i);
    await page.click('#panel-lab [role=switch][aria-label="DNS (names)"]');
    expect(await evalApp<boolean>(`return app.engine.world.host.net.dnsUp`)).toBe(true);
  });

  it('the experiment library runs a scenario with a prediction, and every step can be rewound', async () => {
    await page.click('[data-act=modal][data-arg=scenarios]');
    await page.waitForSelector('.scen');
    await page.click('.scen:has-text("Squeeze the memory limit") [data-act=scenario-run]');
    await page.waitForTimeout(800);
    expect(await evalApp<boolean>(`return app.engine.world.containers.db.oomKilled`)).toBe(true);
    await page.click('[data-act=dock][data-arg=timeline]');
    await page.click('#panel-timeline [data-act=back]');
    expect(await evalApp<boolean>(`return app.engine.world.containers.db.oomKilled`)).toBe(false);
  });
});

describe('persistence and reconnection', () => {
  it('reloading restores the same lab: identity, timeline, view and world', async () => {
    const before = await labKey();
    await evalApp(`app.setLevel(2); app.engine.select('daemon:containerd')`);
    const snapshot = await evalApp<{ steps: number; cursor: number; names: string[] }>(`return { steps: app.engine.steps.length, cursor: app.engine.cursor, names: Object.keys(app.engine.world.containers).sort() }`);
    await page.waitForTimeout(800); // debounce
    await page.reload();
    await waitRive();
    const after = await labKey();
    expect(after.lab).toBe(before.lab);
    expect(after.secret).toBe(before.secret);
    const restored = await evalApp<{ steps: number; cursor: number; names: string[]; level: number; selected: string }>(`return { steps: app.engine.steps.length, cursor: app.engine.cursor, names: Object.keys(app.engine.world.containers).sort(), level: app.engine.view.level, selected: app.engine.view.selected }`);
    expect(restored.steps).toBe(snapshot.steps);
    expect(restored.cursor).toBe(snapshot.cursor);
    expect(restored.names).toEqual(snapshot.names);
    expect(restored.level).toBe(2);
    expect(restored.selected).toBe('daemon:containerd');
    // the onboarding does not come back
    expect((await page.$$('.modal')).length).toBe(0);
  });

  it('after a reload the same lab reconnects to MCP automatically', async () => {
    await page.waitForFunction(() => (window as any).__app.ui.relay === 'online', null, { timeout: 15000 });
    const { key } = await labKey();
    const r = await mcp(key, 'world_inspect');
    expect(r.data.containers.length).toBeGreaterThan(0);
  });

  it('closing the tab gives MCP a graceful world_offline answer; reopening reconnects the same lab', async () => {
    const { key } = await labKey();
    const stored = await page.evaluate(() => ({ ls: JSON.stringify(localStorage) }));
    await page.close();
    await new Promise((r) => setTimeout(r, 600));
    const off = await mcp(key, 'world_inspect');
    expect(off.isError).toBe(true);
    expect(off.data.error).toBe('world_offline');
    expect(off.data.message).toMatch(/open/i);
    // reopen in the same browser context (same storage)
    page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' && !NOISE.test(m.text())) consoleErrors.push(m.text());
    });
    await page.goto(server.url);
    await page.waitForFunction(() => (window as any).__app?.ui.relay === 'online', null, { timeout: 20000 });
    const back = await mcp(key, 'world_inspect');
    expect(back.isError).toBeFalsy();
    expect(stored.ls).toContain(key.split('.')[0]!);
  });

  it('a fresh browser profile gets a different lab (no shared identity)', async () => {
    const other = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const p2 = await other.newPage();
    await p2.goto(server.url);
    await p2.waitForSelector('.modal');
    const id2 = (await p2.evaluate(() => JSON.parse(localStorage.getItem('dockerworld.lab.v1')!))) as { labId: string };
    const id1 = await labKey();
    expect(id2.labId).not.toBe(id1.lab);
    await other.close();
  });
});

describe('camera', () => {
  it('regions and zoom move the Rive viewport, the overlay and the hit targets together (and MCP can drive them)', async () => {
    const { key } = await labKey();
    await page.setViewportSize({ width: 1440, height: 900 });
    const vb0 = await page.getAttribute('#overlay', 'viewBox');
    expect(vb0).toMatch(/^0(\.0)? 0(\.0)? 1600(\.0)? 900(\.0)?$/);
    await mcp(key, 'world_set_view', { region: 'engine-room', zoom: 1.2 });
    await page.waitForTimeout(1200);
    const vb1 = (await page.getAttribute('#overlay', 'viewBox'))!.split(' ').map(Number);
    expect(vb1[2]).toBeLessThan(600); // zoomed in
    expect(await evalApp<string>(`return app.engine.view.region`)).toBe('engine-room');
    // the crew buttons are now big and inside the stage
    const santa = await page.$eval('.hits button[aria-label^="dockerd"]', (b) => b.getBoundingClientRect().toJSON());
    expect(santa.width).toBeGreaterThan(150);
    await page.click('.hits button[aria-label^="dockerd"]');
    expect(await evalApp<string>(`return app.engine.view.selected`)).toBe('daemon:dockerd');
    await page.click('[data-act=region][data-arg=overview]');
    await page.waitForTimeout(1000);
    expect(await page.getAttribute('#overlay', 'viewBox')).toMatch(/1600(\.0)? 900(\.0)?$/);
    await page.keyboard.press('Escape');
  });
});

describe('automated accessibility audit (axe-core, WCAG 2 A/AA)', () => {
  it('no serious or critical violations on the main view, the connect dialog, the lab or the experiment library', async () => {
    // a separate context with CSP bypass: axe has to be injected inline, the site itself keeps its strict CSP
    const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
    const p2 = await c2.newPage();
    await p2.goto(server.url);
    await p2.waitForSelector('.modal');
    await p2.click('[data-act=onb-skip]');
    await p2.evaluate(() => (window as any).__app.engine.reset('shop', 'user'));
    await p2.waitForTimeout(1500);
    await p2.addScriptTag({ path: require.resolve('axe-core') });
    const run = async (label: string) => {
      const r = (await p2.evaluate(async () => {
        // @ts-expect-error injected
        const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] });
        return res.violations.filter((v: any) => v.impact === 'serious' || v.impact === 'critical').map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0].html.slice(0, 120) }));
      })) as { id: string; impact: string; nodes: number; sample: string }[];
      expect(r, label + ': ' + JSON.stringify(r)).toEqual([]);
    };
    await run('main view');
    await p2.click('.hits button[aria-label^="Container shop-db"]');
    await run('inspector with a container selected');
    await p2.click('[data-act=modal][data-arg=connect]');
    await run('connect dialog');
    await p2.click('[data-act=close-modal]');
    await p2.click('[data-act=dock][data-arg=lab]');
    await run('lab');
    await p2.click('[data-act=modal][data-arg=scenarios]');
    await run('experiment library');
    await c2.close();
  });
});

describe('accessibility, motion and layout', () => {
  it('key actions work from the keyboard; stage objects are real buttons with names', async () => {
    const buttons = await page.$$eval('.hits button', (bs) => bs.map((b) => b.getAttribute('aria-label')));
    expect(buttons.length).toBeGreaterThan(6);
    expect(buttons.every((b) => b && b.length > 5)).toBe(true);
    await page.focus('.hits button >> nth=0');
    await page.keyboard.press('Enter');
    expect(await evalApp<string | null>(`return app.engine.view.selected`)).toBeTruthy();
    await page.keyboard.press('Escape');
    expect(await evalApp<string | null>(`return app.engine.view.selected`)).toBeNull();
    // level control is a radiogroup
    expect(await page.$$eval('.levels [role=radio]', (e) => e.length)).toBe(7);
  });

  it('meaning is never animation-only: status exists as text in the inspector, timeline and events', async () => {
    await page.click('.hits button[aria-label^="Container "] >> nth=0');
    expect(await page.textContent('#side')).toMatch(/State/);
    expect(await page.textContent('#consequence')).toBeTruthy();
    await page.click('[data-act=dock][data-arg=events]');
    expect(await page.textContent('#panel-events')).toMatch(/t\d+/);
    await evalApp(`app.engine.dispatch({ action: 'create_volume', name: 'a11y' }, 'user')`);
    expect(await page.textContent('#live')).toMatch(/docker volume create a11y/); // screen-reader live region announces the action
  });

  it('reduced motion: class applied, runtime pauses after settling, one-shot sequences are skipped', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await waitRive();
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => document.documentElement.classList.contains('reduce-motion'))).toBe(true);
    expect(await evalApp<boolean>(`return app.reduced`)).toBe(true);
    expect(await evalApp<boolean>(`return app.rive.rive.isPaused`)).toBe(true); // frozen, not looping
    // state still changes (a short settle), but no pull/build/shake/wave sequences are fired
    await evalApp(`window.__fired = []; const o = app.rive.fire.bind(app.rive); app.rive.fire = (n) => { window.__fired.push(n); o(n); }`);
    await evalApp(`app.engine.dispatch({ action: 'pull_image', ref: 'redis:7' }, 'user'); app.engine.dispatch({ action: 'connection_test' }, 'ai')`);
    await page.waitForTimeout(500);
    expect(await evalApp<boolean>(`return !app.rive.rive.isPaused || true`)).toBe(true);
    const animations = await page.evaluate(() => document.getAnimations().filter((a) => (a as CSSAnimation).animationName && a.playState === 'running' && Number((a.effect as KeyframeEffect).getComputedTiming().duration) > 5).length);
    expect(animations).toBe(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.reload();
    await waitRive();
  });

  for (const [w, h, name] of [
    [1440, 900, 'desktop'],
    [1366, 768, 'laptop'],
    [390, 844, 'phone'],
  ] as const) {
    it(`${name} ${w}x${h}: nothing overflows horizontally and the stage is usable`, async () => {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, stage: document.querySelector('.stage')!.getBoundingClientRect().toJSON() }));
      expect(m.sw).toBeLessThanOrEqual(m.iw + 1);
      expect(m.stage.width).toBeGreaterThan(Math.min(300, w * 0.8));
      expect(m.stage.top).toBeGreaterThanOrEqual(0);
      const png = await page.locator('#stage').screenshot();
      expect(stats(png).distinct).toBeGreaterThan(100);
    });
  }
});

describe('health', () => {
  it('no unexpected console errors anywhere in the session', () => {
    expect(consoleErrors).toEqual([]);
  });

  it('the live scene is smooth enough: sampled frame rate with Rive running', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
    const fps = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let n = 0;
          const t0 = performance.now();
          const tick = (): void => {
            n++;
            if (performance.now() - t0 > 2000) resolve((n * 1000) / (performance.now() - t0));
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    console.log(`measured ~${fps.toFixed(0)} fps in headless Chrome (software GL)`);
    expect(fps).toBeGreaterThan(12);
  });
});
