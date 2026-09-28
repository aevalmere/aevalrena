import type { Bindings, ControlsConfig, PlayerControls } from '../core/types';
import { MAX_PLAYERS } from '../core/types';
import { ACTIONS, cloneControls } from './defaults';

// Saves from before the chord and Smash-layout wave (keys v1 and v2) are ignored, not migrated,
// so every player gets the new defaults exactly once. They are left in storage untouched.
const STORAGE_KEY = 'aevalrena.controls.v3';

/**
 * localStorage, or null when it is missing (node, tests) or access throws (blocked site data).
 * Read through the global rather than `window` so a test can install a fake on globalThis.
 */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

/** Writes every valid saved pair (an array of exactly two strings) over `base`, in place. */
function mergeBindings(base: Bindings, saved: unknown): void {
  const rec = asRecord(saved);
  if (rec === null) return;
  for (const action of ACTIONS) {
    const pair = rec[action];
    if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
      base[action] = [pair[0], pair[1]];
    }
  }
}

function mergePlayer(base: PlayerControls, saved: unknown): void {
  const rec = asRecord(saved);
  if (rec === null) return;
  mergeBindings(base.keys, rec.keys);
  mergeBindings(base.pad, rec.pad);
  const padIndex = rec.padIndex;
  if (typeof padIndex === 'number' && Number.isInteger(padIndex) && padIndex >= -1) base.padIndex = padIndex;
  if (typeof rec.tapJump === 'boolean') base.tapJump = rec.tapJump;
}

function savedPlayers(raw: string): unknown[] | null {
  const parsed = asRecord(JSON.parse(raw) as unknown);
  if (parsed === null || !Array.isArray(parsed.players)) return null;
  return parsed.players as unknown[];
}

/**
 * Loads the saved controls config, merged over `defaults` so any missing, stale, or malformed
 * field falls back to its default rather than breaking. With no v3 save, the defaults are used
 * as they are. Never throws.
 */
export function loadControls(defaults: ControlsConfig): ControlsConfig {
  const merged = cloneControls(defaults);
  try {
    const store = storage();
    if (store === null) return merged;
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return merged;
    const players = savedPlayers(raw);
    if (players === null) return merged;
    for (let i = 0; i < MAX_PLAYERS; i++) mergePlayer(merged.players[i], players[i]);
  } catch {
    return cloneControls(defaults);
  }
  return merged;
}

/** Saves the controls config. Silently no-ops if localStorage is unavailable. */
export function saveControls(config: ControlsConfig): void {
  try {
    const store = storage();
    if (store !== null) store.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // localStorage may be disabled (private browsing, quota exceeded); losing the save is fine.
  }
}
