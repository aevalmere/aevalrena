/**
 * Character AI profile derivation (04 sections 2 to 4), the only way the brain learns about a
 * character: timing and reach by arithmetic on `MoveDef`, everything else by running the sim
 * (probeHit.ts, probeMotion.ts), then tags and role lists (tags.ts), then hand overrides
 * (overrides.ts). The brain reads tags and numbers, never a move id or a character name.
 *
 * Cost (plan risk R4): a cold derive runs thousands of short sims, so the result for every
 * shipped character and stage is committed in `src/characters/<id>/ai.profile.cache.json`
 * (cache.ts), keyed by profileDataHash. getAiProfile and deriveAiProfile read the cache when the
 * hash matches and derive only when it does not (a tuning slider, a balance edit). After a
 * balance edit regenerate the cache from the repo root with:
 *
 *   npx --yes tsx src/ai/charprofile/cache.ts --write
 */
import type {
  CharacterAiProfile, ComboTable, DeriveAiProfileFn, GetAiProfileFn, GrabAiInfo, KillPct, MoveAiInfo, ProfileDataHashFn,
  ShotProfile,
} from '../contracts';
import * as SIM_CONSTANTS from '../../core/constants';
import { TUNING } from '../../core/constants';
import type { CharacterDef, HitboxDef, MoveDef, MoveId, StageDef, ThrowId } from '../../core/types';
import { CHARACTER_DEFS } from '../../characters/registry';
import { grabKitOf } from '../../characters/common/grabkit';
import { STAGE_DEFS } from '../../stages/registry';
import { buildComboTableFrom, type StoredComboTable } from './combo';
import { cachedCombo, cachedEntry, decodeProfileData, overridesHash, type SerializedProfile } from './cache';
import { applyOverrides, overridesFor } from './overrides';
import {
  hasOutput, knockbackOf, probeKillPctBoth, probeLedgeCoverage, probeShieldSafety, probeThrowKillPct, shieldReached,
  strongestHitbox, timelineShots, withTuning,
} from './probeHit';
import { probeMoveRise, probeRecovery, probeShots } from './probeMotion';
import { buildRoles, minFollowStartup, MOVE_ORDER, moveTags, normalReach, styleAffinity, type TagFacts } from './tags';

/** Bump when a probe or rule changes what the same data derives to; it is part of the hash. */
export const DERIVE_VERSION = 2;

/** Victim percents of `starterWindow`: 0, 20, ..., 200. */
export const STARTER_PERCENTS: readonly number[] = [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200];
const THROW_IDS: readonly ThrowId[] = ['fthrow', 'bthrow', 'uthrow', 'dthrow'];

// ---------------------------------------------------------------------------------------------
// Data hash
// ---------------------------------------------------------------------------------------------

/** JSON with sorted keys; non-finite numbers as tokens; functions and undefined skipped. */
export function stableStringify(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : `"#${String(v)}"`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v !== 'object') return 'null';
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const arr = v as ArrayLike<unknown>;
    const parts: string[] = [];
    for (let i = 0; i < arr.length; i++) parts.push(stableStringify(arr[i]));
    return `[${parts.join(',')}]`;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const parts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const x = o[keys[i]];
    if (x === undefined || typeof x === 'function') continue;
    parts.push(`${JSON.stringify(keys[i])}:${stableStringify(x)}`);
  }
  return `{${parts.join(',')}}`;
}

/** 64-bit string hash (two 32-bit multiply-xor lanes), 16 hex digits. Integer math only. */
export function hash64(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h2) + hex(h1);
}

/** The structural sim constants (shield, dodges, ledge, respawn...); TUNING is hashed separately. */
function simConstants(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const all = SIM_CONSTANTS as unknown as Record<string, unknown>;
  const keys = Object.keys(all);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === 'TUNING' || k === 'TUNING_DEFAULTS' || typeof all[k] === 'function') continue;
    out[k] = all[k];
  }
  return out;
}

const defText = new WeakMap<object, string>();
function textOf(o: object): string {
  let t = defText.get(o);
  if (t === undefined) {
    t = stableStringify(o);
    defText.set(o, t);
  }
  return t;
}

