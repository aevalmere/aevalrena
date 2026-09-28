// Aeval's sprites come from the generated sheets in art/aeval/sheets,
// cut by tools/sheetcut/cut.py, packed by tools/sheetcut/pack.py and mapped by
// art/aeval/sheetmap.json. The atlases and animation tables in ./art are
// generated; rerun pack.py instead of editing them.

import { SIM_HZ } from '../../core/types';
import type { ActionId, AnimDef, AnimName, CharacterSprites, FighterState, MoveId } from '../../core/types';
import { AEVAL_BODY_SHEET } from './art/atlas.body';
import { AEVAL_FX_SHEET } from './art/atlas.fx';
import { AEVAL_ANIMS } from './art/anims';

const anims: Record<AnimName, AnimDef> = AEVAL_ANIMS;

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
  taunt2: 'taunt2',
  taunt3: 'taunt3',
  ledgeatk: 'ledgeatk',
  getupatk: 'getupatk',
};

const ACTION_ANIM: Record<ActionId, AnimName> = {
  idle: 'idle',
  walk: 'walk',
  dash: 'dash',
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
  grab: 'grab',
  grabHold: 'grabHold',
  pummel: 'pummel',
  // The fighter state carries no throw direction; every throw uses the forward one.
  throw: 'throwF',
  grabbed: 'grabbed',
  tech: 'tech',
  techRoll: 'techRoll',
  downed: 'downed',
  getUp: 'getUp',
  getUpRoll: 'getUpRoll',
  footstooled: 'footstooled',
  finalSmash: 'fsStart',
  finalSmashVictim: 'fsVictim',
};

/** Sim frames the airJump animation lasts: the sum of its holds, or 0 if the sheet lacks it. */
function animLength(def: AnimDef | undefined): number {
  if (def === undefined) return 0;
  if (def.holds !== undefined) {
    let total = 0;
    for (let i = 0; i < def.holds.length; i++) total += def.holds[i] > 0 ? def.holds[i] : 1;
    return total;
  }
  return def.fps > 0 ? Math.ceil((def.frames.length * SIM_HZ) / def.fps) : 0;
}
const AIR_JUMP_FRAMES = animLength(anims['airJump']);

function animFor(action: ActionId, moveId: MoveId | null, fighter: FighterState): AnimName {
  // setAction restarts actionFrame at the mid-air jump, so the anim starts on its first frame.
  if (action === 'air' && fighter.airJumped && fighter.actionFrame < AIR_JUMP_FRAMES) return 'airJump';
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
  sheet: AEVAL_BODY_SHEET,
  fx: AEVAL_FX_SHEET,
  anims,
  animFor,
};
