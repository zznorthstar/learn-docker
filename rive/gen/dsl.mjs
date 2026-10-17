/**
 * A tiny authoring DSL that emits RML (Rive Markup Language) for the `rive` CLI.
 *
 * Conventions that matter:
 *  - Rive paints the FIRST sibling on TOP. This DSL takes children BACK-TO-FRONT
 *    (like SVG/HTML) and reverses them when emitting, so scenes read naturally.
 *  - Every element that anything references gets an id from one document-wide
 *    counter, so ids can never collide.
 *  - Semantic logic stays outside Rive. The art only exposes view-model
 *    properties (see defineVM) that the app drives from the semantic world.
 */

let counter = 100;
export const nid = () => `0:${++counter}`;
export const resetIds = () => {
  counter = 100;
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export function attrs(o) {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => ` ${k}="${v === true ? 'true' : esc(typeof v === 'number' ? +v.toFixed(4) : v)}"`)
    .join('');
}

/* ----------------------------------------------------------------- colours */

/** '#rrggbb' + alpha -> 'AARRGGBB' */
export function col(hex, a = 1) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase() + full.toUpperCase();
}

/* ------------------------------------------------------------------ binding */

/** a reference to a view-model property: path string + the type it carries */
export function ref(path, type) {
  return { path, type };
}

const BIND_KEYS = { numberProp: 636, boolProp: 634, triggerProp: 686 };

/** <DataBindContext> to nest inside the element it drives */
export function bindCtx(r, propertyKey, conv) {
  return `<DataBindContext sourcePathIds="${r.path}" propertyKey="${propertyKey}"${conv ? ` converterId="${conv}"` : ''}/>`;
}

/* ------------------------------------------------------------------- paints */

export const fill = (color, o = {}) => ({ kind: 'fill', color, ...o });
export const stroke = (color, thickness, o = {}) => ({ kind: 'stroke', color, thickness, ...o });
export const lin = (x1, y1, x2, y2, stops) => ({ lin: { x1, y1, x2, y2, stops } });
export const rad = (cx, cy, r, stops) => ({ rad: { cx, cy, r, stops } });

const norm = (c) => (typeof c === 'string' && c.startsWith('#') ? col(c) : c);

function colorXml(c) {
  if (typeof c === 'string') return `<SolidColor colorValue="${norm(c)}"/>`;
  if (c.solid) return `<SolidColor colorValue="${c.solid}"${c.id ? ` id="${c.id}"` : ''}/>`;
  if (c.bind) return `<SolidColor colorValue="${c.value ?? 'FFFFFFFF'}">${bindCtx(c.bind, 37)}</SolidColor>`;
  const stops = (g) => g.stops.map(([p, k]) => `<GradientStop colorValue="${norm(k)}" position="${p}"/>`).join('');
  if (c.lin) return `<LinearGradient startX="${c.lin.x1}" startY="${c.lin.y1}" endX="${c.lin.x2}" endY="${c.lin.y2}">${stops(c.lin)}</LinearGradient>`;
  if (c.rad) return `<RadialGradient startX="${c.rad.cx}" startY="${c.rad.cy}" endX="${c.rad.cx + c.rad.r}" endY="${c.rad.cy}">${stops(c.rad)}</RadialGradient>`;
  throw new Error('bad colour ' + JSON.stringify(c));
}

function paintXml(p) {
  if (process.env.RIVE_NOFEATHER && p.feather) p = { ...p, feather: 0 };
  if (p.kind === 'fill') {
    const feather = p.feather ? `<Feather strength="${p.feather}"${p.fx ? ` offsetX="${p.fx}"` : ''}${p.fy ? ` offsetY="${p.fy}"` : ''}/>` : '';
    return `<Fill${attrs({ fillRule: p.feather ? 'clockwise' : p.rule, blendModeValue: p.blend })}>${colorXml(p.color)}${feather}</Fill>`;
  }
  const dash = p.dash ? `<DashPath>${p.dash.map((d) => `<Dash length="${d}"/>`).join('')}</DashPath>` : '';
  const trim = p.trim
    ? `<TrimPath id="${p.trim.id ?? ''}" start="${p.trim.start ?? 0}" end="${p.trim.end ?? 1}" offset="${p.trim.offset ?? 0}">${(p.trim.binds ?? []).join('')}</TrimPath>`.replace(' id=""', '')
    : '';
  const feather = p.feather ? `<Feather strength="${p.feather}"/>` : '';
  return `<Stroke${attrs({ thickness: p.thickness, cap: p.cap ?? 'round', join: p.join ?? 'round', blendModeValue: p.blend })}>${colorXml(p.color)}${dash}${trim}${feather}</Stroke>`;
}