/**
 * Hash of everything a derived profile depends on: the CharacterDef (moves, physics, grab kit,
 * Final Smash), the StageDef, TUNING, the structural constants of src/core/constants.ts and
 * DERIVE_VERSION. Defs are treated as immutable: their text is memoized per object.
 */
export const profileDataHash: ProfileDataHashFn = (def, stage, tuning) => {
  const text = `v${DERIVE_VERSION}|${textOf(def)}|${stableStringify(grabKitOf(def))}|${textOf(stage)}|${stableStringify(tuning)}|${stableStringify(simConstants())}`;
  return hash64(text);
};

// ---------------------------------------------------------------------------------------------
// Per-move numbers
// ---------------------------------------------------------------------------------------------

const NO_KILL: KillPct = { center: NaN, ledge: NaN, offstage: NaN };

function earliestHitbox(mv: MoveDef): HitboxDef | null {
  let best: HitboxDef | null = null;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const hb = mv.hitboxes[i];
    if (best === null || hb.start < best.start || (hb.start === best.start && hb.damage > best.damage)) best = hb;
  }
  return best;
}

/** The launching hitbox: the strongest one of the group that starts last (multi-hits launch on the last). */
function launcherHitbox(mv: MoveDef): HitboxDef | null {
  let lastStart = -1;
  let group = -1;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    if (mv.hitboxes[i].start > lastStart) {
      lastStart = mv.hitboxes[i].start;
      group = mv.hitboxes[i].group;
    }
  }
  if (group < 0) return null;
  const sub: MoveDef = { id: mv.id, totalFrames: mv.totalFrames, hitboxes: mv.hitboxes.filter((h) => h.group === group) };
  return strongestHitbox(sub);
}

function hitstunOf(kb: number): number {
  return Math.floor(kb * TUNING.knockback.hitstunPerKb);
}

/** R(m, f) with the aerial landing rule (04 section 2). */
function lagAfter(mv: MoveDef, f: number): number {
  const r = (mv.iasa ?? mv.totalFrames) - f - 1;
  return mv.airOnly === true && mv.landingLag !== undefined ? Math.min(r, mv.landingLag) : r;
}

