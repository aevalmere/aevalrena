import { FOOTSTOOL } from '../core/constants';
import type { CharacterDef, GameState, Rect } from '../core/types';
import { canBeHit } from './hits';
import { clearBuffer } from './input';
import { isLedgeAction } from './ledge';
import { defOf, fighterHurtbox, sameTeam, setAction, simFighters, type SimFighter } from './state';

/**
 * Footstools: an airborne jump off another fighter's head. It beats a double jump and
 * does not spend one, and it leaves the fighter underneath unable to act for a moment.
 */

const HURT: Rect = { x: 0, y: 0, w: 0, h: 0 };

/**
 * The fighter whose head `f`'s feet are on: feet at most FOOTSTOOL.reachY px above the
 * hurtbox top and horizontally within half its width plus FOOTSTOOL.reachX. Lowest
 * index wins, so two heads at once are decided the same way every run.
 */
function footstoolTarget(state: GameState, f: SimFighter): SimFighter | null {
  const fighters = simFighters(state);
  for (let i = 0; i < fighters.length; i++) {
    const v = fighters[i];
    if (v === f || !canBeHit(v)) continue;
    // Teams rule: no footstool off a teammate's head.
    if (sameTeam(state, f.slot, v.slot)) continue;
    if (v.action === 'grabbed' || v.action === 'finalSmashVictim' || isLedgeAction(v.action)) continue;
    // A holder is busy with its victim; a footstool would pull it out of the hold.
    if (v.action === 'grabHold' || v.action === 'pummel' || v.action === 'throw' || v.action === 'finalSmash') continue;
    fighterHurtbox(v, defOf(v), HURT);
    const above = HURT.y - f.y;
    if (above < 0 || above > FOOTSTOOL.reachY) continue;
    if (Math.abs(f.x - v.x) > HURT.w / 2 + FOOTSTOOL.reachX) continue;
    return v;
  }
  return null;
}

/**
 * Jumps off a head if one is in reach. Used by the airborne Jump press, before the
 * double jump, and by the footstool command. Returns true when the footstool happened.
 */
export function tryFootstool(state: GameState, f: SimFighter, def: CharacterDef): boolean {
  if (f.onGround) return false;
  const v = footstoolTarget(state, f);
  if (v === null) return false;

  f.vy = -def.jumpVel;
  f.fastFalling = false;
  setAction(f, 'air');

  const grounded = v.onGround;
  setAction(v, 'footstooled');
  v.stateTimer = grounded ? FOOTSTOOL.victimGround : FOOTSTOOL.victimAir;
  if (!grounded) v.vy = FOOTSTOOL.victimVy;
  v.fastFalling = false;
  v.hitstun = 0;
  v.kbSpeed = 0;
  v.kbFall = 0;
  clearBuffer(v);
  state.events.push({ type: 'footstool', x: f.x, y: f.y, attacker: f.slot, victim: v.slot });
  return true;
}

/** The fighter underneath a footstool: no options until its timer runs out. */
export function stepFootstooled(f: SimFighter): void {
  f.stateTimer--;
  if (f.stateTimer > 0) return;
  setAction(f, f.onGround ? 'idle' : 'air');
}
