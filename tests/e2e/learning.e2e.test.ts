import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
// @ts-expect-error plain JS helper
import { launch, startServer } from './lib.mjs';

let server: { url: string; stop(): void };
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await startServer(38793);
  const session = await launch();
  browser = session.browser;
  page = await session.context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(server.url);
  await page.waitForSelector('.modal');
});
afterAll(async () => { await browser?.close(); server?.stop(); });

describe('focused learning workspace', () => {
  it('starts with short onboarding and gives the world the main workspace', async () => {
    expect((await page.locator('.modal').innerText()).split(/\s+/).length).toBeLessThan(65);
    await page.click('[data-act=onb-skip]');
    await page.waitForSelector('.stage[data-rive=ready]');
    expect(await page.locator('#side').isVisible()).toBe(false);
    expect(await page.locator('#dock').getAttribute('class')).toContain('collapsed');
    const stage = (await page.locator('#stage').boundingBox())!;
    expect(stage.width * stage.height).toBeGreaterThan(1440 * 900 * .65);
    expect(stage.width / stage.height).toBeCloseTo(16 / 9, 1);
  });

  it('opens a substantial terminal with /, keeps input focus, and connects tokens to the world', async () => {
    await page.keyboard.press('/');
    const input = page.locator('#term-input');
    await input.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.id === 'term-input');
    expect((await page.locator('#dock').boundingBox())!.height).toBeGreaterThan(300);
    await input.fill('docker run -d --name practice -p 8081:80 nginx');
    expect(await page.locator('#term-decomp').innerText()).toContain('host → container');
    await input.press('Enter');
    await page.waitForFunction(() => (window as any).__app.engine.world.containers.practice?.state === 'running');
    await page.waitForFunction(() => document.activeElement?.id === 'term-input');
    expect(await page.evaluate(() => (window as any).__app.engine.view.selected)).toBe('container:practice');
    await page.locator('#term-decomp [data-hover="image:nginx:latest"]').hover();
    await page.waitForSelector('#overlay .ring-hover');
    await input.fill('docker ps');
    await input.press('Enter');
    await page.waitForFunction(() => !(window as any).__app.term.running && document.querySelector('#term-out')?.textContent?.includes('CONTAINER ID'));
    await input.press('ArrowUp');
    expect(await input.inputValue()).toBe('docker ps');
  });

  it('shows an AI explanation one beat at a time while retaining the full note and technical depth', async () => {
    const key = await page.evaluate(() => (window as any).__app.bearerKey);
    const explanation = 'An image is a reusable recipe. A container is made from that image. Stop this container and watch what changes.';
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'world_focus', arguments: { target: 'container:practice', say: explanation } } }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as any).result.isError).toBe(false);
    await page.waitForSelector('.caption-text');
    expect(await page.locator('.caption-text').innerText()).toBe('An image is a reusable recipe.');
    await page.click('[data-act=caption-next]');
    expect(await page.locator('.caption-text').innerText()).toBe('A container is made from that image.');
    expect(await page.evaluate(() => (window as any).__app.engine.caption.text)).toBe(explanation);
    await page.click('.hits [data-arg="container:practice"]');
    expect(await page.locator('#side').isVisible()).toBe(true);
    expect(await page.locator('#term-input').isVisible()).toBe(false);
    const story = page.locator('[data-disclosure="container:practice:story"]');
    await story.locator('summary').click();
    await page.locator('#side [data-act=poke]', { hasText: /^Stop$/ }).click();
    expect(await story.getAttribute('open')).not.toBeNull();
    expect(await page.locator('#side').textContent()).toContain('exited');
    await page.click('[data-act=say-clear]');
  });

  it('uses one primary vertical scroll on phones, including terminal and expanded details', async () => {
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('#side details').evaluateAll(nodes => nodes.forEach(node => (node as HTMLDetailsElement).open = true));
      const check = async () => {
        const metrics = await page.evaluate(() => ({
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          nested: [...document.querySelectorAll<HTMLElement>('.panel, .term-out, .predict')].filter(el =>
            el.getClientRects().length && /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1,
          ).map(el => el.id || el.className),
        }));
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
        expect(metrics.nested).toEqual([]);
      };
      await check();
      await page.click('[data-act=dock][data-arg=terminal]');
      await check();
      await page.click('[data-act=dock-toggle]');
    }
  });
});
