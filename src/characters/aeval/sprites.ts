import type { ActionId, AnimDef, AnimName, CharacterSprites, MoveId } from '../../core/types';
import { BODY_ATLAS } from './art/atlas.body';
import { FX_ATLAS } from './art/atlas.fx';

/**
 * Aeval's animation table.
 *
 * Frames come from the reference sheets through tools/spritegen, so the names
 * here are the poses those sheets actually contain. Aeval is a water mage and
 * every attack pose already has its water drawn into it: the sweeps, arcs and
 * thrusts are part of the frame rather than an effect layered on top. Only
 * water that has to travel or outlive the move (the orb, the tidal crescent,
 * the geyser, the whirlpool) lives on the effect sheet.
 */

/** One frame, held: the renderer never advances past it. */
function still(frame: string): AnimDef {
  return { frames: [frame], fps: 1, loop: false };
}

const anims: Record<AnimName, AnimDef> = {
  idle: { frames: ['idle0', 'idle1', 'idle2'], fps: 6, loop: true },
  walk: { frames: ['walk0', 'walk1', 'walk2'], fps: 9, loop: true },
  run: { frames: ['run0', 'run1', 'run2'], fps: 13, loop: true },
  turn: still('turn'),
  crouch: still('crouch'),
  jumpsquat: still('crouch'),
  jump: still('jump'),
  fall: still('fall'),
  land: still('land'),
  helpless: still('helpless'),

  // Ground normals. Every one throws water forward or along the ground.
  jab: { frames: ['jab0', 'jab1'], fps: 14, loop: false },
  ftilt: { frames: ['jab0', 'ftilt1'], fps: 12, loop: false },
  utilt: { frames: ['cast', 'utilt1'], fps: 12, loop: false },
  dtilt: { frames: ['crouch', 'dtilt1'], fps: 12, loop: false },
  dashatk: { frames: ['run1', 'ftilt1'], fps: 12, loop: false },

  fsmash: { frames: ['jab0', 'fsmash2', 'fsmash2'], fps: 8, loop: false },
  usmash: { frames: ['cast', 'usmash2', 'usmash2'], fps: 8, loop: false },
  dsmash: { frames: ['crouch', 'dtilt1', 'dtilt1'], fps: 8, loop: false },

  nair: { frames: ['nair1'], fps: 1, loop: false },
  fair: { frames: ['jab0', 'fair1'], fps: 11, loop: false },
  bair: { frames: ['jab0', 'bair1'], fps: 12, loop: false },
  uair: { frames: ['cast', 'uair1'], fps: 12, loop: false },
  dair: { frames: ['crouch', 'dtilt1'], fps: 11, loop: false },

  // Firing is the casting pose: the orb leaves her hands on one held frame.
  nspecial: still('cast'),
  // The wind-up the renderer swaps in while nspecial is being held. The sim
  // pins actionFrame to 0 for the whole hold, so this reads as the nspecial0
  // pose held still; nspecial1 only shows if the hold ever advances its frame.
  nspecialCharge: { frames: ['nspecial0', 'nspecial1'], fps: 10, loop: false },
  sspecial: { frames: ['cast', 'jab1'], fps: 10, loop: false },
  uspecial: { frames: ['cast', 'usmash2'], fps: 12, loop: false },
  dspecial: { frames: ['cast', 'nair1'], fps: 10, loop: false },

  shield: still('crouch'),
  spotDodge: still('crouch'),
  roll: { frames: ['downed', 'downed'], fps: 12, loop: false },
  airDodge: still('airDodge'),
  hitLight: still('hitLight'),
  hitStrong: still('hitStrong'),
  tumble: { frames: ['hitStrong', 'helpless'], fps: 8, loop: true },
  ledgeHang: still('helpless'),
  ledgeClimb: { frames: ['downed', 'crouch'], fps: 10, loop: false },
  taunt: { frames: ['taunt', 'cast'], fps: 3, loop: true },
  dead: still('dead'),
};

const MOVE_ANIM: Record<MoveId, AnimName> = {
  jab: 'jab',
  ftilt: 'ftilt',
  utilt: 'utilt',
  dtilt: 'dtilt',
  dashatk: 'dashatk',
  fsmash: 'fsmash',
  usmash: 'usmash',
  dsmash: 'dsmash',
  nair: 'nair',
  fair: 'fair',
  bair: 'bair',
  uair: 'uair',
  dair: 'dair',
  nspecial: 'nspecial',
  sspecial: 'sspecial',
  uspecial: 'uspecial',
  dspecial: 'dspecial',
  taunt: 'taunt',
  ledgeatk: 'ftilt',
  getupatk: 'ftilt',
};

const ACTION_ANIM: Record<ActionId, AnimName> = {
  idle: 'idle',
  walk: 'walk',
  dash: 'run',
  run: 'run',
  turn: 'turn',
  crouch: 'crouch',
  jumpsquat: 'jumpsquat',
  // The renderer swaps in 'fall' once the fighter is moving downward.
  air: 'jump',
  airHelpless: 'helpless',
  land: 'land',
  attack: 'idle',
  shield: 'shield',
  shieldStun: 'hitLight',
  shieldBreak: 'hitStrong',
  spotDodge: 'spotDodge',
  roll: 'roll',
  airDodge: 'airDodge',
  hitstun: 'hitLight',
  tumble: 'tumble',
  ledgeGrab: 'ledgeHang',
  ledgeHang: 'ledgeHang',
  ledgeClimb: 'ledgeClimb',
  ledgeRoll: 'roll',
  ledgeJump: 'jump',
  dead: 'dead',
  respawn: 'idle',
};

function animFor(action: ActionId, moveId: MoveId | null): AnimName {
  if (action === 'attack' && moveId !== null) {
    const byMove = MOVE_ANIM[moveId];
    if (byMove !== undefined && anims[byMove] !== undefined) return byMove;
    return 'idle';
  }
  const byAction = ACTION_ANIM[action];
  if (byAction !== undefined && anims[byAction] !== undefined) return byAction;
  return 'idle';
}

export const aevalSprites: CharacterSprites = {
  sheet: BODY_ATLAS,
  fx: FX_ATLAS,
  anims,
  animFor,
};
