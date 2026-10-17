/**
 * Lab identity: a random lab id (public) and a random secret (capability token).
 * Not an account: nothing here identifies a person, and the server stores only
 * a hash of the secret. Persisted in this browser so a reload reconnects to
 * the SAME lab.
 */

export interface LabIdentity {
  labId: string;
  secret: string;
  createdAt: number;
}

const KEY = 'dockerworld.lab.v1';

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function newLabId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = randomBytes(12);
  let s = 'w_';
  for (let i = 0; i < 10; i++) s += alphabet[b[i]! % alphabet.length];
  return s;
}

export function newSecret(): string {
  const b = randomBytes(32);
  let bin = '';
  b.forEach((x) => (bin += String.fromCharCode(x)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface IdentityStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function defaultStore(): IdentityStore {
  try {
    const t = '__t';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
    return localStorage;
  } catch {
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
  }
}

/** Load the identity, or create one on first visit. */
export function loadIdentity(store: IdentityStore = defaultStore()): { identity: LabIdentity; fresh: boolean } {
  try {
    const raw = store.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as LabIdentity;
      if (/^w_[a-z0-9]{6,24}$/.test(v.labId) && /^[A-Za-z0-9_-]{32,64}$/.test(v.secret)) return { identity: v, fresh: false };
    }
  } catch {
    /* fall through to a new identity */
  }
  const identity: LabIdentity = { labId: newLabId(), secret: newSecret(), createdAt: Date.now() };
  try {
    store.setItem(KEY, JSON.stringify(identity));
  } catch {
    /* storage blocked: identity lives for this session only */
  }
  return { identity, fresh: true };
}

export function resetIdentity(store: IdentityStore = defaultStore()): LabIdentity {
  const identity: LabIdentity = { labId: newLabId(), secret: newSecret(), createdAt: Date.now() };
  store.setItem(KEY, JSON.stringify(identity));
  return identity;
}

/** The single string a user pastes into an AI client: "<labId>.<secret>". */
export const bearer = (i: LabIdentity): string => `${i.labId}.${i.secret}`;
