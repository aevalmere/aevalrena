/**
 * Hit probes for the character AI profile (04 section 2): shield safety, kill percent per spot,
 * throw kill percent, and ledge-option coverage. Every number here comes from running the real
 * sim on a private copy of the world, never from a formula alone.
 *
 * The sim looks characters, stages and projectile defs up in module registries by id. A probe
 * registers the defs it was handed under private ids for the duration of one synchronous call
 * (withProbeWorld) and restores the registries afterwards, so any CharacterDef or StageDef can be
 * probed, including an edited copy that is not in the game.
 *
 * Also the shared probe harness for probeMotion.ts (withProbeWorld, withTuning, placement).
 */
import type { KillPct, ProbeKillPctFn, ProbeShieldSafetyFn, ProbeThrowKillPctFn, Spot } from '../contracts';
import { CHARACTER_DEFS } from '../../characters/registry';
import { STAGE_DEFS } from '../../stages/registry';
import { LEDGE_MAX_REGRABS, TUNING } from '../../core/constants';
import { Btn, DIRECT_CODES } from '../../core/types';
import type {
  CharacterDef, GameState, HitboxDef, InputFrame, MatchConfig, MoveDef, MoveId, Platform, ProjectileDef,
  StageDef, ThrowId,
} from '../../core/types';
import { cloneGameState, createGameState, stepGame } from '../../sim/index';
import { PROJECTILE_DEFS } from '../../sim/projectiles';
import { startMove } from '../../sim/moves';
import { forceGrab, startThrow } from '../../sim/grab';
import { simFighters, type SimFighter } from '../../sim/state';

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

const ATK_ID = '__aiProbeAttacker';
const VIC_ID = '__aiProbeVictim';
const STAGE_ID = '__aiProbeStage';
const SETTLE_FRAMES = 10;
const NO_INPUT: InputFrame = { held: 0, pressed: 0, released: 0 };

/** Main platform geometry: the widest solid platform with a ledge. */
export interface StageGeo { main: Platform; mainIndex: number; top: number; left: number; right: number; center: number }

export function stageGeo(stage: StageDef): StageGeo {
  let best = -1;
  let bestW = -1;
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    const ledged = p.ledgeLeft || p.ledgeRight;
    const score = (p.solid ? 2 : 0) + (ledged ? 1 : 0);
    const bestScore = best < 0 ? -1 : (stage.platforms[best].solid ? 2 : 0) + (stage.platforms[best].ledgeLeft || stage.platforms[best].ledgeRight ? 1 : 0);
    if (score > bestScore || (score === bestScore && p.w > bestW)) {
      best = i;
      bestW = p.w;
    }
  }
  const main = stage.platforms[best];
  return { main, mainIndex: best, top: main.y, left: main.x, right: main.x + main.w, center: main.x + main.w / 2 };
}

/** One probe world: the defs registered, and a settled base state to clone per trial. */
export interface ProbeWorld {
  atk: CharacterDef; vic: CharacterDef; stage: StageDef; geo: StageGeo;
  base: GameState;
  /** Scratch inputs, slot 0 attacker and slot 1 victim. */
  inputs: InputFrame[];
}

function copyInto(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = src[k];
    if (v !== null && typeof v === 'object' && typeof dst[k] === 'object' && dst[k] !== null) {
      copyInto(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      dst[k] = v;
    }
  }
}

/**
 * Runs `fn` with the live TUNING object holding the values of `tuning`, then restores it. The sim
 * reads TUNING at the moment it uses a field, so this is how a probe honours a tuning argument.
 */
export function withTuning<T>(tuning: typeof TUNING, fn: () => T): T {
  if (tuning === TUNING) return fn();
  const saved = JSON.parse(JSON.stringify(TUNING)) as typeof TUNING;
  copyInto(TUNING as unknown as Record<string, unknown>, JSON.parse(JSON.stringify(tuning)) as Record<string, unknown>);
  try {
    return fn();
  } finally {
    copyInto(TUNING as unknown as Record<string, unknown>, saved as unknown as Record<string, unknown>);
  }
}

function projectileDefsOf(def: CharacterDef): ProjectileDef[] {
  const out: ProjectileDef[] = [];
  const ids = Object.keys(def.moves) as MoveId[];
  for (let m = 0; m < ids.length; m++) {
    const list = def.moves[ids[m]].projectiles;
    if (list === undefined) continue;
    for (let i = 0; i < list.length; i++) out.push(list[i]);
  }
  return out;
}

/**
 * Registers `atk` (slot 0), `vic` (slot 1) and `stage` under private ids, builds a settled base
 * state and runs `fn`. The attacker's projectile defs win an id clash with the victim's. Every
 * registry entry is restored before returning, also on a throw.
 */
