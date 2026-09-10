import { SIM_HZ } from '../core/types';
import type { AnimDef, AnimName, CharacterSprites, FighterState } from '../core/types';

/**
 * Animation selection. Names come from CharacterSprites.animFor; anything the
 * sheet does not define falls back to idle and is recorded once so a missing
 * animation never throws and never spams.
 */

const FALLBACK_ANIM = 'idle';
const reportedMisses = new Set<string>();

/** Animation names the renderer could not resolve, for the debug overlay. */
export function missingAnims(): ReadonlySet<string> {
  return reportedMisses;
}

function firstAnimName(sprites: CharacterSprites): AnimName | null {
  for (const key in sprites.anims) return key;
  return null;
}

/**
 * Pick the animation for a fighter. Falling in the air prefers a 'fall'
 * animation when the sheet has one.
 */
export function pickAnimName(sprites: CharacterSprites, fighter: FighterState): AnimName | null {
  let name: AnimName;
  const chosen = sprites.animFor(fighter.action, fighter.moveId);
  name = typeof chosen === 'string' ? chosen : FALLBACK_ANIM;

  if (fighter.action === 'air' && fighter.vy > 0 && sprites.anims['fall'] !== undefined) {
    name = 'fall';
  }

  if (sprites.anims[name] !== undefined) return name;

  if (!reportedMisses.has(name)) reportedMisses.add(name);

  if (sprites.anims[FALLBACK_ANIM] !== undefined) return FALLBACK_ANIM;
  return firstAnimName(sprites);
}

/** Frame index inside an animation for a given action frame count. */
export function animFrameIndex(def: AnimDef, actionFrame: number): number {
  const count = def.frames.length;
  if (count <= 1) return 0;
  const fps = def.fps > 0 ? def.fps : 1;
  const frame = actionFrame < 0 ? 0 : actionFrame;
  const raw = Math.floor((frame * fps) / SIM_HZ);
  if (def.loop) {
    const i = raw % count;
    return i < 0 ? 0 : i;
  }
  return raw >= count ? count - 1 : raw;
}

/** Resolve a fighter to a sheet frame name, or null if the sheet has nothing. */
export function frameNameFor(sprites: CharacterSprites, fighter: FighterState): string | null {
  const name = pickAnimName(sprites, fighter);
  if (name === null) return null;
  const def = sprites.anims[name];
  if (def === undefined || def.frames.length === 0) return null;
  return def.frames[animFrameIndex(def, fighter.actionFrame)];
}

/** First frame of the idle animation, used for HUD portraits. */
export function portraitFrameName(sprites: CharacterSprites): string | null {
  if (sprites.sheet.frames['idle0'] !== undefined) return 'idle0';
  const idle = sprites.anims[FALLBACK_ANIM];
  if (idle !== undefined && idle.frames.length > 0) return idle.frames[0];
  const first = firstAnimName(sprites);
  if (first !== null) {
    const def = sprites.anims[first];
    if (def !== undefined && def.frames.length > 0) return def.frames[0];
  }
  for (const key in sprites.sheet.frames) return key;
  return null;
}
