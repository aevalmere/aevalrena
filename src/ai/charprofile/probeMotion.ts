/**
 * Motion probes for the character AI profile (04 section 2): jump rise, up special, air dodge
 * displacement, the recover box, fall time to the blast line, per-move rise, and shot profiles.
 * Motion comes from running the sim on a private world (probeHit.ts harness); shot profiles are
 * tabulated from the sim's own projectile functions, so they need no run.
 */
import type { ProbeRecoveryFn, ProbeShotsFn, RecoveryProfile, ShotProfile } from '../contracts';
import { hitlagFrames, SHIELD_STUN_PER_DAMAGE, TUNING } from '../../core/constants';
import { Btn } from '../../core/types';
import type { CharacterDef, InputFrame, MoveId, ProjectileDef, StageDef } from '../../core/types';
import { stepGame } from '../../sim/index';
import { chargedStat } from '../../sim/projectiles';
import { chargeFraction, chargesPower, projectileChargePower, projectileChargeScale } from '../../sim/hits';
import { startMove } from '../../sim/moves';
import { simFighters, type SimFighter } from '../../sim/state';
import { knockbackOf, place, timelineShots, trialState, withProbeWorld, type ProbeWorld, type StageGeo } from './probeHit';

const HIGH = 260;          // px above the main platform top for free-air probes
const RISE_FRAMES = 120;

function setInput(inp: InputFrame, held: number, pressed: number): void {
  inp.held = held;
  inp.pressed = pressed;
  inp.released = 0;
  inp.direct = 0;
}

/** A fighter at rest high above the stage centre, the other parked on the stage far away. */
function airborneAtRest(w: ProbeWorld, jumpsLeft: number): { state: ReturnType<typeof trialState>; f: SimFighter } {
  const state = trialState(w);
  const [f, other] = simFighters(state);
  const g = w.geo;
  place(f, w.atk, g.center, g.top - HIGH, false);
  f.jumpsLeft = jumpsLeft;
  place(other, w.vic, g.left + 20, g.top, true);
  return { state, f };
}

function groundJumpRise(w: ProbeWorld, full: boolean): number {
  const state = trialState(w);
  const [f, other] = simFighters(state);
  const g = w.geo;
  place(f, w.atk, g.center, g.top, true);
  place(other, w.vic, g.left + 20, g.top, true);
  const [ai, oi] = w.inputs;
  setInput(oi, 0, 0);
  let minY = f.y;
  for (let t = 0; t < RISE_FRAMES; t++) {
    if (t === 0) setInput(ai, Btn.Jump, Btn.Jump);
    else setInput(ai, full ? Btn.Jump : 0, 0);
    stepGame(state, w.inputs);
    if (f.y < minY) minY = f.y;
    if (t > 4 && f.onGround) break;
  }
  return g.top - minY;
}

function airJumpRise(w: ProbeWorld): number {
  const { state, f } = airborneAtRest(w, Math.max(1, w.atk.jumps - 1));
  const [ai, oi] = w.inputs;
  setInput(oi, 0, 0);
  const y0 = f.y;
  let minY = f.y;
  for (let t = 0; t < RISE_FRAMES; t++) {
    setInput(ai, t === 0 ? Btn.Jump : 0, t === 0 ? Btn.Jump : 0);
    stepGame(state, w.inputs);
    if (f.y < minY) minY = f.y;
    if (f.vy > 0 && t > 2) break;
  }
  return y0 - minY;
}