export function withProbeWorld<T>(atk: CharacterDef, vic: CharacterDef, stage: StageDef, fn: (w: ProbeWorld) => T): T {
  // Critical hits are a random 1.3x roll the probe's fixed seed can land on every trial; the
  // profile's numbers are the non-crit baseline, as in sim/calibrate.ts (Trekmore's fsmash read
  // as killing at 46% instead of 118% with crits on).
  if (atk.crit !== undefined) atk = { ...atk, crit: undefined };
  if (vic.crit !== undefined) vic = { ...vic, crit: undefined };
  const prevAtk = CHARACTER_DEFS[ATK_ID];
  const prevVic = CHARACTER_DEFS[VIC_ID];
  const prevStage = STAGE_DEFS[STAGE_ID];
  const shots = projectileDefsOf(vic).concat(projectileDefsOf(atk));
  const savedShots: [string, ProjectileDef | undefined][] = [];
  for (let i = 0; i < shots.length; i++) savedShots.push([shots[i].id, PROJECTILE_DEFS[shots[i].id]]);
  CHARACTER_DEFS[ATK_ID] = atk;
  CHARACTER_DEFS[VIC_ID] = vic;
  STAGE_DEFS[STAGE_ID] = stage;
  for (let i = 0; i < shots.length; i++) PROJECTILE_DEFS[shots[i].id] = shots[i];
  try {
    const config: MatchConfig = {
      stageId: STAGE_ID,
      players: [
        { slot: 0, charId: ATK_ID, cpu: false, cpuLevel: 0 },
        { slot: 1, charId: VIC_ID, cpu: false, cpuLevel: 0 },
      ],
      stocks: 99,
      timeLimitSec: 0,
      seed: 1,
    };
    const base = createGameState(config);
    const pair = [NO_INPUT, NO_INPUT];
    for (let i = 0; i < SETTLE_FRAMES; i++) stepGame(base, pair);
    const w: ProbeWorld = {
      atk, vic, stage, geo: stageGeo(stage), base,
      inputs: [{ held: 0, pressed: 0, released: 0, direct: 0 }, { held: 0, pressed: 0, released: 0, direct: 0 }],
    };
    return fn(w);
  } finally {
    for (let i = savedShots.length - 1; i >= 0; i--) {
      const [id, prev] = savedShots[i];
      if (prev === undefined) delete PROJECTILE_DEFS[id];
      else PROJECTILE_DEFS[id] = prev;
    }
    if (prevAtk === undefined) delete CHARACTER_DEFS[ATK_ID]; else CHARACTER_DEFS[ATK_ID] = prevAtk;
    if (prevVic === undefined) delete CHARACTER_DEFS[VIC_ID]; else CHARACTER_DEFS[VIC_ID] = prevVic;
    if (prevStage === undefined) delete STAGE_DEFS[STAGE_ID]; else STAGE_DEFS[STAGE_ID] = prevStage;
  }
}

/** A fresh trial state: a clone of the settled base. */
export function trialState(w: ProbeWorld): GameState {
  return cloneGameState(w.base);
}

/** Puts a fighter at rest at (x, y), grounded or airborne, with every scratch field cleared. */
export function place(f: SimFighter, def: CharacterDef, x: number, y: number, grounded: boolean): void {
  f.x = x;
  f.y = y;
  f.prevY = y;
  f.vx = 0;
  f.vy = 0;
  f.onGround = grounded;
  f.action = grounded ? 'idle' : 'air';
  f.actionFrame = 0;
  f.moveId = null;
  f.charge = 0;
  f.charging = false;
  f.hitGroups = 0;
  f.hitstun = 0;
  f.hitlag = 0;
  f.invuln = 0;
  f.highDodge = 0;
  f.kbSpeed = 0;
  f.kbFall = 0;
  f.fastFalling = false;
  f.jumpsLeft = def.jumps;
  f.airDodgeUsed = false;
  f.ledge = -1;
  f.ledgeRegrabs = 0;
  f.ledgeCooldown = 0;
  f.stateTimer = 0;
  f.percent = 0;
  f.buffer.btn = 0;
  f.buffer.age = 0;
  f.bufDirect = 0;
  f.grabPartner = -1;
  f.grabTimer = 0;
  f.activeThrow = null;
  f.activeThrowId = null;
  f.techWindow = 0;
  f.techLockout = 0;
}

function setInput(inp: InputFrame, held: number, pressed: number, direct = 0): void {
  inp.held = held;
  inp.pressed = pressed;
  inp.released = 0;
  inp.direct = direct;
}

function dirBit(d: number): number {
  return d > 0 ? Btn.Right : Btn.Left;
}

// ---------------------------------------------------------------------------------------------
// Move geometry helpers (shared with derive.ts)
// ---------------------------------------------------------------------------------------------

