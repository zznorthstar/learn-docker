import { CONCEPTS, type Concept } from './concepts';
import type { RevealMode } from './types';

export type Rel = 'dependsOn' | 'parts' | 'createdBy' | 'managedBy' | 'implementedBy' | 'relatesTo' | 'outward';
const FORWARD: Rel[] = ['dependsOn', 'parts', 'createdBy', 'managedBy', 'implementedBy', 'relatesTo', 'outward'];

export interface Edge {
  from: string;
  to: string;
  rel: Rel;
}

export interface Subgraph {
  mode: RevealMode;
  root: string;
  nodes: string[];
  edges: Edge[];
  /** nodes that were cut off by the size cap */
  truncated: number;
  /** one-sentence reading of what the subgraph shows */
  caption: string;
}

export const MAX_NODES = 14;

export function get(id: string): Concept | undefined {
  return CONCEPTS[id];
}

export function exists(id: string): boolean {
  return id in CONCEPTS;
}

/** all concepts that point at `id` with one of the given relations */
export function reverse(id: string, rels: Rel[]): Edge[] {
  const out: Edge[] = [];
  for (const c of Object.values(CONCEPTS)) {
    for (const r of rels) if ((c[r] as string[]).includes(id)) out.push({ from: c.id, to: id, rel: r });
  }
  return out;
}

export function forward(id: string, rels: Rel[] = FORWARD): Edge[] {
  const c = CONCEPTS[id];
  if (!c) return [];
  const out: Edge[] = [];
  for (const r of rels) for (const t of c[r] as string[]) if (CONCEPTS[t]) out.push({ from: id, to: t, rel: r });
  return out;
}

/** breadth-first walk over directed edges, depth-limited, node-capped */
function walk(root: string, next: (id: string) => Edge[], depth: number, cap = MAX_NODES): { nodes: string[]; edges: Edge[]; truncated: number } {
  const seen = new Set([root]);
  const nodes = [root];
  const edges: Edge[] = [];
  let frontier = [root];
  let truncated = 0;
  for (let d = 0; d < depth && frontier.length; d++) {
    const nf: string[] = [];
    for (const id of frontier) {
      for (const e of next(id)) {
        const other = e.from === id ? e.to : e.from;
        if (!seen.has(other)) {
          if (nodes.length >= cap) {
            truncated++;
            continue;
          }
          seen.add(other);
          nodes.push(other);
          nf.push(other);
        }
        if (seen.has(other)) edges.push(e);
      }
    }
    frontier = nf;
  }
  return { nodes, edges: dedupe(edges), truncated };
}

function dedupe(es: Edge[]): Edge[] {
  const k = new Set<string>();
  return es.filter((e) => {
    const key = `${e.from}>${e.to}>${e.rel}`;
    if (k.has(key)) return false;
    k.add(key);
    return true;
  });
}

const NEEDS: Rel[] = ['dependsOn', 'implementedBy', 'parts'];

/** What the concept needs to exist or function (transitively). */
export function dependsOn(id: string, depth = 2): Subgraph {
  const g = walk(id, (x) => forward(x, ['dependsOn', 'implementedBy']), depth);
  return { mode: 'depends_on', root: id, ...g, caption: `What ${name(id)} needs in order to exist and work.` };
}

/** What would break or change if this concept disappeared. */
export function dependedBy(id: string, depth = 2): Subgraph {
  const g = walk(id, (x) => reverse(x, ['dependsOn', 'implementedBy']), depth);
  return { mode: 'depended_by', root: id, ...g, caption: `What relies on ${name(id)}.` };
}

/** What it is made of. */
export function madeOf(id: string, depth = 2): Subgraph {
  const g = walk(id, (x) => forward(x, ['parts']), depth);
  return { mode: 'made_of', root: id, ...g, caption: `What ${name(id)} is made of.` };
}

/** What uses it (reverse of dependsOn, parts and relatesTo; one hop plus managers). */
export function usedBy(id: string): Subgraph {
  const g = walk(id, (x) => (x === id ? reverse(x, ['dependsOn', 'parts', 'implementedBy', 'relatesTo']) : []), 1);
  return { mode: 'used_by', root: id, ...g, caption: `What uses ${name(id)}.` };
}

/** Why does it exist: its creators and managers, plus what it relates to. */
export function why(id: string): Subgraph {
  const g = walk(id, (x) => forward(x, ['createdBy', 'managedBy', 'relatesTo']), 1);
  return { mode: 'why', root: id, ...g, caption: `${get(id)?.why ?? ''}` };
}

/** Follow the chain down to kernel primitives. Returns the shortest chain(s). */
export function toKernel(id: string): { chains: string[][]; subgraph: Subgraph } {
  const target = (c: Concept) => c.domain === 'linux' && (c.role === 'kernel' || c.id === 'kernel');
  const chains = shortestChains(id, (x) => forward(x, NEEDS).map((e) => e.to), target, 3);
  const nodes = [...new Set(chains.flat())];
  const edges: Edge[] = [];
  for (const ch of chains) for (let i = 0; i + 1 < ch.length; i++) edges.push(...forward(ch[i]!, NEEDS).filter((e) => e.to === ch[i + 1]));
  return {
    chains,
    subgraph: { mode: 'to_kernel', root: id, nodes: nodes.length ? nodes : [id], edges: dedupe(edges), truncated: 0, caption: `How ${name(id)} reaches down to Linux kernel primitives.` },
  };
}

