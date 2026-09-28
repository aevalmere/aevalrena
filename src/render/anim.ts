import { SIM_HZ } from '../core/types';
import type { AnimDef, AnimName, CharacterSprites, FighterState } from '../core/types';

/**
 * Animation selection. Names come from CharacterSprites.animFor; anything the
 * sheet does not define falls back to idle and is recorded once so a missing
 * animation never throws and never spams.
 */

const FALLBACK_ANIM = 'idle';
const CHARGE_SUFFIX = 'Charge';
const AIR_JUMP_ANIM = 'airJump';
const reportedMisses = new Set<string>();

/**
 * Cache of animation name to its charge variant name, so holding a charge never
 * builds a string in the draw path. A name is concatenated once, the first time
 * it is seen, and read out of the map on every frame after that.
 */
const chargeNames = new Map<AnimName, AnimName>();

function chargeNameOf(name: AnimName): AnimName {
  const cached = chargeNames.get(name);
  if (cached !== undefined) return cached;
  const built = name + CHARGE_SUFFIX;
  chargeNames.set(name, built);
  return built;
}

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
 * animation when the sheet has one, and a fighter holding a charge prefers the
 * '<anim>Charge' wind-up pose when the sheet defines one. The sim pins
 * actionFrame to 0 while the charge is held, so that pose holds on its first
 * frame and the move's own animation takes over the frame the charge is let go.
 */
export function pickAnimName(sprites: CharacterSprites, fighter: FighterState): AnimName | null {
  let name: AnimName;
  const chosen = sprites.animFor(fighter.action, fighter.moveId, fighter);
  name = typeof chosen === 'string' ? chosen : FALLBACK_ANIM;

  if (fighter.charging) {
    const held = chargeNameOf(name);
    if (sprites.anims[held] !== undefined) name = held;
  }

  // A mid-air jump's own animation plays through its descent instead of 'fall'.
  if (fighter.action === 'air' && fighter.vy > 0 && name !== AIR_JUMP_ANIM && sprites.anims['fall'] !== undefined) {
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
  const holds = def.holds;
  if (holds !== undefined && holds.length > 0) {
    // Walk the per-frame holds (sim frames). Looping wraps on the total;
    // one-shots clamp on the last frame.
    const n = holds.length < count ? holds.length : count;
    let total = 0;
    for (let i = 0; i < n; i++) total += holds[i] > 0 ? holds[i] : 1;
    let t = actionFrame < 0 ? 0 : Math.floor(actionFrame);
    if (def.loop) {
      t %= total;
    } else if (t >= total) {
      return count - 1;
    }
    for (let i = 0; i < n; i++) {
      const hold = holds[i] > 0 ? holds[i] : 1;
      if (t < hold) return i;
      t -= hold;
    }
    return n - 1;
  }
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