/** Knockback, the sim's formula (src/sim/hits.ts), times TUNING.knockback.kbMul. */
export function knockbackOf(pAfter: number, weight: number, damage: number, bkb: number, kbg: number): number {
  const kb = ((((pAfter / 10) + (pAfter * damage / 20)) * (200 / (weight + 100)) * 1.4) + 18) * (kbg / 100) + bkb;
  return kb * TUNING.knockback.kbMul;
}

/** Spawned (timeline) projectiles of a move; burst-only defs are excluded. */
export function timelineShots(mv: MoveDef): ProjectileDef[] {
  const out: ProjectileDef[] = [];
  const list = mv.projectiles;
  if (list === undefined) return out;
  for (let i = 0; i < list.length; i++) if (list[i].spawnFrame >= 0) out.push(list[i]);
  return out;
}

export function hasOutput(mv: MoveDef): boolean {
  return mv.hitboxes.length > 0 || timelineShots(mv).length > 0;
}

/**
 * The strongest hitbox of a move: the highest knockback at 100 percent against a weight-100
 * victim, earliest start on a tie. Null for a projectile-only move.
 */
export function strongestHitbox(mv: MoveDef): HitboxDef | null {
  let best: HitboxDef | null = null;
  let bestKb = -1;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const hb = mv.hitboxes[i];
    const kb = ((((100 + hb.damage) / 10 + (100 + hb.damage) * hb.damage / 20) * 1.4) + 18) * (hb.kbg / 100) + hb.bkb;
    if (kb > bestKb + 1e-9 || (Math.abs(kb - bestKb) <= 1e-9 && best !== null && hb.start < best.start)) {
      best = hb;
      bestKb = kb;
    }
  }
  return best;
}

/** True when the move can be started on the ground (airOnly moves come from a jump). */
export function groundUsable(mv: MoveDef): boolean {
  return mv.airOnly !== true;
}

// ---------------------------------------------------------------------------------------------
// Shield safety
// ---------------------------------------------------------------------------------------------

/** Out-of-shield replies the defender tries, as button scripts (sim OOS list, 01 section 3). */
const OOS_GRAB = 0;
const OOS_USMASH = 1;
const OOS_UPB = 2;
const OOS_JUMP_NAIR = 3;
const OOS_JUMP_FAIR = 4;
const OOS_COUNT = 6;
const SHIELD_SPACINGS = 4;
const SHIELD_AIR_HEIGHTS = [6, 14, 24, 36];
const SHIELD_WINDOW = 90;

function oosInput(script: number, def: SimFighter, toward: number, inp: InputFrame): void {
  const sh = Btn.Shield;
  switch (script) {
    case OOS_GRAB: setInput(inp, sh | Btn.Grab, Btn.Grab); return;
    case OOS_USMASH: setInput(inp, sh | Btn.Up, Btn.Attack); return;
    case OOS_UPB: setInput(inp, sh | Btn.Up, Btn.Special); return;
    default: break;
  }
  // Jump aerials: jump out of shield, then the aerial once airborne.
  if (def.action === 'shield' || def.action === 'shieldStun') {
    setInput(inp, sh | Btn.Jump, Btn.Jump);
    return;
  }
  if (def.action === 'jumpsquat') {
    setInput(inp, Btn.Jump, 0);
    return;
  }
  if (def.action === 'air') {
    if (script === OOS_JUMP_NAIR) setInput(inp, Btn.Jump, Btn.Attack);
    else if (script === OOS_JUMP_FAIR) setInput(inp, Btn.Jump | dirBit(toward), Btn.Attack);
    else setInput(inp, Btn.Jump | Btn.Up, Btn.Attack);   // jump uair
    return;
  }
  setInput(inp, 0, 0);
}

/** True while the attacker is still paying for its move (before iasa, or in landing lag). */
function committed(f: SimFighter, def: CharacterDef): boolean {
  if (f.action === 'land' || f.action === 'airHelpless') return true;
  if (f.action !== 'attack' || f.moveId === null) return false;
  const mv = def.moves[f.moveId];
  return mv.iasa === undefined || f.actionFrame < mv.iasa;
}

/** Front reach of a move for spacing: hitbox edges and tap projectile travel. */
function spacingReach(mv: MoveDef): { reach: number; behind: boolean } {
  let front = 0;
  let back = 0;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const hb = mv.hitboxes[i];
    front = Math.max(front, hb.x + hb.r);
    back = Math.max(back, -(hb.x - hb.r));
  }
  const shots = timelineShots(mv);
  for (let i = 0; i < shots.length; i++) {
    const p = shots[i];
    const travel = Math.abs(p.vx) * (p.returnFrame !== undefined ? Math.min(p.returnFrame, p.lifetime) : p.lifetime);
    front = Math.max(front, p.x + travel + p.r);
  }
  const behind = back > front;
  return { reach: behind ? back : front, behind };
}

/**
 * Centre distance of spacing bucket k: from bodies touching (k = 0) out to the move's reach
 * plus the defender's half width, minus 1 px (k = SHIELD_SPACINGS - 1), evenly spaced.
 */
