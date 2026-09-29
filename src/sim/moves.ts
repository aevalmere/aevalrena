import { TUNING } from '../core/constants';
import { Btn } from '../core/types';
import type { CharacterDef, GameState, MoveDef, MoveId } from '../core/types';
import { setAction, type SimFighter } from './state';
import { spawnProjectile } from './projectiles';
import { chargeFraction, projectileChargePower, projectileChargeScale } from './hits';

/**
 * Frames a charged cast adds to both the projectile spawn frames and totalFrames:
 * chargeCastFrames times the charge fraction, rounded. f.charge stays on the fighter for
 * the whole move, so this reads the same on every frame of it.
 */
export function castDelay(f: SimFighter, mv: MoveDef): number {
  if (mv.chargeCastFrames === undefined) return 0;
  return Math.round(mv.chargeCastFrames * chargeFraction(f.charge, mv.chargeable));
}

export function moveOf(f: SimFighter, def: CharacterDef): MoveDef {
  return def.moves[f.moveId as MoveId];
}

/**
 * Applies everything a move schedules on one of its frames: momentum injections,
 * projectile spawns and invulnerability windows. A frame that injects vy owns the
 * vertical speed for that frame, so gravity is skipped (rising specials need it).
 */
function applyMoveFrame(state: GameState, f: SimFighter, mv: MoveDef, frame: number): void {
  const vel = mv.velocity;
  if (vel !== undefined) {
    for (let i = 0; i < vel.length; i++) {
      const v = vel[i];
      if (v.frame !== frame) continue;
      if (v.vx !== undefined) {
        const dx = v.vx * f.facing;
        f.vx = v.setX === true ? dx : f.vx + dx;
      }
      if (v.vy !== undefined) {
        f.vy = v.setY === true ? v.vy : f.vy + v.vy;
        f.skipGravity = true;
      }
    }
  }
  const shots = mv.projectiles;
  if (shots !== undefined) {
    // A charged shot swells on the exponential scale curve (hit circle and sprite). A def
    // with `charged` gets all of its extra damage, strength and knockback from that lerp,
    // so its power stays exactly 1 (no double scaling); a chargeable def without `charged`
    // still rides projectileChargePower. An unchargeable move spawns at exactly 1 and 1.
    const power = projectileChargePower(f.charge, mv.chargeable);
    const scale = projectileChargeScale(f.charge, mv.chargeable);
    const delay = castDelay(f, mv);
    for (let i = 0; i < shots.length; i++) {
      const at = shots[i].spawnFrame;
      // A burst-only def (spawnFrame -1) never fires from the timeline, delay or not.
      if (at >= 0 && at + delay === frame) {
        spawnProjectile(state, f, shots[i], shots[i].charged === undefined ? power : 1, scale);
      }
    }
  }
  const inv = mv.invuln;
  if (inv !== undefined && frame >= inv[0] && frame <= inv[1] && f.invuln < 2) f.invuln = 2;
}

/**
 * The buttons that have to stay down for a move to keep charging, worked out once when the
 * move starts. Smashes charge on Attack and specials on Special, but a smash fired by a
 * shortcut that has no Attack key in it (the F&W up smash, the F&S down smash, the C-stick)
 * would then never charge at all, so the smash's own direction holds the charge instead.
 */
function chargeMaskFor(f: SimFighter, mv: MoveDef, id: MoveId): number {
  if (mv.chargeable !== true) return 0;
  if (mv.chargeButton === 'special') return Btn.Special;
  let mask = Btn.Attack;
  if ((f.inputHeld & Btn.Attack) === 0) {
    // Started without Attack (a chord or the C-stick): the smash's own direction holds the charge.
    if (id === 'usmash') mask |= Btn.Up | Btn.CUp;
    else if (id === 'dsmash') mask |= Btn.Down | Btn.CDown;
    else if (id === 'fsmash') mask |= f.facing === 1 ? (Btn.Right | Btn.CRight) : (Btn.Left | Btn.CLeft);
  }
  return mask;
}

/** True while the current move's charge is still being held down. */
function chargeHeld(f: SimFighter): boolean {
  return (f.inputHeld & f.chargeMask) !== 0;
}

export function startMove(state: GameState, f: SimFighter, def: CharacterDef, id: MoveId): void {
  const mv = def.moves[id];
  setAction(f, 'attack');
  f.moveId = id;
  f.hitGroups = 0;
  f.charge = 0;
  f.chargeMask = chargeMaskFor(f, mv, id);
  f.charging = mv.chargeable === true && chargeHeld(f);
  if (!f.charging) applyMoveFrame(state, f, mv, 0);
}

export function endMove(f: SimFighter, mv: MoveDef): void {
  if (f.onGround) {
    setAction(f, 'idle');
    return;
  }
  setAction(f, mv.helplessAfter === true ? 'airHelpless' : 'air');
}

/** Advances the current move by one frame. Returns true on the frame the move ends. */
export function advanceMove(state: GameState, f: SimFighter, def: CharacterDef): boolean {
  const mv = moveOf(f, def);

  if (f.charging) {
    f.actionFrame = 0;
    const holding = chargeHeld(f);
    if (holding && f.charge < TUNING.input.chargeMax) {
      f.charge++;
      return false;
    }
    f.charging = false;
    applyMoveFrame(state, f, mv, 0);
    return false;
  }

  if (f.actionFrame >= mv.totalFrames + castDelay(f, mv)) {
    endMove(f, mv);
    return true;
  }
  applyMoveFrame(state, f, mv, f.actionFrame);
  return false;
}
