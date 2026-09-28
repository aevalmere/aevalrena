import { FS_METER, TUNING } from '../core/constants';
import type { CharacterDef, FinalSmashDef, GameState } from '../core/types';
import { applyHit, gainFsMeter } from './hits';
import { clearBuffer } from './input';
import { unlinkGrab } from './grab';
import { defOf, recordHit, sameTeam, setAction, simFighters, type SimFighter } from './state';

/**
 * Final Smashes.
 *
 * A full meter under the finalSmash rule turns the next Special press (or the finalSmash
 * command) into the character's FinalSmashDef. The attacker hangs in place, invulnerable,
 * for the whole action. On the startup frame it picks one opponent and links it by
 * fighters[] index: the attacker's fsVictim names the victim and the victim's fsAttacker
 * names the attacker. The victim is carried along def.path by syncFinalSmash, takes the
 * def's damage-only hits, and is launched with a real hit on launch.frame.
 *
 * Like grabs, each side checks the link on its own step and lets go when the other side
 * has left its action, so a KO on either side (match.ts unlinks) frees the other.
 */

const PERCENT_CAP = 999;
/** How far behind the attacker's feet a target may stand and still count as in front. */
const BEHIND_TOLERANCE = 8;
/** Where the damage-only hits and the launch are drawn from, above the victim's feet. */
const HIT_HEIGHT = 20;

function indexOfFighter(fighters: SimFighter[], f: SimFighter): number {
  for (let i = 0; i < fighters.length; i++) {
    if (fighters[i] === f) return i;
  }
  return -1;
}

function inFinalSmash(f: SimFighter): boolean {
  return f.action === 'finalSmash' || f.action === 'finalSmashVictim';
}

/** Stays invulnerable for at least the next frame; the per-frame decrement never reaches 0. */
function holdInvuln(f: SimFighter): void {
  if (f.invuln < 2) f.invuln = 2;
}

/**
 * Actions a Final Smash can come out of: the free ground and air states, and a move past
 * its iasa frame. tryBufferedAction only runs for these anyway; the check is here so the
 * CPU and the UI can ask the same question.
 */
function actionable(f: SimFighter, def: CharacterDef): boolean {
  if (f.hitlag > 0) return false;
  switch (f.action) {
    case 'idle':
    case 'walk':
    case 'dash':
    case 'run':
    case 'turn':
    case 'crouch':
    case 'air':
      return true;
    case 'attack': {
      if (f.moveId === null) return false;
      const iasa = def.moves[f.moveId].iasa;
      return iasa !== undefined && f.actionFrame >= iasa;
    }
    default:
      return false;
  }
}

/** Rule on, meter full, the character has a Final Smash, and the fighter can act. */
export function canFinalSmash(state: GameState, f: SimFighter, def: CharacterDef): boolean {
  if (state.config.finalSmash !== true) return false;
  if (f.fsMeter < FS_METER.max) return false;
  if (def.finalSmash === undefined) return false;
  return actionable(f, def);
}

/**
 * The 'nearestFacing' pick: the closest living opponent whose feet are no more than
 * BEHIND_TOLERANCE px behind the attacker, at any distance. Fighters already in a Final
 * Smash on either side, and dead or respawning fighters, are skipped. Ties go to the
 * lowest index, so every run agrees.
 */
function pickTarget(state: GameState, f: SimFighter): number {
  const fighters = simFighters(state);
  let best = -1;
  let bestDist = 0;
  for (let i = 0; i < fighters.length; i++) {
    const v = fighters[i];
    if (v === f || v.stocks <= 0 || v.action === 'dead' || v.action === 'respawn' || inFinalSmash(v)) continue;
    // Teams rule: a Final Smash never catches a teammate.
    if (sameTeam(state, f.slot, v.slot)) continue;
    const dx = v.x - f.x;
    if (dx * f.facing < -BEHIND_TOLERANCE) continue;
    const dy = v.y - f.y;
    const dist = dx * dx + dy * dy;
    if (best >= 0 && dist >= bestDist) continue;
    best = i;
    bestDist = dist;
  }
  return best;
}

/** The victim's offset along def.path at `frame`: linear between keys, held past either end. */
function pathOffset(fs: FinalSmashDef, frame: number, axis: 'x' | 'y'): number {
  const path = fs.path;
  if (path.length === 0) return 0;
  if (frame <= path[0].frame) return path[0][axis];
  for (let i = 1; i < path.length; i++) {
    const b = path[i];
    if (frame > b.frame) continue;
    const a = path[i - 1];
    const span = b.frame - a.frame;
    const t = span <= 0 ? 1 : (frame - a.frame) / span;
    return a[axis] + (b[axis] - a[axis]) * t;
  }
  return path[path.length - 1][axis];
}

