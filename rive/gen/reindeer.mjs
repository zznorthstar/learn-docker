import { anim, artboard, bindCtx, col, defineVM, ell, fill, lin, nid, node, poly, rad, rangeMap, rect, shape, smooth, stateMachine, stroke, star } from './dsl.mjs';
import pal from '../../shared/palette.json' with { type: 'json' };

/**
 * One reusable reindeer. Two instances in the world:
 *   role 0 = foreman (containerd, hard hat)   role 1 = runner (runc, hi-vis vest)
 * The app drives: working (bool), glow (0..1 nose/antler glow), nod (trigger), coat (colour), role.
 */
export function buildReindeer() {
  const vm = defineVM('Reindeer', [
    { name: 'role', type: 'number', def: 0 },
    { name: 'working', type: 'bool', def: false },
    { name: 'glow', type: 'number', def: 0.2 },
    { name: 'nod', type: 'trigger' },
    { name: 'coat', type: 'color', def: 'FF8A5A3A' },
  ]);
  const R = (p) => vm.ref(p);
  const cHat = rangeMap('role→hat', 0, 1, 1, 0);
  const ids = Object.fromEntries(['body', 'head', 'tail', 'earF', 'earB', 'legFL', 'legFR', 'nose', 'bodyScale', 'antler'].map((k) => [k, nid()]));

  const COAT = '#8a5a3a';
  const leg = (name, id, x, shade) =>
    node(name, { id, x, y: 120 }, [
      shape(name + ' leg', {}, rect(13, 44, { oy: 0, r: 6 }), shade ? fill({ bind: R('coat'), value: 'FF8A5A3A' }) : fill({ bind: R('coat'), value: 'FF8A5A3A' })),
      shape(name + ' shade', {}, rect(13, 44, { oy: 0, r: 6 }), fill(col('#000000', shade ? 0.28 : 0.1))),
      shape(name + ' hoof', { y: 44 }, rect(15, 9, { r: 3 }), fill(col('#2a2018'))),
    ]);

  const antlerPath = (flip) => {
    const f = flip ? -1 : 1;
    return [
      smooth([[0, 0], [f * -6, -22], [f * -14, -38], [f * -12, -58]], { closed: false, k: 0.4 }),
      smooth([[f * -6, -22], [f * 6, -34], [f * 12, -46]], { closed: false, k: 0.4 }),
      smooth([[f * -14, -38], [f * -28, -44]], { closed: false, k: 0.4 }),
    ];
  };

  const head = node('head', { id: ids.head, x: 182, y: 66 }, [
    node('antler back', { x: 12, y: -14 }, [shape('antler B', {}, antlerPath(false), stroke(col('#b99a6b', 0.75), 4))]),
    shape('neck', { x: -16, y: 8 }, smooth([[-12, 40], [4, -6], [26, -22], [30, 12], [10, 52]], { closed: true, k: 0.35 }), fill({ bind: R('coat'), value: 'FF8A5A3A' })),
    node('ear back', { id: ids.earB, x: 4, y: -22 }, [shape('ear B', { rot: -0.3 }, ell(10, 22, { oy: 1 }), fill(col('#5f3b24')))]),
    shape('head', { rot: 0.1 }, ell(56, 42), fill({ bind: R('coat'), value: 'FF8A5A3A' })),
    shape('snout', { x: 26, y: 10 }, ell(32, 24), fill(col('#c89a74'))),
    shape('nose glow', { x: 38, y: 10 }, ell(34, 34), fill(rad(0, 0, 17, [[0, col(pal.failure, 0.9)], [1, col(pal.failure, 0)]]), { blend: 'additive' })),
    shape('nose', { id: ids.nose, x: 38, y: 10 }, ell(12, 11), [fill(col('#ff5a5a')), stroke(col('#8a1f2a'), 1.5)]),
    shape('mouth', { x: 30, y: 21 }, poly([[0, 0], [10, 3]], { closed: false }), stroke(col('#3a2418'), 2)),
    shape('eye', { x: 10, y: -2 }, ell(8, 10), fill(col('#1d2233'))),
    shape('eye glint', { x: 12, y: -5 }, ell(3, 3), fill(col('#ffffff'))),
    node('ear front', { id: ids.earF, x: 14, y: -20 }, [shape('ear F', { rot: 0.15 }, ell(11, 24, { oy: 1 }), fill(col('#6d4429')))]),
    node('antler front', { id: ids.antler, x: 18, y: -18 }, [shape('antler F', {}, antlerPath(false), stroke(col('#d6b98a'), 4.5)), shape('antler glow', {}, antlerPath(false), stroke(col(pal.runtime, 0.9), 8, { blend: 'additive', feather: 6 }))]),
    // foreman hard hat (visible when role = 0)
    node('hard hat', { x: 6, y: -22, binds: [bindCtx(R('role'), 18, cHat.id)] }, [
      shape('hat dome', {}, smooth([[-18, 4], [-14, -12], [0, -18], [14, -12], [18, 4]], { closed: true, k: 0.4 }), [fill(col('#ffcc33')), stroke(col('#8a6200'), 2)]),
      shape('hat brim', { y: 4 }, rect(44, 6, { r: 3 }), [fill(col('#ffcc33')), stroke(col('#8a6200'), 2)]),
      shape('hat ridge', { y: -8 }, rect(6, 12, { r: 2 }), fill(col('#e6a800'))),
    ]),
  ]);

  const vest = node('vest', { binds: [bindCtx(R('role'), 18)] }, [
    shape('vest', { x: 116, y: 100 }, smooth([[-50, -20], [-20, -30], [16, -30], [48, -22], [50, 26], [-4, 34], [-48, 26]], { closed: true, k: 0.3 }), [fill(col('#ff8c1a', 0.95)), stroke(col('#8a4300'), 2)]),
    shape('vest stripes', { x: 116, y: 100 }, [rect(98, 6, { y: -4, rot: 0.04 }), rect(98, 6, { y: 12, rot: 0.04 })], fill(col('#fffbe6', 0.9))),
  ]);
  const badge = node('badge', { x: 150, y: 96, binds: [bindCtx(R('role'), 18, cHat.id)] }, [shape('badge', {}, star(22, 22, 5, 0.5), [fill(col('#ffd24a')), stroke(col('#8a6200'), 2)])]);

  const body = node('body', { id: ids.body }, [
    shape('tail', { id: ids.tail, x: 46, y: 86 }, ell(22, 22), [fill(col('#ffffff')), stroke(col('#c9d3e6'), 1.5)]),
    leg('leg BL', nid(), 72, true),
    leg('leg BR', nid(), 92, true),
    shape('torso', { x: 116, y: 100 }, ell(132, 70), fill({ bind: R('coat'), value: 'FF8A5A3A' })),
    shape('torso sheen', { x: 116, y: 100 }, ell(132, 70), fill(lin(0, -35, 0, 35, [[0, col('#ffffff', 0.18)], [0.6, col('#ffffff', 0)], [1, col('#000000', 0.22)]]))),
    shape('belly', { x: 118, y: 118 }, ell(104, 30), fill(col('#e3c6a0', 0.7))),
    vest,
    leg('leg FL', ids.legFL, 138, true),
    leg('leg FR', ids.legFR, 158, false),
    shape('harness', { x: 150, y: 90 }, rect(8, 62, { r: 3, rot: 0.2 }), fill(col(pal.lantern, 0.9))),
    badge,
    head,
  ]);
  const shadow = shape('shadow', { x: 116, y: 168 }, ell(150, 12), fill(col('#000000', 0.32)));
  const root = node('root', { y: 46 }, [shadow, body]);

  /* ---------------------- animations ---------------------- */
  const aAmbient = anim('Ambient', {
    frames: 180,
    loop: 'loop',
    keys: [
      { obj: ids.body, prop: 'scaleY', kf: [[0, 1], [90, 1.018, 'inOut'], [180, 1, 'inOut']] },
      { obj: ids.tail, prop: 'rotation', kf: [[0, -0.3], [45, 0.3, 'inOut'], [90, -0.3, 'inOut'], [135, 0.3, 'inOut'], [180, -0.3, 'inOut']] },
      { obj: ids.earF, prop: 'rotation', kf: [[0, 0], [100, 0], [106, -0.28, 'out'], [114, 0.05, 'inOut'], [120, 0], [180, 0]] },
      { obj: ids.earB, prop: 'rotation', kf: [[0, 0], [60, 0], [66, 0.25, 'out'], [74, 0, 'inOut'], [180, 0]] },
    ],
  });
  const wk = (name, o) =>
    anim(name, {
      frames: o.frames,
      loop: o.loop ?? 'loop',
      keys: [
        { obj: ids.head, prop: 'rotation', kf: o.headRot },
        { obj: ids.head, prop: 'y', kf: o.headY },
        { obj: ids.legFL, prop: 'rotation', kf: o.paw },
        { obj: ids.nose, prop: 'opacity', kf: o.nose },
      ],
    });
  const aIdle = wk('WorkIdle', { frames: 160, headRot: [[0, 0], [80, 0.04, 'inOut'], [160, 0, 'inOut']], headY: [[0, 66], [80, 64, 'inOut'], [160, 66, 'inOut']], paw: [[0, 0]], nose: [[0, 0.75]] });
  const aWork = wk('WorkBusy', {
    frames: 60,
    headRot: [[0, 0.02], [15, 0.14, 'inOut'], [30, -0.04, 'inOut'], [45, 0.14, 'inOut'], [60, 0.02, 'inOut']],
    headY: [[0, 64], [15, 70, 'inOut'], [30, 62, 'inOut'], [45, 70, 'inOut'], [60, 64, 'inOut']],
    paw: [[0, 0], [12, -0.7, 'out'], [24, 0, 'in'], [36, -0.7, 'out'], [48, 0, 'in'], [60, 0]],
    nose: [[0, 1]],
  });
  const aNodIdle = anim('NodIdle', { frames: 1, keys: [{ obj: ids.body, prop: 'y', kf: [[0, 0]] }] });
  const aNod = anim('Nod', { frames: 36, keys: [{ obj: ids.body, prop: 'y', kf: [[0, 0], [8, -8, 'out'], [18, 2, 'in'], [26, -3, 'out'], [36, 0, 'inOut']] }] });

  const sm = stateMachine('Reindeer SM', [
    {
      name: 'Work',
      entry: 'idle',
      states: { idle: { anim: aIdle }, busy: { anim: aWork } },
      transitions: [
        { from: 'idle', to: 'busy', ms: 240, conds: [{ ref: R('working'), value: true }] },
        { from: 'busy', to: 'idle', ms: 320, conds: [{ ref: R('working'), value: false }] },
      ],
    },
    {
      name: 'Nod',
      entry: 'idle',
      states: { idle: { anim: aNodIdle }, nod: { anim: aNod, reset: true } },
      transitions: [
        { from: 'idle', to: 'nod', ms: 60, conds: [{ ref: R('nod'), type: 'trigger' }] },
        { from: 'nod', to: 'idle', ms: 120, exit: 100 },
      ],
    },
    { name: 'Ambient', entry: 'loop', states: { loop: { anim: aAmbient } }, transitions: [] },
  ]);
  const ab = artboard({ name: 'Reindeer', w: 250, h: 236, x: 440, y: 1000, component: true, vm, kids: [root], sm, anims: [aIdle, aWork, aNodIdle, aNod, aAmbient] });
  return { artboard: ab, vm, smId: sm.id, converters: [cHat.xml] };
}