function upSpecialProbe(w: ProbeWorld): RecoveryProfile['upSpecial'] {
  const { state, f } = airborneAtRest(w, 0);
  const [ai, oi] = w.inputs;
  setInput(oi, 0, 0);
  const y0 = f.y;
  let minY = f.y;
  let frames = 0;
  let started = false;
  let helpless = false;
  for (let t = 0; t < 240; t++) {
    setInput(ai, Btn.Up, t === 0 ? Btn.Special : 0);
    stepGame(state, w.inputs);
    if (f.y < minY) minY = f.y;
    if (f.action === 'attack') {
      started = true;
      frames = t + 1;
      continue;
    }
    if (started) {
      helpless = f.action === 'airHelpless';
      break;
    }
  }
  const mv = w.atk.moves.uspecial;
  return {
    rise: y0 - minY,
    frames: started ? frames : mv.totalFrames,
    helpless: started ? helpless : mv.helplessAfter === true,
    // The sim never grabs a ledge during 'attack', so the first possible grab is the frame the move ends.
    grabsBefore: started ? frames : mv.totalFrames,
  };
}

type DodgeKey = 'l' | 'r' | 'u' | 'd' | 'lu' | 'ld' | 'ru' | 'rd' | 'n';
const DODGE_DIRS: [DodgeKey, number][] = [
  ['l', Btn.Left], ['r', Btn.Right], ['u', Btn.Up], ['d', Btn.Down],
  ['lu', Btn.Left | Btn.Up], ['ld', Btn.Left | Btn.Down], ['ru', Btn.Right | Btn.Up], ['rd', Btn.Right | Btn.Down],
  ['n', 0],
];

function airDodgeProbe(w: ProbeWorld, dirBits: number): { dx: number; dy: number } {
  const { state, f } = airborneAtRest(w, 0);
  const [ai, oi] = w.inputs;
  setInput(oi, 0, 0);
  const x0 = f.x;
  const y0 = f.y;
  let started = false;
  for (let t = 0; t < 120; t++) {
    setInput(ai, dirBits | Btn.Shield, t === 0 ? Btn.Shield : 0);
    stepGame(state, w.inputs);
    if (f.action === 'airDodge') {
      started = true;
      continue;
    }
    if (started) break;
  }
  return { dx: f.x - x0, dy: f.y - y0 };
}

/** Frames from ledge height at rest (no fast fall) until the fighter crosses the blast line. */
function fallToBlastProbe(w: ProbeWorld): number {
  const state = trialState(w);
  const [f, other] = simFighters(state);
  const g = w.geo;
  place(f, w.atk, g.right + 100, g.top, false);
  place(other, w.vic, g.left + 20, g.top, true);
  const [ai, oi] = w.inputs;
  setInput(ai, 0, 0);
  setInput(oi, 0, 0);
  for (let t = 0; t < 600; t++) {
    stepGame(state, w.inputs);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'ko' && ev.slot === 0) return t + 1;
    }
  }
  return Infinity;
}

// ---------------------------------------------------------------------------------------------
// Recover box
// ---------------------------------------------------------------------------------------------

/** Width of one dx bin of the recover box, px beyond the ledge corner. */
export const RECOVER_DX_BIN = 20;
/** Number of dx bins: bin b starts b * RECOVER_DX_BIN px beyond the corner. */
export const RECOVER_DX_BINS = 16;
/** Deepest depth probed, px below the main platform top. */
export const RECOVER_MAX_DEPTH = 400;
const DEPTH_STEP = 5;
/** Stored when no depth (not even the ledge top) gets back. */
export const RECOVER_NONE = -1;

/** Index into RecoveryProfile.recoverBox; `jumps` is the character's `CharacterDef.jumps`. */
export function recoverBoxIndex(jumpsLeft: number, upB: number, dodge: number, dxBin: number, jumps: number): number {
  const j = jumpsLeft < 0 ? 0 : jumpsLeft > jumps ? jumps : jumpsLeft;
  return ((j * 2 + (upB ? 1 : 0)) * 2 + (dodge ? 1 : 0)) * RECOVER_DX_BINS + dxBin;
}

/** Recovery scripts: dodge 0 none, 1 diagonal up-toward, 2 toward; upB trigger depth below the top. */
interface Script { dodge: 0 | 1 | 2; upbDepth: number }
const SCRIPTS: Script[] = [
  { dodge: 0, upbDepth: -Infinity },
  { dodge: 0, upbDepth: 40 },
  { dodge: 1, upbDepth: -Infinity },
  { dodge: 2, upbDepth: -Infinity },
];

