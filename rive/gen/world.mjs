import { anim, artboard, bindCtx, col, defineVM, ell, fill, lin, nested, nid, node, poly, rad, rangeMap, rect, rng, shape, smooth, stateMachine, star, stroke, tri } from './dsl.mjs';
import pal from '../../shared/palette.json' with { type: 'json' };

export const WORLD = { w: 1600, h: 900 };
const TAU = Math.PI * 2;

/** Cargo slot geometry (artboard coordinates): centre-x of each slot and the deck line they stand on */
export const SLOT_X = [455, 567, 679, 791, 903, 1015];
export const DECK_Y = 392;
export const CARGO_SCALE = 0.86;
export const CREW = { runner: { x: 1100, s: 0.5 }, foreman: { x: 1178, s: 0.5 }, santa: { x: 1298, s: 0.68 } };
// the harbor (left) and shipyard (right) are authored at full size then scaled to sit below the whale
export const HARBOR_T = { s: 0.74, x: 14, y: 236 };
export const YARD_T = { s: 0.78, x: 340, y: 176 };
const hx = (x) => x * HARBOR_T.s + HARBOR_T.x;
const hy = (y) => y * HARBOR_T.s + HARBOR_T.y;

/** keyframes that repeat `period` frames across `total` */
function cycle(total, period, pattern) {
  const out = [];
  for (let t = 0; t < total; t += period) for (const [ph, v, e] of pattern) out.push([t + ph, v, e]);
  out.push([total, pattern[0][1], pattern[0][2]]);
  return out;
}
const dedupe = (kf) => {
  const seen = new Set();
  return kf.filter(([f]) => (seen.has(f) ? false : seen.add(f)));
};

