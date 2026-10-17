import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
// @ts-expect-error plain JS helper
import { launch, startServer } from './lib.mjs';

let server: { url: string; stop(): void };
let browser: Browser;
let page: Page;
let key: string;
const errors: string[] = [];

async function rpc(method: string, params: object) {
  const response = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  expect(response.status).toBe(200);
  return await response.json() as any;
}
beforeAll(async () => {
  server = await startServer(38794);
  const session = await launch();
  browser = session.browser;
  await session.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  page = await session.context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await page.waitForSelector('.modal');
  await page.waitForFunction(() => (window as any).__app.ui.relay === 'online');
  key = await page.evaluate(() => (window as any).__app.bearerKey);
});
afterAll(async () => { await browser?.close(); server?.stop(); });

describe('external agent onboarding', () => {
  it('shows how two browser tabs work side by side, including the visual consequence', async () => {
    expect(await page.locator('.modal h1').evaluate(el => getComputedStyle(el).fontFamily)).toMatch(/Host Grotesk/);
    for (let i = 0; i < 2; i++) await page.click('[data-act=onb-next]');
    expect(await page.locator('.modal').innerText()).toContain('two tabs next to each other');
    expect(await page.locator('.modal').innerText()).toContain('Leave full screen');
    const sample = async (time: number) => page.locator('.side-by-side-demo').evaluate((el, time) => {
      for (const animation of el.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = time; }
      return { width: el.clientWidth, worldWidth: el.querySelector('.demo-world')!.getBoundingClientRect().width,
        ai: getComputedStyle(el.querySelector('.demo-ai')!).opacity,
        question: getComputedStyle(el.querySelector('.demo-question')!).opacity,
        cargo: getComputedStyle(el.querySelector('.demo-new-container')!).opacity };
    }, time);
    const before = await sample(200);
    expect(before.worldWidth).toBeCloseTo(before.width, 0);
    expect(Number(before.ai)).toBe(0);
    expect(Number(before.cargo)).toBe(0);
    const beside = await sample(2300);
    expect(beside.worldWidth).toBeLessThan(beside.width * .51);
    expect(Number(beside.ai)).toBeGreaterThan(.9);
    expect(Number(beside.question)).toBe(0);
    const after = await sample(4800);
    expect(Number(after.question)).toBe(1);
    expect(Number(after.cargo)).toBe(1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.click('[data-act=onb-back]');
    await page.click('[data-act=onb-next]');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.demo-new-container')!).opacity === '1');
    expect(await page.locator('.demo-world').evaluate(el => parseFloat(getComputedStyle(el).animationDuration))).toBeLessThan(.01);
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const rect = (await page.locator('.side-by-side-demo').boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(await page.locator('[data-act=onb-next]').isVisible()).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.click('[data-act=onb-next]');
  });

  it('merges the agents and copies a complete setup prompt while keeping the visible key masked', async () => {
    const options = await page.locator('[data-live=connect-client] option').allTextContents();
    expect(options).toContain('Ai-Agent (meta muse, grok bot...)');
    for (const old of ['OpenAI Dots', 'Grok Bot', 'Meta Muse']) expect(options).not.toContain(old);
    expect(await page.locator('[data-live=connect-client]').inputValue()).toBe('ai-agent');
    expect(await page.locator('.connection-key').getAttribute('class')).not.toContain('needs-key');
    await page.click('[data-act=copy][data-arg="ai-agent"]');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`${server.url}/mcp`);
    expect(copied).toContain(`Authorization header: Bearer ${key}`);
    expect(copied).toContain('world_connection_test');
    expect(copied).toContain('initialize');
    expect(await page.content()).not.toContain(key);
  });

  it('nudges the credential disclosure only for the separate teaching prompt', async () => {
    await page.selectOption('[data-live=connect-client]', 'prompt');
    await page.waitForSelector('.connection-key.needs-key');
    expect(await page.locator('.connection-key > summary').evaluate(el => getComputedStyle(el).animationName)).toBe('key-invitation');
    await page.click('.connection-key > summary');
    expect(await page.locator('.connection-key > summary').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await page.selectOption('[data-live=connect-client]', 'json');
    await page.waitForSelector('.connection-key:not(.needs-key)');
    await page.click('[data-act=onb-next]');
    await page.waitForSelector('.stage[data-rive=ready]');
  });

  it('has no in-app chat or sign-in, including after an MCP agent connects', async () => {
    const noChat = async () => {
      expect(await page.locator('#chat-input,#lesson-workspace,[data-act=lesson-toggle],.chatgpt-signin').count()).toBe(0);
      expect(await page.locator('body').innerText()).not.toMatch(/ChatGPT|Sign in|Shared chat/);
    };
    await noChat();
    const stage = (await page.locator('#stage').boundingBox())!;
    expect(stage.width * stage.height).toBeGreaterThan(1440 * 900 * .65);
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'external-agent-test', version: '1' } });
    await page.waitForFunction(() => (window as any).__app.engine.link.agent);
    await noChat();
    const listed = await rpc('tools/list', {});
    expect(listed.result.tools).toHaveLength(14);
    expect(listed.result.tools.some((t: any) => t.name === 'lesson_chat')).toBe(false);
    await page.click('[data-act=modal][data-arg=connect]');
    expect(await page.locator('[data-live=connect-client] option').allTextContents()).toContain('Ai-Agent (meta muse, grok bot...)');
    await page.click('[data-act=close-modal]');
    expect(errors).toEqual([]);
  });
});
