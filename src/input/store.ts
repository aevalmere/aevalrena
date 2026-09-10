import type { Bindings, ControlsConfig } from '../core/types';
import { MAX_PLAYERS } from '../core/types';
import { ACTIONS, cloneControls } from './defaults';

const STORAGE_KEY = 'aevalrena.controls.v1';

function mergeBindings(base: Bindings, saved: unknown): Bindings {
  const out: Bindings = { ...base };
  if (typeof saved === 'object' && saved !== null) {
    const rec = saved as Record<string, unknown>;
    for (const action of ACTIONS) {
      const code = rec[action];
      if (typeof code === 'string' && code.length > 0) out[action] = code;
    }
  }
  return out;
}

/**
 * Loads the saved controls config, merged over `defaults` so any missing, stale, or malformed
 * field falls back to its default rather than breaking. Never throws.
 */
export function loadControls(defaults: ControlsConfig): ControlsConfig {
  const merged = cloneControls(defaults);
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return merged;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return merged;
    const players = (parsed as Record<string, unknown>).players;
    if (!Array.isArray(players)) return merged;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const saved = players[i] as unknown;
      if (typeof saved !== 'object' || saved === null) continue;
      const rec = saved as Record<string, unknown>;
      merged.players[i] = {
        bindings: mergeBindings(merged.players[i].bindings, rec.bindings),
        tapJump: typeof rec.tapJump === 'boolean' ? rec.tapJump : merged.players[i].tapJump,
      };
    }
  } catch {
    return cloneControls(defaults);
  }
  return merged;
}

/** Saves the controls config. Silently no-ops if localStorage is unavailable. */
export function saveControls(config: ControlsConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // localStorage may be disabled (private browsing, quota exceeded); losing the save is fine.
  }
}
