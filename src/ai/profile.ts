/**
 * Where Aevalmere keeps what it learned about a player between matches (docs/CPU_AEVALMERE.md, E2).
 *
 * The store is an interface so the brain never touches browser globals directly: in the browser
 * the default is localStorage, in node (the test harness) it is an in-memory map, and a test can
 * inject its own. Only the level 10 opponent profile goes through here, under
 * `aevalrena.aevalmere.profile.v1.<name>`; nothing else is ever written.
 */
import type { MatchConfig } from '../core/types';

export interface ProfileStore {
  load(key: string): string | null;
  save(key: string, value: string): void;
}

/** A store that lives as long as the object does. The harness default and the node default. */
export class MemoryProfileStore implements ProfileStore {
  private readonly map = new Map<string, string>();
  load(key: string): string | null {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }
  save(key: string, value: string): void {
    this.map.set(key, value);
  }
  /** Every key currently held, for tests. */
  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

/**
 * localStorage, when the page has one. A read or write can throw (private mode, a full quota,
 * storage disabled by the user); the profile is an optional extra, so a failed read is "no
 * profile" and a failed write keeps the old one.
 */
function localStore(): ProfileStore {
  return {
    load(key: string): string | null {
      try {
        return localStorage.getItem(key);
      } catch (err) {
        void err;   // storage blocked: play without the profile
        return null;
      }
    },
    save(key: string, value: string): void {
      try {
        localStorage.setItem(key, value);
      } catch (err) {
        void err;   // quota or blocked storage: the previous profile stays
      }
    },
  };
}

export function defaultProfileStore(): ProfileStore {
  return typeof localStorage !== 'undefined' ? localStore() : new MemoryProfileStore();
}

export const PROFILE_PREFIX = 'aevalrena.aevalmere.profile.v1.';

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
