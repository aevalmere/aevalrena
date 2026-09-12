import { TUNING } from '../core/constants';
import { Btn } from '../core/types';
import type { CharacterDef, GameState, MoveDef, MoveId } from '../core/types';
import { setAction, type SimFighter } from './state';
import { spawnProjectile } from './projectiles';
import { projectileChargePower, projectileChargeScale } from './hits';

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
    // A charged shot swells and hits harder on its own exponential curve, so a tap is a
    // small feeble shot that comes out at once and a full charge still tops out where it
    // always did. An unchargeable move spawns at exactly 1 and 1.
    const power = projectileChargePower(f.charge, mv.chargeable);
    const scale = projectileChargeScale(f.charge, mv.chargeable);
    for (let i = 0; i < shots.length; i++) {
      if (shots[i].spawnFrame === frame) spawnProjectile(state, f, shots[i], power, scale);
    }
  }
  const inv = mv.invuln;
  if (inv !== undefined && frame >= inv[0] && frame <= inv[1] && f.invuln < 2) f.invuln = 2;
}

/**
 * The button that has to stay down for a move to keep charging. Smashes charge on
 * Attack, specials on Special; both the start and the hold check read it from here so
 * they can never disagree about which button is being held.
 */
function chargeBit(mv: MoveDef): number {
  return mv.chargeButton === 'special' ? Btn.Special : Btn.Attack;
}

export function startMove(state: GameState, f: SimFighter, def: CharacterDef, id: MoveId): void {
  const mv = def.moves[id];
  setAction(f, 'attack');
  f.moveId = id;
  f.hitGroups = 0;
  f.charge = 0;
  f.charging = mv.chargeable === true && (f.inputHeld & chargeBit(mv)) !== 0;
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
    const holding = (f.inputHeld & chargeBit(mv)) !== 0;
    if (holding && f.charge < TUNING.input.chargeMax) {
      f.charge++;
      return false;
    }
    f.charging = false;
    applyMoveFrame(state, f, mv, 0);
    return false;
  }

  if (f.actionFrame >= mv.totalFrames) {
    endMove(f, mv);
    return true;
  }
  applyMoveFrame(state, f, mv, f.actionFrame);
  return false;
}