function placeVictim(attacker: SimFighter, victim: SimFighter, fs: FinalSmashDef, frame: number): void {
  victim.x = attacker.x + pathOffset(fs, frame, 'x') * attacker.facing;
  victim.y = attacker.y + pathOffset(fs, frame, 'y');
  victim.prevY = victim.y;
  victim.vx = 0;
  victim.vy = 0;
  victim.onGround = false;
  victim.facing = attacker.facing === 1 ? -1 : 1;
}

/** The linked victim if the link still holds on both sides, else null. */
function linkedVictim(fighters: SimFighter[], f: SimFighter, me: number): SimFighter | null {
  const i = f.fsVictim;
  if (i < 0 || i >= fighters.length) return null;
  const v = fighters[i];
  return v.action === 'finalSmashVictim' && v.fsAttacker === me ? v : null;
}

/** The linked attacker if the link still holds on both sides, else null. */
function linkedAttacker(fighters: SimFighter[], f: SimFighter, me: number): SimFighter | null {
  const i = f.fsAttacker;
  if (i < 0 || i >= fighters.length) return null;
  const a = fighters[i];
  return a.action === 'finalSmash' && a.fsVictim === me ? a : null;
}

/** Drops a victim whose Final Smash is over without a launch: back to neutral, free to be hit. */
function freeVictim(v: SimFighter): void {
  v.fsAttacker = -1;
  v.invuln = 0;
  v.vx = 0;
  v.vy = 0;
  setAction(v, v.onGround ? 'idle' : 'air');
}

/** Pulls `victim` out of whatever it was doing and links it to `f`. */
function catchVictim(state: GameState, f: SimFighter, me: number, victim: SimFighter, vi: number): void {
  // Any grab the victim was part of breaks; the other side sees it on its own step.
  unlinkGrab(state, victim);
  victim.activeThrow = null;
  victim.activeThrowId = null;
  setAction(victim, 'finalSmashVictim');
  if (!state.finished) f.stats.finalSmashHits++;
  victim.fsAttacker = me;
  f.fsVictim = vi;
  victim.hitstun = 0;
  victim.hitlag = 0;
  victim.kbSpeed = 0;
  victim.kbFall = 0;
  victim.fastFalling = false;
  victim.ledge = -1;
  victim.highDodge = 0;
  holdInvuln(victim);
  clearBuffer(victim);
}

/** Starts the Final Smash. canFinalSmash must have said yes. */
export function startFinalSmash(state: GameState, f: SimFighter, def: CharacterDef): void {
  f.fsMeter = 0;
  setAction(f, 'finalSmash');
  f.vx = 0;
  f.vy = 0;
  f.kbSpeed = 0;
  f.kbFall = 0;
  f.fastFalling = false;
  f.fsVictim = -1;
  holdInvuln(f);
  clearBuffer(f);
  // The catch re-picks on the startup frame; this names who the rule sees right now, so
  // the renderer has someone to point at from the first frame.
  const preview = def.finalSmash === undefined ? -1 : pickTarget(state, f);
  const victim = preview < 0 ? -1 : simFighters(state)[preview].slot;
  state.events.push({ type: 'finalSmash', x: f.x, y: f.y, attacker: f.slot, victim, phase: 'start' });
  if (!state.finished) f.stats.finalSmashes++;
}

