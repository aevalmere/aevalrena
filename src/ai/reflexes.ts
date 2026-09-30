/**
 * Reflexes (docs/CPU_PLAN.md W2.13; 02 section 14.2; research 20 "Reflex layer").
 *
 * Run before plan continuation and outside search; a reflex that fires writes the frame's Intent
 * and claims the frame (returns true). Each one is gated by the level: its plan family must be in
 * `level.vocabulary`, and any reaction to something that happened (a launch, an attack or a shot
 * in flight) waits until the stimulus is at least R frames old at the frame the input is consumed,
 * R from the executor's reaction function (never under `reactFloor` at human tiers).
 *
 * Own fighter: exact (`v.p.state` carries it exact). Opponents: as perceived. With several
 * opponents every threat test takes the nearest incoming threat from any of them; teammates are
 * never threats.
 *
 * Order (first match wins): noControl, respawnDrop, mashOut, launched (with the tech), ledgeGrab,
 * airDodgeSpike, footstoolEscape, shieldThreat, shieldFloor.
 */
import { AIR_DODGE, FOOTSTOOL, TECH } from '../core/constants';
import { Btn } from '../core/types';
import type { FighterState, GameState, InputFrame, ProjectileDef, Rect } from '../core/types';
import { CHARACTER_DEFS } from '../characters/registry';
import { stepGame } from '../sim';
import { defOf, fighterHurtbox, sameTeam, stageOf, type SimFighter } from '../sim/state';
import { copyStateInto, newSnapshot } from '../net/snapshot';
import type { DecisionView, Executor, Intent, LevelVector, RunReflexesFn, Stimulus } from './contracts';
import { CMD_CODE, CpuExecutor, defaultReaction, type ExecutorScratch } from './executor';
import { STREAM, randInt } from './rng';

export const REFLEX_IDS = ['noControl', 'respawnDrop', 'mashOut', 'launched', 'tech', 'ledgeGrab', 'airDodgeSpike',
  'footstoolEscape', 'shieldThreat', 'shieldFloor'] as const;
export type ReflexId = typeof REFLEX_IDS[number];

const L = Btn.Left, R = Btn.Right, U = Btn.Up, D = Btn.Down;
/** Arm the tech when the landing is this many frames past the consumption delay (02 14.2). */
const TECH_ARM = 8;
/** Landing prediction horizon past the consumption delay: the whole tech window. */
const TECH_LOOK = TECH.window;
/** Tech roll away from an opponent closer than this (px). */
const TECH_ROLL_NEAR = 70;
/** Threat scan horizon (frames). */
const THREAT_HORIZON = 24;
/** Shield this many frames before the hit at the latest consumable frame. */
const SHIELD_MARGIN = 2;
/** Keep an existing shield up while a threat is this close. */
const SHIELD_KEEP = 10;
/** Shield floor (HP): god 20 (02 14.2), humans 8 to 20 by s. */
const SHIELD_FLOOR_GOD = 20;
/** Respawn: god drops at 20 frames; human tiers wait up to 20 more, less with skill. */
const RESPAWN_WAIT = 20;
const RESPAWN_SPREAD = 20;
/** Footstool when an opponent under us threatens within this many frames past the delay. */
const FOOTSTOOL_THREAT = 8;
/** Hitbox and hurtbox overlap slack (px). */
const PAD = 2;

/** One threat from the scan. */
interface Threat { t: number; age: number; key: number; opp: number; spike: boolean }

class ReflexMemory implements ExecutorScratch {
  launched = false;
  launchTick = 0;
  techArmed = false;
  techDirBit = 0;
  /** Hitstun seen last frame: a rise means a fresh hit, so a new launch (and a new tech). */
  lastHitstun = 0;
  respawnTick = -1;
  last: ReflexId | null = null;
  fired = 0;
  work: GameState | null = null;
  readonly inputs: InputFrame[] = [];
  readonly stim: Stimulus = { key: 0, frame: 0, bits: 0, pCue: 0, stress: 0, alert: false };
  readonly hit: Threat = { t: 0, age: 0, key: 0, opp: -1, spike: false };
  readonly spike: Threat = { t: 0, age: 0, key: 0, opp: -1, spike: true };
  reset(): void {
    this.launched = false; this.launchTick = 0; this.techArmed = false; this.techDirBit = 0; this.lastHitstun = 0;
    this.respawnTick = -1; this.last = null; this.fired = 0;
  }
}

const fallbackMem = new WeakMap<Executor, ReflexMemory>();

