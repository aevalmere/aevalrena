import { LOW_HIT_HEIGHT } from '../core/constants';
import type { FighterState, MoveId } from '../core/types';
import type { SimFighter } from './state';

/** Moves whose every hitbox counts as low, whatever its height. */
const LOW_MOVES: readonly MoveId[] = ['dtilt', 'dsmash'];

/**
 * A low hit is one a roll cannot dodge: a hitbox or projectile flagged `low`, any
 * hitbox of a move in LOW_MOVES, or a hit from a grounded attacker whose center sits
 * within LOW_HIT_HEIGHT px above the victim's feet, so an aerial skimming the floor
 * never counts. `moveId` is the attacker's move, null for projectiles.
 * `attackerGrounded` is the attacker's onGround; projectiles pass true and keep the height rule.
 */
export function isLowHit(
  victim: FighterState, hitY: number, low: boolean | undefined, moveId: MoveId | null, attackerGrounded: boolean,
): boolean {
  if (low === true) return true;
  if (moveId !== null) {
    for (let i = 0; i < LOW_MOVES.length; i++) {
      if (LOW_MOVES[i] === moveId) return true;
    }
  }
  return attackerGrounded && hitY >= victim.y - LOW_HIT_HEIGHT;
}

/**
 * True when the hit whiffs because the victim is inside a roll's dodge window
 * (highDodge) and the hit is not low. Full invulnerability is checked elsewhere.
 */
export function dodgesHit(
  victim: SimFighter, hitY: number, low: boolean | undefined, moveId: MoveId | null, attackerGrounded: boolean,
): boolean {
  return victim.highDodge > 0 && !isLowHit(victim, hitY, low, moveId, attackerGrounded);
}