/** One step of the attacker's Final Smash. Called from stepAction. */
export function stepFinalSmash(state: GameState, f: SimFighter, def: CharacterDef): void {
  const fs = def.finalSmash;
  const fighters = simFighters(state);
  const me = indexOfFighter(fighters, f);
  if (fs === undefined) {
    releaseFinalSmash(state, me);
    setAction(f, f.onGround ? 'idle' : 'air');
    return;
  }
  f.vx = 0;
  f.vy = 0;
  holdInvuln(f);
  clearBuffer(f);
  const frame = f.actionFrame;

  if (frame === fs.startup && f.fsVictim < 0) {
    const vi = pickTarget(state, f);
    if (vi >= 0) {
      const v = fighters[vi];
      catchVictim(state, f, me, v, vi);
      placeVictim(f, v, fs, frame);
    }
  }

  const victim = linkedVictim(fighters, f, me);
  if (victim === null) f.fsVictim = -1;
  const victimSlot = victim === null ? -1 : victim.slot;

  for (let i = 0; i < fs.phases.length; i++) {
    if (fs.phases[i].start !== frame) continue;
    state.events.push({ type: 'finalSmash', x: f.x, y: f.y, attacker: f.slot, victim: victimSlot, phase: fs.phases[i].name });
  }

  if (victim !== null) {
    // Teams rule: a teammate victim (pickTarget never picks one, but guarded) takes no damage.
    const friendly = sameTeam(state, f.slot, victim.slot);
    for (let i = 0; i < fs.hits.length; i++) {
      if (friendly || fs.hits[i].frame !== frame) continue;
      const damage = fs.hits[i].damage * TUNING.knockback.damageMul;
      recordHit(state, victim, f.slot, Math.min(PERCENT_CAP, victim.percent + damage) - victim.percent);
      victim.percent = Math.min(PERCENT_CAP, victim.percent + damage);
      victim.lastHitBy = f.slot;
      gainFsMeter(state, f, victim, damage);
      state.events.push({
        type: 'hit', x: victim.x, y: victim.y - HIT_HEIGHT,
        attacker: f.slot, victim: victim.slot, damage, kb: 0, angle: 0,
      });
    }

    const l = fs.launch;
    if (frame === l.frame) {
      placeVictim(f, victim, fs, frame);
      f.fsVictim = -1;
      victim.fsAttacker = -1;
      victim.invuln = 0;
      setAction(victim, 'air');
      clearBuffer(victim);
      const hy = victim.y - HIT_HEIGHT;
      state.events.push({ type: 'finalSmash', x: victim.x, y: hy, attacker: f.slot, victim: victim.slot, phase: 'launch' });
      applyHit(state, victim, f.slot, f.facing, l.damage, l.angle, l.bkb, l.kbg, 1, 0, victim.x, hy);
    }
  }

  if (frame < fs.totalFrames) return;
  // A def whose launch comes after totalFrames never launches; the victim just drops.
  releaseFinalSmash(state, me);
  setAction(f, f.onGround ? 'idle' : 'air');
}

/**
 * One step of a caught fighter. Input does nothing; position comes from syncFinalSmash.
 * A broken link (the attacker was KO'd, or its action ended) frees the victim here.
 */
export function stepFinalSmashVictim(state: GameState, f: SimFighter): void {
  const fighters = simFighters(state);
  if (linkedAttacker(fighters, f, indexOfFighter(fighters, f)) === null) {
    freeVictim(f);
    return;
  }
  f.vx = 0;
  f.vy = 0;
  holdInvuln(f);
  clearBuffer(f);
}

/**
 * Lets go of the victim held by fighters[attackerIndex] at once, without a launch: the
 * victim drops back to idle or air. Clears the link on both sides. Safe with no victim.
 */
export function releaseFinalSmash(state: GameState, attackerIndex: number): void {
  const fighters = simFighters(state);
  if (attackerIndex < 0 || attackerIndex >= fighters.length) return;
  const f = fighters[attackerIndex];
  const v = linkedVictim(fighters, f, attackerIndex);
  f.fsVictim = -1;
  if (v !== null) freeVictim(v);
}

/**
 * Clears every Final Smash link `f` is part of, as attacker or victim. A held victim is
 * freed at once; an attacker who loses its victim plays the rest of the action as a whiff.
 * Used when `f` is KO'd or respawns.
 */
export function unlinkFinalSmash(state: GameState, f: SimFighter): void {
  const fighters = simFighters(state);
  const me = indexOfFighter(fighters, f);
  if (f.fsVictim >= 0) releaseFinalSmash(state, me);
  const a = f.fsAttacker;
  if (a >= 0 && a < fighters.length && fighters[a].fsVictim === me) fighters[a].fsVictim = -1;
  f.fsAttacker = -1;
}

/**
 * Carries every caught victim along its attacker's path. Runs after all fighters have
 * moved, next to syncGrabbed, so hits this frame see the victim where it is drawn.
 */
export function syncFinalSmash(state: GameState): void {
  const fighters = simFighters(state);
  for (let i = 0; i < fighters.length; i++) {
    const v = fighters[i];
    if (v.action !== 'finalSmashVictim') continue;
    const a = linkedAttacker(fighters, v, i);
    if (a === null) continue;
    const fs = defOf(a).finalSmash;
    if (fs === undefined) continue;
    placeVictim(a, v, fs, a.actionFrame);
  }
}