function moveNumbers(def: CharacterDef, id: MoveId, shots: readonly ShotProfile[]): MoveAiInfo {
  const mv = def.moves[id];
  const total = mv.totalFrames;
  const dmgMul = TUNING.knockback.damageMul;
  const info: MoveAiInfo = {
    id, tags: [],
    startup: total, activeEnd: total, endlag: 0, landingLag: mv.landingLag ?? 0, total,
    reach: { front: 0, back: 0, up: 0, down: 0 },
    maxDamage: 0, advShield: NaN, safeShield: false, safeShieldMeasured: false,
    killPct: { ...NO_KILL }, killPctRecover: { ...NO_KILL },
    starterWindow: STARTER_PERCENTS.map(() => NaN),
    chargeable: mv.chargeable === true, charge: null,
  };
  if (mv.chargeable === true) info.charge = { maxFrames: TUNING.input.chargeMax, damageMul: 1 + TUNING.input.chargeBonus };
  if (!hasOutput(mv)) return info;

  let startup = Infinity;
  let activeEnd = -Infinity;
  const r = info.reach;
  const groupMax = new Map<number, number>();
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const hb = mv.hitboxes[i];
    startup = Math.min(startup, hb.start);
    activeEnd = Math.max(activeEnd, hb.end);
    r.front = Math.max(r.front, hb.x + hb.r);
    r.back = Math.max(r.back, -(hb.x - hb.r));
    r.up = Math.max(r.up, -(hb.y - hb.r));
    r.down = Math.max(r.down, hb.y + hb.r);
    groupMax.set(hb.group, Math.max(groupMax.get(hb.group) ?? 0, hb.damage));
  }
  let damage = 0;
  groupMax.forEach((d) => { damage += d; });
  damage *= dmgMul;
  const defs = timelineShots(mv);
  for (let i = 0; i < defs.length; i++) {
    const p = defs[i];
    const s = shots[i];
    startup = Math.min(startup, s.castFrames(0));
    activeEnd = Math.max(activeEnd, s.castFrames(0));
    const speed = s.speed(0);
    const life = s.lifetime(0);
    const out = p.returnFrame !== undefined && p.returnFrame < life ? p.returnFrame : life;
    r.front = Math.max(r.front, p.x + speed * out + p.r);
    if (p.returnFrame !== undefined && p.returnFrame < life) {
      r.back = Math.max(r.back, speed * (life - p.returnFrame) - (p.x + speed * p.returnFrame) + p.r);
    }
    r.up = Math.max(r.up, -(p.y - p.r));
    r.down = Math.max(r.down, p.y + p.r);
    damage += s.damage(0);
  }
  info.startup = startup;
  info.activeEnd = activeEnd;
  info.endlag = (mv.iasa ?? total) - startup - 1;
  info.maxDamage = damage;

  const first = earliestHitbox(mv);
  const shotFirst = first === null || (shots.length > 0 && shots[0].castFrames(0) < first.start);
  const d0 = shotFirst ? shots[0].damage(0) : (first as HitboxDef).damage * dmgMul;
  const f0 = shotFirst ? shots[0].castFrames(0) : (first as HitboxDef).start;
  info.advShield = Math.floor(d0 * SIM_CONSTANTS.SHIELD_STUN_PER_DAMAGE) + 2 - lagAfter(mv, f0);

  const launcher = launcherHitbox(mv);
  let ld: number;
  let lbkb: number;
  let lkbg: number;
  let lf: number;
  if (launcher !== null) {
    ld = launcher.damage * dmgMul;
    lbkb = launcher.bkb;
    lkbg = launcher.kbg;
    lf = launcher.start;
  } else {
    ld = shots[0].damage(0);
    lbkb = defs[0].bkb;
    lkbg = defs[0].kbg;
    lf = shots[0].castFrames(0);
  }
  const lag = lagAfter(mv, lf);
  info.starterWindow = STARTER_PERCENTS.map((p) => hitstunOf(knockbackOf(p + ld, def.weight, ld, lbkb, lkbg)) - lag);

  if (mv.chargeable === true && launcher === null && shots.length > 0 && shots[0].damage(0) > 0) {
    info.charge = { maxFrames: TUNING.input.chargeMax, damageMul: shots[0].damage(TUNING.input.chargeMax) / shots[0].damage(0) };
  }
  return info;
}

function grabInfo(def: CharacterDef, stage: StageDef): GrabAiInfo {
  const kit = grabKitOf(def);
  const throws = {} as GrabAiInfo['throws'];
  for (let i = 0; i < THROW_IDS.length; i++) {
    const t = THROW_IDS[i];
    const td = kit.throws[t];
    const d = td.damage * TUNING.knockback.damageMul;
    const lag = td.totalFrames - td.releaseFrame - 1;
    throws[t] = {
      release: td.releaseFrame, damage: d, angle: td.angle, bkb: td.bkb, kbg: td.kbg,
      killPct: probeThrowKillPct(def, def, stage, t),
      starterWindow: STARTER_PERCENTS.map((p) => hitstunOf(knockbackOf(p + d, def.weight, d, td.bkb, td.kbg)) - lag),
    };
  }
  return {
    standing: { total: kit.stand.totalFrames, active: [kit.stand.start, kit.stand.end], reach: kit.stand.x + kit.stand.r },
    dash: { total: kit.dash.totalFrames, active: [kit.dash.start, kit.dash.end], reach: kit.dash.x + kit.dash.r },
    holdBase: kit.holdBase, holdPerPercent: kit.holdPerPercent, mashFrames: kit.mashFrames,
    throws,
  };
}

// ---------------------------------------------------------------------------------------------
// Combo table (W1.5), built on first use
// ---------------------------------------------------------------------------------------------

/** Mirror-matchup brackets (04 section 5): K = lowest center kill percent of a reliable killer. */
export function mirrorBrackets(moves: Record<MoveId, MoveAiInfo>): number[] {
  let K = Infinity;
  for (let i = 0; i < MOVE_ORDER.length; i++) {
    const m = moves[MOVE_ORDER[i]];
    if (m === undefined || m.startup > 20) continue;
    if (m.tags.indexOf('killMove') < 0) continue;
    if (m.killPct.center < K) K = m.killPct.center;
  }
  if (!Number.isFinite(K)) K = 250;
  return [0, Math.round(0.3 * K), Math.round(0.6 * K), Math.round(0.85 * K), K];
}