function shieldSpacing(def: CharacterDef, reach: number, k: number): number {
  const touch = def.hurtbox.w;
  const far = Math.max(touch, def.hurtbox.w / 2 + reach - 1);
  return touch + (far - touch) * k / (SHIELD_SPACINGS - 1);
}

interface ShieldTrial { touched: boolean; punished: boolean }

function shieldTrial(w: ProbeWorld, id: MoveId, dist: number, airHeight: number, behind: boolean, script: number): ShieldTrial {
  const state = trialState(w);
  const [atk, dfn] = simFighters(state);
  const g = w.geo;
  const airborne = w.atk.moves[id].airOnly === true;
  const atkX = g.center - dist / 2;
  place(atk, w.atk, atkX, airborne ? g.top - airHeight : g.top, !airborne);
  place(dfn, w.vic, atkX + dist, g.top, true);
  atk.facing = behind ? -1 : 1;
  dfn.facing = -1;
  dfn.action = 'shield';
  startMove(state, atk, w.atk, id);
  const out: ShieldTrial = { touched: false, punished: false };
  const [ai, di] = w.inputs;
  setInput(ai, 0, 0);
  let react = false;
  for (let t = 0; t < SHIELD_WINDOW; t++) {
    if (react) oosInput(script, dfn, -1, di);
    else setInput(di, Btn.Shield, 0);
    // Read before the step: a hit or a catch replaces the attacker's action.
    const wasCommitted = committed(atk, w.atk);
    stepGame(state, w.inputs);
    const ev = state.events;
    for (let e = 0; e < ev.length; e++) {
      const x = ev[e];
      if (x.type === 'shieldHit' && x.victim === 1) {
        out.touched = true;
        react = true;
      }
      const hitAtk = (x.type === 'hit' && x.victim === 0) || (x.type === 'grab' && x.victim === 0);
      if (hitAtk && wasCommitted) out.punished = true;
    }
    if (out.punished) break;
    if (!react && t > 8 && atk.action !== 'attack' && atk.action !== 'land' && !projectileAlive(state, 0)) break;
    if (react && !committed(atk, w.atk) && t > 4) {
      // The attacker is free; a later hit is not a punish of this move.
      if (atk.action !== 'attack' && atk.action !== 'land') break;
    }
  }
  return out;
}

function projectileAlive(state: GameState, owner: number): boolean {
  for (let i = 0; i < state.projectiles.length; i++) {
    const p = state.projectiles[i];
    if (p.alive && p.owner === owner) return true;
  }
  return false;
}

/**
 * Shield safety by probe (04 section 2): a shielding copy of the attacker answers on its first
 * free frame with each out-of-shield option in turn (grab, up smash, up special, jump nair, jump
 * fair, jump uair). `bySpacing[k]` is true when the move reaches the shield at spacing bucket k
 * (shieldSpacing: bodies touching out to the tip) and no option hits the attacker while it is still committed
 * (before iasa or in landing lag). `safe` is true when some reaching spacing is safe.
 */
export const probeShieldSafety: ProbeShieldSafetyFn = (def, stage, id) => {
  const mv = def.moves[id];
  const bySpacing: boolean[] = [];
  for (let k = 0; k < SHIELD_SPACINGS; k++) bySpacing.push(false);
  if (!hasOutput(mv)) return { safe: false, bySpacing };
  return withProbeWorld(def, def, stage, (w) => {
    const { reach, behind } = spacingReach(mv);
    let anySafe = false;
    for (let k = 0; k < SHIELD_SPACINGS; k++) {
      const dist = shieldSpacing(def, reach, k);
      const heights = mv.airOnly === true ? SHIELD_AIR_HEIGHTS : [0];
      for (let hIdx = 0; hIdx < heights.length; hIdx++) {
        let touched = false;
        let punished = false;
        for (let s = 0; s < OOS_COUNT && !punished; s++) {
          const r = shieldTrial(w, id, dist, heights[hIdx], behind, s);
          if (!r.touched) break;
          touched = true;
          if (r.punished) punished = true;
        }
        if (!touched) continue;
        bySpacing[k] = !punished;
        if (!punished) anySafe = true;
        break;
      }
    }
    return { safe: anySafe, bySpacing };
  });
};

/** Whether the move reached a shield at any probed spacing (for safeShieldMeasured). */
export function shieldReached(def: CharacterDef, stage: StageDef, id: MoveId): boolean {
  const mv = def.moves[id];
  if (!hasOutput(mv)) return false;
  return withProbeWorld(def, def, stage, (w) => {
    const { reach, behind } = spacingReach(mv);
    const heights = mv.airOnly === true ? SHIELD_AIR_HEIGHTS : [0];
    for (let k = 0; k < SHIELD_SPACINGS; k++) {
      const dist = shieldSpacing(def, reach, k);
      for (let h = 0; h < heights.length; h++) {
        if (shieldTrial(w, id, dist, heights[h], behind, OOS_GRAB).touched) return true;
      }
    }
    return false;
  });
}

