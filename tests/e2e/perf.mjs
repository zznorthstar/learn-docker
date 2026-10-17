// Measures what the page costs: transfer sizes, load timeline, idle CPU, frame rate.
// node tests/e2e/perf.mjs   (run `npm run build` first)
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { launch, root, startServer } from './lib.mjs';

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
const rows = walk(path.join(root, 'dist')).map((f) => {
  const b = readFileSync(f);
  return { file: path.relative(path.join(root, 'dist'), f), raw: b.length, gz: gzipSync(b).length, br: brotliCompressSync(b).length };
});
const total = (k) => rows.reduce((a, r) => a + r[k], 0);
console.log('ASSETS (bytes)  raw / gzip / brotli');
for (const r of rows) console.log(`  ${r.file.padEnd(34)} ${String(r.raw).padStart(8)} ${String(r.gz).padStart(8)} ${String(r.br).padStart(8)}`);
console.log(`  ${'TOTAL'.padEnd(34)} ${String(total('raw')).padStart(8)} ${String(total('gz')).padStart(8)} ${String(total('br')).padStart(8)}`);
const critical = rows.filter((r) => /index.*\.(js|css)$|index\.html|poster/.test(r.file));
console.log(`  first-paint critical path (html+css+js+poster), brotli: ${critical.reduce((a, r) => a + r.br, 0)} bytes`);
const lazy = rows.filter((r) => /riveWorld|\.wasm|\.riv/.test(r.file));
console.log(`  loaded after first paint (rive runtime + wasm + scene), brotli: ${lazy.reduce((a, r) => a + r.br, 0)} bytes`);

const srv = await startServer(Number(process.env.E2E_PORT ?? 38793));
const { browser, context } = await launch();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
const t0 = Date.now();
await page.goto(srv.url, { waitUntil: 'commit' });
await page.waitForSelector('.modal');
const tUi = Date.now() - t0;
await page.click('[data-act=onb-skip]');
await page.waitForSelector('.stage[data-rive="ready"]', { timeout: 30000 });
const tRive = Date.now() - t0;
const paint = await page.evaluate(() => performance.getEntriesByType('paint').map((p) => `${p.name} ${Math.round(p.startTime)}ms`));
console.log(`\nLOAD  interactive UI after ${tUi} ms; live Rive scene after ${tRive} ms (local, no network latency)  paint: ${paint.join(', ')}`);
await page.evaluate(() => window.__app.engine.reset('shop', 'user'));
await page.waitForTimeout(3000);
const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const m0 = await metric();
const w0 = Date.now();
await page.waitForTimeout(6000);
const m1 = await metric();
const wall = (Date.now() - w0) / 1000;
const busy = ((m1.TaskDuration - m0.TaskDuration) / wall) * 100;
const script = ((m1.ScriptDuration - m0.ScriptDuration) / wall) * 100;
console.log(`IDLE  main thread busy ${busy.toFixed(1)}% (script ${script.toFixed(1)}%) with the full 3-container scene animating (headless Chrome, software GL)`);
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const f = () => { n++; performance.now() - t > 3000 ? res((n * 1000) / (performance.now() - t)) : requestAnimationFrame(f); }; requestAnimationFrame(f); }));
console.log(`FPS   ${fps.toFixed(0)} fps rAF cadence (software rendering)`);
// hidden: the runtime must stop rendering and cost nothing
await page.evaluate(() => { document.querySelector('.stage-wrap').style.display = 'none'; });
await page.waitForTimeout(800);
const paused = await page.evaluate(() => window.__app.rive.rive.isPaused);
const m2 = await metric(); const w2 = Date.now(); await page.waitForTimeout(3000); const m3 = await metric();
console.log(`HIDDEN rive paused when the stage is not visible: ${paused}; main thread busy ${(((m3.TaskDuration - m2.TaskDuration) / ((Date.now() - w2) / 1000)) * 100).toFixed(1)}%`);
const heap = await metric();
console.log(`MEM   JS heap ${(heap.JSHeapUsedSize / 1048576).toFixed(1)} MB, DOM nodes ${heap.Nodes}, layout count ${heap.LayoutCount}`);
await browser.close();
srv.stop();
