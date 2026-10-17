import { anim, artboard, col, defineVM, ell, fill, lin, nid, node, poly, rad, rangeMap, rect, shape, smooth, stateMachine, stroke, star } from './dsl.mjs';
import pal from '../../shared/palette.json' with { type: 'json' };

/**
 * Santa = dockerd. A slightly chaotic pilot. The app drives:
 *   mood: 0 calm · 1 working (steering) · 2 panic · 3 asleep (daemon stopped)
 *   wave: trigger (connection test / greeting)
 */
export function buildSanta() {
  const vm = defineVM('Santa', [
    { name: 'mood', type: 'number', def: 0 },
    { name: 'wave', type: 'trigger' },
  ]);
  const R = (p) => vm.ref(p);
  const ids = Object.fromEntries(['body', 'head', 'pom', 'eyeL', 'eyeR', 'mouth', 'sweat', 'wheel', 'armR', 'armL', 'burst', 'brows', 'zzz', 'hatTip'].map((k) => [k, nid()]));

  const RED = '#d93a3a';
  const RED_D = '#a82a30';
  const SKIN = '#f3cba6';

  const wheel = node('wheel', { id: ids.wheel, x: 100, y: 196 }, [
    shape('wheel rim', {}, ell(72, 72), stroke(col('#2c3550'), 7)),
    shape('wheel rim hi', {}, ell(72, 72), stroke(col('#8da2d6', 0.55), 2.5)),
    shape('spokes', {}, [rect(66, 6, {}), rect(6, 66, {})], fill(col('#2c3550'))),
    shape('hub', {}, ell(16, 16), [fill(col(pal.lantern)), stroke(col('#2c3550'), 2)]),
  ]);

  // arm = shoulder pivot -> forearm chain, so sleeve, cuff and mitten rotate as ONE limb
  const arm = (name, id, x, y, inner) =>
    node(name, { id, x, y }, [
      node(name + ' fore', { rot: inner }, [
        shape(name + ' sleeve', {}, rect(22, 50, { oy: 0, r: 10 }), [fill(col(RED)), stroke(col(RED_D), 2)]),
        shape(name + ' cuff', { y: 46 }, rect(26, 10, { r: 5 }), fill(col('#ffffff'))),
        shape(name + ' mitten', { y: 60 }, ell(20, 20), [fill(col('#2d2f3b')), stroke(col('#14161e'), 1.5)]),
      ]),
    ]);
  const armL = arm('arm L', ids.armL, 68, 148, -0.5);
  const armR = arm('arm R', ids.armR, 132, 148, 0.5);

  const head = node('head', { id: ids.head, x: 100, y: 108 }, [
    // beard first (behind face edge), then face, then features
    shape('beard', {}, smooth([[-30, -2], [-34, 18], [-20, 38], [0, 46], [20, 38], [34, 18], [30, -2], [0, 6]], { closed: true, k: 0.4 }), [fill(col('#ffffff')), stroke(col('#c9d3e6'), 2)]),
    shape('face', { y: -12 }, ell(60, 56), fill(col(SKIN))),
    shape('cheeks', { y: -4 }, [ell(12, 8, { x: -17 }), ell(12, 8, { x: 17 })], fill(col('#f08a8a', 0.45))),
    shape('mustache', { y: 4 }, [ell(26, 13, { x: -11, y: 0 }), ell(26, 13, { x: 11, y: 0 })], [fill(col('#ffffff')), stroke(col('#c9d3e6'), 1.5)]),
    shape('nose', { y: -4 }, ell(13, 11), fill(col('#e9857a'))),
    node('eyes', {}, [
      shape('eye L', { id: ids.eyeL, x: -11, y: -17 }, ell(7, 9), fill(col('#1d2233'))),
      shape('eye R', { id: ids.eyeR, x: 11, y: -17 }, ell(7, 9), fill(col('#1d2233'))),
      shape('glint', {}, [ell(2.4, 2.4, { x: -9.5, y: -19.5 }), ell(2.4, 2.4, { x: 12.5, y: -19.5 })], fill(col('#ffffff'))),
    ]),
    shape('brows', { id: ids.brows }, [rect(14, 4, { x: -11, y: -27, r: 2 }), rect(14, 4, { x: 11, y: -27, r: 2 })], fill(col('#ffffff'))),
    shape('mouth', { id: ids.mouth, y: 14 }, ell(12, 7), [fill(col('#6b1f2a'))]),
    // hat
    node('hat', {}, [
      shape('hat body', {}, smooth([[-31, -30], [-24, -52], [-4, -66], [20, -64], [38, -50], [36, -34], [31, -30]], { closed: true, k: 0.35 }), [fill(col(RED)), stroke(col(RED_D), 2)]),
      shape('hat fold', {}, poly([[-6, -64], [10, -48], [8, -33]], { closed: false }), stroke(col(RED_D, 0.6), 2)),
      shape('hat band', { y: -30 }, rect(72, 14, { r: 7 }), [fill(col('#ffffff')), stroke(col('#c9d3e6'), 1.5)]),
      node('pom', { id: ids.pom, x: 38, y: -48 }, [shape('pom', { x: 6, y: 10 }, ell(17, 17), [fill(col('#ffffff')), stroke(col('#c9d3e6'), 1.5)])]),
    ]),
    // headset (dockerd listens to the radio)
    shape('headset', { y: -12 }, smooth([[-36, 8], [-38, -16], [-24, -34], [0, -40], [24, -34], [38, -16], [36, 8]], { closed: false, k: 0.3 }), stroke(col('#2c3550', 0.95), 3)),
    shape('ear cup', { x: -37, y: -4 }, rect(10, 18, { r: 4 }), [fill(col('#2c3550')), stroke(col(pal.runtime), 1.5)]),
    shape('mic', { x: -34, y: 10 }, smooth([[0, 0], [4, 12], [14, 16]], { closed: false, k: 0.4 }), stroke(col('#2c3550'), 2.5)),
    shape('mic tip', { x: -20, y: 26 }, ell(7, 7), fill(col(pal.runtime))),
  ]);

  const coat = node('torso', {}, [
    shape('coat', { x: 100, y: 172 }, smooth([[-52, -30], [-58, 12], [-46, 42], [0, 52], [46, 42], [58, 12], [52, -30], [0, -40]], { closed: true, k: 0.35 }), [fill(lin(0, -40, 0, 52, [[0, col('#e94b4b')], [1, col(RED_D)]])), stroke(col('#6e1a22'), 2)]),
    shape('fur trim', { x: 100, y: 144 }, rect(70, 11, { r: 5 }), fill(col('#ffffff'))),
    shape('belt', { x: 100, y: 184 }, rect(112, 15), fill(col('#1d2233'))),
    shape('buckle', { x: 100, y: 184 }, rect(22, 17, { r: 3 }), [fill(col(pal.lantern)), stroke(col('#7a4a00'), 2)]),
    shape('buckle inner', { x: 100, y: 184 }, rect(10, 8, { r: 2 }), fill(col('#1d2233'))),
  ]);

  const sweat = shape('sweat', { id: ids.sweat, op: 0, x: 140, y: 76 }, smooth([[0, -9], [6, 3], [0, 9], [-6, 3]], { closed: true, k: 0.5 }), fill(col('#7cc7ff')));
  const zzz = node('zzz', { id: ids.zzz, op: 0, x: 142, y: 54 }, [
    shape('z1', {}, poly([[0, 0], [12, 0], [0, 12], [12, 12]], { closed: false }), stroke(col('#cfd6e4'), 2.5)),
    shape('z2', { x: 14, y: -14 }, poly([[0, 0], [9, 0], [0, 9], [9, 9]], { closed: false }), stroke(col('#cfd6e4'), 2)),
  ]);
  const burst = node('wave sparkle', { id: ids.burst, op: 0, x: 168, y: 80 }, [
    shape('sparkle 1', {}, star(26, 26, 4, 0.35), fill(col('#fff3a8'), { blend: 'additive' })),
    shape('sparkle 2', { x: 18, y: -20 }, star(14, 14, 4, 0.35), fill(col('#fff3a8'), { blend: 'additive' })),
    shape('sparkle 3', { x: -4, y: -26 }, star(10, 10, 4, 0.35), fill(col('#ffffff'), { blend: 'additive' })),
  ]);

  const body = node('santa', { id: ids.body }, [coat, wheel, armL, head, armR, sweat, zzz, burst]);
  const root = node('root', { x: 0, y: 0 }, [body]);

  /* ---------------------- animations ---------------------- */
  const TAU = Math.PI * 2;
  const mood = (name, o) =>
    anim(name, {
      frames: o.frames,
      loop: 'loop',
      keys: [
        { obj: ids.body, prop: 'y', kf: o.y },
        { obj: ids.body, prop: 'x', kf: o.x ?? [[0, 0]] },
        { obj: ids.body, prop: 'rotation', kf: o.rot ?? [[0, 0]] },
        { obj: ids.wheel, prop: 'rotation', kf: o.wheel ?? [[0, 0]] },
        { obj: ids.pom, prop: 'rotation', kf: o.pom },
        { obj: ids.mouth, prop: 'scaleX', kf: o.mouthX ?? [[0, 1]] },
        { obj: ids.mouth, prop: 'scaleY', kf: o.mouthY ?? [[0, 1]] },
        { obj: ids.sweat, prop: 'opacity', kf: [[0, o.sweat ?? 0]] },
        { obj: ids.zzz, prop: 'opacity', kf: o.zzz ?? [[0, 0]] },
        { obj: ids.head, prop: 'rotation', kf: o.head ?? [[0, 0]] },
        { obj: ids.head, prop: 'y', kf: [[0, o.headY ?? 108]] },
      ],
    });
  const aCalm = mood('Calm', { frames: 180, y: [[0, 0], [90, -2.5, 'inOut'], [180, 0, 'inOut']], pom: [[0, 0.1], [90, -0.12, 'inOut'], [180, 0.1, 'inOut']], mouthY: [[0, 0.8]] });
  const aWork = mood('Working', {
    frames: 120,
    y: [[0, 0], [30, -1.5, 'inOut'], [60, 0, 'inOut'], [90, -1.5, 'inOut'], [120, 0, 'inOut']],
    rot: [[0, -0.02], [60, 0.025, 'inOut'], [120, -0.02, 'inOut']],
    wheel: [[0, -0.5], [30, 0.35, 'inOut'], [60, -0.2, 'inOut'], [90, 0.5, 'inOut'], [120, -0.5, 'inOut']],
    pom: [[0, 0.3], [60, -0.3, 'inOut'], [120, 0.3, 'inOut']],
    mouthX: [[0, 1.2], [30, 0.8], [60, 1.3], [90, 0.9], [120, 1.2]],
    mouthY: [[0, 1.3], [30, 0.9], [60, 1.5], [90, 1], [120, 1.3]],
    head: [[0, -0.05], [60, 0.05, 'inOut'], [120, -0.05, 'inOut']],
  });
  const aPanic = mood('Panic', {
    frames: 24,
    y: [[0, 0], [6, -3], [12, 0], [18, -3], [24, 0]],
    x: [[0, -2.5], [4, 2.5], [8, -2], [12, 2.5], [16, -2.5], [20, 2], [24, -2.5]],
    rot: [[0, -0.04], [12, 0.04], [24, -0.04]],
    wheel: [[0, -1], [6, 1], [12, -1], [18, 1], [24, -1]],
    pom: [[0, 0.7], [6, -0.7], [12, 0.7], [18, -0.7], [24, 0.7]],
    mouthX: [[0, 1.6]],
    mouthY: [[0, 2.8], [6, 2.2], [12, 2.9], [18, 2.2], [24, 2.8]],
    sweat: 1,
  });
  const aAsleep = mood('Asleep', {
    frames: 240,
    y: [[0, 6], [120, 9, 'inOut'], [240, 6, 'inOut']],
    pom: [[0, 0.25]],
    mouthY: [[0, 0.3]],
    zzz: [[0, 0.3], [60, 1, 'inOut'], [120, 0.3, 'inOut'], [180, 1, 'inOut'], [240, 0.3, 'inOut']],
    head: [[0, 0.22]],
    headY: 112,
  });

  const aWaveIdle = anim('WaveIdle', { frames: 1, keys: [{ obj: ids.armR, prop: 'rotation', kf: [[0, 0]] }, { obj: ids.burst, prop: 'opacity', kf: [[0, 0]] }] });
  const aWave = anim('Wave', {
    frames: 120,
    keys: [
      { obj: ids.armR, prop: 'rotation', kf: [[0, 0], [14, -2.7, 'back'], [28, -2.1, 'inOut'], [44, -2.9, 'inOut'], [60, -2.1, 'inOut'], [76, -2.9, 'inOut'], [92, -2.1, 'inOut'], [120, 0, 'inOut']] },
      { obj: ids.burst, prop: 'opacity', kf: [[0, 0], [16, 1, 'out'], [70, 1], [110, 0, 'in']] },
      { obj: ids.burst, prop: 'rotation', kf: [[0, 0], [120, 0.8]] },
    ],
  });

  const aBlink = anim('Blink', {
    frames: 260,
    loop: 'loop',
    keys: [
      { obj: ids.eyeL, prop: 'scaleY', kf: [[0, 1], [110, 1], [114, 0.1], [120, 1], [200, 1], [203, 0.1], [208, 1], [260, 1]] },
      { obj: ids.eyeR, prop: 'scaleY', kf: [[0, 1], [110, 1], [114, 0.1], [120, 1], [200, 1], [203, 0.1], [208, 1], [260, 1]] },
    ],
  });

  const M = R('mood');
  const mt = (from, to) => ({ from, to, ms: to === 'panic' ? 80 : 280, conds: [{ ref: M, value: { calm: 0, working: 1, panic: 2, asleep: 3 }[to] }] });
  const keys = ['calm', 'working', 'panic', 'asleep'];
  const moodTransitions = [];
  for (const a of keys) for (const b of keys) if (a !== b) moodTransitions.push(mt(a, b));
  const sm = stateMachine('Santa SM', [
    { name: 'Mood', entry: 'calm', states: { calm: { anim: aCalm }, working: { anim: aWork }, panic: { anim: aPanic }, asleep: { anim: aAsleep } }, transitions: moodTransitions },
    {
      name: 'Wave',
      entry: 'idle',
      states: { idle: { anim: aWaveIdle }, wave: { anim: aWave, reset: true } },
      transitions: [
        { from: 'idle', to: 'wave', ms: 80, conds: [{ ref: R('wave'), type: 'trigger' }] },
        { from: 'wave', to: 'idle', ms: 160, exit: 100 },
      ],
    },
    { name: 'Blink', entry: 'loop', states: { loop: { anim: aBlink } }, transitions: [] },
  ]);
  const ab = artboard({ name: 'Santa', w: 200, h: 240, x: 220, y: 1000, component: true, vm, kids: [root], sm, anims: [aCalm, aWork, aPanic, aAsleep, aWaveIdle, aWave, aBlink] });
  return { artboard: ab, vm, smId: sm.id, converters: [] };
}
