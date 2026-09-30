/**
 * Style axis: the four archetype vectors (03 section 3.1). Independent of level.
 *
 * Every number is the 03 table's level-5 proposal, to be recalibrated by W3.5 (values only).
 * Weights past the six in the 03 table (shield, ledgeControl, stockRisk, repetition, continuity,
 * healed) are multipliers on the outcome terms defined in search/outcome.ts: 1 is neutral, and
 * `healed` equals `damageTaken` so percent the orb drain heals back is worth what the same damage
 * taken costs (the rule in aevalmere.ts evaluate today).
 */
import type { Archetype, ObjectiveWeights, StyleVector } from './contracts';

function weights(damageDealt: number, damageTaken: number, frameAdvantage: number, stageControl: number,
  killProbability: number, zone: number): ObjectiveWeights {
  return { damageDealt, damageTaken, frameAdvantage, stageControl, killProbability, zone,
    shield: 1, ledgeControl: 1, stockRisk: 1, repetition: 1, continuity: 1, healed: damageTaken };
}

/** Freezes the shared tables so a caller cannot change another CPU's vector. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o as object)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/**
 * Field notes, per 03 section 3.1:
 * - lambdaAheadMin: floor on lambda when a stock ahead with no timer; only balanced raises it (0.7).
 * - spacingMul: preferred spacing as a multiple of own poke reach; countering 1.1 to 1.6,
 *   defensive a fixed 1.5, balanced adaptive.
 * - clockForceFrames: frames without a threat exchange before the best approach is forced;
 *   Infinity = no forcing clock (the stall clock stallT0 still applies).
 * - shootSafeMargin: frames; countering uses 0 instead of +4 when a punish plan is ready.
 * - edgeguardWillingness: share of offstage edgeguard families admitted (onstage traps always
 *   are). High 1.0, medium 0.5, low 0.2; balanced admits all and lets rollouts decide.
 * - tagBias: 1 = biased up. The 03 entries that are not move tags (dash grab for aggressive,
 *   retreating aerials for defensive, whiff-punish moves for countering) are carried by the
 *   candidate filter and plan families instead.
 */
const STYLES: Readonly<Record<Archetype, StyleVector>> = deepFreeze({
  aggressive: {
    archetype: 'aggressive', w: weights(1.0, 0.6, 1.4, 1.2, 1.3, 0.3),
    lambda: 0.35, alpha: 0.10, lambdaAheadMin: 0.35,
    spacingMul: [0.6, 0.8], filter: 'aggressive',
    tagBias: { poke: 1, comboStarter: 1 },
    trigger: 'clock', clockForceFrames: 60, baitShare: 0.05,
    stallT0: 210, shotBand: [0.15, 0.6], shootSafeMargin: -6, retreatAfterShot: [0, 0],
    predictorMixCap: 0.5, exploitBias: ['ledge', 'recovery'], edgeguardWillingness: 1.0,
  },
  defensive: {
    archetype: 'defensive', w: weights(0.8, 1.6, 0.8, 0.7, 0.8, 1.0),
    lambda: 0.80, alpha: 0.40, lambdaAheadMin: 0.80,
    spacingMul: [1.5, 1.5], filter: 'defensive',
    tagBias: { projectile: 1, oosOption: 1, getOffMe: 1 },
    trigger: 'commitmentZone', clockForceFrames: Infinity, baitShare: 0.10,
    stallT0: 720, shotBand: [0.55, 1.0], shootSafeMargin: 12, retreatAfterShot: [20, 30],
    predictorMixCap: 0.5, exploitBias: ['approach', 'shield'], edgeguardWillingness: 0.2,
  },
  countering: {
    archetype: 'countering', w: weights(0.9, 1.2, 1.2, 0.6, 1.1, 0.6),
    lambda: 0.60, alpha: 0.30, lambdaAheadMin: 0.60,
    spacingMul: [1.1, 1.6], filter: 'countering',
    tagBias: { oosOption: 1, killMove: 1 },
    trigger: 'commitment', clockForceFrames: Infinity, baitShare: 0.30,
    stallT0: 540, shotBand: [0.4, 0.85], shootSafeMargin: 4, retreatAfterShot: [10, 10],
    predictorMixCap: 0.9, exploitBias: ['roll', 'spotDodge', 'airDodge'], edgeguardWillingness: 0.5,
  },
  balanced: {
    archetype: 'balanced', w: weights(1.0, 1.25, 1.0, 1.0, 1.0, 0.6),
    lambda: 0.50, alpha: 0.20, lambdaAheadMin: 0.70,
    spacingMul: 'adaptive', filter: 'none',
    tagBias: {},
    trigger: 'both', clockForceFrames: Infinity, baitShare: 0.10,
    stallT0: 420, shotBand: [0.3, 0.9], shootSafeMargin: 6, retreatAfterShot: [10, 10],
    predictorMixCap: 0.75, exploitBias: 'all', edgeguardWillingness: 1.0,
  },
});

/**
 * Style vector for an archetype. The god (balanced level 5) uses the balanced vector, which is the
 * true objective; `god` with another archetype returns that archetype's vector unchanged.
 */
export function styleVector(archetype: Archetype, god: boolean): StyleVector {
  // `god` is part of the frozen signature; it changes the level vector only, not the style.
  return STYLES[archetype];
}
