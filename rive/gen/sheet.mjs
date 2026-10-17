// Render several variants of an artboard and tile them into one labelled PNG.
// node rive/gen/sheet.mjs --riv=... --artboard=Cargo --sm="Cargo SM" --out=sheet.png --cell=360x270 --cols=4 "label|key=val,key=val|wait|fire" ...
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.find((x) => x.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
const variants = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const dir = mkdtempSync(path.join(process.env.SCRATCH ?? tmpdir(), 'sheet-'));
const files = [];
variants.forEach((v, i) => {
  const [label, sets, wait = '1200', fire = ''] = v.split('|');
  const f = path.join(dir, `${String(i).padStart(2, '0')}.png`);
  const args = [path.join(here, 'render.mjs'), `--riv=${arg('riv', '')}`, `--artboard=${arg('artboard', '')}`, `--sm=${arg('sm', '')}`, `--size=${arg('cell', '360x270')}`, `--set=${sets}`, `--wait=${wait}`, `--out=${f}`, `--bg=${arg('bg', '#1b2233')}`];
  if (fire) args.push(`--fire=${fire}`);
  execFileSync('node', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  execFileSync('convert', [f, '-gravity', 'northwest', '-fill', 'white', '-pointsize', '16', '-annotate', '+8+6', label, f]);
  files.push(f);
});
execFileSync('montage', [...files, '-tile', `${arg('cols', '4')}x`, '-geometry', '+4+4', '-background', '#0c111c', arg('out', 'sheet.png')]);
console.log('sheet ->', arg('out', 'sheet.png'));
