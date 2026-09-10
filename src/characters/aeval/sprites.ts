import type { ActionId, AnimDef, AnimName, CharacterSprites, MoveId, PixelSheet } from '../../core/types';
import { PALETTE } from './art/palette';
import { BODY_FRAMES } from './art/body';
import { FX_FRAMES } from './art/fx';

const sheet: PixelSheet = { palette: PALETTE, frames: BODY_FRAMES };
const fx: PixelSheet = { palette: PALETTE, frames: FX_FRAMES };

/** One frame, held: the renderer never advances past it. */
function still(frame: string): AnimDef {
  return { frames: [frame], fps: 1, loop: false };
}

const anims: Record<AnimName, AnimDef> = {
  idle: { frames: ['idle0', 'idle1', 'idle2'], fps: 6, loop: true },
  walk: { frames: ['walk0', 'walk1', 'walk2', 'walk3'], fps: 10, loop: true },
  run: { frames: ['run0', 'run1', 'run2', 'run3'], fps: 14, loop: true },
  turn: still('turn0'),
  crouch: still('crouch0'),
  jumpsquat: still('jumpsquat0'),
  jump: still('jump0'),
  fall: still('fall0'),
  land: still('land0'),
  helpless: still('helpless0'),

  jab: { frames: ['jab0', 'jab1'], fps: 10, loop: false },
  ftilt: { frames: ['ftilt0', 'ftilt1'], fps: 12, loop: false },
  utilt: { frames: ['utilt0', 'utilt1'], fps: 12, loop: false },
  dtilt: { frames: ['dtilt0', 'dtilt1'], fps: 12, loop: false },
  dashatk: { frames: ['dashatk0', 'dashatk1'], fps: 12, loop: false },

  fsmash: { frames: ['fsmash0', 'fsmash1', 'fsmash2'], fps: 8, loop: false },
  usmash: { frames: ['usmash0', 'usmash1', 'usmash2'], fps: 8, loop: false },
  dsmash: { frames: ['dsmash0', 'dsmash1', 'dsmash2'], fps: 8, loop: false },

  nair: { frames: ['nair0', 'nair1'], fps: 10, loop: false },
  fair: { frames: ['fair0', 'fair1'], fps: 10, loop: false },
  bair: { frames: ['bair0', 'bair1'], fps: 10, loop: false },
  uair: { frames: ['uair0', 'uair1'], fps: 10, loop: false },
  dair: { frames: ['dair0', 'dair1'], fps: 10, loop: false },

  nspecial: { frames: ['nspecial0', 'nspecial1'], fps: 12, loop: false },
  sspecial: { frames: ['sspecial0', 'sspecial1'], fps: 12, loop: false },
  uspecial: { frames: ['uspecial0', 'uspecial1'], fps: 12, loop: false },
  dspecial: { frames: ['dspecial0', 'dspecial1'], fps: 12, loop: false },

  shield: still('shield0'),
  spotDodge: still('spotDodge0'),
  roll: { frames: ['roll0', 'roll1'], fps: 12, loop: false },
  airDodge: still('airDodge0'),
  hitLight: still('hitLight0'),
  hitStrong: still('hitStrong0'),
  tumble: { frames: ['tumble0', 'tumble1'], fps: 8, loop: true },
  ledgeHang: still('ledgeHang0'),
  ledgeClimb: { frames: ['ledgeClimb0', 'ledgeClimb1'], fps: 12, loop: false },
  taunt: { frames: ['taunt0', 'taunt1'], fps: 4, loop: true },
  dead: still('dead0'),
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
  sheet,
  fx,
  anims,
  animFor,
};
