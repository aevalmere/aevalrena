import type { CharacterDef, MoveDef, MoveId } from '../../core/types';

/**
 * Stub frame data. The sim worker replaces every entry with real hitboxes,
 * velocities, and timings per SPEC section 5. This file only needs to
 * typecheck for the scaffold.
 */
const MOVE_IDS: MoveId[] = [
  'jab', 'ftilt', 'utilt', 'dtilt', 'dashatk',
  'fsmash', 'usmash', 'dsmash',
  'nair', 'fair', 'bair', 'uair', 'dair',
  'nspecial', 'sspecial', 'uspecial', 'dspecial',
  'taunt', 'ledgeatk', 'getupatk',
];

function placeholderMove(id: MoveId): MoveDef {
  return { id, totalFrames: 20, hitboxes: [] };
}

const moves = {} as Record<MoveId, MoveDef>;
for (const id of MOVE_IDS) {
  moves[id] = placeholderMove(id);
}

export const aevalDef: CharacterDef = {
  id: 'aeval',
  name: 'Aeval',
  weight: 88,
  walkSpeed: 1.3,
  runSpeed: 2.6,
  dashSpeed: 2.8,
  dashFrames: 12,
  groundAccel: 0.35,
  groundFriction: 0.22,
  airSpeed: 1.7,
  airAccel: 0.12,
  airFriction: 0.03,
  gravity: 0.15,
  maxFall: 3.2,
  fastFall: 5.0,
  jumpVel: 5.4,
  shortHopVel: 3.5,
  doubleJumpVel: 5.0,
  jumps: 2,
  jumpSquat: 3,
  hurtbox: { w: 26, h: 40 },
  crouchHurtbox: { w: 26, h: 26 },
  ledgeGrabBox: { w: 20, h: 24, yOff: -30 },
  moves,
};
