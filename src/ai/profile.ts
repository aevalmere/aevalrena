/**
 * What the CPU keeps about a player between matches (02 section 6.9), format v2.
 *
 * The store is an interface so the brain never touches browser globals directly: in the browser
 * the default is localStorage, in node (the harness) an in-memory map, and a test can inject its
 * own. Profiles live under `aevalrena.cpu.profile.v2.<name>`, plus one index key,
 * `aevalrena.cpu.profiles.v2`, listing the stored names with their last-saved time so the count
 * stays capped; a value over PROFILE_MAX_BYTES is refused.
 *
 * v1 profiles (`aevalrena.aevalmere.profile.v1.*`) are discarded, not migrated (owner decision
 * O6): the v2 prefix never reads them, `decodeProfile` rejects a v1 body with a reason, and
 * `discardV1Profiles` removes the old keys from a backend once, with a logged reason.
 */
import type { MatchConfig } from '../core/types';
import type { Archetype } from './contracts';

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

export const PROFILE_VERSION = 2;
export const PROFILE_PREFIX = 'aevalrena.cpu.profile.v2.';
/** The index of stored profiles: `{"v":2,"e":[[key, savedAt], ...]}`. */
export const PROFILE_INDEX_KEY = 'aevalrena.cpu.profiles.v2';
/** Most profiles kept at once; saving one more evicts the one saved longest ago. */
export const PROFILE_CAP = 16;
/** Largest stored value in UTF-16 code units; 16 of these stay well inside a 5 MB localStorage quota. */
export const PROFILE_MAX_BYTES = 200_000;
/** v1 keys, read only to delete them. */
export const V1_PROFILE_PREFIX = 'aevalrena.aevalmere.profile.v1.';
export const V1_INDEX_KEY = 'aevalrena.aevalmere.profiles.v1';

interface IndexEntry { key: string; t: number }

/**
 * Wraps a backend with the index and the caps. Every profile save stamps its key in the index;
 * past `cap` the oldest are removed. A value over PROFILE_MAX_BYTES is refused with a warning.
 * A save that throws (a full quota) evicts the oldest other profile and retries once; if that
 * fails too it is logged and dropped (the old profile stays), since the profile is an optional
 * extra and must never break a match.
 */
export class CappedProfileStore implements ProfileStore {
  private lastT = 0;
  constructor(private readonly backend: ProfileBackend, private readonly cap = PROFILE_CAP,
    private readonly maxBytes = PROFILE_MAX_BYTES) {}

  load(key: string): string | null {
    try {
      return this.backend.load(key);
    } catch (err) {
      void err;   // storage blocked: play without the profile
      return null;
    }
  }

  save(key: string, value: string): void {
    if (value.length > this.maxBytes) {
      console.warn(`[cpu] profile not saved (${value.length} over the ${this.maxBytes} cap): ${key}`);
      return;
    }
    const index = this.readIndex();
    if (!this.trySave(key, value)) {
      if (!this.evictOldest(index, key) || !this.trySave(key, value)) {
        console.warn(`[cpu] profile not saved (storage full or blocked): ${key}`);
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
      if (obj.v !== PROFILE_VERSION || !Array.isArray(obj.e)) return [];
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
    const text = JSON.stringify({ v: PROFILE_VERSION, e: index.map((e) => [e.key, e.t]) });
    if (!this.trySave(PROFILE_INDEX_KEY, text)) {
      console.warn('[cpu] profile index not saved (storage full or blocked)');
    }
  }
}

/**
 * Removes every v1 profile listed in the v1 index, and the index, from `backend`. Returns how many
 * profile keys were removed; logs the reason once when there was anything to remove.
 */
export function discardV1Profiles(backend: ProfileBackend): number {
  let text: string | null = null;
  try { text = backend.load(V1_INDEX_KEY); } catch (err) { void err; return 0; }   // storage blocked
  if (text === null) return 0;
  let removed = 0;
  try {
    const obj = JSON.parse(text) as { e?: unknown };
    if (Array.isArray(obj.e)) {
      for (const row of obj.e) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0].startsWith(V1_PROFILE_PREFIX)) continue;
        try { backend.remove(row[0]); removed++; } catch (err) { void err; }   // a stuck key only costs space
      }
    }
  } catch (err) {
    void err;   // a corrupt v1 index: drop the index itself below
  }
  try { backend.remove(V1_INDEX_KEY); } catch (err) { void err; }
  console.info(`[cpu] discarded ${removed} v1 player profile(s): the v2 opponent model does not read v1 (decision O6)`);
  return removed;
}