/** A ComboTable that calls buildComboTable the first time a method needs entries. */
function lazyComboTable(profile: () => CharacterAiProfile, victim: CharacterDef, stage: StageDef, brackets: number[],
  preset: StoredComboTable | null): ComboTable {
  let built: ComboTable | null = null;
  const get = (): ComboTable => {
    if (built === null) built = buildComboTableFrom(profile(), victim, stage, brackets, preset);
    return built;
  };
  return {
    brackets,
    bracketOf: (percent) => get().bracketOf(percent),
    routes: (k) => get().routes(k),
    routesNear: (k) => { const t = get(); return t.routesNear !== undefined ? t.routesNear(k) : t.routes(k); },
    warm: (b) => { const t = get(); if (t.warm !== undefined) t.warm(b); },
    killConfirm: (starter, bracket, spot) => get().killConfirm(starter, bracket, spot),
    summary: () => get().summary(),
  };
}

// ---------------------------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------------------------

function presentMoves(def: CharacterDef): MoveId[] {
  const out: MoveId[] = [];
  for (let i = 0; i < MOVE_ORDER.length; i++) if (def.moves[MOVE_ORDER[i]] !== undefined) out.push(MOVE_ORDER[i]);
  return out;
}

function hitsLedgeMoves(def: CharacterDef, ids: readonly MoveId[]): MoveId[] {
  return ids.filter((id) => def.moves[id].hitsLedge === true);
}

function shotsByMove(all: readonly ShotProfile[], id: MoveId): ShotProfile[] {
  return all.filter((s) => s.moveId === id);
}

/** Attaches the lazy mirror combo table (built against the profile object it is attached to). */
function attachComboTable(p: CharacterAiProfile, def: CharacterDef, stage: StageDef, preset: StoredComboTable | null = null): void {
  p.comboTable = lazyComboTable(() => p, def, stage, mirrorBrackets(p.moves), preset);
}

/**
 * The derived profile before overrides, with no cache lookup: every probe runs. This is what
 * the cache stores. Deterministic: the sim is deterministic and every loop runs in MOVE_ORDER.
 */
export function deriveBaseProfile(def: CharacterDef, stage: StageDef, tuning: typeof TUNING): CharacterAiProfile {
  return withTuning(tuning, () => {
    const dataHash = profileDataHash(def, stage, tuning);
    const ids = presentMoves(def);
    const shots = probeShots(def, stage);
    const moves = {} as Record<MoveId, MoveAiInfo>;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const info = moveNumbers(def, id, shotsByMove(shots, id));
      if (hasOutput(def.moves[id])) {
        const sh = probeShieldSafety(def, stage, id);
        info.safeShieldMeasured = shieldReached(def, stage, id);
        info.safeShield = info.safeShieldMeasured ? sh.safe : info.advShield >= 0;
        const kills = probeKillPctBoth(def, def, stage, id);
        info.killPct = kills.idle;
        info.killPctRecover = kills.recover;
      }
      moves[id] = info;
    }
    const minFollow = minFollowStartup(def, moves);
    const reachRef = normalReach(moves);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const facts: TagFacts = {
        def,
        ledgeMask: probeLedgeCoverage(def, stage, id),
        rise: probeMoveRise(def, stage, id),
        minFollow,
        normalReach: reachRef,
        shots: shotsByMove(shots, id),
      };
      moves[id].tags = moveTags(id, moves[id], facts);
    }
    const profile: CharacterAiProfile = {
      charId: def.id,
      dataHash,
      physics: {
        weight: def.weight, walk: def.walkSpeed, run: def.runSpeed, dash: def.dashSpeed, dashFrames: def.dashFrames,
        airSpeed: def.airSpeed, gravity: def.gravity, maxFall: def.maxFall, fastFall: def.fastFall, jumpSquat: def.jumpSquat,
        hurtbox: { w: def.hurtbox.w, h: def.hurtbox.h },
      },
      moves,
      shots,
      grab: grabInfo(def, stage),
      recovery: probeRecovery(def, stage),
      roles: buildRoles(moves, def.hurtbox.h, def.jumpSquat, hitsLedgeMoves(def, ids)),
      comboTable: null as unknown as ComboTable,
      styleAffinity: styleAffinity(moves, shots),
    };
    attachComboTable(profile, def, stage);
    return profile;
  });
}