/* ---------------------------------------------------------------- geometry */

export const rect = (w, h, o = {}) => ({ t: 'Rectangle', w, h, r: o.r ?? 0, ox: o.ox ?? 0.5, oy: o.oy ?? 0.5, x: o.x, y: o.y, binds: o.binds });
export const ell = (w, h, o = {}) => ({ t: 'Ellipse', w, h, ox: o.ox ?? 0.5, oy: o.oy ?? 0.5, x: o.x, y: o.y, binds: o.binds });
export const tri = (w, h, o = {}) => ({ t: 'Triangle', w, h, ox: o.ox ?? 0.5, oy: o.oy ?? 0.5, x: o.x });
export const star = (w, h, points, inner, o = {}) => ({ t: 'Star', w, h, points, inner, ox: 0.5, oy: 0.5, x: o.x, y: o.y });

/** corner-point polyline; `radius` rounds the corners */
export const poly = (pts, o = {}) => ({ t: 'poly', pts, closed: o.closed ?? true, radius: o.radius ?? 0 });

/**
 * A smooth curve through points (Catmull-Rom style handles).
 * A point can be [x, y, 'c'] to force a sharp corner.
 */
export const smooth = (pts, o = {}) => ({ t: 'smooth', pts, closed: o.closed ?? true, k: o.k ?? 0.33 });

