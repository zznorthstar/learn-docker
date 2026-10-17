import type { Persisted } from '../engine/engine';

/**
 * Browser-local persistence. Identity + preferences live in localStorage
 * (needed synchronously at boot); the lab itself (world timeline, view,
 * progress) lives in IndexedDB. Everything is best-effort: if storage is
 * blocked the lab simply lives for this session.
 */

const DB = 'whale-lab';
const STORE = 'labs';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveLab(labId: string, data: Persisted): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, labId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* storage unavailable: fine */
  }
}

export async function loadLab(labId: string): Promise<Persisted | null> {
  try {
    const db = await open();
    const v = await new Promise<Persisted | null>((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get(labId);
      r.onsuccess = () => resolve((r.result as Persisted) ?? null);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return v;
  } catch {
    return null;
  }
}

export async function deleteLab(labId: string): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(labId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
}

export interface Prefs {
  onboarded: boolean;
  reducedMotion: 'auto' | 'on' | 'off';
  quality: 'auto' | 'low';
  dockTab: string;
  sideTab: string;
}

const PREF_KEY = 'dockerworld.prefs.v1';
const DEFAULT_PREFS: Prefs = { onboarded: false, reducedMotion: 'auto', quality: 'auto', dockTab: 'timeline', sideTab: 'object' };

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
