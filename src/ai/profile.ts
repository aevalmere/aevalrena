/**
 * Where Aevalmere keeps what it learned about a player between matches (docs/CPU_AEVALMERE.md, E2).
 *
 * The store is an interface so the brain never touches browser globals directly: in the browser
 * the default is localStorage, in node (the test harness) it is an in-memory map, and a test can
 * inject its own. Only the level 10 opponent profiles go through here, under
 * `aevalrena.aevalmere.profile.v1.<name>`, plus one index key, `aevalrena.aevalmere.profiles.v1`,
 * that lists the stored names with their last-saved time so the total stays capped.
 */
import type { MatchConfig } from '../core/types';

export interface ProfileStore {
  load(key: string): string | null;
  save(key: string, value: string): void;
}

/** A raw key-value backend. `save` may throw (a full quota); `remove` deletes a key. */
export interface ProfileBackend extends ProfileStore {
  remove(key: string): void;
}

/** A store that lives as long as the object does. The harness default and the node default. */
export class MemoryProfileStore implements ProfileBackend {
  private readonly map = new Map<string, string>();
  load(key: string): string | null {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }
  save(key: string, value: string): void {
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
  /** Every key currently held, for tests. */
  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

export const PROFILE_PREFIX = 'aevalrena.aevalmere.profile.v1.';
/** The index of stored profiles: `{"v":1,"e":[[key, savedAt], ...]}`. */
export const PROFILE_INDEX_KEY = 'aevalrena.aevalmere.profiles.v1';
/** Most profiles kept at once; saving one more evicts the one saved longest ago. */
export const PROFILE_CAP = 16;

interface IndexEntry { key: string; t: number }

/**
 * Wraps a backend with the index and the cap. Every profile save stamps its key in the index;
 * past PROFILE_CAP the oldest are removed. A save that throws (a full quota) evicts the oldest
 * other profile and retries once; if that fails too it is logged and dropped (the old profile
 * stays), since the profile is an optional extra and must never break a match.
 */
export class CappedProfileStore implements ProfileStore {
  private lastT = 0;
  constructor(private readonly backend: ProfileBackend, private readonly cap = PROFILE_CAP) {}

  load(key: string): string | null {
    try {
      return this.backend.load(key);
    } catch (err) {
      void err;   // storage blocked: play without the profile
      return null;
    }
  }

  save(key: string, value: string): void {
    const index = this.readIndex();
    if (!this.trySave(key, value)) {
      if (!this.evictOldest(index, key) || !this.trySave(key, value)) {
        console.warn(`[aevalmere] profile not saved (storage full or blocked): ${key}`);
        return;
      }
    }
    // A monotonic stamp: two saves in the same millisecond still order.
    const t = Math.max(Date.now(), this.lastT + 1);
    this.lastT = t;
    let found = false;
    for (let i = 0; i < index.length; i++) if (index[i].key === key) { index[i].t = t; found = true; }
    if (!found) index.push({ key, t });
    index.sort((a, b) => a.t - b.t);
    while (index.length > this.cap) {
      const old = index.shift() as IndexEntry;
      this.tryRemove(old.key);
    }
    this.writeIndex(index);
  }

  /** Profile keys currently in the index, oldest first. */
  indexedKeys(): string[] {
    return this.readIndex().map((e) => e.key);
  }

  private trySave(key: string, value: string): boolean {
    try {
      this.backend.save(key, value);
      return true;
    } catch (err) {
      void err;   // handled by the caller: evict and retry once
      return false;
    }
  }

  private tryRemove(key: string): void {
    try {
      this.backend.remove(key);
    } catch (err) {
      void err;   // a key that cannot be removed only costs space
    }
  }

  /** Removes the oldest indexed profile other than `keep`. False when there is none to remove. */
  private evictOldest(index: IndexEntry[], keep: string): boolean {
    index.sort((a, b) => a.t - b.t);
    for (let i = 0; i < index.length; i++) {
      if (index[i].key === keep) continue;
      this.tryRemove(index[i].key);
      index.splice(i, 1);
      this.writeIndex(index);
      return true;
    }
    return false;
  }

  private readIndex(): IndexEntry[] {
    const text = this.load(PROFILE_INDEX_KEY);
    if (text === null) return [];
    try {
      const obj = JSON.parse(text) as { v?: unknown; e?: unknown };
      if (obj.v !== 1 || !Array.isArray(obj.e)) return [];
      const out: IndexEntry[] = [];
      for (const row of obj.e) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'number') continue;
        if (!row[0].startsWith(PROFILE_PREFIX)) continue;
        out.push({ key: row[0], t: row[1] });
        if (row[1] > this.lastT) this.lastT = row[1];
      }
      return out;
    } catch (err) {
      void err;   // a corrupt index is rebuilt from the next save
      return [];
    }
  }

  private writeIndex(index: IndexEntry[]): void {
    const text = JSON.stringify({ v: 1, e: index.map((e) => [e.key, e.t]) });
    if (!this.trySave(PROFILE_INDEX_KEY, text)) {
      console.warn('[aevalmere] profile index not saved (storage full or blocked)');
    }
  }
}

/** localStorage as a raw backend: its errors reach CappedProfileStore, which handles them. */
function localBackend(): ProfileBackend {
  return {
    load: (key: string): string | null => localStorage.getItem(key),
    save: (key: string, value: string): void => { localStorage.setItem(key, value); },
    remove: (key: string): void => { localStorage.removeItem(key); },
  };
}

export function defaultProfileStore(): ProfileStore {
  return new CappedProfileStore(typeof localStorage !== 'undefined' ? localBackend() : new MemoryProfileStore());
}

/**
 * Profile key of the player in `slot`: the name they typed, or `slot<n>` when they typed none.
 * Returns null for a CPU slot, whose habits are not a person's and are never stored.
 */
export function profileKeyFor(config: MatchConfig, slot: number): string | null {
  for (let i = 0; i < config.players.length; i++) {
    const p = config.players[i];
    if (p.slot !== slot) continue;
    if (p.cpu) return null;
    const name = p.name !== undefined ? p.name.trim() : '';
    return PROFILE_PREFIX + (name !== '' ? name : `slot${slot}`);
  }
  return null;
}