function geomXml(g) {
  const b = (g.binds ?? []).join('');
  switch (g.t) {
    case 'Rectangle': {
      const r = g.r ? ` cornerRadiusTL="${g.r}"` : '';
      return `<Rectangle width="${g.w}" height="${g.h}" originX="${g.ox}" originY="${g.oy}"${r}${g.x !== undefined ? ` x="${g.x}"` : ''}${g.y !== undefined ? ` y="${g.y}"` : ''}>${b}</Rectangle>`;
    }
    case 'Ellipse':
      return `<Ellipse width="${g.w}" height="${g.h}" originX="${g.ox}" originY="${g.oy}"${g.x !== undefined ? ` x="${g.x}"` : ''}${g.y !== undefined ? ` y="${g.y}"` : ''}>${b}</Ellipse>`;
    case 'Triangle':
      return `<Triangle width="${g.w}" height="${g.h}" originX="${g.ox}" originY="${g.oy}"${g.x !== undefined ? ` x="${g.x}"` : ''}/>`;
    case 'Star':
      return `<Star width="${g.w}" height="${g.h}" points="${g.points}" innerRadius="${g.inner}" originX="0.5" originY="0.5"${g.x !== undefined ? ` x="${g.x}"` : ''}${g.y !== undefined ? ` y="${g.y}"` : ''}/>`;
    case 'poly': {
      // clockwise detection via signed area (screen coords: y down)
      let a = 0;
      g.pts.forEach((p, i) => {
        const q = g.pts[(i + 1) % g.pts.length];
        a += p[0] * q[1] - q[0] * p[1];
      });
      const cw = a > 0;
      return `<PointsPath isClosed="${g.closed}" isClockwise="${cw}">${g.pts.map((p) => `<StraightVertex x="${p[0]}" y="${p[1]}"${g.radius ? ` radius="${g.radius}"` : ''}/>`).join('')}</PointsPath>`;
    }
    case 'smooth': {
      const n = g.pts.length;
      let a = 0;
      g.pts.forEach((p, i) => {
        const q = g.pts[(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
      });
      const cw = a > 0;
      const vs = g.pts.map((p, i) => {
        if (p[2] === 'c') return `<StraightVertex x="${p[0]}" y="${p[1]}"/>`;
        const prev = g.pts[g.closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
        const next = g.pts[g.closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
        const tx = next[0] - prev[0];
        const ty = next[1] - prev[1];
        const ang = Math.atan2(ty, tx);
        const dOut = Math.hypot(next[0] - p[0], next[1] - p[1]) * g.k;
        const dIn = Math.hypot(p[0] - prev[0], p[1] - prev[1]) * g.k;
        return `<CubicDetachedVertex x="${p[0]}" y="${p[1]}" inRotation="${(ang + Math.PI).toFixed(4)}" inDistance="${dIn.toFixed(2)}" outRotation="${ang.toFixed(4)}" outDistance="${dOut.toFixed(2)}"/>`;
      });
      return `<PointsPath isClosed="${g.closed}" isClockwise="${cw}">${vs.join('')}</PointsPath>`;
    }
    default:
      throw new Error('geometry ' + g.t);
  }
}

/* ---------------------------------------------------------------- elements */

/**
 * Elements are { id, xml, name }. `kids` is back-to-front; emitted front-to-back.
 */
const tx = (o) => ({ x: o.x, y: o.y, rotation: o.rot, scaleX: o.sx ?? o.s, scaleY: o.sy ?? o.s, opacity: o.op });

export function node(name, o = {}, kids = []) {
  const id = o.id ?? nid();
  const binds = (o.binds ?? []).join('');
  const xml = `<Node${attrs({ ...tx(o), name, id })}>${binds}${[...kids].reverse().map((k) => k.xml).join('')}</Node>`;
  return { id, name, xml };
}

export function shape(name, o, geoms, paints) {
  const id = o.id ?? nid();
  const gs = (Array.isArray(geoms) ? geoms : [geoms]).map(geomXml).join('');
  const ps = (Array.isArray(paints) ? paints : [paints]).map(paintXml).join('');
  const binds = (o.binds ?? []).join('');
  const clip = o.clip ? `<ClippingShape sourceId="${o.clip}"/>` : '';
  const xml = `<Shape${attrs({ ...tx(o), blendModeValue: o.blend, name, id })}>${binds}${gs}${ps}${clip}</Shape>`;
  return { id, name, xml };
}

/** nested component placement bound to a nested view model property of the host VM */
export function nested(name, artboardId, o) {
  const id = o.id ?? nid();
  const xml = `<NestedArtboard${attrs({ artboardId, dataBindPathIds: o.vmPath, x: o.x, y: o.y, scaleX: o.sx ?? o.s, scaleY: o.sy ?? o.s, rotation: o.rot, opacity: o.op, name, id })}><NestedStateMachine animationId="${o.smId}" name="SM"/></NestedArtboard>`;
  return { id, name, xml };
}

export const raw = (xml, id) => ({ id, name: 'raw', xml });

/* ------------------------------------------------------------- animations */

export const EASE = {
  linear: null,
  inOut: [0.42, 0, 0.58, 1],
  out: [0, 0, 0.58, 1],
  in: [0.42, 0, 1, 1],
  back: [0.34, 1.56, 0.64, 1],
  soft: [0.25, 0.1, 0.25, 1],
};

const COLOR_PROPS = new Set(['colorValue']);

function kfXml(prop, [frame, value, ease]) {
  const isColor = COLOR_PROPS.has(prop);
  const el = isColor ? 'KeyFrameColor' : 'KeyFrameDouble';
  if (ease === 'hold') return `<${el} value="${value}" frame="${frame}" interpolationType="hold"/>`;
  const curve = typeof ease === 'string' ? EASE[ease] : ease;
  if (!curve) return `<${el} value="${value}" frame="${frame}" interpolationType="linear"/>`;
  return `<${el} value="${value}" frame="${frame}" interpolationType="cubic"><CubicEaseInterpolator x1="${curve[0]}" y1="${curve[1]}" x2="${curve[2]}" y2="${curve[3]}"/></${el}>`;
}

/**
 * keys: [{ obj: element | id, prop: 'rotation', kf: [[frame, value, ease?], ...] }]
 * Several entries for the same object are merged into one KeyedObject.
 */
export function anim(name, { frames, loop = 'oneShot', keys, fps = 60, speed }) {
  const id = nid();
  const byObj = new Map();
  for (const k of keys) {
    const oid = typeof k.obj === 'string' ? k.obj : k.obj.id;
    if (!byObj.has(oid)) byObj.set(oid, []);
    byObj.get(oid).push(k);
  }
  const body = [...byObj.entries()]
    .map(([oid, ks]) => `<KeyedObject objectId="${oid}">${ks.map((k) => `<KeyedProperty property="${k.prop}">${k.kf.map((f) => kfXml(k.prop, f)).join('')}</KeyedProperty>`).join('')}</KeyedObject>`)
    .join('');
  return { id, name, xml: `<LinearAnimation${attrs({ loopValue: loop, duration: frames, fps: fps === 60 ? undefined : fps, speed, name, id })}>${body}</LinearAnimation>` };
}

/* ---------------------------------------------------- view models & binding */

/**
 * defineVM('Cargo', [{name, type:'number'|'bool'|'color'|'trigger'|'vm', def, vm?}])
 * -> { id, name, ref(name) , xml(instances) }
 */
export function defineVM(name, props) {
  const id = nid();
  const defInstance = nid();
  const list = props.map((p) => ({ ...p, id: nid() }));
  const map = Object.fromEntries(list.map((p) => [p.name, p]));
  return {
    id,
    name,
    defInstance,
    props: list,
    /** path to a property when the artboard is bound to this VM directly */
    ref(prop) {
      const p = map[prop];
      if (!p) throw new Error(`VM ${name} has no property ${prop}`);
      return ref(`${id}-${p.id}`, p.type);
    },
    /** path from a HOST vm through a nested vm property */
    refVia(hostVm, nestedProp, prop) {
      const nestedId = hostVm.props.find((x) => x.name === nestedProp)?.id;
      if (!nestedId) throw new Error(`${hostVm.name} has no nested ${nestedProp}`);
      return ref(`${hostVm.id}-${nestedId}-${map[prop].id}`, map[prop].type);
    },
    emit(instances = [], defaults = {}) {
      const propXml = list
        .map((p) => {
          switch (p.type) {
            case 'number':
              return `<ViewModelPropertyNumber name="${p.name}" id="${p.id}"/>`;
            case 'bool':
              return `<ViewModelPropertyBoolean name="${p.name}" id="${p.id}"/>`;
            case 'color':
              return `<ViewModelPropertyColor name="${p.name}" id="${p.id}"/>`;
            case 'trigger':
              return `<ViewModelPropertyTrigger name="${p.name}" id="${p.id}"/>`;
            case 'vm':
              return `<ViewModelPropertyViewModel viewModelReferenceId="${p.vm.id}" name="${p.name}" id="${p.id}"/>`;
            default:
              throw new Error('prop type ' + p.type);
          }
        })
        .join('');
      const inst = (iname, iid, vals = {}) => {
        const vx = list
          .map((p) => {
            const v = vals[p.name] ?? p.def;
            switch (p.type) {
              case 'number':
                return `<ViewModelInstanceNumber propertyValue="${v ?? 0}" viewModelPropertyId="${p.id}"/>`;
              case 'bool':
                return `<ViewModelInstanceBoolean propertyValue="${v ? 'true' : 'false'}" viewModelPropertyId="${p.id}"/>`;
              case 'color':
                return `<ViewModelInstanceColor propertyValue="${v ?? 'FFFFFFFF'}" viewModelPropertyId="${p.id}"/>`;
              case 'trigger':
                return `<ViewModelInstanceTrigger viewModelPropertyId="${p.id}"/>`;
              case 'vm':
                return `<ViewModelInstanceViewModel propertyValue="${vals[p.name]}" viewModelPropertyId="${p.id}"/>`;
              default:
                return '';
            }
          })
          .join('');
        return `<ViewModelInstance exports="true" name="${iname}" id="${iid}">${vx}</ViewModelInstance>`;
      };
      const insts = [inst('Default', defInstance, defaults), ...instances.map((i) => inst(i.name, i.id, i.values))].join('');
      return `<ViewModel defaultInstanceId="${defInstance}" name="${name}" id="${id}">${propXml}${insts}</ViewModel>`;
    },
  };
}

/* ---------------------------------------------------------------- converters */

/** linear remap of a bound number, e.g. reveal 0..1 -> shell opacity 1..0 */
export function rangeMap(name, inMin, inMax, outMin, outMax) {
  const id = nid();
  return { id, xml: `<DataConverterRangeMapper minInput="${inMin}" maxInput="${inMax}" minOutput="${outMin}" maxOutput="${outMax}" clampLower="true" clampUpper="true" name="${name}" id="${id}"/>` };
}

/* ------------------------------------------------------------ state machines */

function cmp(c) {
  const r = c.ref;
  if (c.type === 'trigger' || r.type === 'trigger') {
    return `<TransitionViewModelCondition><TransitionPropertyViewModelComparator><BindablePropertyTrigger>${bindCtx(r, BIND_KEYS.triggerProp)}</BindablePropertyTrigger></TransitionPropertyViewModelComparator><TransitionValueTriggerComparator/></TransitionViewModelCondition>`;
  }
  if (r.type === 'bool') {
    return `<TransitionViewModelCondition><TransitionPropertyViewModelComparator><BindablePropertyBoolean>${bindCtx(r, BIND_KEYS.boolProp)}</BindablePropertyBoolean></TransitionPropertyViewModelComparator><TransitionValueBooleanComparator value="${c.value ? 'true' : 'false'}"/></TransitionViewModelCondition>`;
  }
  const op = c.op ?? 'equal';
  return `<TransitionViewModelCondition opValue="${op}"><TransitionPropertyViewModelComparator><BindablePropertyNumber>${bindCtx(r, BIND_KEYS.numberProp)}</BindablePropertyNumber></TransitionPropertyViewModelComparator><TransitionValueNumberComparator value="${c.value}"/></TransitionViewModelCondition>`;
}

/**
 * layers: [{ name, entry: 'key', states: { key: { anim, speed?, reset? } },
 *            transitions: [{ from, to, ms?, conds?: [{ref, value, op?}], exit?: percent }] }]
 */
export function stateMachine(name, layers) {
  const id = nid();
  const lx = layers
    .map((L) => {
      const lid = nid();
      const sid = Object.fromEntries(Object.keys(L.states).map((k) => [k, nid()]));
      const keys = Object.keys(L.states);
      const outgoing = (key) =>
        L.transitions
          .filter((t) => t.from === key)
          .map((t) => {
            const flags = t.exit !== undefined ? ` enableExitTime="true" exitTimeIsPercetange="true" exitTime="${t.exit}"` : '';
            return `<StateTransition stateToId="${sid[t.to]}" duration="${t.ms ?? 200}"${flags}>${(t.conds ?? []).map(cmp).join('')}</StateTransition>`;
          })
          .join('');
      const states = keys
        .map((k, i) => {
          const s = L.states[k];
          return `<AnimationState animationId="${s.anim.id}"${attrs({ speed: s.speed, reset: s.reset })} x="${200 + i * 220}" y="${(i % 2) * 140}" id="${sid[k]}">${outgoing(k)}</AnimationState>`;
        })
        .join('');
      return `<StateMachineLayer name="${L.name}" id="${lid}"><AnyState x="200" y="-160"/><ExitState x="420" y="-160"/><EntryState x="0" y="0"><StateTransition stateToId="${sid[L.entry]}"/></EntryState>${states}</StateMachineLayer>`;
    })
    .join('');
  return { id, name, xml: `<StateMachine name="${name}" id="${id}">${lx}</StateMachine>` };
}

/* ----------------------------------------------------------------- artboards */

/**
 * artboard({ name, w, h, x, y, component, vm, bg, kids, sm, anims })
 * kids: back-to-front elements. anims: animation elements (must be declared AFTER the state machine).
 */
export function artboard(o) {
  const id = o.id ?? nid();
  const styleId = nid();
  const bg = o.bg ? `<Fill name="bg"><SolidColor colorValue="${o.bg}"/></Fill>` : '';
  const body = [...o.kids].reverse().map((k) => k.xml).join('');
  const xml = `<Artboard${attrs({ isComponent: o.component, defaultStateMachineId: o.sm?.id, viewModelId: o.vm?.id, viewModelInstanceId: o.vm?.defInstance, styleId, width: o.w, height: o.h, x: o.x, y: o.y, name: o.name, id })}><LayoutComponentStyle name="${o.name} Style" id="${styleId}"/>${bg}${body}${o.sm ? o.sm.xml : ''}${(o.anims ?? []).map((a) => a.xml).join('')}</Artboard>`;
  const asset = o.component ? `<ComponentAsset artboardId="${id}" name="${o.name}"/>` : '';
  return { id, name: o.name, xml, asset };
}

export function document(parts) {
  return `<Rive version="1" kind="fragment">\n${parts.join('\n')}\n</Rive>\n`;
}

/* --------------------------------------------------------------------- misc */

/** n deterministic pseudo-random numbers in [0,1) from a seed */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}