// ---------------------------------------------------------------------------------------------
// Kill percent
// ---------------------------------------------------------------------------------------------

const KO_FRAMES = 240;
const KILL_MAX = 250;
const AIR_HEIGHT = 30;
/** Center placements, the same list and order as src/sim/calibrate.ts (bc: within 2 percent). */
const PLACEMENTS: { gap: number; lift: number }[] = [
  { gap: 40, lift: 0 },
  { gap: 26, lift: 0 },
  { gap: 0, lift: 0 },
  { gap: 0, lift: 44 },
];
const CENTER_ATTACKER_OFFSET = -20;
const LEDGE_INSET = 12;
const OFFSTAGE_OUT = 40;
const OFFSTAGE_BELOW = 30;
const AIM_DY = [0, -10, 10, -20, 20];

/** Absolute placement of one kill trial. */
interface Setup { atkX: number; atkY: number; atkGround: boolean; facing: 1 | -1; vicX: number; vicY: number; vicGround: boolean }

interface KillTrial { ko: boolean; hit: boolean; dirX: number }

/**
 * The scripted best-recovery victim (active once hit): nothing during hitstun, then a press toward the stage to
 * leave tumble, drift toward the stage, midair jumps when falling near ledge height, up special
 * when out of jumps and below the ledge. Button scripts only, so it works for any character.
 */
function recoverInput(f: SimFighter, g: StageGeo, inp: InputFrame, upbUsed: boolean): boolean {
  setInput(inp, 0, 0);
  if (f.hitlag > 0 || f.hitstun > 0 || f.onGround) return upbUsed;
  if (f.action === 'ledgeHang' || f.action === 'ledgeGrab' || f.action === 'dead' || f.action === 'respawn') return upbUsed;
  const over = f.x > g.left && f.x < g.right;
  let dir = f.x < g.center ? 1 : -1;
  if (over && f.y > g.top) dir = f.x < g.center ? -1 : 1;   // under the stage: get out first
  if (over && f.y <= g.top) return upbUsed;                  // above the stage: fall onto it
  const held = dirBit(dir);
  if (f.action === 'tumble' || f.action === 'hitstun') {
    setInput(inp, held, held);
    return upbUsed;
  }
  if (f.action !== 'air') {
    setInput(inp, held, 0);
    return upbUsed;
  }
  if (f.jumpsLeft > 0 && f.vy >= 0 && f.y > g.top - 40) {
    setInput(inp, held, Btn.Jump);
    return upbUsed;
  }
  if (f.jumpsLeft === 0 && !upbUsed && f.vy >= 0 && f.y > g.top + 10) {
    setInput(inp, held | Btn.Up, Btn.Special);
    return true;
  }
  setInput(inp, held, 0);
  return upbUsed;
}

function killTrial(w: ProbeWorld, id: MoveId, s: Setup, percent: number, recover: boolean): KillTrial {
  const state = trialState(w);
  const [atk, vic] = simFighters(state);
  place(atk, w.atk, s.atkX, s.atkY, s.atkGround);
  place(vic, w.vic, s.vicX, s.vicY, s.vicGround);
  atk.facing = s.facing;
  vic.facing = s.facing === 1 ? -1 : 1;
  vic.percent = percent;
  startMove(state, atk, w.atk, id);
  const out: KillTrial = { ko: false, hit: false, dirX: 0 };
  const [ai, vi] = w.inputs;
  setInput(ai, 0, 0);
  setInput(vi, 0, 0);
  let upb = false;
  let bestKb = -1;
  for (let t = 0; t < KO_FRAMES; t++) {
    // The recovering victim holds still until the move has hit it.
    if (recover && out.hit) upb = recoverInput(vic, w.geo, vi, upb);
    stepGame(state, w.inputs);
    const ev = state.events;
    for (let e = 0; e < ev.length; e++) {
      const x = ev[e];
      if (x.type === 'hit' && x.victim === 1) {
        out.hit = true;
        if (x.kb > bestKb) {
          bestKb = x.kb;
          const c = Math.cos((x.angle * Math.PI) / 180);
          out.dirX = c > 0.05 ? 1 : c < -0.05 ? -1 : 0;
        }
      }
      if (x.type === 'ko' && x.slot === 1) out.ko = true;
    }
    if (out.ko) break;
    const atkDone = atk.action !== 'attack' && !projectileAlive(state, 0);
    if (!atkDone) continue;
    if (!out.hit) break;
    const settled = vic.hitstun === 0 && vic.hitlag === 0 && vic.action !== 'tumble' && vic.action !== 'hitstun';
    if (settled && (vic.onGround || vic.action === 'ledgeHang')) break;
  }
  return out;
}

