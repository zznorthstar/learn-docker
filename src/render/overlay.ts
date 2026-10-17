import type { Container, Level, Overlay, Target, ViewState, World, WorldEvent } from '../engine/types';
import { hostNet, kernelView, vethName } from '../engine/derive';
import { relations } from '../engine/inspect';
import { diskUsedMB, hostCpuPct, hostMemUsedMB } from '../engine/world';
import { fmtMB } from '../engine/util';
import { anchorOf, DECK_Y, LAYOUT, type Pt, type Scene } from './scene';
import { imageTint, networkColor, PAL } from './palette';

/**
 * The SVG overlay: everything that is about RELATIONSHIPS between things and
 * about the truth under the metaphor. Positions are in the 1600x900 artboard,
 * identical to the Rive scene, so the two layers always line up.
 *
 * Rule: one system = one colour (see palette). Labels change with the
 * abstraction level; the SAME object is named in the vocabulary of that level.
 */

export interface OverlayCtx {
  w: World;
  view: ViewState;
  scene: Scene;
  slotOf: Map<string, number>;
  /** events produced by the most recent timeline step */
  recent: WorldEvent[];
  hover: string | null;
  compact: boolean;
  showRequest: boolean;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const has = (v: ViewState, o: Overlay): boolean => v.overlays.includes(o);

function chip(x: number, y: number, text: string, o: { color?: string; size?: number; anchor?: 'start' | 'middle' | 'end'; strong?: boolean; bg?: string; cls?: string } = {}): string {
  const size = o.size ?? 22;
  const w = Math.max(28, text.length * size * 0.54 + 20);
  const anchor = o.anchor ?? 'middle';
  const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  const tx = x0 + w / 2;
  return `<g class="chip ${o.cls ?? ''}"><rect x="${x0.toFixed(1)}" y="${(y - size).toFixed(1)}" width="${w.toFixed(1)}" height="${(size + 9).toFixed(1)}" rx="${(size / 2 + 4).toFixed(1)}" fill="${o.bg ?? 'rgba(8,11,22,.82)'}" stroke="${o.color ?? 'rgba(255,255,255,.2)'}" stroke-width="1.6"/><text x="${tx.toFixed(1)}" y="${(y - 1).toFixed(1)}" text-anchor="middle" font-size="${size - 4}" fill="${o.strong ? '#fff' : '#e3e9f8'}" font-weight="${o.strong ? 700 : 500}">${esc(text)}</text></g>`;
}

function arrow(a: Pt, b: Pt, color: string, o: { dash?: string; label?: string; bend?: number; width?: number; opacity?: number } = {}): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 - (o.bend ?? 40);
  const d = `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  const ang = Math.atan2(b.y - my, b.x - mx);
  const ah = 11;
  const hx = b.x - Math.cos(ang) * 2;
  const hy = b.y - Math.sin(ang) * 2;
  const p1 = `${(hx - Math.cos(ang - 0.45) * ah).toFixed(1)},${(hy - Math.sin(ang - 0.45) * ah).toFixed(1)}`;
  const p2 = `${(hx - Math.cos(ang + 0.45) * ah).toFixed(1)},${(hy - Math.sin(ang + 0.45) * ah).toFixed(1)}`;
  const lab = o.label ? chip((a.x + b.x) / 2, (a.y + b.y) / 2 - (o.bend ?? 40) / 2 + 4, o.label, { color, size: 17 }) : '';
  return `<g opacity="${o.opacity ?? 0.95}"><path d="${d}" fill="none" stroke="${color}" stroke-width="${o.width ?? 3}" stroke-linecap="round" ${o.dash ? `stroke-dasharray="${o.dash}"` : ''}/><polygon points="${hx.toFixed(1)},${hy.toFixed(1)} ${p1} ${p2}" fill="${color}"/>${lab}</g>`;
}

const slotPt = (c: OverlayCtx, name: string): Pt | null => {
  const i = c.slotOf.get(name);
  if (i === undefined) return null;
  const s = LAYOUT.slots[i]!;
  return { x: s.x, y: s.y };
};

const stateWord = (c: Container): string => (c.state === 'exited' ? `exited ${c.exitCode}${c.oomKilled ? ' OOM' : ''}` : c.state === 'running' && c.health === 'unhealthy' ? 'unhealthy' : c.state);

const LEVEL_CREW: Record<Level, { santa: string; foreman: string; runner: string; whale: string; harbor: string; yard: string }> = {
  0: { santa: 'Santa', foreman: 'foreman reindeer', runner: 'runner reindeer', whale: 'the whale', harbor: 'the harbor', yard: 'the shipyard' },
  1: { santa: 'dockerd', foreman: 'containerd', runner: 'runc', whale: 'host', harbor: 'registry', yard: 'image build' },
  2: { santa: 'dockerd (API)', foreman: 'containerd', runner: 'runc', whale: 'host', harbor: 'registry', yard: 'BuildKit' },
  3: { santa: 'dockerd (pid)', foreman: 'containerd (pid)', runner: 'runc (leaves)', whale: 'Linux host: every box is a process', harbor: 'registry', yard: 'BuildKit' },
  4: { santa: 'dockerd', foreman: 'containerd', runner: 'runc', whale: 'ONE Linux kernel for everything', harbor: 'registry', yard: 'BuildKit' },
  5: { santa: 'dockerd', foreman: 'containerd', runner: 'runc (OCI runtime)', whale: 'host', harbor: 'registry (OCI dist.)', yard: 'build → OCI image' },
  6: { santa: 'dockerd', foreman: 'containerd', runner: 'runc', whale: 'a Kubernetes Node, a cloud VM…', harbor: 'registry', yard: 'CI/CD build' },
};

export function overlaySvg(c: OverlayCtx): string {
  const { w, view, scene } = c;
  const L = view.level;
  const parts: string[] = [];
  const A = LAYOUT.anchors;
  const names = LEVEL_CREW[L];

  /* ---------------- ecosystem (level 6) ---------------- */
  if (L >= 6) parts.push(ecosystem(c));

  /* ---------------- image rack under the whale ---------------- */
  for (const im of scene.images) {
    const img = w.images[im.ref]!;
    const users = Object.values(w.containers).filter((x) => x.imageId === img.id).length;
    const tint = imageTint(img.ref.split(':')[0]!);
    const sel = view.selected === `image:${im.ref}`;
    const stacks = Math.min(4, Math.max(1, Math.ceil(im.layers / 2)));
    const sheets = Array.from({ length: stacks }, (_, k) => `<rect x="${im.x - 31 + k * 3}" y="${im.y - 26 - k * 4}" width="62" height="42" rx="4" fill="${PAL.registry}" fill-opacity="${0.16 + k * 0.1}" stroke="${PAL.registry}" stroke-opacity=".55" stroke-width="1.5"/>`).join('');
    parts.push(`<g class="rack ${sel ? 'is-sel' : ''}"><path d="M${im.x},652 V${im.y - 26 - stacks * 4 + 2}" stroke="rgba(255,255,255,.22)" stroke-width="1.5" stroke-dasharray="3 4"/>${sheets}<rect x="${im.x - 22}" y="${im.y - 14}" width="44" height="4" rx="2" fill="${tint}" opacity=".9"/><rect x="${im.x - 22}" y="${im.y - 5}" width="30" height="3" rx="1.5" fill="#fff" opacity=".5"/><rect x="${im.x - 22}" y="${im.y + 2}" width="36" height="3" rx="1.5" fill="#fff" opacity=".35"/></g>`);
    const arch = img.arch !== w.host.arch;
    const repo = img.ref.split(':')[0]!;
    if (!c.compact) parts.push(chip(im.x, im.y + 40, `${repo.length > 11 ? repo.slice(0, 10) + '…' : repo}${arch ? ' ⚠' : ''}`, { size: 17, color: sel ? PAL.registry : undefined }));
    if (L >= 2 && !c.compact) parts.push(`<text x="${im.x}" y="${im.y + 62}" text-anchor="middle" font-size="14.5" fill="${PAL.registry}">${im.layers} layers${users ? ` · ${users}×` : ''}</text>`);
    if (L >= 4 && !c.compact) parts.push(`<text x="${im.x}" y="${im.y + 79}" text-anchor="middle" font-size="12.5" fill="${PAL.storage}">${img.layers.length ? img.layers[img.layers.length - 1]!.replace('sha256:', '').slice(0, 7) + '…' : ''}</text>`);
  }
  if (scene.images.length && !c.compact) parts.push(chip(520 - 46, 690, L === 0 ? 'blueprints' : 'images', { size: 15, anchor: 'end', color: PAL.registry }));

  /* ---------------- volumes (strapped cargo) ---------------- */
  for (const v of scene.volumes) {
    const vol = w.volumes[v.name]!;
    const sel = view.selected === `volume:${v.name}`;
    const relevant = has(view, 'storage') || sel || v.users.some((u) => view.selected === `container:${u}`);
    parts.push(`<g class="barrel ${sel ? 'is-sel' : ''}"><ellipse cx="${v.x}" cy="${v.y + 22}" rx="26" ry="8" fill="rgba(0,0,0,.35)"/><rect x="${v.x - 24}" y="${v.y - 22}" width="48" height="44" rx="10" fill="${PAL.storage}" fill-opacity=".28" stroke="${PAL.storage}" stroke-width="2.5"/><ellipse cx="${v.x}" cy="${v.y - 22}" rx="24" ry="8" fill="${PAL.storage}" fill-opacity=".55" stroke="${PAL.storage}" stroke-width="2"/><path d="M${v.x - 24},${v.y - 8} H${v.x + 24} M${v.x - 24},${v.y + 8} H${v.x + 24}" stroke="${PAL.storage}" stroke-width="2" opacity=".8"/></g>`);
    if (!c.compact) parts.push(chip(v.x, v.y + 50, `${v.name}${L >= 1 ? ` · ${vol.items}` : ''}`, { size: 17, color: sel ? PAL.storage : undefined }));
    if (!v.users.length && !c.compact) parts.push(`<text x="${v.x}" y="${v.y + 72}" text-anchor="middle" font-size="14" fill="${PAL.storage}" opacity=".8">unattached</text>`);
    for (const u of v.users) {
      const sp = slotPt(c, u);
      if (!sp) continue;
      const bend = 90 + (sp.x % 40);
      const d = `M${v.x},${v.y - 30} C${v.x},${v.y - 120} ${sp.x},${sp.y + 120} ${sp.x - 18},${sp.y + 14}`;
      parts.push(`<path d="${d}" fill="none" stroke="${PAL.storage}" stroke-width="${relevant ? 4 : 2}" stroke-dasharray="${relevant ? '0' : '6 8'}" opacity="${relevant ? 0.9 : 0.35}" stroke-linecap="round"/>`);
      void bend;
    }
  }
  for (const b of scene.bindDirs) {
    parts.push(`<g><rect x="${b.x - 34}" y="${b.y - 16}" width="68" height="32" rx="5" fill="${PAL.storage}" fill-opacity=".14" stroke="${PAL.storage}" stroke-dasharray="5 5" stroke-width="2"/><text x="${b.x}" y="${b.y + 5}" text-anchor="middle" font-size="14" fill="${PAL.storage}">host dir</text></g>`);
    if (!c.compact) parts.push(chip(b.x, b.y + 42, b.path, { size: 15, color: PAL.storage }));
    for (const u of b.users) {
      const sp = slotPt(c, u);
      if (sp) parts.push(`<path d="M${b.x - 34},${b.y} C${b.x - 200},${b.y - 60} ${sp.x + 120},${sp.y + 140} ${sp.x + 14},${sp.y + 16}" fill="none" stroke="${PAL.storage}" stroke-width="2" stroke-dasharray="3 7" opacity=".5"/>`);
    }
  }

  /* ---------------- network lanes ---------------- */
  for (const lane of scene.lanes) {
    const col = lane.name === 'bridge' ? '#7fb8c4' : networkColor(lane.index);
    const net = w.networks[lane.name]!;
    const sel = view.selected === `network:${lane.name}`;
    const hot = has(view, 'network') || sel || L >= 4;
    const x1 = lane.x1 - 56;
    const x2 = lane.x2 + 56;
    parts.push(`<g class="lane ${sel ? 'is-sel' : ''}"><path d="M${x1},${lane.y} H${x2}" stroke="${col}" stroke-width="${sel ? 6 : 4}" stroke-linecap="round" opacity="${hot ? 1 : 0.75}" ${lane.name === 'bridge' ? 'stroke-dasharray="14 8"' : ''}/>`);
    for (const m of lane.members) parts.push(`<path d="M${m.x},${lane.y} V${DECK_Y - 62 - 12}" stroke="${col}" stroke-width="3" opacity=".8"/><circle cx="${m.x}" cy="${lane.y}" r="5.5" fill="${col}"/>`);
    parts.push('</g>');
    if (!c.compact) {
      const label = L === 0 ? `${lane.name === 'bridge' ? 'default line' : lane.name + ' line'}` : `${lane.name}${net.subnet ? ' ' + net.subnet : ''}${net.dns ? ' · DNS' : ''}`;
      parts.push(chip(x1 + 4, lane.y + 7, label, { anchor: 'end', size: 19, color: col }));
    }
    if (L >= 4 && has(view, 'network') && !c.compact) {
      const hn = hostNet(w).bridges.find((b) => b.network === lane.name);
      if (hn) parts.push(`<text x="${x2 + 12}" y="${lane.y + 6}" font-size="15" fill="${col}">${esc(hn.name)} (bridge) · ${hn.ports.length} veth</text>`);
    }
  }

  /* ---------------- containers: names, state, ports ---------------- */
  for (const s of scene.slots) {
    if (!s.name) continue;
    const ct = w.containers[s.name];
    if (!ct) continue;
    const sel = view.selected === `container:${s.name}`;
    const warn = ct.state === 'exited' && (ct.exitCode ?? 0) !== 0;
    const color = warn || ct.health === 'unhealthy' ? PAL.failure : ct.state === 'running' ? '#e8eefc' : '#9aa6bf';
    const short = s.name.length > 11 ? s.name.slice(0, 10) + '…' : s.name;
    if (!c.compact || sel) {
      parts.push(chip(s.x, DECK_Y + 46, short, { size: 18, strong: true, color: sel ? PAL.lantern : undefined }));
      if (!c.compact) {
        const stateShort = ct.state === 'exited' ? (ct.oomKilled ? 'OOM killed' : `exited ${ct.exitCode}`) : ct.state === 'running' && ct.health === 'unhealthy' ? 'unhealthy' : ct.state;
        let y = DECK_Y + 68;
        if (L >= 1) {
          const repo = ct.imageRef.split(':')[0]!;
          parts.push(`<text x="${s.x}" y="${y}" text-anchor="middle" font-size="15" fill="#9fb0d4">${esc(repo.length > 12 ? repo.slice(0, 11) + '…' : repo)}</text>`);
          y += 18;
        }
        parts.push(`<text x="${s.x}" y="${y}" text-anchor="middle" font-size="15.5" font-weight="600" fill="${color}">${esc(stateShort)}</text>`);
        y += 6;
        // gate label next to the gangplank
        const gate = ct.ports[0];
        if (gate) parts.push(chip(s.x + 74, DECK_Y + 30, `${L === 0 ? 'gate ' : ':'}${gate.host}${L >= 1 ? '→' + gate.container : ''}`, { size: 15, color: PAL.network, anchor: 'start' }));
        // level 3+: PID tag; level 4+: namespace letters and cgroup bar
        if (L >= 3 && ct.pid) {
          y += 20;
          parts.push(chip(s.x, y, `PID ${ct.pid}`, { size: 15, color: PAL.kernel }));
        }
        if ((L >= 4 || has(view, 'kernel')) && (ct.state === 'running' || ct.state === 'paused')) {
          const kv = kernelView(w, ct);
          const ns = kv.namespaces.filter((n) => !n.shared).map((n) => n.type[0]!.toUpperCase());
          y += 22;
          parts.push(chip(s.x, y, `ns ${ns.join('')}`, { size: 14.5, color: PAL.kernel }));
          const lim = ct.limits.memoryMB;
          const pct = Math.min(1, ct.usage.memMB / (lim ?? 512));
          y += 12;
          parts.push(`<rect x="${s.x - 40}" y="${y}" width="80" height="7" rx="3.5" fill="rgba(0,0,0,.55)" stroke="rgba(255,255,255,.2)"/><rect x="${s.x - 40}" y="${y}" width="${(80 * pct).toFixed(1)}" height="7" rx="3.5" fill="${pct > 0.85 ? PAL.failure : PAL.resource}"/>`);
          parts.push(chip(s.x, y + 28, `${Math.round(ct.usage.memMB)}${lim ? '/' + lim : ''} MB`, { size: 14, color: PAL.resource }));
        }
      }
    }
    if (has(view, 'resources') && L < 4) {
      const lim = ct.limits.memoryMB;
      const pct = Math.min(1, ct.usage.memMB / (lim ?? 512));
      parts.push(`<rect x="${s.x - 40}" y="${DECK_Y - 84}" width="80" height="8" rx="4" fill="rgba(255,255,255,.16)"/><rect x="${s.x - 40}" y="${DECK_Y - 84}" width="${(80 * pct).toFixed(1)}" height="8" rx="4" fill="${pct > 0.85 ? PAL.failure : PAL.resource}"/>`);
    }
    if (has(view, 'storage') && ct.layerData.items > 0) parts.push(chip(s.x, DECK_Y + 164, `${ct.layerData.items} records in writable layer`, { size: 14, color: PAL.storage }));
  }
  if (scene.overflow.length) parts.push(chip(1100, DECK_Y - 112, `+${scene.overflow.length} more: ${scene.overflow.slice(0, 3).join(', ')}`, { size: 17, color: PAL.runtime, anchor: 'end' }));

  /* ---------------- crew / place labels ---------------- */
  const place = (x: number, y: number, text: string, target: Target, anchor: 'start' | 'middle' | 'end' = 'middle'): void => {
    parts.push(chip(x, y, text, { size: 20, strong: view.selected === target, color: view.selected === target ? PAL.runtime : undefined, anchor }));
  };
  if (!c.compact) {
    place(LAYOUT.crew.santa.x, 238, names.santa, 'daemon:dockerd');
    place(LAYOUT.crew.foreman.x + 30, 292, names.foreman, 'daemon:containerd', 'end');
    place(LAYOUT.crew.runner.x + 10, 330, names.runner, 'daemon:runc', 'end');
    parts.push(chip(930, 690, names.whale, { size: 24, strong: true }));
    parts.push(chip(236, 540, names.harbor, { size: 21, color: PAL.registry }));
    parts.push(chip(1384, 606, names.yard, { size: 21, color: PAL.build }));
  }
  if (L >= 3 && !c.compact) {
    parts.push(`<text x="${LAYOUT.crew.santa.x}" y="256" text-anchor="middle" font-size="14" fill="${PAL.kernel}">pid ${w.daemons.dockerd.pid}</text>`);
    parts.push(`<text x="${LAYOUT.crew.foreman.x}" y="302" text-anchor="middle" font-size="14" fill="${PAL.kernel}">pid ${w.daemons.containerd.pid}</text>`);
  }

  /* ---------------- level 2: engine call chain ---------------- */
  if (L === 2 || has(view, 'process')) {
    const santa: Pt = { x: LAYOUT.crew.santa.x - 40, y: 300 };
    const fore: Pt = { x: LAYOUT.crew.foreman.x, y: 322 };
    const run: Pt = { x: LAYOUT.crew.runner.x, y: 326 };
    parts.push(arrow(santa, fore, PAL.runtime, { label: 'gRPC', bend: 30 }));
    parts.push(arrow(fore, run, PAL.runtime, { label: 'task create', bend: 36 }));
    const target = view.selected?.startsWith('container:') ? view.selected : null;
    const targets = target ? [target] : Object.keys(w.containers).filter((n) => w.containers[n]!.state === 'running').slice(0, 2).map((n) => `container:${n}`);
    for (const t of targets) {
      const sp = slotPt(c, t.slice(10));
      if (sp) parts.push(arrow(run, { x: sp.x + 20, y: sp.y - 66 }, PAL.runtime, { dash: '7 7', label: t === target ? 'clone() + exec' : undefined, bend: 60 }));
    }
    if (!c.compact) parts.push(chip(1130, 214, 'docker CLI → /var/run/docker.sock', { size: 15, color: PAL.runtime, anchor: 'start' }));
    // shims under the running containers
    for (const s of scene.slots) {
      const ct = s.name ? w.containers[s.name] : null;
      if (ct && ct.state === 'running' && L === 2 && !c.compact) parts.push(chip(s.x, DECK_Y + 112, `shim ${ct.pid - 3}`, { size: 14, color: PAL.runtime }));
    }
  }

  /* ---------------- level 5: OCI labels ---------------- */
  if (L === 5 && !c.compact) {
    parts.push(chip(LAYOUT.crew.runner.x, 340, 'consumes config.json', { size: 15, color: PAL.standard }));
    parts.push(chip(236, 560, 'OCI distribution API', { size: 15, color: PAL.standard }));
    parts.push(chip(700, 760, 'OCI image: manifest + config + layer blobs', { size: 15, color: PAL.standard }));
  }

  /* ---------------- resources HUD ---------------- */
  if (has(view, 'resources')) parts.push(hud(c));

  /* ---------------- dependencies ---------------- */
  if (has(view, 'dependencies') && view.selected) {
    const rel = relations(w, view.selected);
    const from = anchorOf(w, scene, view.selected, c.slotOf);
    if (from) {
      for (const r of rel.dependsOn.slice(0, 6)) {
        const to = anchorOf(w, scene, r.target, c.slotOf);
        if (to) parts.push(arrow(from, to, PAL.registry, { label: r.label.slice(0, 30), bend: 70 }));
      }
      for (const r of rel.dependedBy.slice(0, 6)) {
        const to = anchorOf(w, scene, r.target, c.slotOf);
        if (to) parts.push(arrow(to, from, PAL.lantern, { dash: '8 6', label: r.label.slice(0, 26), bend: 70 }));
      }
    }
  }

  /* ---------------- causality ---------------- */
  if (has(view, 'causality') || c.recent.some((e) => e.severity === 'error')) parts.push(causality(c));

  /* ---------------- request trace ---------------- */
  const rq = w.requests[w.requests.length - 1];
  if (rq && (c.showRequest || has(view, 'network'))) {
    const pts: Pt[] = [];
    const first = rq.from === 'external' ? { x: 1500, y: 470 } : rq.from === 'host' ? A.whale! : anchorOf(w, scene, `container:${rq.from}`, c.slotOf);
    if (first) pts.push(first);
    for (const h of rq.hops) {
      const p = h.anchor ? anchorOf(w, scene, h.anchor, c.slotOf) : null;
      if (p && (!pts.length || Math.hypot(p.x - pts[pts.length - 1]!.x, p.y - pts[pts.length - 1]!.y) > 4)) pts.push(p);
    }
    if (pts.length > 1) {
      const d = 'M' + pts.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' L');
      const col = rq.ok ? PAL.kernel : PAL.failure;
      const end = pts[pts.length - 1]!;
      parts.push(`<g class="request"><path d="${d}" fill="none" stroke="${col}" stroke-width="5" stroke-dasharray="10 9" stroke-linecap="round" opacity=".9"><animate attributeName="stroke-dashoffset" from="38" to="0" dur="1.2s" repeatCount="indefinite"/></path><circle cx="${end.x}" cy="${end.y}" r="14" fill="${col}" opacity=".35"/>${rq.ok ? '' : `<path d="M${end.x - 10},${end.y - 10} l20,20 m0,-20 l-20,20" stroke="${PAL.failure}" stroke-width="5" stroke-linecap="round"/>`}${chip(end.x, end.y - 28, rq.ok ? `HTTP ${rq.status} · ${rq.latencyMs} ms` : rq.reason.slice(0, 58), { size: 17, color: col })}</g>`);
    }
  }

  /* ---------------- highlight rings (selected / hover / revealed) ---------------- */
  const ring = (t: Target | null, cls: string): void => {
    if (!t) return;
    const p = anchorOf(w, scene, t, c.slotOf);
    if (!p) return;
    const isC = t.startsWith('container:');
    if (isC) {
      const sp = slotPt(c, t.slice(10));
      if (sp) parts.push(`<rect class="${cls}" x="${sp.x - 70}" y="${sp.y - 84}" width="140" height="100" rx="14" fill="none" stroke="${PAL.lantern}" stroke-width="${cls === 'ring-sel' ? 4 : 2.5}"/>`);
    } else {
      parts.push(`<circle class="${cls}" cx="${p.x}" cy="${p.y}" r="${t === 'host' ? 120 : 48}" fill="none" stroke="${PAL.lantern}" stroke-width="${cls === 'ring-sel' ? 4 : 2.5}" ${t === 'host' ? 'stroke-dasharray="14 10"' : ''}/>`);
    }
  };
  ring(c.hover && c.hover !== view.selected ? c.hover : null, 'ring-hover');
  ring(view.selected, 'ring-sel');

  return parts.join('');
}

function hud(c: OverlayCtx): string {
  const { w } = c;
  const gauges: [string, number, string, string][] = [
    ['CPU', Math.min(1, hostCpuPct(w) / 100), `${Math.round(hostCpuPct(w))}%`, PAL.resource!],
    ['RAM', Math.min(1, hostMemUsedMB(w) / w.host.ramMB), `${Math.round(hostMemUsedMB(w))}/${w.host.ramMB} MB`, PAL.resource!],
    ['DISK', Math.min(1, diskUsedMB(w) / w.host.diskMB), `${fmtMB(Math.max(0, w.host.diskMB - diskUsedMB(w)))} free`, PAL.storage!],
  ];
  const out = [`<rect x="40" y="250" width="230" height="140" rx="14" fill="rgba(8,11,22,.72)" stroke="rgba(255,255,255,.18)"/>`];
  gauges.forEach(([n, v, txt, col], i) => {
    const y = 288 + i * 40;
    out.push(`<text x="58" y="${y}" font-size="17" fill="#cfd8ee">${n}</text><rect x="110" y="${y - 14}" width="130" height="12" rx="6" fill="rgba(255,255,255,.14)"/><rect x="110" y="${y - 14}" width="${(130 * v).toFixed(1)}" height="12" rx="6" fill="${v > 0.9 ? PAL.failure : col}"/><text x="110" y="${y + 6}" font-size="12.5" fill="#9fb0d4">${esc(txt)}</text>`);
  });
  return out.join('');
}

function causality(c: OverlayCtx): string {
  const ev = c.recent.filter((e) => e.target && e.severity !== 'info' ? true : e.concepts.length > 0).slice(0, 40);
  const order: { target: Target; label: string; sev: string }[] = [];
  const short = (k: string): string => k.replace(/^(kernel|engine|process|container|cgroup|service|image|network|volume)\./, '').replace(/[._]/g, ' ');
  for (const e of ev) {
    const last = order[order.length - 1];
    if (last && last.target === e.target) {
      last.label = short(e.kind);
      last.sev = e.severity;
      continue;
    }
    order.push({ target: e.target, label: short(e.kind), sev: e.severity });
  }
  const pts = order.slice(0, 7).map((o) => ({ ...o, p: anchorOf(c.w, c.scene, o.target, c.slotOf) })).filter((o) => o.p) as { target: Target; label: string; sev: string; p: Pt }[];
  const out: string[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y) < 20) continue;
    out.push(arrow(a.p, b.p, a.sev === 'error' || b.sev === 'error' ? PAL.failure! : PAL.lantern!, { bend: 50, width: 3.5, opacity: 0.85 }));
  }
  pts.forEach((o, i) => {
    out.push(`<g><circle cx="${o.p.x}" cy="${o.p.y}" r="14" fill="${o.sev === 'error' ? PAL.failure : PAL.lantern}" stroke="#0b0f17" stroke-width="2.5"/><text x="${o.p.x}" y="${o.p.y + 5}" text-anchor="middle" font-size="15" font-weight="700" fill="#0b0f17">${i + 1}</text></g>`);
    if (!c.compact) out.push(chip(o.p.x, o.p.y - 26, o.label.slice(0, 22), { size: 15, color: o.sev === 'error' ? PAL.failure : PAL.lantern }));
  });
  return out.join('');
}

function ecosystem(c: OverlayCtx): string {
  const A = LAYOUT.anchors;
  const sats: { x: number; y: number; name: string; sub: string; to: Pt; link: string; col: string }[] = [
    { x: 520, y: 120, name: 'Kubernetes', sub: 'kubelet → CRI → containerd → runc', to: A.foreman!, link: 'CRI', col: PAL.runtime! },
    { x: 860, y: 78, name: 'Podman · CRI-O', sub: 'other engines, same OCI runtimes', to: A.runner!, link: 'OCI runtime', col: PAL.standard! },
    { x: 1190, y: 120, name: 'Managed cloud', sub: 'Fargate · Cloud Run: microVM per task', to: A.whale!, link: 'runs your image', col: PAL.registry! },
    { x: 1450, y: 250, name: 'CI/CD + supply chain', sub: 'build once → sign → push by digest', to: A.shipyard!, link: 'artifact', col: PAL.build! },
  ];
  const out: string[] = [];
  for (const s of sats) {
    out.push(arrow({ x: s.x, y: s.y + 24 }, s.to, s.col, { dash: '9 8', label: s.link, bend: 20, opacity: 0.8 }));
    out.push(`<g><circle cx="${s.x}" cy="${s.y}" r="30" fill="${s.col}" fill-opacity=".18" stroke="${s.col}" stroke-width="3"/><circle cx="${s.x}" cy="${s.y}" r="9" fill="${s.col}"/></g>`);
    if (!c.compact) {
      out.push(chip(s.x, s.y - 40, s.name, { size: 19, strong: true, color: s.col }));
      out.push(`<text x="${s.x}" y="${s.y + 56}" text-anchor="middle" font-size="14" fill="${s.col}">${esc(s.sub)}</text>`);
    }
  }
  return out.join('');
}

export { vethName };
