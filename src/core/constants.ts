/**
 * Feel constants.
 *
 * TUNING holds every value the debug panel (F4) can change while a match runs.
 * The sim reads these fields at the moment it uses them and never writes them,
 * so the step stays deterministic for a given set of values. Never copy a
 * TUNING field into a module-level constant: that would freeze it at import
 * time and the sliders would do nothing mid-match.
 *
 * The structural constants below (shield, dodges, ledge, respawn, Sakurai
 * angles) are frame data the rest of the game is built around, so they stay
 * fixed exports.
 */
export const TUNING = {
  knockback: { toVel: 0.06, decay: 0.051, hitstunPerKb: 0.4, tumbleKb: 80, damageMul: 1, kbMul: 1, sakuraiThreshold: 60 },
  hitlag: { base: 4, perDamage: 0.5, max: 20 },
  input: { buffer: 6, smashTapWindow: 5, dashRetapWindow: 14, chargeMax: 60, chargeBonus: 0.4, rollTapWindow: 12, walkAxis: 0.7, padDeadzone: 0.35 },
  camera: { lerp: 0.12, zoomMin: 1.0, zoomMax: 1.8, margin: 60, shakeMax: 4, shakeFrames: 12 },
};
export const TUNING_DEFAULTS: typeof TUNING = JSON.parse(JSON.stringify(TUNING));
export function hitlagFrames(damage: number): number { return Math.min(TUNING.hitlag.max, Math.floor(damage * TUNING.hitlag.perDamage) + TUNING.hitlag.base); }

export const SHIELD_MAX = 60;
export const SHIELD_DECAY = 0.12;     // per frame held
export const SHIELD_REGEN = 0.07;     // per frame not held
export const SHIELD_BREAK_STUN = 180;
export const SHIELD_STUN_PER_DAMAGE = 0.6;  // frames of shield stun per damage point, +2 floor
export const SPOT_DODGE = { total: 22, invStart: 3, invEnd: 17 };
export const ROLL = { total: 24, invStart: 3, invEnd: 16, distance: 80 };
/** A shortcut move (its own key or chord) replaces a button-started attack while actionFrame is below this. */
export const SHORTCUT_REPLACE_FRAMES = 3;
export const LOW_HIT_HEIGHT = 14;     // a hit centered within this many px above the victim's feet is low
export const AIR_DODGE = { total: 30, invStart: 3, invEnd: 27 };
export const TECH = { window: 20, lockout: 40, inPlace: { total: 26, invEnd: 20 }, roll: { total: 40, invEnd: 20, distance: 40 } };  // press window, re-press lockout, landing options
export const KNOCKDOWN = { maxFrames: 120 };                     // longest a downed fighter stays down
export const GETUP = { total: 30, invEnd: 22 };                  // stand up from downed
export const GETUP_ROLL = { total: 35, invEnd: 25, distance: 40 };   // roll out of downed
export const FOOTSTOOL = { reachX: 6, reachY: 12, victimGround: 30, victimAir: 20, victimVy: 6 };   // reach past the hurtbox, victim stun frames and push
export const FS_METER = { max: 300, perDamageDealt: 1.0, perDamageTaken: 0.6 };   // Final Smash meter gain per damage point
export const LEDGE_HANG_INVULN = 40;
export const LEDGE_MAX_REGRABS = 3;
export const RESPAWN_INVULN = 120;
export const RESPAWN_PLATFORM_FRAMES = 180;
export const SAKURAI_WEAK_ANGLE = 0;
export const SAKURAI_STRONG_ANGLE = 40;
