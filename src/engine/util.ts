/** Small deterministic helpers. The engine never touches Date.now() or Math.random(). */

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** Deterministic pseudo "sha256" hex string of `len` hex chars (default 64). */
export function hex(seed: string, len = 64): string {
  const next = xmur3(seed);
  let out = '';
  while (out.length < len) out += next().toString(16).padStart(8, '0');
  return out.slice(0, len);
}

export const sha = (seed: string): string => 'sha256:' + hex(seed);
export const short = (digest: string, n = 12): string => digest.replace(/^sha256:/, '').slice(0, n);

/** Deterministic number in [0,1) from a seed string. */
export function unit(seed: string): number {
  return xmur3(seed)() / 4294967296;
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

export function fmtMB(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  if (mb >= 10) return Math.round(mb) + ' MB';
  return mb.toFixed(1) + ' MB';
}

/** "128MB" | "1g" | 256 -> megabytes */
export function parseMemory(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(v.trim());
  if (!m) return NaN;
  const n = parseFloat(m[1]!);
  switch (m[2]!.toLowerCase()) {
    case 'k':
      return n / 1024;
    case 'g':
      return n * 1024;
    case 't':
      return n * 1024 * 1024;
    default:
      return n; // bare number / "m" => MB
  }
}

/** Split "repo:tag", defaulting the tag to latest. */
export function normalizeRef(ref: string): string {
  const r = ref.trim().replace(/^docker\.io\/(library\/)?/, '').replace(/^library\//, '');
  const lastSlash = r.lastIndexOf('/');
  const lastColon = r.lastIndexOf(':');
  return lastColon > lastSlash ? r : r + ':latest';
}

export const containerTarget = (name: string): string => `container:${name}`;

export function parseTarget(t: string): { kind: string; name: string } {
  const i = t.indexOf(':');
  if (i < 0) return { kind: t, name: '' };
  return { kind: t.slice(0, i), name: t.slice(i + 1) };
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Docker-style random-looking container names, but deterministic from a counter. */
const ADJ = ['quirky', 'stoic', 'brave', 'sleepy', 'jolly', 'mellow', 'nimble', 'plucky', 'wobbly', 'zesty'];
const NOUN = ['narwhal', 'walrus', 'otter', 'puffin', 'heron', 'badger', 'lemur', 'ferret', 'gecko', 'yak'];
export function autoName(n: number): string {
  return `${ADJ[n % ADJ.length]}_${NOUN[Math.floor(n / ADJ.length + n * 3) % NOUN.length]}`;
}

/** own-property lookup: user-chosen names like "constructor" must never resolve to Object.prototype members */
export function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
