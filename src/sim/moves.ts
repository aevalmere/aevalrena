import { SMASH_CHARGE_MAX } from '../core/constants';
import { Btn } from '../core/types';
import type { CharacterDef, GameState, MoveDef, MoveId } from '../core/types';
import { setAction, type SimFighter } from './state';
import { spawnProjectile } from './projectiles';

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
    for (let i = 0; i < shots.length; i++) {
      if (shots[i].spawnFrame === frame) spawnProjectile(state, f, shots[i]);
    }
  }
  const inv = mv.invuln;
  if (inv !== undefined && frame >= inv[0] && frame <= inv[1] && f.invuln < 2) f.invuln = 2;
}

export function startMove(state: GameState, f: SimFighter, def: CharacterDef, id: MoveId): void {
  const mv = def.moves[id];
  setAction(f, 'attack');
  f.moveId = id;
  f.hitGroups = 0;
  f.charge = 0;
  f.charging = mv.chargeable === true && (f.inputHeld & Btn.Attack) !== 0;
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
    const holding = (f.inputHeld & Btn.Attack) !== 0;
    if (holding && f.charge < SMASH_CHARGE_MAX) {
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
