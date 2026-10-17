// Generates rive/world/scene.rml from the DSL scenes, builds the .riv with the
// rive CLI and copies it to public/rive/. Usage: node rive/gen/build.mjs [--only=cargo|santa|deer]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { document, nid, resetIds } from './dsl.mjs';
import { buildCargo } from './cargo.mjs';
import { buildSanta } from './santa.mjs';
import { buildReindeer } from './reindeer.mjs';
import { buildWorld, SLOT_X, CREW, DECK_Y, CARGO_SCALE, WORLD } from './world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const projDir = join(root, 'rive', 'world');
mkdirSync(projDir, { recursive: true });

const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);
const mainName = { cargo: 'Cargo', santa: 'Santa', deer: 'Reindeer' }[only] ?? 'World';

resetIds();
const cargo = buildCargo();
const santa = buildSanta();
const deer = buildReindeer();
const world = buildWorld({ cargo, santa, deer });

// nested view-model instances: one per placement
const slotInst = SLOT_X.map((_, i) => ({ name: `slot${i}`, id: nid(), values: {} }));
const foremanInst = { name: 'foreman', id: nid(), values: { role: 0, coat: 'FF7A4E30', glow: 0.3 } };
const runnerInst = { name: 'runner', id: nid(), values: { role: 1, coat: 'FFA56F45', glow: 0.3 } };
const santaInst = { name: 'santa', id: nid(), values: {} };

const parts = [];
parts.push(cargo.artboard.xml, cargo.artboard.asset, santa.artboard.xml, santa.artboard.asset, deer.artboard.xml, deer.artboard.asset, world.artboard.xml);
parts.push(cargo.vm.emit(slotInst), santa.vm.emit([santaInst]), deer.vm.emit([foremanInst, runnerInst]));
parts.push(world.vm.emit([], { santa: santaInst.id, foreman: foremanInst.id, runner: runnerInst.id, ...Object.fromEntries(slotInst.map((s) => [s.name, s.id])) }));
parts.push(...cargo.converters, ...deer.converters, ...world.converters);

writeFileSync(join(projDir, 'rive.yaml'), `name: docker-world\nmain: ${mainName}\n`);
writeFileSync(join(projDir, 'scene.rml'), document(parts));
console.log('wrote scene.rml', (document(parts).length / 1024).toFixed(0) + ' KB');

const rive = process.env.RIVE_BIN ?? join(process.env.HOME, '.rive', 'bin', 'rive');
const run = (args) => execFileSync(rive, args, { cwd: projDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  run(['.', '--verify']);
} catch (e) {
  console.error(e.stdout, e.stderr);
  process.exit(1);
}
const insp = JSON.parse(run(['inspect', '.', '--summary']));
const bad = insp.problems.filter((p) => !['artboards-overlap', 'artboard-without-style', 'states-overlap'].includes(p.kind));
if (bad.length) {
  console.error('PROBLEMS', JSON.stringify(bad, null, 2));
  process.exit(1);
}
console.log(run(['.', '--once']).trim());
const out = join(projDir, 'build', 'docker-world.riv');
if (!existsSync(out)) throw new Error('no riv at ' + out);
mkdirSync(join(root, 'public', 'rive'), { recursive: true });
const dest = 'docker-world.riv';
if (!only) copyFileSync(out, join(root, 'public', 'rive', dest)); // partial (--only) builds stay in rive/world/build/

// the layout contract the renderer needs (anchor points in artboard space)
const layout = {
  artboard: { name: 'World', ...WORLD },
  slots: SLOT_X.map((x, i) => ({ index: i, x, y: DECK_Y, w: 124 * CARGO_SCALE, h: 66 * CARGO_SCALE })),
  crew: CREW,
  anchors: {
    whale: { x: 910, y: 520 }, brain: { x: 1280, y: 478 }, ram: { x: 960, y: 520 }, hold: { x: 700, y: 585 }, kernel: { x: 800, y: 530 },
    santa: { x: CREW.santa.x, y: 330 }, foreman: { x: CREW.foreman.x, y: 340 }, runner: { x: CREW.runner.x, y: 340 },
    harbor: { x: 230, y: 570 }, crane: { x: 270, y: 500 }, shipyard: { x: 1380, y: 600 }, gates: { x: 1000, y: 392 },
  },
  vm: Object.fromEntries(world.vm.props.map((p) => [p.name, p.type])),
};
if (!only) writeFileSync(join(root, 'src', 'render', 'layout.generated.json'), JSON.stringify(layout, null, 2));
console.log(only ? 'partial build kept in rive/world/build/' : 'copied -> public/rive/docker-world.riv + src/render/layout.generated.json');
