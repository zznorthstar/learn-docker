import palette from '../../shared/palette.json';
import type { Role } from '../engine/concepts';

export const PAL = palette as Record<string, string>;

/** one colour per system: used by the art, the SVG overlay and the UI */
export const ROLE_COLOR: Record<Role, string> = {
  runtime: PAL.runtime!,
  network: PAL.network!,
  storage: PAL.storage!,
  kernel: PAL.kernel!,
  resource: PAL.resource!,
  failure: PAL.failure!,
  registry: PAL.registry!,
  build: PAL.build!,
  standard: PAL.standard!,
};

/** container body colours: derived from the image so the same image always looks the same */
const IMAGE_TINTS: Record<string, string> = {
  nginx: '#4a7bd0',
  redis: '#d0503a',
  postgres: '#3a8fa8',
  alpine: '#7a8aa8',
  busybox: '#8a7a5a',
  'hello-world': '#c9a227',
  node: '#4ca56a',
  'my-api': '#4ca56a',
  python: '#d0b04a',
  leaky: '#b05ad0',
  'arm-demo': '#d06a9a',
};

export function imageTint(ref: string): string {
  const repo = ref.split(':')[0]!;
  if (IMAGE_TINTS[repo]) return IMAGE_TINTS[repo]!;
  let h = 0;
  for (const c of repo) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 45% 52%)`;
}

/** '#rrggbb' | 'hsl(...)' -> 0xFFRRGGBB number for Rive colour properties */
export function toRiveColor(css: string): number {
  if (css.startsWith('#')) return (0xff000000 | parseInt(css.slice(1), 16)) >>> 0;
  const m = /hsl\((\d+)\s+(\d+)%\s+(\d+)%\)/.exec(css);
  if (!m) return 0xff4a7bd0;
  const h = +m[1]! / 360;
  const s = +m[2]! / 100;
  const l = +m[3]! / 100;
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  const to = (x: number): number => Math.round(x * 255);
  return (0xff000000 | (to(f(0)) << 16) | (to(f(8)) << 8) | to(f(4))) >>> 0;
}

export function networkColor(i: number): string {
  const hues = [PAL.network!, '#5fb3f0', '#7be0a8', '#a8e05f', '#f0a85f'];
  return hues[i % hues.length]!;
}
