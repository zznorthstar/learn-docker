export const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type IconName = 'back' | 'fwd' | 'now' | 'copy' | 'check' | 'flask' | 'bolt' | 'plug' | 'eye' | 'eyeoff' | 'x' | 'play' | 'question' | 'whale' | 'lock' | 'dots';

const P: Record<IconName, string> = {
  back: 'M15 5l-8 7 8 7M19 5v14',
  fwd: 'M9 5l8 7-8 7M5 5v14',
  now: 'M5 5l8 7-8 7M13 5l8 7-8 7',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  check: 'M5 13l4 4 10-11',
  flask: 'M9 3h6M10 3v6L5 19a1 1 0 001 1h12a1 1 0 001-1l-5-10V3',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeoff: 'M3 3l18 18M10.6 5.2A9.7 9.7 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.1 7.1A17 17 0 002 12s4 7 10 7a9.6 9.6 0 004-.9',
  x: 'M6 6l12 12M18 6L6 18',
  play: 'M7 4l13 8-13 8z',
  question: 'M9 9a3 3 0 116 0c0 2-3 2-3 5M12 18v.5',
  whale: 'M2 14c3-6 10-8 16-5 3 1 4 3 4 5-3 4-9 6-15 5-3-1-4-3-5-5zM17 12h.01',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
};

export function icon(name: IconName, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[name]}"/></svg>`;
}

export function whaleLogo(size = 26): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#10163a"/><path d="M4 18c4-7 12-9 19-6 3 1 5 3 5 6-3 4-9 7-16 6-4-1-7-3-8-6z" fill="#3d62ad"/><path d="M5 17l-3-5 6 2z" fill="#34559c"/><circle cx="23" cy="15.5" r="1.5" fill="#fff"/><rect x="9" y="9" width="5" height="3" rx=".6" fill="#d0503a"/><rect x="15" y="9" width="5" height="3" rx=".6" fill="#4a7bd0"/></svg>`;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export const tone = (t: string): string => (t === 'ok' ? 'ok' : t === 'warn' ? 'warn' : t === 'bad' ? 'bad' : t === 'info' ? 'info' : 'idle');
