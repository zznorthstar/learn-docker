// Runs against the deployed Worker too: MCP_SMOKE_URL=https://… node tests/e2e/mcp-smoke.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { launch } from './lib.mjs';

const base = process.env.MCP_SMOKE_URL ?? 'http://127.0.0.1:38901';
const artifacts = process.env.SMOKE_ARTIFACTS ?? '/tmp/docker-mcp-smoke';
await mkdir(artifacts, { recursive: true });
const { browser, context } = await launch();
let sequence = 0;
const rpc = async (key, method, params, headers = {}) => {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: ++sequence }), method, params }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const tool = async (key, name, args = {}, headers = {}) => {
  const response = await rpc(key, 'tools/call', { name, arguments: args }, headers);
  assert.equal(response.status, 200);
  assert.equal(response.body.result.isError, false);
  return JSON.parse(response.body.result.content[0].text);
};

try {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__app?.ui.relay === 'online' && window.__app?.ui.riveState === 'ready');
  if (await page.locator('[data-act=onb-skip]').count()) await page.locator('[data-act=onb-skip]').click();
  const identity = await page.evaluate(() => window.__app.identity);
  const key = `${identity.labId}.${identity.secret}`;
  const wrongKey = `${identity.labId}.${identity.secret[0] === 'x' ? 'y' : 'x'}${identity.secret.slice(1)}`;
  for (const headers of [{}, { 'Sec-Fetch-Mode': 'navigate', accept: 'text/html' }, { 'Sec-Fetch-Mode': 'cors', origin: base }]) {
    for (const invalid of [null, 'invalid', wrongKey]) {
      assert.equal((await rpc(invalid, 'ping', {}, headers)).status, 401);
    }
    assert.equal((await rpc(key, 'ping', {}, headers)).status, 200);
  }
  await page.click('[data-act=modal][data-arg=connect]');
  await page.click('[data-act=selftest]');
  await page.waitForFunction(() => window.__app.ui.selfTest.state === 'ok');
  assert.equal(await page.evaluate(() => window.__app.engine.link.agent), false);
  await page.screenshot({ path: `${artifacts}/self-test.png` });
  await page.click('[data-act=close-modal]');
  await page.waitForFunction(() => !window.__app.selfTestActive);
  const init = await rpc(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deployed-smoke-test', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal((await rpc(key, 'notifications/initialized')).status, 202);
  assert.ok((await rpc(key, 'tools/list')).body.result.tools.some(t => t.name === 'world_connection_test'));

  // An independent browser owns another lab. Calls must never leak between them.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto(base);
  await otherPage.waitForFunction(() => window.__app?.ui.relay === 'online');
  const otherId = await otherPage.evaluate(() => window.__app.identity.labId);
  assert.notEqual(otherId, identity.labId);
  await page.evaluate(() => {
    window.__smokeWaves = 0;
    const fire = window.__app.rive.fire.bind(window.__app.rive);
    window.__app.rive.fire = name => { if (name === 'santa/wave') window.__smokeWaves++; fire(name); };
    window.__app.engine.setView({ region: 'engine-room', zoom: 1 });
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${artifacts}/before-wave.png` });
  const result = await tool(key, 'world_connection_test', {}, { 'Sec-Fetch-Mode': 'navigate' });
  assert.equal(result.ok, true);
  await page.waitForFunction(() => window.__smokeWaves === 1);
  for (let i = 0; i < 4; i++) {
    await page.screenshot({ path: `${artifacts}/wave-${i}.png` });
    await page.waitForTimeout(150);
  }
  assert.equal(await otherPage.evaluate(() => window.__app.engine.cues.filter(c => c.kind === 'wave').length), 0);
  assert.match(await page.locator('#stage-msg').innerText(), /Your AI is connected/);
  await tool(key, 'world_inspect');
  assert.equal(await page.locator('#chat-input,#lesson-workspace,.chatgpt-signin').count(), 0);
  assert.equal((await rpc(key, 'tools/list')).body.result.tools.length, 14);
  await page.screenshot({ path: `${artifacts}/world-workspace.png` });
  assert.deepEqual(errors, []);
  await other.close();
  console.log(JSON.stringify({ base, auth: '12 header/auth combinations passed', initialize: 200, notification: 202,
    tools: 'listed', selfTest: 'app button passed without claiming an AI was connected', connectionTest: 'returned ok through the real browser', wave: 'Rive trigger fired; four frames captured',
    interface: 'external AI only; in-app chat and sign-in removed',
    isolation: 'second lab received no wave', browserErrors: errors, artifacts }, null, 2));
} finally {
  await browser.close();
}