function lowestKo(ko: (p: number) => boolean): number {
  if (!ko(KILL_MAX)) return NaN;
  let lo = 0;
  let hi = KILL_MAX;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ko(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function centerSetup(w: ProbeWorld, mv: MoveDef, pl: { gap: number; lift: number }): Setup {
  const g = w.geo;
  const airborne = mv.airOnly === true;
  const atkX = g.center + CENTER_ATTACKER_OFFSET;
  const atkY = airborne ? g.top - AIR_HEIGHT : g.top;
  const vicY = pl.lift === 0 ? g.top : atkY - pl.lift;
  return { atkX, atkY, atkGround: !airborne, facing: 1, vicX: atkX + pl.gap, vicY, vicGround: pl.lift === 0 };
}

/** The center setup mirrored as needed and moved so the victim stands LEDGE_INSET inside the launch-side ledge. */
function ledgeSetup(w: ProbeWorld, mv: MoveDef, pl: { gap: number; lift: number }, launchDir: number): Setup {
  const g = w.geo;
  const c = centerSetup(w, mv, pl);
  // Orient so the launch goes toward the right ledge, then place the victim by it.
  const facing: 1 | -1 = launchDir < 0 ? -1 : 1;
  const rel = (c.atkX - c.vicX) * facing;
  // Launch goes right in world terms after orienting: facing 1 with right launch, or facing -1
  // with a left launch at facing 1 (which becomes right when mirrored).
  let vicX = g.right - LEDGE_INSET;
  let atkX = vicX + rel;
  if (c.atkGround && atkX > g.right - 1) {
    atkX = g.right - 1;
    vicX = atkX - rel;
  }
  return { atkX, atkY: c.atkY, atkGround: c.atkGround, facing, vicX, vicY: c.vicY, vicGround: c.vicGround };
}

/** Frames of free fall from rest: total drop after n frames. */
function fallAfter(def: CharacterDef, n: number): number {
  let vy = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    vy = Math.min(vy + def.gravity, Math.max(def.maxFall, vy));
    y += vy;
  }
  return y;
}

/**
 * Offstage: the victim airborne OFFSTAGE_OUT px beyond the launch-side corner and OFFSTAGE_BELOW px
 * below the ledge, at rest. The attacker is aimed so the move's strongest hitbox (or its first
 * shot) is centred on the victim's body on its first active frame. Ground-only moves stand at
 * the edge. Returns null when the move cannot be aimed at an offstage victim.
 */
function offstageSetup(w: ProbeWorld, mv: MoveDef, launchDir: number, dyAdj: number): Setup | null {
  const g = w.geo;
  const facing: 1 | -1 = launchDir < 0 ? -1 : 1;
  const hb = strongestHitbox(mv);
  let hx: number;
  let hy: number;
  let at: number;
  if (hb !== null) {
    hx = hb.x;
    hy = hb.y;
    at = hb.start;
  } else {
    const shots = timelineShots(mv);
    if (shots.length === 0) return null;
    const p = shots[0];
    hx = p.x + Math.abs(p.vx) * 6;
    hy = p.y;
    at = p.spawnFrame + 6;
  }
  const half = w.vic.hurtbox.h / 2;
  // The victim sits beyond the right corner; the orientation mirrors the move so it launches right.
  let vicX = g.right + OFFSTAGE_OUT;
  let vicY = g.top + OFFSTAGE_BELOW + dyAdj;
  const vicFall = fallAfter(w.vic, at);
  if (mv.groundOnly === true) {
    let atkX = vicX - facing * hx;
    if (atkX > g.right - 1) {
      atkX = g.right - 1;
      vicX = atkX + facing * hx;
    }
    if (vicX - w.vic.hurtbox.w / 2 <= g.right) return null;
    vicY = g.top + hy + half - vicFall + dyAdj;
    return { atkX, atkY: g.top, atkGround: true, facing, vicX, vicY, vicGround: false };
  }
  const atkFall = fallAfter(w.atk, at);
  const atkY = vicY + vicFall - atkFall - half - hy;
  return { atkX: vicX - facing * hx, atkY, atkGround: false, facing, vicX, vicY, vicGround: false };
}

interface KillPlan { center: Setup | null; ledge: Setup | null; offstage: Setup[] }

function killPlan(w: ProbeWorld, id: MoveId): KillPlan {
  const mv = w.atk.moves[id];
  let pick: { gap: number; lift: number } | null = null;
  let dir = 1;
  for (let i = 0; i < PLACEMENTS.length; i++) {
    const r = killTrial(w, id, centerSetup(w, mv, PLACEMENTS[i]), 0, false);
    if (r.hit) {
      pick = PLACEMENTS[i];
      break;
    }
  }
  if (pick === null) return { center: null, ledge: null, offstage: [] };
  const c = centerSetup(w, mv, pick);
  const probe = killTrial(w, id, c, 100, false);
  if (probe.dirX !== 0) dir = probe.dirX;
  const offs: Setup[] = [];
  for (let i = 0; i < AIM_DY.length; i++) {
    const s = offstageSetup(w, mv, dir, AIM_DY[i]);
    if (s !== null) offs.push(s);
  }
  return { center: c, ledge: ledgeSetup(w, mv, pick, dir), offstage: offs };
}

function killAt(w: ProbeWorld, id: MoveId, plan: KillPlan, spot: Spot, recover: boolean): number {
  if (spot === 'center') return plan.center === null ? NaN : lowestKo((p) => killTrial(w, id, plan.center as Setup, p, recover).ko);
  if (spot === 'ledge') return plan.ledge === null ? NaN : lowestKo((p) => killTrial(w, id, plan.ledge as Setup, p, recover).ko);
  for (let i = 0; i < plan.offstage.length; i++) {
    const s = plan.offstage[i];
    if (!killTrial(w, id, s, 0, recover).hit) continue;
    return lowestKo((p) => killTrial(w, id, s, p, recover).ko);
  }
  return NaN;
}

function killPctIn(w: ProbeWorld, id: MoveId, recover: boolean, plan?: KillPlan): KillPct {
  const p = plan ?? killPlan(w, id);
  return {
    center: killAt(w, id, p, 'center', recover),
    ledge: killAt(w, id, p, 'ledge', recover),
    offstage: killAt(w, id, p, 'offstage', recover),
  };
}

/**
 * Kill percent per spot (04 section 2): the lowest victim percent in [0, 250] at which the move,
 * started through the real hit path, sends the victim past `stage.blast` within 240 frames; NaN
 * when it never does. `recover` false: the victim never presses anything (the calibrate.ts
 * victim, so center matches `measure`). `recover` true: the scripted best-recovery victim.
 * center: the calibrate.ts placement at the main platform's middle. ledge: the same placement,
 * oriented and moved so the victim stands 12 px inside the ledge it is launched toward. offstage:
 * the victim at rest 40 px beyond that ledge and 30 px below its top, the move aimed at it.
 * An offstage victim that does nothing falls to its death, so the no-input offstage value is
 * the percent at which the move connects there; the brain reads `killPctRecover` for offstage.
 */
export const probeKillPct: ProbeKillPctFn = (def, victim, stage, id, recover) => {
  const mv = def.moves[id];
  if (!hasOutput(mv)) return { center: NaN, ledge: NaN, offstage: NaN };
  return withProbeWorld(def, victim, stage, (w) => killPctIn(w, id, recover));
};

/** Both kill tables in one world (the placement search runs once). */
export function probeKillPctBoth(def: CharacterDef, victim: CharacterDef, stage: StageDef, id: MoveId): { idle: KillPct; recover: KillPct } {
  const mv = def.moves[id];
  if (!hasOutput(mv)) {
    return { idle: { center: NaN, ledge: NaN, offstage: NaN }, recover: { center: NaN, ledge: NaN, offstage: NaN } };
  }
  return withProbeWorld(def, victim, stage, (w) => {
    const plan = killPlan(w, id);
    return { idle: killPctIn(w, id, false, plan), recover: killPctIn(w, id, true, plan) };
  });
}

// ---------------------------------------------------------------------------------------------
// Throw kill percent
// ---------------------------------------------------------------------------------------------

const THROW_LEDGE_INSET = 30;

function throwTrial(w: ProbeWorld, t: ThrowId, x: number, facing: 1 | -1, percent: number): boolean {
  const state = trialState(w);
  const [atk, vic] = simFighters(state);
  const g = w.geo;
  place(atk, w.atk, x, g.top, true);
  place(vic, w.vic, x + facing * 20, g.top, true);
  atk.facing = facing;
  vic.facing = facing === 1 ? -1 : 1;
  vic.percent = percent;
  if (!forceGrab(state, atk, vic)) return false;
  startThrow(state, atk, t);
  const [ai, vi] = w.inputs;
  setInput(ai, 0, 0);
  setInput(vi, 0, 0);
  let upb = false;
  let released = false;
  for (let i = 0; i < KO_FRAMES; i++) {
    upb = recoverInput(vic, g, vi, upb);
    stepGame(state, w.inputs);
    const ev = state.events;
    for (let e = 0; e < ev.length; e++) {
      const x2 = ev[e];
      if (x2.type === 'ko' && x2.slot === 1) return true;
      if (x2.type === 'throw' && x2.victim === 1) released = true;
    }
    if (!released) continue;
    const settled = vic.hitstun === 0 && vic.hitlag === 0 && vic.action !== 'tumble' && vic.action !== 'hitstun';
    if (settled && (vic.onGround || vic.action === 'ledgeHang')) return false;
  }
  return false;
}

/**
 * Throw kill percent: the holder grabs a victim standing 20 px ahead and throws `t`. The thrown
 * victim always gets to act, so this uses the scripted best-recovery victim. center: from the
 * main platform's middle. ledge: the holder THROW_LEDGE_INSET px inside a ledge, both facings,
 * the lower percent kept. offstage: NaN (a grab needs a grounded victim).
 */
export const probeThrowKillPct: ProbeThrowKillPctFn = (def, victim, stage, t) => withProbeWorld(def, victim, stage, (w) => {
  const g = w.geo;
  const center = minDefined(
    lowestKo((p) => throwTrial(w, t, g.center, 1, p)),
    lowestKo((p) => throwTrial(w, t, g.center, -1, p)),
  );
  const ledge = minDefined(
    lowestKo((p) => throwTrial(w, t, g.right - THROW_LEDGE_INSET, 1, p)),
    lowestKo((p) => throwTrial(w, t, g.right - THROW_LEDGE_INSET, -1, p)),
  );
  return { center, ledge, offstage: NaN };
});

function minDefined(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return Math.min(a, b);
}

// ---------------------------------------------------------------------------------------------
// Ledge-option coverage (ledgeTrapTool)
// ---------------------------------------------------------------------------------------------

/** Bits of probeLedgeCoverage's mask. */
export const LEDGE_OPT_CLIMB = 1;
export const LEDGE_OPT_ATTACK = 2;
export const LEDGE_OPT_ROLL = 4;
export const LEDGE_OPT_JUMP = 8;
const LEDGE_SPACINGS = [30, 55, 80];
const LEDGE_DELAY_MAX = 44;
const LEDGE_DELAY_STEP = 4;
const LEDGE_WINDOW = 80;
const LEDGE_JUMP_CODE = DIRECT_CODES.indexOf('ledgeJump') + 1;

function ledgeTrial(w: ProbeWorld, id: MoveId, option: number, spacing: number, delay: number): boolean {
  const state = trialState(w);
  const [atk, vic] = simFighters(state);
  const g = w.geo;
  place(atk, w.atk, g.right - spacing, g.top, true);
  atk.facing = 1;
  place(vic, w.vic, g.right, g.top + 20, false);
  vic.action = 'ledgeHang';
  vic.ledge = g.mainIndex * 2 + 1;
  vic.facing = -1;
  vic.ledgeRegrabs = LEDGE_MAX_REGRABS + 1;
  const [ai, vi] = w.inputs;
  setInput(ai, 0, 0);
  for (let t = 0; t < LEDGE_WINDOW; t++) {
    if (t === 0) {
      if (option === LEDGE_OPT_CLIMB) setInput(vi, Btn.Jump, Btn.Jump);
      else if (option === LEDGE_OPT_ATTACK) setInput(vi, Btn.Attack, Btn.Attack);
      else if (option === LEDGE_OPT_ROLL) setInput(vi, Btn.Shield, Btn.Shield);
      else setInput(vi, 0, 0, LEDGE_JUMP_CODE);
    } else {
      setInput(vi, 0, 0);
    }
    if (t === delay) {
      if (atk.action !== 'idle') return false;
      startMove(state, atk, w.atk, id);
    }
    stepGame(state, w.inputs);
    const ev = state.events;
    for (let e = 0; e < ev.length; e++) {
      const x = ev[e];
      if (x.type === 'hit' && x.victim === 1) return true;
    }
    if (t > delay && atk.action !== 'attack' && !projectileAlive(state, 0)) return false;
  }
  return false;
}

/**
 * Which of the four ledge options (climb, attack, roll, jump) the move hits when started from
 * the stage at 30, 55 or 80 px from the ledge at some delay 0 to 44 frames after the option is
 * pressed by a hanger with no ledge invulnerability left. Returns a mask of LEDGE_OPT_* bits.
 */
export function probeLedgeCoverage(def: CharacterDef, stage: StageDef, id: MoveId): number {
  const mv = def.moves[id];
  if (!hasOutput(mv) || !groundUsable(mv)) return 0;
  return withProbeWorld(def, def, stage, (w) => {
    let mask = 0;
    const opts = [LEDGE_OPT_CLIMB, LEDGE_OPT_ATTACK, LEDGE_OPT_ROLL, LEDGE_OPT_JUMP];
    for (let o = 0; o < opts.length; o++) {
      let hit = false;
      for (let s = 0; s < LEDGE_SPACINGS.length && !hit; s++) {
        for (let d = 0; d <= LEDGE_DELAY_MAX && !hit; d += LEDGE_DELAY_STEP) {
          if (ledgeTrial(w, id, opts[o], LEDGE_SPACINGS[s], d)) hit = true;
        }
      }
      if (hit) mask |= opts[o];
    }
    return mask;
  });
}
