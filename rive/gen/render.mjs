// Render a .riv artboard in headless Chrome with the real @rive-app/canvas runtime.
// node rive/gen/render.mjs --riv public/rive/cargo.riv --artboard Cargo --out /tmp/x.png \
//   --size 540x400 --set "occupied=true,status=1,reveal=0.5,tint=#4a7bd0" --wait 900 --sm "Cargo SM" [--bg #202838]
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const rivPath = path.resolve(arg('riv'));
const artboard = arg('artboard');
const sm = arg('sm');
const out = arg('out', '/tmp/rive.png');
const [W, H] = arg('size', '540x400').split('x').map(Number);
const sets = arg('set', '');
const wait = Number(arg('wait', '900'));
const bg = arg('bg', '#1b2233');
const triggers = arg('fire', '');
const later = arg('later', ''); // "ms:key=value;..." applied after wait, then wait again
const info = arg('info', '') === '1';

const libDir = path.join(root, 'node_modules', '@rive-app', arg('lib', 'canvas-lite'));
const srv = http
  .createServer((q, s) => {
    const u = q.url.split('?')[0];
    let file = u === '/rive.js' ? path.join(libDir, 'rive.js') : u === '/rive.wasm' ? path.join(libDir, 'rive.wasm') : u === '/f.riv' ? rivPath : null;
    if (u === '/') {
      s.writeHead(200, { 'content-type': 'text/html' });
      s.end(`<!doctype html><body style="margin:0;background:${bg}"><canvas id=c width=${W} height=${H} style="width:${W}px;height:${H}px"></canvas><script src="/rive.js"></script>`);
      return;
    }
    if (!file) {
      s.writeHead(404);
      s.end();
      return;
    }
    s.writeHead(200, { 'content-type': file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(s);
  })
  .listen(0);
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on('console', (m) => logs.push(m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
await page.goto(`http://localhost:${port}/`);
await page.evaluate(
  ({ artboard, sm, sets, triggers, info }) =>
    new Promise((resolve) => {
      setTimeout(resolve, 15000);
      window.__logs = [];
      const r = new window.rive.Rive({
        src: '/f.riv',
        canvas: document.getElementById('c'),
        autoplay: true,
        autoBind: true,
        artboard: artboard || undefined,
        stateMachines: sm || undefined,
        locateFile: (f) => '/' + f,
        onLoad() {
          r.resizeDrawingSurfaceToCanvas();
          window.__r = r;
          const vmi = r.viewModelInstance;
          const find = (path) => {
            const parts = path.split('.');
            let v = vmi;
            for (const p of parts.slice(0, -1)) v = v.viewModel(p);
            return [v, parts[parts.length - 1]];
          };
          window.__set = (kv) => {
            for (const pair of kv.split(',').filter(Boolean)) {
              const [k, raw] = pair.split('=');
              const [v, name] = find(k);
              const prop = v.properties.find((p) => p.name === name);
              if (!prop) throw new Error('no property ' + k);
              if (prop.type === 'number') v.number(name).value = parseFloat(raw);
              else if (prop.type === 'boolean') v.boolean(name).value = raw === 'true';
              else if (prop.type === 'color') v.color(name).value = parseInt('FF' + raw.replace('#', ''), 16) >>> 0;
              else if (prop.type === 'trigger') v.trigger(name).trigger();
            }
          };
          window.__fire = (names) => {
            for (const k of names.split(',').filter(Boolean)) {
              const [v, name] = find(k);
              v.trigger(name).trigger();
            }
          };
          if (info) window.__logs.push(JSON.stringify({ contents: r.contents, props: vmi ? vmi.properties : null }));
          try {
            if (sets) window.__set(sets);
          } catch (e) {
            window.__logs.push('SETERR ' + e.message);
          }
          resolve();
        },
        onLoadError(e) {
          window.__logs.push('LOADERR ' + JSON.stringify(e));
          resolve();
        },
      });
    }),
  { artboard, sm, sets, triggers, info },
);
await page.waitForTimeout(wait);
if (triggers) {
  await page.evaluate((t) => window.__fire(t), triggers);
  await page.waitForTimeout(Number(arg('fire-wait', '120')));
}
if (later) {
  for (const step of later.split(';')) {
    const [ms, kv] = step.split(':');
    await page.waitForTimeout(Number(ms));
    await page.evaluate((x) => window.__set(x), kv);
  }
  await page.waitForTimeout(Number(arg('later-wait', '700')));
}
await page.screenshot({ path: out });
const l = await page.evaluate(() => window.__logs);
for (const x of [...l, ...logs.filter((x) => !/deprecat|suppress/i.test(x))]) console.log(x);
await browser.close();
srv.close();