/** Rebuilds a profile from cached data: shot curves are re-tabulated (arithmetic, no sim run). */
export function rehydrateProfile(def: CharacterDef, stage: StageDef, data: SerializedProfile): CharacterAiProfile {
  const d = decodeProfileData(data);
  const profile: CharacterAiProfile = {
    charId: d.charId,
    dataHash: d.dataHash,
    physics: d.physics,
    moves: d.moves,
    shots: probeShots(def, stage),
    grab: d.grab,
    recovery: d.recovery,
    roles: d.roles,
    comboTable: null as unknown as ComboTable,
    styleAffinity: d.styleAffinity,
  };
  attachComboTable(profile, def, stage);
  return profile;
}

/** Cached base profile when the committed cache holds this exact hash, else a fresh derive. */
function baseProfile(def: CharacterDef, stage: StageDef, tuning: typeof TUNING, hash: string): { profile: CharacterAiProfile; cached: boolean } {
  const hit = cachedEntry(def.id, stage.id);
  if (hit !== null && hit.dataHash === hash) {
    return { profile: withTuning(tuning, () => rehydrateProfile(def, stage, hit.profile)), cached: true };
  }
  return { profile: deriveBaseProfile(def, stage, tuning), cached: false };
}

const warned = new Set<string>();
function withOverrides(base: CharacterAiProfile): CharacterAiProfile {
  const { profile, warnings } = applyOverrides(base, overridesFor(base.charId));
  for (let i = 0; i < warnings.length; i++) {
    const key = `${base.charId}|${warnings[i]}`;
    if (warned.has(key)) continue;
    warned.add(key);
    console.warn(`[ai profile ${base.charId}] ${warnings[i]}`);
  }
  return profile;
}

/**
 * 04 section 4 steps 1 to 10: the cache when the data hash matches, else a derive; then the
 * character's hand overrides (warnings printed once). Returns a new object on each call.
 */
export const deriveAiProfile: DeriveAiProfileFn = (def, stage, tuning) => {
  const hash = profileDataHash(def, stage, tuning);
  const { profile } = baseProfile(def, stage, tuning, hash);
  return finish(profile, def, stage, hash);
};

/**
 * Overrides on top, and a fresh lazy combo table so it reads the final numbers. The table's
 * canonical entries come from the committed cache when it was generated for this data hash and
 * override set (the same entries a build would make), else they build on first use.
 */
function finish(base: CharacterAiProfile, def: CharacterDef, stage: StageDef, hash: string): CharacterAiProfile {
  const p = withOverrides(base);
  attachComboTable(p, def, stage, cachedCombo(def.id, stage.id, hash, overridesHash(overridesFor(def.id))));
  return p;
}

const memo = new Map<string, { hash: string; profile: CharacterAiProfile; cached: boolean }>();

/**
 * The profile of a registered character on a registered stage under the live TUNING, memoized by
 * data hash: the committed cache on a match, a derive otherwise (a tuning change re-derives).
 */
export const getAiProfile: GetAiProfileFn = (charId, stageId) => {
  const def = CHARACTER_DEFS[charId];
  const stage = STAGE_DEFS[stageId];
  if (def === undefined) throw new Error(`getAiProfile: unknown character ${charId}`);
  if (stage === undefined) throw new Error(`getAiProfile: unknown stage ${stageId}`);
  const hash = profileDataHash(def, stage, TUNING);
  const key = `${charId}|${stageId}`;
  const m = memo.get(key);
  if (m !== undefined && m.hash === hash) return m.profile;
  const { profile, cached } = baseProfile(def, stage, TUNING, hash);
  const out = finish(profile, def, stage, hash);
  memo.set(key, { hash, profile: out, cached });
  return out;
};

/** Whether the last getAiProfile for this pair came from the committed cache (for tests and warm-up logs). */
export function profileFromCache(charId: string, stageId: string): boolean | null {
  const m = memo.get(`${charId}|${stageId}`);
  return m === undefined ? null : m.cached;
}