function tryRecover(w: ProbeWorld, dx: number, depth: number, jumps: number, upB: boolean, dodge: boolean, sc: Script): boolean {
  const state = trialState(w);
  const [f, other] = simFighters(state);
  const g: StageGeo = w.geo;
  place(f, w.atk, g.right + dx, g.top + depth, false);
  f.jumpsLeft = jumps;
  f.airDodgeUsed = !dodge;
  f.facing = -1;
  place(other, w.vic, g.left + 20, g.top, true);
  const [ai, oi] = w.inputs;
  setInput(oi, 0, 0);
  const toward = Btn.Left;
  let upbLeft = upB;
  let dodgeLeft = dodge && sc.dodge !== 0;
  for (let t = 0; t < 360; t++) {
    let held = toward;
    let pressed = 0;
    if (f.action === 'air' && f.vy >= 0) {
      if (f.jumpsLeft > 0) pressed = Btn.Jump;
      else if (dodgeLeft) {
        held = sc.dodge === 1 ? toward | Btn.Up : toward;
        pressed = Btn.Shield;
        dodgeLeft = false;
      } else if (upbLeft && f.y - g.top >= sc.upbDepth) {
        held = toward | Btn.Up;
        pressed = Btn.Special;
        upbLeft = false;
      }
    }
    setInput(ai, held, pressed);
    stepGame(state, w.inputs);
    if (f.action === 'ledgeHang' || f.action === 'ledgeGrab' || f.onGround) return true;
    if (f.action === 'dead') return false;
    const spent = f.jumpsLeft === 0 && !upbLeft && !dodgeLeft;
    if (spent && f.vy > 0 && f.y > g.top + 90 && f.action !== 'attack' && f.action !== 'airDodge') return false;
  }
  return false;
}

function reachable(w: ProbeWorld, dx: number, depth: number, jumps: number, upB: boolean, dodge: boolean): boolean {
  for (let s = 0; s < SCRIPTS.length; s++) {
    const sc = SCRIPTS[s];
    if (sc.dodge !== 0 && !dodge) continue;
    if (sc.upbDepth !== -Infinity && !upB) continue;
    if (tryRecover(w, dx, depth, jumps, upB, dodge, sc)) return true;
  }
  return false;
}

/**
 * recoverBox[recoverBoxIndex(j, u, d, b, def.jumps)]: the deepest start (feet px below the main
 * platform top, at rest, RECOVER_DX_BIN * b px beyond the ledge corner) from which one of four
 * button scripts (hold toward; midair jumps when falling; an optional air dodge, diagonal or
 * straight toward; up special at once or 40 px below the top) reaches a ledge hang or the
 * ground, with j midair jumps left, up special allowed (u) and the air dodge unspent (d).
 * Resolution 5 px; RECOVER_NONE when not even depth 0 gets back. Assumes reach is monotone in
 * depth (shallower is never worse) and in resources (more is never worse), not in dx: right
 * under the corner the stage's underside blocks the rise.
 */
