import { anim, artboard, bindCtx, col, defineVM, ell, fill, lin, nid, node, poly, rad, rangeMap, rect, shape, smooth, stateMachine, stroke, tri } from './dsl.mjs';
import pal from '../../shared/palette.json' with { type: 'json' };

/**
 * Cargo: one reusable shipping-container component. It is NOT the container's
 * semantic model; it is the visual performance of one. The app writes the
 * view-model properties below from semantic state; nothing Docker-specific
 * lives in the state machine.
 *
 * status: 0 created · 1 running · 2 exited · 3 failed (OOM/crash) · 4 paused · 5 running but unhealthy
 * reveal: 0 = shipping box ... 1 = the truth (process + namespaces + cgroup)
 */
export function buildCargo() {
  const vm = defineVM('Cargo', [
    { name: 'occupied', type: 'bool', def: false },
    { name: 'status', type: 'number', def: 0 },
    { name: 'hover', type: 'bool', def: false },
    { name: 'selected', type: 'bool', def: false },
    { name: 'reveal', type: 'number', def: 0 },
    { name: 'pressure', type: 'number', def: 0 },
    { name: 'hasVolume', type: 'number', def: 0 },
    { name: 'published', type: 'number', def: 0 },
    { name: 'networked', type: 'number', def: 0 },
    { name: 'tint', type: 'color', def: 'FF4A7BD0' },
    { name: 'pulse', type: 'trigger' },
  ]);
  const R = (p) => vm.ref(p);

  /* converters */
  const cShell = rangeMap('reveal→shell', 0, 0.8, 1, 0);
  const cCore = rangeMap('reveal→core', 0.3, 1, 0, 1);
  const cRed = rangeMap('pressure→redGauge', 0.75, 1, 0.75, 1);
  const cGhost = rangeMap('reveal→ghost', 0.1, 0.9, 0, 1);

  const W = 124;
  const H = 66;
  const cy = -H / 2; // core centre

  /* ---- ids we animate ---- */
  const lampColorId = nid();
  const ids = {
    root: nid(),
    lift: nid(),
    bob: nid(),
    halo: nid(),
    lampGlow: nid(),
    crack: nid(),
    scorch: nid(),
    dim: nid(),
    frost: nid(),
    smoke: nid(),
    flash: nid(),
    ringA: nid(),
    ringB: nid(),
    ringC: nid(),
    arcs: nid(),
    smoke1: nid(),
    smoke2: nid(),
    smoke3: nid(),
  };

  const shellX = -W / 2;
  const ribs = [];
  for (let i = 0; i < 9; i++) ribs.push(rect(3, H - 14, { x: -52 + i * 13, y: -H / 2, oy: 0.5 }));

  /* ---- the shipping-box shell (dissolves with reveal) ---- */
  // the tint is a bound colour: build that shape explicitly
  const tintShape = shape('shell tint', {}, rect(W, H, { oy: 1, r: 4 }), fill({ bind: R('tint'), value: 'FF4A7BD0' }));
  const shellKids = [
    tintShape,
    shape('shell sheen', {}, rect(W, H, { oy: 1, r: 4 }), fill(lin(0, -H, 0, 0, [[0, col('#ffffff', 0.22)], [0.5, col('#ffffff', 0)], [1, col('#000000', 0.22)]]))),
    shape('ribs', {}, ribs.map((r) => ({ ...r, oy: 0.5 })), fill(col('#000000', 0.17))),
    shape('top rail', {}, rect(W, 6, { oy: 1, y: -H + 6 }), fill(col('#000000', 0.32))),
    shape('bottom rail', {}, rect(W, 6, { oy: 1, y: 0 }), fill(col('#000000', 0.38))),
    shape('posts', {}, [rect(9, H, { x: -W / 2 + 4.5, oy: 1 }), rect(9, H, { x: W / 2 - 4.5, oy: 1 })], fill(col('#000000', 0.34))),
    shape('door seam', {}, [rect(2, H - 14, { x: 40, y: -H / 2 }), rect(2, H - 14, { x: 46, y: -H / 2 })], fill(col('#000000', 0.5))),
    shape('lock bars', {}, [rect(2, 30, { x: 36, y: -H / 2 }), rect(2, 30, { x: 50, y: -H / 2 })], fill(col('#d8dee9', 0.55))),
    shape('plate', {}, rect(26, 12, { x: -34, y: -H + 18, r: 2 }), fill(col('#ffffff', 0.55))),
    shape('plate marks', {}, [rect(16, 2, { x: -34, y: -H + 15 }), rect(10, 2, { x: -37, y: -H + 21 })], fill(col('#0b0f17', 0.55))),
    shape('outline', {}, rect(W, H, { oy: 1, r: 4 }), stroke(col('#0b0f17', 0.9), 3)),
  ];
  const shellGroup = node('shell group', { binds: [bindCtx(R('reveal'), 18, cShell.id)] }, shellKids);

  /* ---- reveal: ghost outline + process core ---- */
  const ghost = shape('ghost outline', { binds: [bindCtx(R('reveal'), 18, cGhost.id)] }, rect(W, H, { oy: 1, r: 4 }), stroke(col('#9ad1ff', 0.85), 2, { dash: [8, 6] }));

  const coreKids = [
    shape('core glow', {}, ell(70, 70, { y: cy }), fill(rad(0, cy, 35, [[0, col('#ffd166', 0.55)], [1, col('#ffd166', 0)]]), { blend: 'additive' })),
    shape('gauge track', {}, ell(58, 58, { y: cy }), stroke(col('#ffffff', 0.14), 4)),
    shape('gauge', {}, ell(58, 58, { y: cy }), stroke(col(pal.resource), 4, { cap: 'butt', trim: { start: 0, end: 0, binds: [bindCtx(R('pressure'), 115)] } })),
    shape('gauge hot', { rot: -Math.PI / 2 * 0 }, ell(58, 58, { y: cy }), stroke(col(pal.failure), 5, { cap: 'butt', trim: { start: 0.75, end: 0.75, binds: [bindCtx(R('pressure'), 115, cRed.id)] } })),
    node('ring A', { id: ids.ringA, y: cy }, [shape('ring A', {}, ell(34, 34), stroke(col(pal.kernel, 0.95), 2, { dash: [7, 5] }))]),
    node('ring B', { id: ids.ringB, y: cy }, [shape('ring B', {}, ell(46, 46), stroke(col(pal.kernel, 0.7), 2, { dash: [3, 7] }))]),
    node('ring C', { id: ids.ringC, y: cy }, [shape('ring C', {}, ell(22, 22), stroke(col(pal.kernel, 0.9), 1.5, { dash: [4, 4] }))]),
    shape('pip', {}, ell(14, 14, { y: cy }), fill(rad(0, cy, 7, [[0, 'FFFFF3C4'], [1, col('#ffb454')]]))),
  ];
  const core = node('core', { binds: [bindCtx(R('reveal'), 18, cCore.id)] }, coreKids);

  /* ---- state decorations ---- */
  const lamp = node('lamp', { x: 46, y: -H + 8 }, [
    shape('lamp glow', { id: ids.lampGlow, op: 0 }, ell(22, 22), fill(rad(0, 0, 11, [[0, col('#ffffff', 0.8)], [1, col('#ffffff', 0)]]), { blend: 'additive' })),
    shape('lamp', {}, ell(9, 9), [fill({ solid: col('#c9a227'), id: lampColorId }), stroke(col('#0b0f17', 0.8), 1.5)]),
  ]);
  const crack = shape(
    'cracks',
    { id: ids.crack, op: 0 },
    [poly([[-10, -H], [-2, -48], [-14, -38], [-4, -26], [-16, -14], [-8, 0]], { closed: false }), poly([[-2, -48], [14, -44], [6, -34]], { closed: false }), poly([[-14, -38], [-30, -40]], { closed: false })],
    stroke(col(pal.failure), 2.5, { join: 'miter', cap: 'butt' }),
  );
  const scorch = shape('scorch', { id: ids.scorch, op: 0 }, rect(W, H, { oy: 1, r: 4 }), fill(lin(0, -H, 0, 0, [[0, col('#1a0505', 0.2)], [1, col('#1a0505', 0.7)]])));
  const dim = shape('dim', { id: ids.dim, op: 0 }, rect(W, H, { oy: 1, r: 4 }), fill(col('#0b0f17', 0.52)));
  const frost = node('frost', { id: ids.frost, op: 0 }, [
    shape('frost sheet', {}, rect(W, H, { oy: 1, r: 4 }), fill(col('#bfe9ff', 0.38))),
    shape('frost lines', {}, [poly([[-50, -20], [-30, -34], [-12, -22]], { closed: false }), poly([[10, -46], [30, -30], [52, -42]], { closed: false })], stroke(col('#ffffff', 0.7), 2)),
  ]);
  const smoke = node('smoke', { id: ids.smoke, op: 0 }, [
    shape('smoke 1', { id: ids.smoke1, x: -14, y: -H - 4 }, ell(14, 14), fill(col('#9aa0ad', 0.55))),
    shape('smoke 2', { id: ids.smoke2, x: 6, y: -H - 4 }, ell(18, 18), fill(col('#7b8190', 0.5))),
    shape('smoke 3', { id: ids.smoke3, x: 24, y: -H - 4 }, ell(12, 12), fill(col('#9aa0ad', 0.5))),
  ]);

  /* ---- attachments: volume strap, gangplank, antenna ---- */
  const strap = node('strap', { binds: [bindCtx(R('hasVolume'), 18)] }, [
    shape('strap band', { x: -18 }, rect(13, H + 8, { oy: 1, y: 3 }), fill(col(pal.storage))),
    shape('strap stitch', { x: -18 }, [rect(1.5, H + 4, { x: -3.5, oy: 1, y: 1 }), rect(1.5, H + 4, { x: 3.5, oy: 1, y: 1 })], fill(col('#7a3d00', 0.55))),
    shape('buckle', { x: -18, y: -H / 2 }, rect(14, 10, { r: 2 }), [fill(col('#ffe9a8')), stroke(col('#7a3d00', 0.8), 1.5)]),
  ]);
  const plank = node('gangplank', { binds: [bindCtx(R('published'), 18)] }, [
    shape('plank', {}, poly([[34, -2], [46, -9], [76, 15], [66, 22]]), [fill(col('#b9814b')), stroke(col('#3b240f', 0.9), 2)]),
    shape('plank slats', {}, [poly([[44, -2], [48, 2]], { closed: false }), poly([[54, 6], [58, 10]], { closed: false }), poly([[63, 12], [67, 16]], { closed: false })], stroke(col('#3b240f', 0.7), 2)),
    shape('gate', { x: 78, y: 19 }, ell(16, 16), [fill(col(pal.network)), stroke(col('#0b0f17', 0.9), 2)]),
    shape('gate pip', { x: 78, y: 19 }, ell(5, 5), fill(col('#ffffff', 0.9))),
  ]);
  const antenna = node('antenna', { binds: [bindCtx(R('networked'), 18)] }, [
    shape('mast', { x: -50, y: -H }, rect(2.5, 15, { oy: 1 }), fill(col('#cfd6e4'))),
    shape('mast tip', { x: -50, y: -H - 16 }, ell(6, 6), fill(col(pal.network))),
    node('signal arcs', { id: ids.arcs, x: -50, y: -H - 16 }, [
      shape('arc 1', {}, ell(14, 14), stroke(col(pal.network, 0.9), 2, { trim: { start: 0.62, end: 0.88 } })),
      shape('arc 2', {}, ell(24, 24), stroke(col(pal.network, 0.65), 2, { trim: { start: 0.64, end: 0.86 } })),
      shape('arc 3', {}, ell(34, 34), stroke(col(pal.network, 0.4), 2, { trim: { start: 0.65, end: 0.85 } })),
    ]),
  ]);

  const halo = shape('halo', { id: ids.halo, op: 0, y: 4 }, ell(180, 46), fill(rad(0, 0, 90, [[0, col(pal.lantern, 0.7)], [1, col(pal.lantern, 0)]]), { blend: 'additive' }));
  const shadow = shape('shadow', { y: 2 }, ell(136, 15), fill(col('#000000', 0.38)));
  const flash = shape('flash', { id: ids.flash, op: 0 }, rect(W + 8, H + 8, { oy: 1, r: 6 }), fill(col('#ffffff', 0.85), { blend: 'screen' }));

  const content = node('content', { id: ids.bob }, [
    shellGroup,
    strap,
    ghost,
    core,
    scorch,
    crack,
    dim,
    frost,
    smoke,
    lamp,
    antenna,
    plank,
    flash,
  ]);
  const lift = node('lift', { id: ids.lift }, [shadow, content]);
  const root = node('root', { id: ids.root, x: 90, y: 104 }, [halo, lift]);

  /* ---- animations ---- */
  const hold = (name, keys) => anim(name, { frames: 1, loop: 'oneShot', keys });
  const rootKeys = (s, op, y = 0) => [
    { obj: ids.root, prop: 'scaleX', kf: [[0, s]] },
    { obj: ids.root, prop: 'scaleY', kf: [[0, s]] },
    { obj: ids.root, prop: 'opacity', kf: [[0, op]] },
    { obj: ids.root, prop: 'y', kf: [[0, 104 + y]] },
  ];
  const aEmpty = hold('Empty', rootKeys(0.01, 0));
  const aPresent = hold('Present', rootKeys(1, 1));
  const aLand = anim('Land', {
    frames: 34,
    keys: [
      { obj: ids.root, prop: 'opacity', kf: [[0, 0], [5, 1, 'out']] },
      { obj: ids.root, prop: 'y', kf: [[0, 104 - 90], [26, 104, 'back'], [34, 104]] },
      { obj: ids.root, prop: 'scaleX', kf: [[0, 1.15], [26, 1, 'out']] },
      { obj: ids.root, prop: 'scaleY', kf: [[0, 0.9], [14, 1.08, 'out'], [30, 0.97], [34, 1]] },
    ],
  });

  const lampKeys = (color, glow, extra = []) => [
    { obj: lampColorId, prop: 'colorValue', kf: [[0, color]] },
    { obj: ids.lampGlow, prop: 'opacity', kf: [[0, glow]] },
    ...extra,
  ];
  const status = (name, o) =>
    anim(name, {
      frames: o.frames ?? 1,
      loop: o.loop ?? 'oneShot',
      keys: [
        ...lampKeys(o.lamp, o.glow ?? 0, o.lampExtra ?? []),
        { obj: ids.crack, prop: 'opacity', kf: [[0, o.crack ?? 0]] },
        { obj: ids.scorch, prop: 'opacity', kf: [[0, o.scorch ?? 0]] },
        { obj: ids.dim, prop: 'opacity', kf: [[0, o.dim ?? 0]] },
        { obj: ids.frost, prop: 'opacity', kf: [[0, o.frost ?? 0]] },
        { obj: ids.smoke, prop: 'opacity', kf: [[0, o.smoke ?? 0]] },
        ...(o.bob ?? []),
      ],
    });
  const aCreated = status('Created', { lamp: col('#c9a227'), glow: 0.15 });
  const aRunning = status('Running', {
    lamp: col('#5cff8a'),
    glow: 0.9,
    loop: 'loop',
    frames: 120,
    lampExtra: [],
    bob: [{ obj: ids.bob, prop: 'y', kf: [[0, 0], [60, -1.6, 'inOut'], [120, 0, 'inOut']] }],
  });
  // keep the lamp glow breathing while running
  aRunning.xml = aRunning.xml.replace(
    `<KeyedObject objectId="${ids.lampGlow}"><KeyedProperty property="opacity"><KeyFrameDouble value="0.9" frame="0" interpolationType="linear"/></KeyedProperty></KeyedObject>`,
    `<KeyedObject objectId="${ids.lampGlow}"><KeyedProperty property="opacity"><KeyFrameDouble value="0.55" frame="0" interpolationType="linear"/><KeyFrameDouble value="1" frame="60" interpolationType="cubic"><CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/></KeyFrameDouble><KeyFrameDouble value="0.55" frame="120" interpolationType="cubic"><CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/></KeyFrameDouble></KeyedProperty></KeyedObject>`,
  );
  const aExited = status('Exited', { lamp: col('#3a3f4a'), glow: 0, dim: 1 });
  const aFailed = status('Failed', {
    lamp: col(pal.failure),
    glow: 1,
    crack: 1,
    scorch: 1,
    smoke: 1,
    loop: 'loop',
    frames: 60,
    bob: [{ obj: ids.bob, prop: 'x', kf: [[0, 0], [6, 1.5], [12, -1.5], [18, 1], [24, 0], [60, 0]] }],
  });
  const aPaused = status('Paused', { lamp: col('#7cc7ff'), glow: 0.5, frost: 1 });
  const aWarn = status('Unhealthy', { lamp: col('#ffb454'), glow: 1, loop: 'loop', frames: 50, bob: [{ obj: ids.bob, prop: 'x', kf: [[0, 0], [25, 0.8, 'inOut'], [50, 0, 'inOut']] }] });

  const aIdleI = hold('IdleI', [
    { obj: ids.halo, prop: 'opacity', kf: [[0, 0]] },
    { obj: ids.lift, prop: 'y', kf: [[0, 0]] },
  ]);
  const aHover = hold('HoverI', [
    { obj: ids.halo, prop: 'opacity', kf: [[0, 0.55]] },
    { obj: ids.lift, prop: 'y', kf: [[0, -4]] },
  ]);
  const aSelected = anim('SelectedI', {
    frames: 90,
    loop: 'loop',
    keys: [
      { obj: ids.halo, prop: 'opacity', kf: [[0, 0.85], [45, 1, 'inOut'], [90, 0.85, 'inOut']] },
      { obj: ids.lift, prop: 'y', kf: [[0, -7]] },
    ],
  });

  const aPulseIdle = hold('PulseIdle', [{ obj: ids.flash, prop: 'opacity', kf: [[0, 0]] }]);
  const aPulse = anim('Pulse', { frames: 22, keys: [{ obj: ids.flash, prop: 'opacity', kf: [[0, 0], [4, 0.8, 'out'], [22, 0, 'in']] }] });

  const TAU = Math.PI * 2;
  const aAmbient = anim('Ambient', {
    frames: 240,
    loop: 'loop',
    keys: [
      { obj: ids.ringA, prop: 'rotation', kf: [[0, 0], [240, TAU]] },
      { obj: ids.ringB, prop: 'rotation', kf: [[0, 0], [240, -TAU]] },
      { obj: ids.ringC, prop: 'rotation', kf: [[0, 0], [240, TAU * 2]] },
      { obj: ids.arcs, prop: 'opacity', kf: [[0, 0.35], [60, 1, 'inOut'], [120, 0.35, 'inOut'], [180, 1, 'inOut'], [240, 0.35, 'inOut']] },
      { obj: ids.smoke1, prop: 'y', kf: [[0, -H - 4], [120, -H - 42], [121, -H - 4], [240, -H - 42]] },
      { obj: ids.smoke1, prop: 'opacity', kf: [[0, 0.8], [118, 0], [121, 0.8], [238, 0]] },
      { obj: ids.smoke2, prop: 'y', kf: [[0, -H - 24], [60, -H - 46], [61, -H - 4], [180, -H - 46], [181, -H - 4], [240, -H - 24]] },
      { obj: ids.smoke2, prop: 'opacity', kf: [[0, 0.5], [58, 0], [61, 0.8], [178, 0], [181, 0.8], [240, 0.5]] },
      { obj: ids.smoke3, prop: 'y', kf: [[0, -H - 14], [100, -H - 44], [101, -H - 4], [220, -H - 44], [221, -H - 4], [240, -H - 12]] },
      { obj: ids.smoke3, prop: 'opacity', kf: [[0, 0.6], [98, 0], [101, 0.8], [218, 0], [221, 0.8], [240, 0.6]] },
    ],
  });

  /* ---- state machine ---- */
  const S = R('status');
  const sIs = (n) => [{ ref: S, value: n }];
  const healthStates = { created: { anim: aCreated }, running: { anim: aRunning }, exited: { anim: aExited }, failed: { anim: aFailed }, paused: { anim: aPaused }, warn: { anim: aWarn } };
  const order = ['created', 'running', 'exited', 'failed', 'paused', 'warn'];
  const healthTrans = [];
  for (const from of order) for (const to of order) if (from !== to) healthTrans.push({ from, to, ms: to === 'failed' ? 60 : 260, conds: sIs(order.indexOf(to)) });

  const sm = stateMachine('Cargo SM', [
    {
      name: 'Presence',
      entry: 'empty',
      states: { empty: { anim: aEmpty }, land: { anim: aLand }, present: { anim: aPresent } },
      transitions: [
        { from: 'empty', to: 'land', ms: 0, conds: [{ ref: R('occupied'), value: true }] },
        { from: 'land', to: 'present', ms: 0, exit: 100 },
        { from: 'land', to: 'empty', ms: 120, conds: [{ ref: R('occupied'), value: false }] },
        { from: 'present', to: 'empty', ms: 240, conds: [{ ref: R('occupied'), value: false }] },
      ],
    },
    { name: 'Health', entry: 'created', states: healthStates, transitions: healthTrans },
    {
      name: 'Interaction',
      entry: 'idle',
      states: { idle: { anim: aIdleI }, hover: { anim: aHover }, selected: { anim: aSelected } },
      transitions: [
        { from: 'idle', to: 'selected', ms: 160, conds: [{ ref: R('selected'), value: true }] },
        { from: 'idle', to: 'hover', ms: 140, conds: [{ ref: R('hover'), value: true }] },
        { from: 'hover', to: 'selected', ms: 160, conds: [{ ref: R('selected'), value: true }] },
        { from: 'hover', to: 'idle', ms: 160, conds: [{ ref: R('hover'), value: false }] },
        { from: 'selected', to: 'idle', ms: 200, conds: [{ ref: R('selected'), value: false }] },
      ],
    },
    {
      name: 'Pulse',
      entry: 'idle',
      states: { idle: { anim: aPulseIdle }, flash: { anim: aPulse, reset: true } },
      transitions: [
        { from: 'idle', to: 'flash', ms: 0, conds: [{ ref: R('pulse'), type: 'trigger' }] },
        { from: 'flash', to: 'idle', ms: 0, exit: 100 },
      ],
    },
    { name: 'Ambient', entry: 'loop', states: { loop: { anim: aAmbient } }, transitions: [] },
  ]);

  const anims = [aEmpty, aPresent, aLand, aCreated, aRunning, aExited, aFailed, aPaused, aWarn, aIdleI, aHover, aSelected, aPulseIdle, aPulse, aAmbient];
  const ab = artboard({ name: 'Cargo', w: 180, h: 134, x: 0, y: 1000, component: true, vm, kids: [root], sm, anims });
  const converters = [cShell, cCore, cRed, cGhost].map((c) => c.xml);
  return { artboard: ab, vm, converters, smId: sm.id, size: { w: 180, h: 134, rootX: 90, rootY: 104 } };
}
