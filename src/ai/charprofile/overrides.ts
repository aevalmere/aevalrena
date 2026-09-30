/**
 * Hand overrides on top of the derived profile (04 sections 4 and 8).
 *
 * Overrides live next to each character as `src/characters/<id>/ai.overrides.json` and are listed
 * in OVERRIDE_FILES below. Hand values win. A number that moves more than CONTRADICTION_MARGIN
 * away from the derived one is applied and reported in `warnings`, so a stale override shows up
 * after a balance edit instead of silently fighting the data.
 */
import type { ApplyOverridesFn, CharacterAiOverrides, CharacterAiProfile, MoveAiInfo, MoveTag, ShotProfile } from '../contracts';
import type { MoveId } from '../../core/types';
// JSON modules are bundled by Vite and loaded by tsx; tsconfig has no resolveJsonModule.
// @ts-ignore
import aevalOverrides from '../../characters/aeval/ai.overrides.json';
// @ts-ignore
import trekmoreOverrides from '../../characters/trekmore/ai.overrides.json';
import { buildRoles, MOVE_ORDER } from './tags';

/** Override files by character id. A new character adds its file here. */
const OVERRIDE_FILES: Record<string, unknown> = {
  aeval: aevalOverrides,
  trekmore: trekmoreOverrides,
};

/** Relative change above which an overridden number is reported as a contradiction. */
export const CONTRADICTION_MARGIN = 0.1;

const ALL_TAGS: readonly MoveTag[] = ['poke', 'antiAir', 'comboStarter', 'extender', 'killMove', 'spike', 'gimpTool',
  'oosOption', 'ledgeTrapTool', 'projectile', 'getOffMe', 'recovery', 'landingOption', 'commandGrab'];

/** The override object for a character, or an empty one. */
export function overridesFor(charId: string): CharacterAiOverrides {
  const raw = OVERRIDE_FILES[charId];
  if (raw === undefined || raw === null || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  // A "$comment" key documents the file and is not an override.
  const out: Record<string, unknown> = {};
  const keys = Object.keys(o);
  for (let i = 0; i < keys.length; i++) if (keys[i] !== '$comment') out[keys[i]] = o[keys[i]];
  return out as CharacterAiOverrides;
}

function contradicts(derived: number, hand: number): boolean {
  if (!Number.isFinite(derived) || !Number.isFinite(hand)) return Number.isNaN(derived) !== Number.isNaN(hand);
  const scale = Math.max(Math.abs(derived), 1e-9);
  return Math.abs(hand - derived) / scale > CONTRADICTION_MARGIN;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * Deep-assigns plain override data onto `dst` (already a private copy), reporting numbers that
 * contradict the derived value. Functions on `dst` (shot profile curves) take a number as a
 * constant curve, checked against their value at 0.
 */
function mergeInto(dst: Record<string, unknown>, src: Record<string, unknown>, path: string, warnings: string[]): void {
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const hand = src[k];
    const here = `${path}.${k}`;
    if (!(k in dst)) {
      warnings.push(`override ${here}: no such field in the derived profile, ignored`);
      continue;
    }
    const cur = dst[k];
    if (typeof cur === 'function') {
      if (typeof hand !== 'number') {
        warnings.push(`override ${here}: expected a number for a curve, ignored`);
        continue;
      }
      const at0 = (cur as (h: number, p?: number) => number)(0, 0);
      if (contradicts(at0, hand)) warnings.push(`override ${here}: ${fmt(hand)} contradicts derived ${fmt(at0)} (at h 0) by more than ${CONTRADICTION_MARGIN * 100}%`);
      dst[k] = () => hand;
      continue;
    }
    if (cur instanceof Float32Array) {
      if (hand === null || typeof hand !== 'object') {
        warnings.push(`override ${here}: expected an array or index map, ignored`);
        continue;
      }
      const idx = Object.keys(hand as object);
      for (let j = 0; j < idx.length; j++) {
        const n = Number(idx[j]);
        const v = (hand as Record<string, unknown>)[idx[j]];
        if (!(n >= 0 && n < cur.length) || typeof v !== 'number') continue;
        if (contradicts(cur[n], v)) warnings.push(`override ${here}[${n}]: ${fmt(v)} contradicts derived ${fmt(cur[n])} by more than ${CONTRADICTION_MARGIN * 100}%`);
        cur[n] = v;
      }
      continue;
    }
    if (cur !== null && typeof cur === 'object') {
      if (hand === null || typeof hand !== 'object') {
        warnings.push(`override ${here}: expected an object, ignored`);
        continue;
      }
      mergeInto(cur as Record<string, unknown>, hand as Record<string, unknown>, here, warnings);
      continue;
    }
    if (typeof cur === 'number') {
      const v = hand === null ? NaN : hand;   // JSON has no NaN: null stands for it
      if (typeof v !== 'number') {
        warnings.push(`override ${here}: expected a number, ignored`);
        continue;
      }
      if (contradicts(cur, v)) warnings.push(`override ${here}: ${fmt(v)} contradicts derived ${fmt(cur)} by more than ${CONTRADICTION_MARGIN * 100}%`);
      dst[k] = v;
      continue;
    }
    if (typeof cur !== typeof hand) {
      warnings.push(`override ${here}: type ${typeof hand} does not match ${typeof cur}, ignored`);
      continue;
    }
    dst[k] = hand;
  }
}

function cloneMove(m: MoveAiInfo): MoveAiInfo {
  return {
    id: m.id, tags: m.tags.slice(),
    startup: m.startup, activeEnd: m.activeEnd, endlag: m.endlag, landingLag: m.landingLag, total: m.total,
    reach: { front: m.reach.front, back: m.reach.back, up: m.reach.up, down: m.reach.down },
    maxDamage: m.maxDamage, advShield: m.advShield, safeShield: m.safeShield, safeShieldMeasured: m.safeShieldMeasured,
    killPct: { center: m.killPct.center, ledge: m.killPct.ledge, offstage: m.killPct.offstage },
    killPctRecover: { center: m.killPctRecover.center, ledge: m.killPctRecover.ledge, offstage: m.killPctRecover.offstage },
    starterWindow: m.starterWindow.slice(),
    chargeable: m.chargeable, charge: m.charge === null ? null : { maxFrames: m.charge.maxFrames, damageMul: m.charge.damageMul },
  };
}

/** Deep copy of plain data (no functions); Float32Array copied. */
function clonePlain<T>(v: T): T {
  if (v instanceof Float32Array) return new Float32Array(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => clonePlain(x)) as unknown as T;
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(v as object);
    for (let i = 0; i < keys.length; i++) out[keys[i]] = clonePlain((v as Record<string, unknown>)[keys[i]]);
    return out as T;
  }
  return v;
}