function recoverBox(w: ProbeWorld): Float32Array {
  const J = w.atk.jumps;
  const box = new Float32Array((J + 1) * 2 * 2 * RECOVER_DX_BINS);
  box.fill(RECOVER_NONE);
  for (let j = 0; j <= J; j++) {
    for (let u = 0; u < 2; u++) {
      for (let d = 0; d < 2; d++) {
        for (let b = 0; b < RECOVER_DX_BINS; b++) {
          // Fewer resources give a lower bound.
          let lower = RECOVER_NONE;
          if (j > 0) lower = Math.max(lower, box[recoverBoxIndex(j - 1, u, d, b, J)]);
          if (u > 0) lower = Math.max(lower, box[recoverBoxIndex(j, 0, d, b, J)]);
          if (d > 0) lower = Math.max(lower, box[recoverBoxIndex(j, u, 0, b, J)]);
          const dx = b * RECOVER_DX_BIN;
          let lo = lower < 0 ? -1 : Math.floor(lower / DEPTH_STEP);
          let hi = Math.floor(RECOVER_MAX_DEPTH / DEPTH_STEP);
          if (lo < 0) {
            if (!reachable(w, dx, 0, j, u === 1, d === 1)) {
              box[recoverBoxIndex(j, u, d, b, J)] = RECOVER_NONE;
              continue;
            }
            lo = 0;
          }
          if (hi < lo) hi = lo;
          // Largest step k in [lo, hi] that is reachable, k = lo known reachable.
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (reachable(w, dx, mid * DEPTH_STEP, j, u === 1, d === 1)) lo = mid;
            else hi = mid - 1;
          }
          box[recoverBoxIndex(j, u, d, b, J)] = lo * DEPTH_STEP;
        }
      }
    }
  }
  return box;
}

/**
 * Recovery profile by probe: full hop, short hop and midair jump rise; up special rise, frames,
 * helplessness and the first frame a ledge can be grabbed; air dodge displacement per held
 * direction (dy in sim coordinates, positive down); the recover box; frames of free fall from
 * ledge height to the blast line.
 */
export const probeRecovery: ProbeRecoveryFn = (def, stage) => withProbeWorld(def, def, stage, (w) => {
  const airDodge = {} as RecoveryProfile['airDodge'];
  for (let i = 0; i < DODGE_DIRS.length; i++) airDodge[DODGE_DIRS[i][0]] = airDodgeProbe(w, DODGE_DIRS[i][1]);
  return {
    rise: { fullHop: groundJumpRise(w, true), shortHop: groundJumpRise(w, false), airJump: airJumpRise(w) },
    upSpecial: upSpecialProbe(w),
    airDodge,
    recoverBox: recoverBox(w),
    fallToBlast: fallToBlastProbe(w),
  };
});

/** Height a move lifts the fighter when started in the air at rest (velocity keys), px. */
export function probeMoveRise(def: CharacterDef, stage: StageDef, id: MoveId): number {
  const vel = def.moves[id].velocity;
  if (vel === undefined) return 0;
  let up = false;
  for (let i = 0; i < vel.length; i++) if (vel[i].vy !== undefined && (vel[i].vy as number) < 0) up = true;
  if (!up) return 0;
  return withProbeWorld(def, def, stage, (w) => {
    const { state, f } = airborneAtRest(w, 0);
    const [ai, oi] = w.inputs;
    setInput(ai, 0, 0);
    setInput(oi, 0, 0);
    startMove(state, f, w.atk, id);
    const y0 = f.y;
    let minY = f.y;
    for (let t = 0; t < 200; t++) {
      stepGame(state, w.inputs);
      if (f.y < minY) minY = f.y;
      if (f.action !== 'attack') break;
    }
    return y0 - minY;
  });
}

// ---------------------------------------------------------------------------------------------
// Shot profiles
// ---------------------------------------------------------------------------------------------

function clampH(h: number, max: number): number {
  if (!(h > 0)) return 0;
  const r = Math.round(h);
  return r > max ? max : r;
}

/**
 * One shot profile per timeline projectile (burst-only defs are the parent's `burstId`). `h` is
 * frames of charge held (0 to TUNING.input.chargeMax; ignored by a move that cannot charge).
 * castFrames(h): move frame of the spawn after release (the hold itself is not included);
 * totalFrames(h): move length after release; tail(h) = totalFrames - castFrames; speed px per
 * frame; lifetime frames; range: spawn offset plus travel before it dies or turns back, px
 * ahead of the thrower (no radius); radius: hit circle, charge scale included; height: px above
 * the feet at spawn; damage and strength with charge; frozenOnHit(h, pct): hitlag plus hitstun
 * on a victim of the thrower's own weight at pct before the hit; frozenOnShield(h): hitlag plus
 * shield stun. cost 0 and cap Infinity: no resource-bounded shots in the sim.
 */