/** localStorage as a raw backend: its errors reach CappedProfileStore, which handles them. */
function localBackend(): ProfileBackend {
  return {
    load: (key: string): string | null => localStorage.getItem(key),
    save: (key: string, value: string): void => { localStorage.setItem(key, value); },
    remove: (key: string): void => { localStorage.removeItem(key); },
  };
}

let v1Checked = false;

/** localStorage in the browser (old v1 profiles removed on first use), an in-memory map in node. */
export function defaultProfileStore(): ProfileStore {
  if (typeof localStorage === 'undefined') return new CappedProfileStore(new MemoryProfileStore());
  const backend = localBackend();
  if (!v1Checked) { v1Checked = true; discardV1Profiles(backend); }
  return new CappedProfileStore(backend);
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

// ---------------------------------------------------------------------------------------------
// The v2 profile body
// ---------------------------------------------------------------------------------------------

/**
 * One player's profile: the predictor's serialized model (predictor.ts `serialize`), plus the
 * stored archetype and skill estimates (02 section 6.9) and how many matches built it.
 */
export interface PlayerProfile {
  model: string;
  archetype: Archetype | null;
  /** Per-player rating estimate (06); null until the harness or brain sets one. */
  skill: number | null;
  matches: number;
}

const ARCHETYPES: readonly Archetype[] = ['aggressive', 'defensive', 'countering', 'balanced'];

export function encodeProfile(p: PlayerProfile): string {
  return JSON.stringify({ v: PROFILE_VERSION, model: p.model, arch: p.archetype, skill: p.skill, m: p.matches });
}

/**
 * Parses a stored profile. `profile` is null when there is none or it is unusable, and `reason`
 * says why: 'none', 'corrupt', 'v1 profile discarded (decision O6)' or 'unknown version <v>'.
 */
export function decodeProfile(text: string | null): { profile: PlayerProfile | null; reason: string } {
  if (text === null) return { profile: null, reason: 'none' };
  let obj: unknown;
  try { obj = JSON.parse(text); } catch (err) { void err; return { profile: null, reason: 'corrupt' }; }
  if (obj === null || typeof obj !== 'object') return { profile: null, reason: 'corrupt' };
  const o = obj as Record<string, unknown>;
  if (o.v === 1) return { profile: null, reason: 'v1 profile discarded (decision O6)' };
  if (o.v !== PROFILE_VERSION) return { profile: null, reason: `unknown version ${String(o.v)}` };
  if (typeof o.model !== 'string') return { profile: null, reason: 'corrupt' };
  const arch = typeof o.arch === 'string' && (ARCHETYPES as readonly string[]).includes(o.arch) ? o.arch as Archetype : null;
  const skill = typeof o.skill === 'number' && Number.isFinite(o.skill) ? o.skill : null;
  const matches = typeof o.m === 'number' && Number.isFinite(o.m) && o.m >= 0 ? Math.floor(o.m) : 0;
  return { profile: { model: o.model, archetype: arch, skill, matches }, reason: 'ok' };
}

const logged = new Set<string>();

/** Loads and decodes `key`; a rejected profile's reason is logged once per key per session. */
export function loadPlayerProfile(store: ProfileStore, key: string): PlayerProfile | null {
  const { profile, reason } = decodeProfile(store.load(key));
  if (profile === null && reason !== 'none' && !logged.has(key)) {
    logged.add(key);
    console.info(`[cpu] profile ${key} ignored: ${reason}`);
  }
  return profile;
}

export function savePlayerProfile(store: ProfileStore, key: string, p: PlayerProfile): void {
  store.save(key, encodeProfile(p));
}