function memOf(exec: Executor): ReflexMemory {
  if (exec instanceof CpuExecutor) {
    if (!(exec.reflexData instanceof ReflexMemory)) exec.reflexData = new ReflexMemory();
    return exec.reflexData as ReflexMemory;
  }
  let m = fallbackMem.get(exec);
  if (m === undefined) { m = new ReflexMemory(); fallbackMem.set(exec, m); }
  return m;
}

/** The reflex that claimed the last frame for this executor, or null. */
export function lastReflex(exec: Executor): ReflexId | null { return memOf(exec).last; }
/** Frames claimed by reflexes since the executor's last reset. */
export function reflexFrames(exec: Executor): number { return memOf(exec).fired; }

function reactionOf(exec: Executor, m: ReflexMemory, v: DecisionView, key: number, stimFrame: number): number {
  const st = m.stim;
  st.key = key; st.frame = stimFrame; st.bits = 0; st.pCue = 0; st.stress = 0; st.alert = false;
  const fn = exec instanceof CpuExecutor ? exec.reactionFn() : defaultReaction;
  return fn(st, v.level, v.seed, v.slot);
}

function dropPlan(exec: Executor): void {
  if (exec instanceof CpuExecutor) exec.dropPlan();
}

function claim(exec: Executor, m: ReflexMemory, id: ReflexId, out: Intent, held: number, direct: number, mash: number): boolean {
  out.held = held; out.direct = direct; out.mash = mash;
  m.last = id;
  m.fired++;
  if (exec instanceof CpuExecutor) exec.markClaimed();
  return true;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

const HURT: Rect = { x: 0, y: 0, w: 0, h: 0 };
const HURT2: Rect = { x: 0, y: 0, w: 0, h: 0 };

function circleHitsRect(cx: number, cy: number, r: number, x: number, y: number, w: number, h: number): boolean {
  const nx = cx < x ? x : cx > x + w ? x + w : cx;
  const ny = cy < y ? y : cy > y + h ? y + h : cy;
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

/** Projectile def by owner character and def id; built once per character. */
const shotDefs = new Map<string, Map<string, ProjectileDef>>();
function shotDef(charId: string, defId: string): ProjectileDef | null {
  let m = shotDefs.get(charId);
  if (m === undefined) {
    m = new Map<string, ProjectileDef>();
    const def = CHARACTER_DEFS[charId];
    if (def !== undefined) {
      for (const id of Object.keys(def.moves)) {
        const ps = def.moves[id as keyof typeof def.moves].projectiles;
        if (ps === undefined) continue;
        for (let i = 0; i < ps.length; i++) m.set(ps[i].id, ps[i]);
      }
    }
    shotDefs.set(charId, m);
  }
  const d = m.get(defId);
  return d === undefined ? null : d;
}

function isSpikeAngle(a: number): boolean { return a >= 225 && a <= 315; }

/**
 * Nearest incoming hits on `me` from every opponent, within THREAT_HORIZON frames: `hit` is the
 * nearest shieldable one (grab boxes left out), `spike` the nearest downward one. t = -1 for none.
 */
function scanThreats(s: GameState, meI: number, hit: Threat, spike: Threat): void {
  hit.t = -1; spike.t = -1;
  const me = s.fighters[meI];
  fighterHurtbox(me, defOf(me), HURT);
  const frame = s.frame;
  for (let i = 0; i < s.fighters.length; i++) {
    if (i === meI) continue;
    const o = s.fighters[i] as SimFighter;
    if (o.stocks <= 0 || o.action === 'dead' || sameTeam(s, me.slot, o.slot)) continue;
    if (o.action !== 'attack' || o.moveId === null || o.charging) continue;
    const mv = defOf(o).moves[o.moveId];
    for (let k = 0; k < mv.hitboxes.length; k++) {
      const hb = mv.hitboxes[k];
      if (hb.end < o.actionFrame) continue;
      const t = hb.start > o.actionFrame ? hb.start - o.actionFrame : 0;
      if (t > THREAT_HORIZON) continue;
      const cx = o.x + o.vx * t + hb.x * o.facing;
      const cy = o.y + (o.onGround ? 0 : o.vy * t) + hb.y;
      const mx = HURT.x + me.vx * t, my = HURT.y + (me.onGround ? 0 : me.vy * t);
      if (!circleHitsRect(cx, cy, hb.r + PAD, mx, my, HURT.w, HURT.h)) continue;
      const key = ((o.slot + 1) * 7919 + (frame - o.actionFrame)) & 0x7fffffff;
      if (hb.grab === undefined && (hit.t < 0 || t < hit.t)) {
        hit.t = t; hit.age = o.actionFrame; hit.key = key; hit.opp = i; hit.spike = isSpikeAngle(hb.angle);
      }
      if (isSpikeAngle(hb.angle) && hb.grab === undefined && (spike.t < 0 || t < spike.t)) {
        spike.t = t; spike.age = o.actionFrame; spike.key = key; spike.opp = i; spike.spike = true;
      }
    }
  }
  const bit = me.slot >= 0 && me.slot < 31 ? 1 << me.slot : 0;
  for (let i = 0; i < s.projectiles.length; i++) {
    const p = s.projectiles[i];
    if (!p.alive || p.owner === me.slot || sameTeam(s, me.slot, p.owner) || (p.hitSlots & bit) !== 0) continue;
    let ownerChar = '';
    for (let j = 0; j < s.fighters.length; j++) if (s.fighters[j].slot === p.owner) ownerChar = s.fighters[j].charId;
    if (ownerChar === '') continue;
    const pd = shotDef(ownerChar, p.defId);
    if (pd === null) continue;
    const r = pd.r * (p.scale > 0 ? p.scale : 1) + PAD;
    let x = p.x, y = p.y, vy = p.vy;
    const left = pd.lifetime - p.age;
    for (let t = 0; t <= THREAT_HORIZON && t <= left; t++) {
      if (t > 0) { vy += pd.gravity; x += p.vx; y += vy; }
      const mx = HURT.x + me.vx * t, my = HURT.y + (me.onGround ? 0 : me.vy * t);
      if (!circleHitsRect(x, y, r, mx, my, HURT.w, HURT.h)) continue;
      const key = (1000003 + p.id) & 0x7fffffff;
      if (hit.t < 0 || t < hit.t) { hit.t = t; hit.age = p.age; hit.key = key; hit.opp = -1; hit.spike = false; }
      break;
    }
  }
}

/** Frames until our tumble lands (1 = the next step), -1 when it will not land within `max`. */
function landIn(s: GameState, meI: number, m: ReflexMemory, max: number, heldNow: number): number {
  if (m.work === null) m.work = newSnapshot();
  const n = s.fighters.length;
  while (m.inputs.length < n) m.inputs.push({ held: 0, pressed: 0, released: 0, direct: 0 });
  const work = m.work;
  copyStateInto(work, s);
  for (let t = 1; t <= max; t++) {
    for (let j = 0; j < n; j++) {
      const inp = m.inputs[j];
      inp.held = j === meI ? heldNow : work.fighters[j].inputHeld;
      inp.pressed = 0; inp.released = 0; inp.direct = 0;
    }
    stepGame(work, m.inputs);
    const f = work.fighters[meI];
    const a = f.action;
    if (a === 'downed' || a === 'tech' || a === 'techRoll' || f.onGround) return t;
    if (a !== 'tumble' && a !== 'hitstun') return -1;
  }
  return -1;
}

function inwardBit(s: GameState, x: number): number {
  const plats = stageOf(s).platforms;
  let best = -1, bw = -1;
  for (let i = 0; i < plats.length; i++) if (plats[i].solid && plats[i].w > bw) { bw = plats[i].w; best = i; }
  if (best < 0) return x > 0 ? L : R;
  const cx = plats[best].x + plats[best].w / 2;
  return x > cx ? L : R;
}

function offstage(s: GameState, f: FighterState): boolean {
  const plats = stageOf(s).platforms;
  for (let i = 0; i < plats.length; i++) {
    const p = plats[i];
    if (p.solid && f.x >= p.x && f.x <= p.x + p.w) return false;
  }
  return true;
}

function shieldFloor(level: LevelVector): number {
  return level.god ? SHIELD_FLOOR_GOD : 8 + 12 * level.s;
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

/** reflexes.ts: true = frame claimed, `out` written. */
export const runReflexes: RunReflexesFn = (v: DecisionView, exec: Executor, out: Intent): boolean => {
  if (exec instanceof CpuExecutor) exec.sync(v.p.state);
  const m = memOf(exec);
  m.last = null;
  const s = v.p.state;
  const meI = v.p.meI;
  const me = s.fighters[meI] as SimFighter | undefined;
  if (me === undefined) return false;
  const lv = v.level;
  const vocab = lv.vocabulary;
  const d = exec.outputFrameOf(0);
  const frame = v.p.frame;
  const prevHeld = exec instanceof CpuExecutor ? exec.lastHeld() : 0;

  // ---- noControl: nothing an input can do; send nothing so no press leaks into the buffer ----
  const a = me.action;
  if (me.stocks <= 0 || a === 'dead' || a === 'footstooled' || a === 'finalSmashVictim' || a === 'shieldBreak'
      || a === 'finalSmash') {
    dropPlan(exec);
    m.launched = false; m.techArmed = false;
    return claim(exec, m, 'noControl', out, 0, 0, 0);
  }

  // ---- respawnDrop: take a beat on the platform, then drop (god at 20 frames, humans vary) ----
  if (a === 'respawn') {
    dropPlan(exec);
    m.launched = false; m.techArmed = false;
    if (m.respawnTick < 0 || me.actionFrame <= 1) m.respawnTick = frame - me.actionFrame;
    const spread = lv.god ? 0 : Math.round(RESPAWN_SPREAD * (1 - lv.s));
    const wait = RESPAWN_WAIT + (spread > 0 ? randInt(spread + 1, v.seed, v.slot, m.respawnTick, STREAM.wake) : 0);
    const go = me.actionFrame + d + 1 >= wait && (prevHeld & D) === 0;
    return claim(exec, m, 'respawnDrop', out, go ? D : 0, 0, 0);
  }
  m.respawnTick = -1;

  // ---- mashOut: grabbed; the executor spaces the presses at the level rate and the sim cap ----
  if (a === 'grabbed') {
    dropPlan(exec);
    m.launched = false; m.techArmed = false;
    return claim(exec, m, 'mashOut', out, 0, 0, lv.mashEvery > 0 ? 1 : 0);
  }

  // ---- launched and tech ----
  const launched = a === 'hitstun' || a === 'tumble';
  if (launched) {
    // A fresh hit while still launched (hitstun rose) is a new launch: the armed tech of the old
    // one was spent or never pressed, and the reaction to this hit starts now.
    const fresh = me.hitstun > m.lastHitstun;
    m.lastHitstun = me.hitstun;
    if (!m.launched || fresh) {
      m.launched = true;
      m.launchTick = frame;
      m.techArmed = false;
      m.techDirBit = 0;
    }
    const reactR = reactionOf(exec, m, v, m.launchTick, m.launchTick);
    const reacted = frame - m.launchTick + d >= reactR;
    if (m.techArmed) {
      dropPlan(exec);
      return claim(exec, m, 'tech', out, m.techDirBit, 0, 0);
    }
      if (a === 'tumble' && !me.onGround && vocab.has('tech') && reacted && me.techLockout <= d + 1) {
      const t = landIn(s, meI, m, d + TECH_LOOK, prevHeld & (L | R));
      if (t >= d + 1 && t <= d + TECH_ARM) {
        // Roll away from a close opponent when the direction can still be pressed inside hitstun
        // (a direction pressed in a tumble after hitstun ends the tumble and loses the tech).
        let dirBit = 0;
        if (me.hitstun > d + 1) {
          let near = -1, nd = TECH_ROLL_NEAR;
          for (let i = 0; i < s.fighters.length; i++) {
            if (i === meI) continue;
            const o = s.fighters[i];
            if (o.stocks <= 0 || o.action === 'dead' || sameTeam(s, me.slot, o.slot)) continue;
            const dx = Math.abs(o.x - me.x);
            if (dx < nd) { nd = dx; near = i; }
          }
          if (near >= 0) dirBit = s.fighters[near].x > me.x ? L : R;
        }
        m.techArmed = true;
        m.techDirBit = dirBit;
        dropPlan(exec);
        return claim(exec, m, 'tech', out, dirBit, CMD_CODE.tech, 0);
      }
    }
    // In hitstun or hitlag: nothing but the tech press. Before the launch has been reacted to,
    // a tumble waits too (a person has not yet seen they were hit).
    if (me.hitstun > 1 || me.hitlag > 0 || (a === 'tumble' && !reacted)) {
      dropPlan(exec);
      return claim(exec, m, 'launched', out, 0, 0, 0);
    }
    return false;
  }
  m.launched = false;
  m.lastHitstun = 0;
  m.techArmed = false;

  // ---- ledgeGrab: falling into a free ledge's snap region; hold toward the stage, nothing else ----
  if ((a === 'air' || a === 'airHelpless') && me.ledge < 0 && me.ledgeCooldown === 0 && vocab.has('recovery')) {
    const def = defOf(me);
    const steps = d + 1;
    const vyAt = me.vy + def.gravity * steps;
    if (vyAt > 0) {
      const px = me.x + me.vx * steps;
      const py = me.y + (me.vy + vyAt) * 0.5 * steps;
      const box = def.ledgeGrabBox;
      const bx0 = px - box.w / 2, bx1 = px + box.w / 2, by0 = py + box.yOff, by1 = by0 + box.h;
      const plats = stageOf(s).platforms;
      for (let i = 0; i < plats.length; i++) {
        const p = plats[i];
        for (let side = 0; side < 2; side++) {
          if (side === 0 ? !p.ledgeLeft : !p.ledgeRight) continue;
          const index = i * 2 + side;
          let taken = false;
          for (let j = 0; j < s.fighters.length; j++) if (s.fighters[j].ledge === index) taken = true;
          if (taken) continue;
          const outward = side === 0 ? -1 : 1;
          const cornerX = side === 0 ? p.x : p.x + p.w;
          const rx0 = side === 0 ? cornerX - box.w : cornerX;
          const rx1 = side === 0 ? cornerX : cornerX + box.w;
          const ry0 = p.y - 4, ry1 = p.y + box.h + 20;
          if (bx1 < rx0 || bx0 > rx1 || by1 < ry0 || by0 > ry1) continue;
          if ((px - cornerX) * outward < -2) continue;
          return claim(exec, m, 'ledgeGrab', out, outward === -1 ? R : L, 0, 0);
        }
      }
    }
  }

  // ---- threats from every opponent ----
  const needScan = (a === 'air' && (vocab.has('airDodge') || vocab.has('footstool')))
    || (me.onGround && vocab.has('shield')) || a === 'shield';
  if (needScan) scanThreats(s, meI, m.hit, m.spike);
  else { m.hit.t = -1; m.spike.t = -1; }

  // ---- airDodgeSpike: a spike already in flight, dodged so the invulnerability covers the hit ----
  if (a === 'air' && !me.airDodgeUsed && vocab.has('airDodge') && m.spike.t >= 0) {
    const lo = d + 1 + AIR_DODGE.invStart;
    if (m.spike.t >= lo && m.spike.t <= lo + 2) {
      const stimFrame = frame - m.spike.age;
      if (m.spike.age + d >= reactionOf(exec, m, v, m.spike.key, stimFrame)) {
        return claim(exec, m, 'airDodgeSpike', out, inwardBit(s, me.x) | U, CMD_CODE.dirAirDodge, 0);
      }
    }
  }

  // ---- footstoolEscape: jump off the head of an opponent under us who is about to hit us, or
  // when out of jumps offstage ----
  if (a === 'air' && vocab.has('footstool')) {
    const steps = d + 1;
    const myY = me.y + me.vy * steps, myX = me.x + me.vx * steps;
    for (let i = 0; i < s.fighters.length; i++) {
      if (i === meI) continue;
      const o = s.fighters[i];
      if (o.stocks <= 0 || o.action === 'dead' || o.action === 'grabbed' || o.ledge >= 0
          || sameTeam(s, me.slot, o.slot)) continue;
      fighterHurtbox(o, defOf(o), HURT2);
      const top = HURT2.y + (o.onGround ? 0 : o.vy * steps);
      const above = top - myY;
      if (above < 0 || above > FOOTSTOOL.reachY) continue;
      if (Math.abs(myX - (o.x + o.vx * steps)) > HURT2.w / 2 + FOOTSTOOL.reachX) continue;
      const threatened = m.hit.t >= 0 && m.hit.opp === i && m.hit.t <= d + FOOTSTOOL_THREAT;
      const stranded = me.jumpsLeft === 0 && offstage(s, me);
      if (threatened || stranded) return claim(exec, m, 'footstoolEscape', out, 0, CMD_CODE.footstool, 0);
    }
  }

  // ---- shieldThreat: a hit already in flight that nothing else beats, shielded on its last frame ----
  const groundedActionable = me.onGround && (a === 'idle' || a === 'walk' || a === 'dash' || a === 'run'
    || a === 'crouch' || a === 'turn' || a === 'shield');
  if (groundedActionable && vocab.has('shield') && m.hit.t >= 0 && me.shieldHp > shieldFloor(lv)) {
    const t = m.hit.t;
    if (a === 'shield' && t <= d + SHIELD_KEEP) return claim(exec, m, 'shieldThreat', out, Btn.Shield, 0, 0);
    if (t >= d + 1 && t <= d + 1 + SHIELD_MARGIN) {
      const stimFrame = frame - m.hit.age;
      if (m.hit.age + d >= reactionOf(exec, m, v, m.hit.key, stimFrame)) {
        return claim(exec, m, 'shieldThreat', out, Btn.Shield, 0, 0);
      }
    }
  }

  // ---- shieldFloor: drop the shield before it breaks when nothing is about to hit it ----
  if (a === 'shield' && me.shieldHp < shieldFloor(lv) && (m.hit.t < 0 || m.hit.t > d + 2)) {
    return claim(exec, m, 'shieldFloor', out, 0, 0, 0);
  }

  return false;
};