export const probeShots: ProbeShotsFn = (def) => {
  const out: ShotProfile[] = [];
  const maxH = TUNING.input.chargeMax > 0 ? TUNING.input.chargeMax : 0;
  const ids = Object.keys(def.moves) as MoveId[];
  for (let m = 0; m < ids.length; m++) {
    const mv = def.moves[ids[m]];
    const shots = timelineShots(mv);
    for (let s = 0; s < shots.length; s++) out.push(shotProfile(def, ids[m], shots[s], chargesPower(mv) ? maxH : 0));
  }
  return out;
};

function shotProfile(def: CharacterDef, moveId: MoveId, p: ProjectileDef, maxH: number): ShotProfile {
  const mv = def.moves[moveId];
  const n = maxH + 1;
  const cast = new Float64Array(n);
  const total = new Float64Array(n);
  const speed = new Float64Array(n);
  const life = new Float64Array(n);
  const range = new Float64Array(n);
  const radius = new Float64Array(n);
  const damage = new Float64Array(n);
  const strength = new Float64Array(n);
  const bkb = new Float64Array(n);
  const kbg = new Float64Array(n);
  const shield = new Float64Array(n);
  const damageMul = TUNING.knockback.damageMul;
  for (let h = 0; h < n; h++) {
    const frac = chargeFraction(h, chargesPower(mv));
    const delay = mv.chargeCastFrames === undefined ? 0 : Math.round(mv.chargeCastFrames * frac);
    const power = p.charged === undefined ? projectileChargePower(h, chargesPower(mv)) : 1;
    const scale = projectileChargeScale(h, chargesPower(mv));
    cast[h] = p.spawnFrame + delay;
    total[h] = mv.totalFrames + delay;
    speed[h] = Math.abs(chargedStat(p, frac, 'vx'));
    life[h] = Math.round(chargedStat(p, frac, 'lifetime'));
    const out = p.returnFrame !== undefined && p.returnFrame < life[h] ? p.returnFrame : life[h];
    range[h] = p.x + speed[h] * out;
    radius[h] = chargedStat(p, frac, 'r') * scale;
    damage[h] = chargedStat(p, frac, 'damage') * power * damageMul;
    strength[h] = chargedStat(p, frac, 'strength');
    bkb[h] = chargedStat(p, frac, 'bkb');
    kbg[h] = chargedStat(p, frac, 'kbg');
    shield[h] = Math.max(1, hitlagFrames(damage[h])) + Math.floor(damage[h] * SHIELD_STUN_PER_DAMAGE) + 2;
  }
  const weight = def.weight;
  return {
    moveId,
    defId: p.id,
    castFrames: (h) => cast[clampH(h, maxH)],
    totalFrames: (h) => total[clampH(h, maxH)],
    tail: (h) => total[clampH(h, maxH)] - cast[clampH(h, maxH)],
    speed: (h) => speed[clampH(h, maxH)],
    lifetime: (h) => life[clampH(h, maxH)],
    range: (h) => range[clampH(h, maxH)],
    radius: (h) => radius[clampH(h, maxH)],
    height: -p.y,
    damage: (h) => damage[clampH(h, maxH)],
    strength: (h) => strength[clampH(h, maxH)],
    frozenOnHit: (h, pct) => {
      const i = clampH(h, maxH);
      const d = damage[i];
      const kb = knockbackOf(pct + d, weight, d, bkb[i], kbg[i]);
      return Math.max(1, hitlagFrames(d)) + Math.floor(kb * TUNING.knockback.hitstunPerKb);
    },
    frozenOnShield: (h) => shield[clampH(h, maxH)],
    pierces: !p.destroyOnHit,
    returns: p.returnFrame === undefined ? null : p.returnFrame,
    low: p.low === true,
    burstId: p.burstId === undefined ? null : p.burstId,
    cost: 0,
    cap: Infinity,
  };
}