export function buildWorld({ cargo, santa, deer }) {
  const vm = defineVM('World', [
    { name: 'level', type: 'number', def: 0 },
    { name: 'cpuLoad', type: 'number', def: 0.1 },
    { name: 'memPressure', type: 'number', def: 0.2 },
    { name: 'diskFill', type: 'number', def: 0.3 },
    { name: 'storm', type: 'bool', def: false },
    { name: 'registryUp', type: 'number', def: 1 },
    { name: 'building', type: 'number', def: 0 },
    { name: 'pull', type: 'trigger' },
    { name: 'build', type: 'trigger' },
    { name: 'shake', type: 'trigger' },
    { name: 'santa', type: 'vm', vm: santa.vm },
    { name: 'foreman', type: 'vm', vm: deer.vm },
    { name: 'runner', type: 'vm', vm: deer.vm },
    ...SLOT_X.map((_, i) => ({ name: `slot${i}`, type: 'vm', vm: cargo.vm })),
  ]);
  const R = (p) => vm.ref(p);

  const cToy = rangeMap('level→toy', 0, 4, 1, 0.34);
  const cInternals = rangeMap('level→internals', 2.2, 3.8, 0, 1);
  const cCrew = rangeMap('level→crew', 3, 5, 1, 0.5);
  const cHarbor = rangeMap('level→harbor', 4, 6, 1, 0.6);
  const cKernelGlow = rangeMap('level→kernel', 3.2, 4.4, 0, 1);

  const ids = Object.fromEntries(
    ['whale', 'tail', 'fin', 'eyeLid', 'spoutA', 'spoutB', 'spoutC', 'starsA', 'starsB', 'cloudsFar', 'cloudsMid', 'lantern0', 'lantern1', 'lantern2', 'lantern3', 'lantern4', 'lantern5', 'beam', 'beamNode', 'crane', 'hook', 'hammer', 'sparks', 'storm', 'flashSky', 'plate0', 'plate1', 'plate2', 'plate3', 'pullBeam', 'bplate0', 'bplate1', 'bplate2', 'bplate3', 'bsparks', 'cpuGlow', 'kernelPulse', 'rain', 'dim', 'lanternGlow', 'moonGlow', 'ecoRing', 'sparkBurst'].map((k) => [k, nid()]),
  );

  /* ===================================================================== SKY */
  const sky = shape('sky', {}, rect(1600, 900, { ox: 0, oy: 0 }), fill(lin(0, 0, 0, 900, [[0, col(pal.sky0)], [0.5, col(pal.sky1)], [0.8, col(pal.sky2)], [1, col(pal.horizon)]])));
  const rnd = rng(7);
  const starsOf = (n, rMin, rMax) =>
    Array.from({ length: n }, () => {
      const d = (rMin + rnd() * (rMax - rMin)) * 2;
      return ell(d, d, { x: 20 + rnd() * 1560, y: 10 + rnd() * 520 });
    });
  const mkStars = (id, n) => node(`stars ${id}`, { id: ids[id] }, [shape(`stars ${id} dots`, {}, starsOf(n, 0.5, 1.6), fill(col('#ffffff', 0.9)))]);
  const starsStatic = shape('stars faint', {}, starsOf(60, 0.4, 1.0), fill(col('#cfd6ff', 0.6)));
  const moon = node('moon', { x: 250, y: 150 }, [
    shape('moon glow', { id: ids.moonGlow }, ell(380, 380), fill(rad(0, 0, 190, [[0, col('#fff3d1', 0.32)], [1, col('#fff3d1', 0)]]), { blend: 'additive' })),
    shape('moon', {}, ell(120, 120), fill(lin(-40, -40, 40, 40, [[0, col('#fff8e3')], [1, col('#d9d2b7')]]))),
    shape('craters', {}, [ell(22, 22, { x: -22, y: -14 }), ell(14, 14, { x: 24, y: 10 }), ell(10, 10, { x: -8, y: 28 }), ell(8, 8, { x: 18, y: -30 })], fill(col('#b9b196', 0.55))),
  ]);

  /* clouds: two copies 1600px apart drift left forever */
  const cloudBlob = (cx, cy, s, color) =>
    shape('cloud', {}, [ell(120 * s, 46 * s, { x: cx, y: cy }), ell(90 * s, 56 * s, { x: cx - 50 * s, y: cy + 6 * s }), ell(100 * s, 50 * s, { x: cx + 56 * s, y: cy + 8 * s }), ell(70 * s, 38 * s, { x: cx + 10 * s, y: cy - 20 * s })], fill(color));
  const cloudSet = (seed, y0, color, scale) => {
    const r2 = rng(seed);
    return Array.from({ length: 6 }, (_, i) => cloudBlob(120 + i * 270 + r2() * 90, y0 + (r2() - 0.5) * 60, scale * (0.8 + r2() * 0.7), color));
  };
  const cloudsFar = node('clouds far', { id: ids.cloudsFar }, [node('far a', {}, cloudSet(11, 690, col('#6b4a8c', 0.42), 1.5)), node('far b', { x: 1600 }, cloudSet(11, 690, col('#6b4a8c', 0.42), 1.5))]);
  const cloudsMid = node('clouds mid', { id: ids.cloudsMid }, [node('mid a', {}, cloudSet(23, 790, col('#a04e7e', 0.5), 2.1)), node('mid b', { x: 1600 }, cloudSet(23, 790, col('#a04e7e', 0.5), 2.1))]);
  const horizonGlow = shape('horizon glow', {}, rect(1600, 260, { ox: 0, oy: 1, y: 900 }), fill(lin(0, 640, 0, 900, [[0, col(pal.horizon, 0)], [1, col('#ff9a6b', 0.5)]])));

  /* ================================================================== WHALE */
  const WHALE = '#34559c';
  const bodyPts = [[395, 486], [470, 436], [580, 402], [720, 388], [880, 384], [1040, 384], [1170, 376], [1270, 372], [1350, 396], [1408, 444], [1426, 500], [1380, 548], [1290, 590], [1160, 628], [1000, 648], [820, 652], [660, 636], [540, 596], [450, 548]];
  const bellyPts = [[470, 560], [560, 600], [680, 634], [820, 652], [1000, 648], [1160, 628], [1290, 590], [1380, 548], [1360, 540], [1250, 568], [1120, 596], [980, 612], [820, 616], [680, 600], [570, 574]];
  const whaleShape = (n, paints) => shape(n, {}, smooth(bodyPts, { closed: true, k: 0.3 }), paints);
  const whaleBody = node('whale skin', { binds: [bindCtx(R('level'), 18, cToy.id)] }, [
    whaleShape('whale base', fill(lin(0, 372, 0, 652, [[0, '#3d62ad'], [0.55, col(WHALE)], [1, '#6f93d1']]))),
    shape('belly light', {}, smooth(bellyPts, { closed: true, k: 0.3 }), fill(col('#a9c6ee', 0.55))),
    shape('belly lines', {}, [poly([[1180, 604], [980, 622], [800, 624]], { closed: false }), poly([[1220, 590], [1030, 606], [850, 608]], { closed: false }), poly([[1150, 614], [960, 632], [780, 636]], { closed: false })], stroke(col('#ffffff', 0.18), 3)),
    shape('back sheen', {}, smooth([[470, 440], [580, 408], [720, 394], [880, 390], [1040, 390], [1170, 382], [1270, 378]], { closed: false }), stroke(col(pal.lantern, 0.55), 5, { feather: 4 })),
    shape('belly rim', {}, smooth(bellyPts.slice(0, 9), { closed: false, k: 0.3 }), stroke(col(pal.horizon, 0.8), 6, { feather: 7, blend: 'additive' })),
    shape('mouth', {}, smooth([[1424, 512], [1380, 534], [1320, 540], [1250, 532]], { closed: false, k: 0.4 }), stroke(col('#0b0f17', 0.7), 4)),
    shape('barnacles', {}, [ell(14, 11, { x: 600, y: 560 }), ell(10, 8, { x: 626, y: 570 }), ell(12, 9, { x: 1090, y: 600 }), ell(8, 7, { x: 740, y: 598 })], fill(col('#d7dff0', 0.6))),
  ]);
  const whaleOutline = whaleShape('whale outline', stroke(col('#0b0f17', 0.85), 5));
  const tail = node('tail', { id: ids.tail, x: 410, y: 500 }, [
    shape('tail stalk', {}, smooth([[0, -16], [-40, -24], [-84, -50], [-84, 50], [-40, 28], [0, 22]], { closed: true, k: 0.3 }), fill(col(WHALE))),
    shape('fluke', {}, smooth([[-70, 0], [-110, -70], [-176, -118], [-206, -100], [-170, -40], [-134, -6], [-206, 22], [-196, 78], [-140, 70], [-100, 34]], { closed: true, k: 0.28 }), [fill(lin(-206, -118, -70, 70, [[0, '#2a4684'], [1, '#4a73bf']])), stroke(col('#0b0f17', 0.85), 5)]),
  ]);
  const fin = node('fin', { id: ids.fin, x: 1090, y: 590 }, [shape('pectoral', {}, smooth([[0, 0], [-38, 54], [-94, 128], [-64, 132], [-4, 86], [34, 30]], { closed: true, k: 0.3 }), [fill(col('#2d4c8c')), stroke(col('#0b0f17', 0.85), 5)])]);
  const eye = node('eye', { x: 1346, y: 468 }, [
    shape('eye white', {}, ell(26, 26), [fill(col('#fffdf4')), stroke(col('#0b0f17'), 3)]),
    shape('pupil', { x: 2 }, ell(15, 15), fill(col('#10172a'))),
    shape('glint', { x: -2, y: -4 }, ell(5, 5), fill(col('#ffffff'))),
    shape('lid', { id: ids.eyeLid, y: -13, sy: 0.02 }, ell(28, 26, { oy: 1 }), fill(col('#3d62ad'))),
  ]);
  const spout = node('spout', { x: 1210, y: 376 }, [
    shape('mist A', { id: ids.spoutA, x: 0, y: 0 }, ell(16, 16), fill(col('#e8f2ff', 0.55))),
    shape('mist B', { id: ids.spoutB, x: 6, y: 0 }, ell(11, 11), fill(col('#e8f2ff', 0.5))),
    shape('mist C', { id: ids.spoutC, x: -6, y: 0 }, ell(8, 8), fill(col('#e8f2ff', 0.5))),
  ]);

  /* ---- internals: the whale's anatomy, shown at deeper abstraction levels ---- */
  const chip = (cx, cy) =>
    node('cpu', { x: cx, y: cy }, [
      shape('cpu glow', { id: ids.cpuGlow, op: 0.2 }, ell(150, 150), fill(rad(0, 0, 75, [[0, col(pal.failure, 0.7)], [1, col(pal.failure, 0)]]), { blend: 'additive' })),
      shape('cpu pins', {}, [...Array.from({ length: 6 }, (_, i) => rect(5, 14, { x: -25 + i * 10, y: -40 })), ...Array.from({ length: 6 }, (_, i) => rect(5, 14, { x: -25 + i * 10, y: 40 })), ...Array.from({ length: 6 }, (_, i) => rect(14, 5, { x: -40, y: -25 + i * 10 })), ...Array.from({ length: 6 }, (_, i) => rect(14, 5, { x: 40, y: -25 + i * 10 }))], fill(col('#c9d3e6'))),
      shape('cpu die', {}, rect(66, 66, { r: 8 }), [fill(col('#1d2740')), stroke(col(pal.resource), 3)]),
      shape('cpu core', {}, rect(34, 34, { r: 5 }), fill(lin(-17, -17, 17, 17, [[0, col(pal.resource)], [1, col('#ff9f43')]]))),
      shape('cpu cross', {}, [rect(34, 2, {}), rect(2, 34, {})], fill(col('#1d2740'))),
    ]);
  const memConv = [0, 1, 2, 3].map((i) => rangeMap('mem→' + i, i * 0.2, 0.55 + i * 0.15, 0.08, 1));
  const ramSticks2 = [0, 1, 2, 3].map((i) =>
    node('ram ' + i, {}, [
      shape('ram body', { x: 900 + i * 40, y: 560 }, rect(22, 78, { oy: 1, r: 3 }), [fill(col('#11361f')), stroke(col(pal.kernel, 0.9), 2)]),
      shape('ram level', { x: 900 + i * 40, y: 557, binds: [bindCtx(R('memPressure'), 17, memConv[i].id)] }, rect(14, 66, { oy: 1, r: 2 }), fill(col(pal.resource, 0.9))),
      shape('ram teeth', { x: 900 + i * 40, y: 565 }, rect(16, 6), fill(col(pal.lantern))),
    ]),
  );
  const diskConv = rangeMap('disk→fill', 0, 1, 0.05, 1);
  const drum = (x) =>
    node('drum', {}, [
      shape('drum body', { x, y: 600 }, rect(46, 54, { oy: 1, r: 8 }), [fill(col('#2a2236')), stroke(col(pal.storage, 0.9), 2.5)]),
      shape('drum fill', { x, y: 597, binds: [bindCtx(R('diskFill'), 17, diskConv.id)] }, rect(38, 46, { oy: 1, r: 5 }), fill(col(pal.storage, 0.85))),
      shape('drum top', { x, y: 548 }, ell(46, 12), [fill(col('#3b3148')), stroke(col(pal.storage, 0.9), 2)]),
    ]);
  const pulseTrimId = nid();
  const kernelPath = smooth([[1280, 470], [1160, 500], [1040, 520], [900, 510], [780, 540], [650, 520], [540, 520], [440, 505]], { closed: false, k: 0.3 });
  const mesh = node('kernel mesh', { binds: [bindCtx(R('level'), 18, cKernelGlow.id)] }, [
    shape('nerve glow', {}, kernelPath, stroke(col(pal.kernel, 0.7), 9, { feather: 8, blend: 'additive' })),
    shape('nerve', {}, kernelPath, stroke(col(pal.kernel, 0.95), 3)),
    shape('nerve pulse', { id: ids.kernelPulse }, kernelPath, stroke(col('#eaffee'), 5, { trim: { id: pulseTrimId, start: 0, end: 0.08 }, blend: 'additive' })),
    shape('branches', {}, [poly([[1160, 500], [1130, 440]], { closed: false }), poly([[1040, 520], [1010, 590]], { closed: false }), poly([[780, 540], [760, 470]], { closed: false }), poly([[650, 520], [640, 585]], { closed: false })], stroke(col(pal.kernel, 0.7), 2)),
    shape('nodes', {}, [ell(11, 11, { x: 1160, y: 500 }), ell(11, 11, { x: 1040, y: 520 }), ell(11, 11, { x: 900, y: 510 }), ell(11, 11, { x: 780, y: 540 }), ell(11, 11, { x: 650, y: 520 }), ell(11, 11, { x: 540, y: 520 })], [fill(col('#07210f')), stroke(col(pal.kernel), 2.5)]),
  ]);
  const internals = node('internals', { binds: [bindCtx(R('level'), 18, cInternals.id)] }, [
    shape('internals tint', {}, smooth(bodyPts.map(([x, y]) => [x, y]), { closed: true, k: 0.3 }), fill(col('#0a1226', 0.55))),
    ...drumGroup(drum),
    ...ramSticks2,
    chip(1280, 478),
    mesh,
  ]);
  function drumGroup(d) {
    return [d(640), d(700), d(760)];
  }

  /* ================================================================== DECK */
  const deckBoards = node('deck', {}, [
    shape('deck shadow', {}, rect(820, 10, { ox: 0, x: 415, y: DECK_Y + 4 }), fill(col('#000000', 0.35))),
    shape('deck planks', {}, rect(820, 16, { ox: 0, x: 415, y: DECK_Y - 2 }), [fill(lin(0, DECK_Y - 2, 0, DECK_Y + 14, [[0, '#8a6038'], [1, '#5a3d22']])), stroke(col('#2a1a0c', 0.9), 2)]),
    shape('plank lines', {}, Array.from({ length: 16 }, (_, i) => rect(1.5, 14, { x: 440 + i * 50, y: DECK_Y + 6 })), fill(col('#2a1a0c', 0.55))),
    shape('slot marks', {}, SLOT_X.map((x) => rect(88, 5, { x, y: DECK_Y - 1, r: 2 })), fill(col('#ffffff', 0.12))),
    shape('rail posts', {}, [0, 1, 2, 3, 4, 5, 6].map((i) => rect(5, 34, { x: 432 + i * 126, y: DECK_Y - 14, oy: 1 })), fill(col('#4a3220'))),
  ]);
  const lanternAt = (i, x) =>
    node('lantern ' + i, {}, [
      shape('lantern glow', { id: ids['lantern' + i], x, y: DECK_Y - 50 }, ell(64, 64), fill(rad(0, 0, 32, [[0, col(pal.lantern, 0.75)], [1, col(pal.lantern, 0)]]), { blend: 'additive' })),
      shape('lantern', { x, y: DECK_Y - 50 }, rect(9, 13, { r: 3 }), [fill(col('#ffd88a')), stroke(col('#3a2410'), 2)]),
    ]);
  const lanterns = node('lanterns', {}, [0, 1, 2, 3, 4, 5].map((i) => lanternAt(i, 432 + (i + 0.5) * 126)));

  /* cockpit (Santa), crew, cargo placements */
  const cockpit = node('cockpit', {}, [
    shape('cockpit base', {}, smooth([[1232, 392], [1240, 374], [1360, 374], [1368, 392]], { closed: true, k: 0.2 }), [fill(lin(0, 374, 0, 392, [[0, '#6c7a9a'], [1, '#3a4562']])), stroke(col('#0b0f17', 0.9), 3)]),
    shape('console lights', {}, [ell(7, 7, { x: 1262, y: 383 }), ell(7, 7, { x: 1282, y: 383 }), ell(7, 7, { x: 1302, y: 383 })], fill(col(pal.runtime))),
  ]);
  const canopy = node('canopy', {}, [
    shape('canopy glass', {}, smooth([[1236, 376], [1244, 296], [1298, 262], [1352, 296], [1364, 376]], { closed: true, k: 0.35 }), [fill(lin(0, 262, 0, 376, [[0, col('#bfe9ff', 0.28)], [1, col('#bfe9ff', 0.06)]])), stroke(col('#dff3ff', 0.55), 3)]),
    shape('canopy glint', {}, poly([[1260, 300], [1280, 282]], { closed: false }), stroke(col('#ffffff', 0.7), 4)),
  ]);

  const santaScale = CREW.santa.s;
  const santaN = nested('Santa', santa.artboard.id, { vmPath: `${vm.id}-${vm.props.find((p) => p.name === 'santa').id}`, smId: santa.smId, x: CREW.santa.x - 100 * santaScale, y: 384 - 238 * santaScale, s: santaScale });
  const reindeerPlace = (name, who, key) => {
    const s = CREW[key].s;
    // ground in artboard coords: hooves bottom at y = 46 + 120 + 44 + 9 = 219
    return nested(name, deer.artboard.id, { vmPath: `${vm.id}-${vm.props.find((p) => p.name === key).id}`, smId: deer.smId, x: CREW[key].x - 125 * s, y: DECK_Y - 4 - 219 * s, s });
  };
  const runnerN = reindeerPlace('Runner reindeer (runc)', deer, 'runner');
  const foremanN = reindeerPlace('Foreman reindeer (containerd)', deer, 'foreman');
  const crew = node('crew', { binds: [bindCtx(R('level'), 18, cCrew.id)] }, [runnerN, foremanN, santaN]);

  const slots = SLOT_X.map((x, i) =>
    nested(`cargo slot ${i}`, cargo.artboard.id, {
      vmPath: `${vm.id}-${vm.props.find((p) => p.name === 'slot' + i).id}`,
      smId: cargo.smId,
      x: x - 90 * CARGO_SCALE,
      y: DECK_Y - 104 * CARGO_SCALE - 2,
      s: CARGO_SCALE,
    }),
  );

  /* ================================================================ HARBOR */
  const HX = 0;
  const harborBase = node('harbor base', {}, [
    shape('island rock', {}, smooth([[30, 640], [60, 700], [110, 770], [170, 830], [240, 790], [300, 840], [360, 770], [410, 700], [420, 640]], { closed: true, k: 0.3 }), [fill(lin(0, 640, 0, 840, [[0, '#4b4358'], [1, '#2a2438']])), stroke(col('#0b0f17', 0.8), 4)]),
    shape('island top', {}, rect(400, 16, { ox: 0, x: 24, y: 626, r: 5 }), [fill(col('#6d5a47')), stroke(col('#0b0f17', 0.8), 3)]),
    shape('pier planks', {}, Array.from({ length: 12 }, (_, i) => rect(2, 14, { x: 40 + i * 33, y: 633 })), fill(col('#2a1a0c', 0.55))),
  ]);
  const warehouse = node('warehouse', {}, [
    shape('wh wall', { x: 60, y: 540 }, rect(150, 90, { ox: 0, oy: 0 }), [fill(lin(0, 540, 0, 630, [[0, '#6b5a7e'], [1, '#463a58']])), stroke(col('#0b0f17', 0.8), 3)]),
    shape('wh roof', { x: 52, y: 516 }, poly([[0, 24], [83, -12], [166, 24]]), [fill(col('#a1463a')), stroke(col('#0b0f17', 0.8), 3)]),
    shape('wh door', { x: 110, y: 584 }, rect(44, 46, { ox: 0, oy: 0 }), [fill(col('#2a2236')), stroke(col('#0b0f17'), 2)]),
    shape('wh window', { x: 80, y: 560 }, rect(18, 18, { ox: 0, oy: 0 }), fill(col(pal.lantern, 0.85))),
    // blueprint rolls stacked at the door
    shape('blueprints', {}, [ell(34, 12, { x: 94, y: 624 }), ell(34, 12, { x: 126, y: 624 }), ell(34, 12, { x: 110, y: 612 })], [fill(col(pal.registry, 0.95)), stroke(col('#17324f'), 2)]),
  ]);
  const crane = node('crane', {}, [
    shape('crane tower', { x: 262, y: 626 }, rect(10, 150, { oy: 1 }), [fill(col('#8e99b3')), stroke(col('#0b0f17', 0.8), 2)]),
    node('crane arm', { id: ids.crane, x: 267, y: 482 }, [
      shape('arm', {}, rect(170, 8, { ox: 0.15, r: 3 }), [fill(col('#b6c0d6')), stroke(col('#0b0f17', 0.8), 2)]),
      node('hook', { id: ids.hook, x: 126, y: 4 }, [shape('cable', {}, rect(2, 60, { oy: 0 }), fill(col('#e6ebf5'))), shape('hook', { y: 64 }, ell(12, 12), [fill(col(pal.registry)), stroke(col('#0b0f17'), 2)])]),
    ]),
  ]);
  const lighthouse = node('lighthouse', {}, [
    shape('lh tower', { x: 366, y: 626 }, smooth([[-18, 0], [-12, -120], [12, -120], [18, 0]], { closed: true, k: 0.1 }), [fill(col('#ece7f4')), stroke(col('#0b0f17', 0.8), 3)]),
    shape('lh stripes', { x: 366, y: 626 }, [rect(34, 18, { y: -30 }), rect(26, 16, { y: -78 })], fill(col(pal.registry, 0.9))),
    shape('lh room', { x: 366, y: 494 }, rect(34, 22, { r: 4 }), [fill(col('#fff3c4')), stroke(col('#0b0f17', 0.8), 2)]),
    shape('lh roof', { x: 366, y: 478 }, tri(46, 20), [fill(col('#a1463a')), stroke(col('#0b0f17', 0.8), 2)]),
    node('beam', { id: ids.beamNode, x: 366, y: 494, binds: [bindCtx(R('registryUp'), 18)] }, [
      shape('beam R', { id: ids.beam }, poly([[0, 0], [260, -34], [260, 34]]), fill(lin(0, 0, 260, 0, [[0, col('#fff3c4', 0.8)], [1, col('#fff3c4', 0)]]), { blend: 'additive' })),
      shape('beam L', { rot: Math.PI }, poly([[0, 0], [260, -34], [260, 34]]), fill(lin(0, 0, 260, 0, [[0, col('#fff3c4', 0.5)], [1, col('#fff3c4', 0)]]), { blend: 'additive' })),
    ]),
  ]);
  const harborLamps = shape('harbor lamps', {}, [ell(10, 10, { x: 44, y: 612 }), ell(10, 10, { x: 410, y: 612 })], fill(col(pal.lantern, 0.9), { blend: 'additive' }));
  const harbor = node('harbor', { x: HARBOR_T.x, y: HARBOR_T.y, s: HARBOR_T.s, binds: [bindCtx(R('level'), 18, cHarbor.id)] }, [harborBase, warehouse, crane, lighthouse, harborLamps]);

  /* pull sequence: plates travel from harbor crane to the deck */
  const plate = (id) =>
    node('travelling plate', { id, op: 0, x: hx(300), y: hy(540) }, [
      shape('plate', {}, rect(34, 24, { r: 3 }), [fill(col(pal.registry, 0.95)), stroke(col('#17324f'), 2.5)]),
      shape('plate lines', {}, [rect(24, 2, { y: -5 }), rect(18, 2, { y: 1 }), rect(22, 2, { y: 7 })], fill(col('#17324f', 0.75))),
    ]);
  const pullBeam = shape('pull beam', { id: ids.pullBeam, op: 0 }, poly([[hx(292), hy(548)], [hx(330), hy(536)], [650, 372], [610, 396]]), fill(lin(hx(292), hy(548), 640, 380, [[0, col(pal.registry, 0.55)], [1, col(pal.registry, 0)]]), { blend: 'additive' }));
  const plates = [0, 1, 2, 3].map((i) => plate(ids['plate' + i]));

  /* ============================================================== SHIPYARD */
  const yard = node('shipyard', { x: YARD_T.x, y: YARD_T.y, s: YARD_T.s, binds: [bindCtx(R('level'), 18, cHarbor.id)] }, [
    shape('yard rock', {}, smooth([[1190, 660], [1230, 730], [1300, 800], [1380, 850], [1470, 800], [1540, 740], [1570, 660]], { closed: true, k: 0.3 }), [fill(lin(0, 660, 0, 850, [[0, '#4b4358'], [1, '#2a2438']])), stroke(col('#0b0f17', 0.8), 4)]),
    shape('yard deck', {}, rect(390, 16, { ox: 0, x: 1184, y: 646, r: 5 }), [fill(col('#6d5a47')), stroke(col('#0b0f17', 0.8), 3)]),
    // forge
    shape('forge', { x: 1260, y: 646 }, rect(86, 62, { oy: 1, r: 6 }), [fill(col('#3a2f4a')), stroke(col('#0b0f17', 0.85), 3)]),
    shape('forge mouth', { x: 1260, y: 646 }, rect(46, 30, { oy: 1, r: 6 }), fill(lin(0, 616, 0, 646, [[0, '#ffb454'], [1, '#e6492d']]))),
    shape('chimney', { x: 1290, y: 584 }, rect(16, 44, { oy: 1 }), [fill(col('#2a2236')), stroke(col('#0b0f17', 0.85), 2)]),
    // anvil
    shape('anvil', { x: 1352, y: 646 }, poly([[-26, -34], [28, -34], [18, -22], [10, -16], [14, 0], [-14, 0], [-10, -16], [-18, -22]]), [fill(col('#8e99b3')), stroke(col('#0b0f17', 0.85), 2.5)]),
    node('hammer', { id: ids.hammer, x: 1376, y: 560 }, [shape('handle', {}, rect(6, 62, { oy: 0 }), fill(col('#8a6038'))), shape('head', { y: 62 }, rect(32, 16, { r: 3 }), [fill(col('#b6c0d6')), stroke(col('#0b0f17', 0.85), 2)])]),
    node('sparks', { id: ids.sparks, x: 1352, y: 610, op: 0 }, [
      shape('spark a', { x: -10, y: 0 }, ell(5, 5), fill(col('#ffd166', 0.95), { blend: 'additive' })),
      shape('spark b', { x: 10, y: -4 }, ell(4, 4), fill(col('#ff9f43', 0.95), { blend: 'additive' })),
      shape('spark c', { x: 0, y: -10 }, ell(6, 6), fill(col('#fff3a8', 0.95), { blend: 'additive' })),
      shape('spark d', { x: 18, y: 2 }, ell(3, 3), fill(col('#ffd166', 0.95), { blend: 'additive' })),
      shape('spark e', { x: -20, y: -6 }, ell(3, 3), fill(col('#ff9f43', 0.95), { blend: 'additive' })),
    ]),
    shape('yard glow', { x: 1352, y: 620 }, ell(170, 90), fill(rad(0, 0, 85, [[0, col('#ffb454', 0.32)], [1, col('#ffb454', 0)]]), { blend: 'additive' })),
    // stacked blueprint plates (build output)
    ...[0, 1, 2, 3].map((i) =>
      shape('built plate ' + i, { id: ids['bplate' + i], x: 1470, y: 640 - i * 14, op: 0.0 }, rect(78, 12, { r: 3 }), [fill(col(pal.build, 0.95)), stroke(col('#4a1a33'), 2)]),
    ),
  ]);
  const builtPlates = [0, 1, 2, 3].map((i) => ids['bplate' + i]);

  /* ================================================================ WEATHER */
  const stormClouds = node('storm', { id: ids.storm, op: 0 }, [
    shape('storm veil', {}, rect(1600, 520, { ox: 0, oy: 0 }), fill(lin(0, 0, 0, 520, [[0, col('#06080f', 0.82)], [1, col('#06080f', 0)]]))),
    node('storm clouds', {}, Array.from({ length: 8 }, (_, i) => cloudBlob(100 + i * 210, 60 + (i % 3) * 36, 2.4, col('#1a1d2e', 0.92)))),
    shape('rain', { id: ids.rain }, Array.from({ length: 60 }, (_, i) => rect(2, 26, { x: 20 + i * 27, y: 100 + ((i * 53) % 400), rot: 0.2 })), fill(col('#9fc6ff', 0.55))),
  ]);
  const lightning = shape('lightning flash', { id: ids.flashSky, op: 0 }, rect(1600, 900, { ox: 0, oy: 0 }), fill(col('#dfe9ff', 0.6), { blend: 'screen' }));
  const dim = shape('failure dim', { id: ids.dim, op: 0 }, rect(1600, 900, { ox: 0, oy: 0 }), fill(col('#1a0505', 0.35)));
  const vignette = shape('vignette', {}, rect(1600, 900, { ox: 0, oy: 0 }), fill(rad(800, 450, 1000, [[0.45, col('#000000', 0)], [1, col('#000000', 0.55)]])));

  /* ========================================================== composition */
  const whaleGroup = node('whale', { id: ids.whale }, [
    tail,
    fin,
    whaleBody,
    whaleOutline,
    internals,
    eye,
    spout,
    deckBoards,
    lanterns,
    cockpit,
    node('cargo slots', {}, slots),
    crew,
    canopy,
  ]);
  const kids = [
    sky,
    starsStatic,
    mkStars('starsA', 26),
    mkStars('starsB', 26),
    moon,
    cloudsFar,
    horizonGlow,
    harbor,
    yard,
    whaleGroup,
    cloudsMid,
    pullBeam,
    ...plates,
    stormClouds,
    dim,
    lightning,
    vignette,
  ];

  /* ============================================================ ANIMATIONS */
  const T = 3600;
  const loopK = (period, pattern) => dedupe(cycle(T, period, pattern));
  const sway = (amp) => [[0, -amp, 'inOut'], [0.5, amp, 'inOut']];
  const swayKeys = (period, amp) => loopK(period, [[0, -amp, 'inOut'], [period / 2, amp, 'inOut']]);
  const bob = (period, amp, base = 0) => loopK(period, [[0, base, 'inOut'], [period / 2, base + amp, 'inOut']]);
  const aAmbient = anim('Ambient', {
    frames: T,
    loop: 'loop',
    keys: [
      { obj: ids.cloudsFar, prop: 'x', kf: [[0, 0], [T, -1600]] },
      { obj: ids.cloudsMid, prop: 'x', kf: [[0, 0], [1799, -1599], [1800, 0], [3599, -1599], [3600, 0]] },
      { obj: ids.tail, prop: 'rotation', kf: swayKeys(240, 0.1) },
      { obj: ids.fin, prop: 'rotation', kf: swayKeys(300, 0.07) },
      { obj: ids.whale, prop: 'y', kf: bob(360, 7) },
      { obj: ids.eyeLid, prop: 'scaleY', kf: loopK(300, [[0, 0.02], [120, 0.02], [124, 1], [130, 0.02]]) },
      { obj: ids.starsA, prop: 'opacity', kf: loopK(180, [[0, 1, 'inOut'], [90, 0.25, 'inOut']]) },
      { obj: ids.starsB, prop: 'opacity', kf: loopK(180, [[0, 0.3, 'inOut'], [90, 1, 'inOut']]) },
      { obj: ids.spoutA, prop: 'y', kf: loopK(120, [[0, 0], [119, -60]]) },
      { obj: ids.spoutA, prop: 'opacity', kf: loopK(120, [[0, 0.7], [100, 0], [119, 0]]) },
      { obj: ids.spoutB, prop: 'y', kf: loopK(120, [[0, 0], [119, -70]]) },
      { obj: ids.spoutB, prop: 'x', kf: loopK(120, [[0, 6], [119, 22]]) },
      { obj: ids.spoutB, prop: 'opacity', kf: loopK(120, [[0, 0], [20, 0.7], [110, 0], [119, 0]]) },
      { obj: ids.spoutC, prop: 'y', kf: loopK(120, [[0, 0], [119, -52]]) },
      { obj: ids.spoutC, prop: 'x', kf: loopK(120, [[0, -6], [119, -20]]) },
      { obj: ids.spoutC, prop: 'opacity', kf: loopK(120, [[0, 0], [45, 0.7], [110, 0], [119, 0]]) },
      ...[0, 1, 2, 3, 4, 5].map((i) => ({ obj: ids['lantern' + i], prop: 'opacity', kf: loopK(60 + i * 12, [[0, 1, 'inOut'], [(60 + i * 12) / 2, 0.62 + (i % 3) * 0.06, 'inOut']]) })),
      { obj: ids.beamNode, prop: 'rotation', kf: loopK(300, [[0, -0.5, 'inOut'], [150, 0.5, 'inOut']]) },
      { obj: ids.crane, prop: 'rotation', kf: swayKeys(360, 0.025) },
      { obj: ids.hook, prop: 'rotation', kf: swayKeys(180, 0.06) },
      { obj: ids.hammer, prop: 'rotation', kf: loopK(40, [[0, -0.9, 'in'], [14, 0.25, 'out'], [20, 0.25, 'out'], [40, -0.9, 'inOut']]) },
      { obj: ids.sparks, prop: 'y', kf: loopK(40, [[0, 610], [39, 570]]) },
      { obj: pulseTrimId, prop: 'start', kf: loopK(180, [[0, 0], [150, 0.92], [179, 0.92]]) },
      { obj: pulseTrimId, prop: 'end', kf: loopK(180, [[0, 0.08], [150, 1], [179, 1]]) },
    ],
  });


  const hold = (name, keys) => anim(name, { frames: 1, keys });
  const aCalm = hold('Calm', [
    { obj: ids.storm, prop: 'opacity', kf: [[0, 0]] },
    { obj: ids.dim, prop: 'opacity', kf: [[0, 0]] },
  ]);
  const aStorm = anim('Storm', {
    frames: 420,
    loop: 'loop',
    keys: [
      { obj: ids.storm, prop: 'opacity', kf: [[0, 1]] },
      { obj: ids.dim, prop: 'opacity', kf: [[0, 1]] },
      { obj: ids.rain, prop: 'y', kf: loopRain(420) },
      { obj: ids.flashSky, prop: 'opacity', kf: [[0, 0], [90, 0], [92, 0.9], [96, 0.1], [99, 0.7], [112, 0], [250, 0], [252, 0.8], [258, 0], [420, 0]] },
    ],
  });
  function loopRain(T2) {
    return dedupe(cycle(T2, 24, [[0, 0], [23, 48]]));
  }
  const aShakeIdle = hold('ShakeIdle', [{ obj: ids.whale, prop: 'x', kf: [[0, 0]] }]);
  const aShake = anim('Shudder', {
    frames: 44,
    keys: [
      { obj: ids.whale, prop: 'x', kf: [[0, 0], [4, -9, 'out'], [10, 8], [16, -6], [22, 5], [28, -3], [34, 2], [44, 0]] },
      { obj: ids.whale, prop: 'rotation', kf: [[0, 0], [4, 0.012], [10, -0.01], [16, 0.008], [22, -0.005], [44, 0]] },
    ],
  });
  const aPullIdle = hold('PullIdle', plates.map((p) => ({ obj: p.id, prop: 'opacity', kf: [[0, 0]] })).concat([{ obj: ids.pullBeam, prop: 'opacity', kf: [[0, 0]] }]));
  const pullKeys = [];
  plates.forEach((p, i) => {
    const d = i * 16;
    pullKeys.push(
      { obj: p.id, prop: 'opacity', kf: [[0, 0], [d, 0], [d + 6, 1], [d + 70, 1], [d + 78, 0]] },
      { obj: p.id, prop: 'x', kf: [[d, hx(300)], [d + 72, 520 + i * 90, 'inOut']] },
      { obj: p.id, prop: 'y', kf: [[d, hy(548)], [d + 30, 300 - i * 6, 'out'], [d + 72, DECK_Y - 40, 'in']] },
      { obj: p.id, prop: 'rotation', kf: [[d, -0.3], [d + 72, 0.2]] },
      { obj: p.id, prop: 'scaleX', kf: [[d, 1], [d + 72, 0.8]] },
    );
  });
  pullKeys.push({ obj: ids.pullBeam, prop: 'opacity', kf: [[0, 0], [12, 0.9, 'out'], [90, 0.6], [140, 0, 'in']] }, { obj: ids.hook, prop: 'rotation', kf: [[0, 0], [20, 0.3, 'inOut'], [80, -0.2, 'inOut'], [140, 0]] });
  const aPull = anim('PullSeq', { frames: 150, keys: pullKeys });
  const aBuildIdle = hold('BuildIdle', builtPlates.map((id) => ({ obj: id, prop: 'opacity', kf: [[0, 0]] })).concat([{ obj: ids.sparks, prop: 'opacity', kf: [[0, 0]] }]));
  const buildKeys = builtPlates.map((id, i) => ({ obj: id, prop: 'opacity', kf: [[0, 0], [i * 22, 0], [i * 22 + 4, 1], [140, 1], [160, 0]] }));
  buildKeys.push({ obj: ids.sparks, prop: 'opacity', kf: [[0, 1], [110, 1], [130, 0]] });
  const aBuild = anim('BuildSeq', { frames: 160, keys: buildKeys });

  // sparks visibility while `building` is on: gate by direct bind on the sparks node (opacity <- building)
  const sm = stateMachine('World SM', [
    {
      name: 'Weather',
      entry: 'calm',
      states: { calm: { anim: aCalm }, storm: { anim: aStorm } },
      transitions: [
        { from: 'calm', to: 'storm', ms: 700, conds: [{ ref: R('storm'), value: true }] },
        { from: 'storm', to: 'calm', ms: 900, conds: [{ ref: R('storm'), value: false }] },
      ],
    },
    {
      name: 'Shudder',
      entry: 'idle',
      states: { idle: { anim: aShakeIdle }, shake: { anim: aShake, reset: true } },
      transitions: [
        { from: 'idle', to: 'shake', ms: 0, conds: [{ ref: R('shake'), type: 'trigger' }] },
        { from: 'shake', to: 'idle', ms: 120, exit: 100 },
      ],
    },
    {
      name: 'Pull',
      entry: 'idle',
      states: { idle: { anim: aPullIdle }, seq: { anim: aPull, reset: true } },
      transitions: [
        { from: 'idle', to: 'seq', ms: 0, conds: [{ ref: R('pull'), type: 'trigger' }] },
        { from: 'seq', to: 'idle', ms: 160, exit: 100 },
      ],
    },
    {
      name: 'Build',
      entry: 'idle',
      states: { idle: { anim: aBuildIdle }, seq: { anim: aBuild, reset: true } },
      transitions: [
        { from: 'idle', to: 'seq', ms: 0, conds: [{ ref: R('build'), type: 'trigger' }] },
        { from: 'seq', to: 'idle', ms: 160, exit: 100 },
      ],
    },
    { name: 'Ambient', entry: 'loop', states: { loop: { anim: aAmbient } }, transitions: [] },
  ]);

  const anims = [aAmbient, aCalm, aStorm, aShakeIdle, aShake, aPullIdle, aPull, aBuildIdle, aBuild];
  const ab = artboard({ name: 'World', w: WORLD.w, h: WORLD.h, x: 0, y: 0, vm, kids, sm, anims });

  return { artboard: ab, vm, smId: sm.id, converters: [cToy, cInternals, cCrew, cHarbor, cKernelGlow, diskConv, ...memConv].map((c) => c.xml), ids };
}