/**
 * Hand values over a derived profile. Returns a new profile (the input is not touched) with
 * tags added and removed, numbers replaced, role lists rebuilt from the new tags, and
 * `overrides` set to `o`; `warnings` lists every contradiction and every entry that was ignored.
 * The combo table object is carried over as is.
 */
export const applyOverrides: ApplyOverridesFn = (p, o) => {
  const warnings: string[] = [];
  const moves = {} as Record<MoveId, MoveAiInfo>;
  for (let i = 0; i < MOVE_ORDER.length; i++) {
    const id = MOVE_ORDER[i];
    if (p.moves[id] !== undefined) moves[id] = cloneMove(p.moves[id]);
  }
  const shots: ShotProfile[] = [];
  for (let i = 0; i < p.shots.length; i++) shots.push({ ...p.shots[i] });
  const out: CharacterAiProfile = {
    charId: p.charId, dataHash: p.dataHash,
    physics: clonePlain(p.physics),
    moves, shots,
    grab: clonePlain(p.grab),
    recovery: clonePlain(p.recovery),
    roles: clonePlain(p.roles),
    comboTable: p.comboTable,
    styleAffinity: clonePlain(p.styleAffinity),
    overrides: o,
  };

  const tagEdits = o.tags ?? {};
  const tagIds = Object.keys(tagEdits) as MoveId[];
  for (let i = 0; i < tagIds.length; i++) {
    const id = tagIds[i];
    const edit = tagEdits[id];
    const m = moves[id];
    if (m === undefined || edit === undefined) {
      warnings.push(`override tags.${id}: unknown move, ignored`);
      continue;
    }
    const add = edit.add ?? [];
    const remove = edit.remove ?? [];
    for (let j = 0; j < remove.length; j++) {
      const at = m.tags.indexOf(remove[j]);
      if (at >= 0) m.tags.splice(at, 1);
      else warnings.push(`override tags.${id}.remove: ${remove[j]} was not derived`);
    }
    for (let j = 0; j < add.length; j++) {
      if (ALL_TAGS.indexOf(add[j]) < 0) {
        warnings.push(`override tags.${id}.add: unknown tag ${add[j]}, ignored`);
        continue;
      }
      if (m.tags.indexOf(add[j]) < 0) m.tags.push(add[j]);
    }
    // Keep the canonical tag order so equal tag sets compare equal.
    m.tags.sort((a, b) => ALL_TAGS.indexOf(a) - ALL_TAGS.indexOf(b));
  }

  const num = o.numbers;
  if (num !== undefined) {
    if (num.moves !== undefined) mergeInto(moves as unknown as Record<string, unknown>, num.moves as Record<string, unknown>, 'numbers.moves', warnings);
    if (num.shots !== undefined) mergeInto(shots as unknown as Record<string, unknown>, num.shots as unknown as Record<string, unknown>, 'numbers.shots', warnings);
    if (num.grab !== undefined) mergeInto(out.grab as unknown as Record<string, unknown>, num.grab as Record<string, unknown>, 'numbers.grab', warnings);
    if (num.recovery !== undefined) mergeInto(out.recovery as unknown as Record<string, unknown>, num.recovery as Record<string, unknown>, 'numbers.recovery', warnings);
  }

  // Moves in ledgeTrap without the tag are the hitsLedge ones; they stay whatever the tags say.
  const extra: MoveId[] = [];
  for (let i = 0; i < p.roles.ledgeTrap.length; i++) {
    const id = p.roles.ledgeTrap[i];
    if (p.moves[id].tags.indexOf('ledgeTrapTool') < 0) extra.push(id);
  }
  out.roles = buildRoles(moves, out.physics.hurtbox.h, out.physics.jumpSquat, extra);
  return { profile: out, warnings };
};

export { ALL_TAGS };
