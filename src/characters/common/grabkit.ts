import type { CharacterDef, GrabKit } from '../../core/types';

/**
 * Grab, pummel and throw data shared by every character that does not bring its own
 * CharacterDef.grabKit. Offsets are fighter-local with the fighter facing right: x grows
 * forward, y is negative above the feet, origin at the feet center.
 *
 * Reach, against a 26 px wide hurtbox: the standing box covers 7 to 25 px ahead, so it
 * catches a fighter whose center stands up to 38 px away. The dash box reaches 45 px.
 */
export const DEFAULT_GRAB_KIT: GrabKit = {
  stand: { totalFrames: 30, start: 7, end: 8, x: 16, y: -20, r: 9 },
  dash: { totalFrames: 38, start: 9, end: 10, x: 22, y: -20, r: 10 },
  holdX: 14,
  holdY: 0,
  holdBase: 60,
  holdPerPercent: 0.5,
  mashFrames: 4,
  pummel: { damage: 1.5, totalFrames: 16, hitFrame: 4 },
  throws: {
    fthrow: { totalFrames: 24, releaseFrame: 10, damage: 8, angle: 40, bkb: 60, kbg: 60, holdX: 18, holdY: -4 },
    // The holder turns around on the first frame, then launches forward from the new facing.
    bthrow: { totalFrames: 30, releaseFrame: 14, damage: 9, angle: 40, bkb: 65, kbg: 65, holdX: 18, holdY: -4 },
    uthrow: { totalFrames: 28, releaseFrame: 12, damage: 7, angle: 90, bkb: 70, kbg: 55, holdX: 0, holdY: -30 },
    dthrow: { totalFrames: 26, releaseFrame: 12, damage: 6, angle: 70, bkb: 50, kbg: 40, holdX: 10, holdY: 0 },
  },
};

/** The kit a character grabs with: its own, or DEFAULT_GRAB_KIT. */
export function grabKitOf(def: CharacterDef): GrabKit {
  return def.grabKit ?? DEFAULT_GRAB_KIT;
}