/** Follow outward links to the wider ecosystem. */
export function toEcosystem(id: string): { chains: string[][]; subgraph: Subgraph } {
  const target = (c: Concept) => c.domain === 'ecosystem';
  const chains = shortestChains(id, (x) => [...forward(x, ['outward']).map((e) => e.to), ...reverse(x, ['dependsOn']).filter((e) => CONCEPTS[e.from]?.domain === 'ecosystem').map((e) => e.from)], target, 4);
  const nodes = [...new Set(chains.flat())];
  const edges: Edge[] = [];
  for (const ch of chains) for (let i = 0; i + 1 < ch.length; i++) edges.push({ from: ch[i]!, to: ch[i + 1]!, rel: 'outward' });
  return {
    chains,
    subgraph: { mode: 'to_ecosystem', root: id, nodes: nodes.length ? nodes : [id], edges: dedupe(edges), truncated: 0, caption: `Where ${name(id)} connects to the wider container ecosystem.` },
  };
}

function shortestChains(root: string, next: (id: string) => string[], isTarget: (c: Concept) => boolean, max: number): string[][] {
  const out: string[][] = [];
  const queue: string[][] = [[root]];
  const seenAt = new Map<string, number>([[root, 0]]);
  while (queue.length && out.length < max) {
    const path = queue.shift()!;
    const last = path[path.length - 1]!;
    const c = CONCEPTS[last];
    if (path.length > 1 && c && isTarget(c)) {
      out.push(path);
      continue;
    }
    if (path.length > 6) continue;
    for (const n of next(last)) {
      if (path.includes(n)) continue;
      const d = path.length;
      if ((seenAt.get(n) ?? Infinity) < d) continue; // already reached shorter
      seenAt.set(n, d);
      queue.push([...path, n]);
    }
  }
  return out;
}

/** Shortest undirected path between two concepts, labelled by relation. */
export function between(a: string, b: string): { path: string[]; edges: Edge[] } | null {
  if (!exists(a) || !exists(b)) return null;
  const all: Edge[] = [];
  for (const c of Object.values(CONCEPTS)) all.push(...forward(c.id));
  const adj = new Map<string, Edge[]>();
  for (const e of all) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e);
  }
  const prev = new Map<string, Edge | null>([[a, null]]);
  const q = [a];
  while (q.length) {
    const x = q.shift()!;
    if (x === b) break;
    for (const e of adj.get(x) ?? []) {
      const o = e.from === x ? e.to : e.from;
      if (!prev.has(o)) {
        prev.set(o, e);
        q.push(o);
      }
    }
  }
  if (!prev.has(b)) return null;
  const path = [b];
  const edges: Edge[] = [];
  for (let cur = b; cur !== a; ) {
    const e = prev.get(cur)!;
    edges.unshift(e);
    cur = e.from === cur ? e.to : e.from;
    path.unshift(cur);
  }
  return { path, edges };
}

export function reveal(mode: RevealMode, root: string): Subgraph {
  switch (mode) {
    case 'depends_on':
      return dependsOn(root);
    case 'depended_by':
      return dependedBy(root);
    case 'made_of':
      return madeOf(root);
    case 'used_by':
      return usedBy(root);
    case 'why':
      return why(root);
    case 'to_kernel':
      return toKernel(root).subgraph;
    case 'to_ecosystem':
      return toEcosystem(root).subgraph;
    case 'follow':
    default: {
      const g = walk(root, (x) => forward(x, ['dependsOn', 'relatesTo', 'parts']), 1, 10);
      return { mode: 'follow', root, ...g, caption: `Concepts directly connected to ${name(root)}.` };
    }
  }
}

function name(id: string): string {
  return CONCEPTS[id]?.name ?? id;
}

/** Concepts that matter to a Docker object kind, in teaching order. */
export function conceptsForTarget(target: string): string[] {
  const kind = target.split(':')[0];
  switch (kind) {
    case 'host':
      return ['host', 'kernel', 'disk'];
    case 'container':
      return ['container', 'process', 'image', 'namespaces', 'cgroups'];
    case 'image':
      return ['image', 'layer', 'manifest', 'tag'];
    case 'volume':
      return ['volume', 'writable-layer', 'mnt-ns'];
    case 'network':
      return ['network', 'bridge', 'veth', 'service-discovery'];
    case 'daemon':
      return target.endsWith('containerd') ? ['containerd', 'shim', 'runc'] : target.endsWith('buildkit') ? ['buildkit'] : ['dockerd', 'docker-api'];
    case 'registry':
      return ['registry', 'oci-distribution'];
    case 'compose':
      return ['compose', 'service-discovery'];
    default:
      return [];
  }
}
