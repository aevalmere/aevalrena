/**
 * Skill axis: the level vector as a function of one scalar `s` (03 sections 2 and 2.5), the
 * calibrated `s` per archetype and guide level, and the UI level mapping (docs/CPU_PLAN.md 2.1).
 *
 * Curves. Each knob has five knots at s = 0, 0.25, 0.5, 0.75, 1 (casual, intermediate, advanced,
 * top player, world's best), taken from the 03 section 2 tables, and one of three shapes between
 * them:
 * - lin: linear between neighbouring knots;
 * - geo: geometric between neighbouring knots (a * (b / a)^f), for knobs that 03 section 2.5 states
 *   as exponentials of s (timing SD, lapse, temperature, menu, search steps, mash interval);
 * - step: the value of the knot at or below s, for discrete vocabulary-like knobs.
 * The 2.5 closed forms are close to but not equal to the table rows (for example lapse
 * 0.04 * 0.5^(4s) gives 0.25% at s = 1 where the table says 0.2%, and tau = 0.6 * 0.03^s gives 0.10
 * at s = 0.5 where the table says 0.15); the table rows win, so every knot reproduces them exactly.
 * God is not a point on the curve: it is its own column.
 *
 * Reaction floor. Every human `s` has reactFloor 10 and reactBase at least 12 (16 - 4s), so the
 * sampled reaction R = max(floor, ...) never goes under 10 frames. Only god drops to its perception
 * age (4).
 *
 * No Math.pow, Math.exp or Math.log: the geometric shape uses repeated square roots.
 */
import type { Archetype, CpuSpec, GuideLevel, LevelVector, PlanFamilyId, StyleVector } from './contracts';
import { styleVector } from './archetypes';

type Knots = readonly [number, number, number, number, number];

function clamp01(s: number): number {
  return s > 1 ? 1 : s >= 0 ? s : 0;   // NaN maps to 0
}

/** r^f for r > 0 and f in [0, 1], by the binary expansion of f and repeated square roots. */
function powFrac(r: number, f: number): number {
  let out = 1, root = r, x = f;
  for (let i = 0; i < 40 && x > 0; i++) {
    root = Math.sqrt(root);
    x *= 2;
    if (x >= 1) { out *= root; x -= 1; }
  }
  return out;
}

function segIndex(s: number): number {
  const i = Math.floor(s * 4);
  return i > 3 ? 3 : i;
}

function lin(k: Knots, s: number): number {
  const i = segIndex(s), f = s * 4 - i;
  return k[i] + (k[i + 1] - k[i]) * f;
}

function geo(k: Knots, s: number): number {
  const i = segIndex(s), f = s * 4 - i;
  const a = k[i], b = k[i + 1];
  if (f === 0) return a;
  if (f === 1) return b;
  if (!(a > 0) || !(b > 0)) return a + (b - a) * f;   // a zero knot: fall back to linear
  return a * powFrac(b / a, f);
}

function step<T>(k: readonly [T, T, T, T, T], s: number): T {
  return k[s >= 1 ? 4 : Math.floor(s * 4)];
}

// ---- 03 section 2.1, reaction ----
const REACT_SD: Knots = [3.0, 2.5, 2.2, 2.0, 1.7];
const SURPRISE: Knots = [6, 4, 3, 2, 1];
const HICK_B: Knots = [8.0, 6.0, 4.5, 3.5, 2.5];
/** Refractory cost per frame: 0.5 below world's best, 0.3 at world's best. */
const K_PRP: Knots = [0.5, 0.5, 0.5, 0.5, 0.3];
const HUMAN_REACT_FLOOR = 10;
const GOD_PERCEPTION_AGE = 4;

// ---- 03 section 2.2, execution ----
const SIGMA_J: Knots = [3.0, 1.8, 1.1, 0.7, 0.4];
const LAPSE: Knots = [0.04, 0.02, 0.01, 0.005, 0.002];
/** Weber fraction for long known intervals, 0.10 casual to 0.04 world's best. */
const K_WEBER: Knots = [0.10, 0.085, 0.07, 0.055, 0.04];
/** Windows this wide or wider get no jitter at advanced and up. */
const NO_JITTER_WIDTH = 12;

// ---- 03 section 2.3, decision quality, menu and knowledge ----
const TAU: Knots = [0.6, 0.35, 0.15, 0.04, 0.02];
const ERROR_RATE: Knots = [0.30, 0.17, 0.09, 0.05, 0.025];
/** Menu cap; "all" at world's best. The last segment runs toward 48 (about twice the prefilter size). */
const MENU_CAP: Knots = [4, 6, 10, 24, 48];
const OPTIONS_CAP: Knots = [2, 3, 4, 5, 6];
const PLAN_HOLD: Knots = [24, 20, 16, 13, 10];
/**
 * Search steps: geometric between knots. 03 gives 0 (static evaluation) at casual; the casual knot
 * is 240 instead (docs/CPU_LEVELS_LEDGER.md loop 1): under static evaluation every candidate scored
 * the same outcome, so a casual chose uniformly at random from its menu, walked away from half its
 * approaches and took 20,000 frames without a KO in a mirror (aitest a). 240 steps buys about one
 * 24-frame sample for each plan of a casual's 4-plan menu (two for a routine decision's half), so the
 * casual's weakness stays in its reaction, execution, menu, vocabulary and temperature, not in
 * blindness.
 */
const STEP_BUDGET: Knots = [240, 300, 800, 1600, 2600];
const EVENTS_PER_SEC: Knots = [2.5, 3.0, 3.5, 4.5, 5.5];
const EXPLOIT_CAP: Knots = [0, 0, 0.3, 0.6, 0.6];
const OPENING_RATE: Knots = [0.30, 0.20, 0.10, 0.02, 0.01];
const RECOGNITION: Knots = [0.3, 0.5, 0.7, 0.9, 0.95];
const COMBO_DEPTH: Knots = [0, 0, 2, 4, Infinity];
/**
 * Mash interval in frames from advanced up (03 section 4 and plan decision 3): 12 at advanced,
 * 3 at world's best, geometric between (6 at top player); none below advanced.
 */
const MASH_EVERY: readonly [number, number, number] = [12, 6, 3];
/** Learning knots at advanced, top player, world's best (none below advanced). */
const GAMMA_SLOW: readonly [number, number, number] = [0.98, 0.95, 0.95];
/** Fast table decay; equal to gammaSlow means no changepoint pair at that tier. */
const GAMMA_FAST: readonly [number, number, number] = [0.98, 0.95, 0.90];
const LEARN_Z: readonly [number, number, number] = [1.96, 1.645, 1.645];
const LEARN_N_MIN: readonly [number, number, number] = [10, 5, 5];

// ---- 03 section 4, humanizer (magnitudes are proposals; 03 gives direction only) ----
/** Accidental-roll tolerance, allowed at levels 1 to 3 only. */
const ACCIDENT_TOLERANCE: Knots = [0.05, 0.03, 0.01, 0, 0];
/** Chance of committing to a punish on a bait (empty hop, shield poke, intangible roll). */
const BAIT_WEAKNESS: Knots = [0.5, 0.35, 0.2, 0.1, 0.05];

// ---- 03 section 2.3, option vocabulary ----
/**
 * Casual. 03's L1 list has no smashes, but 03's percent-knowledge line says L1 and L2 "throw kill
 * moves when a smash is available"; without one a casual mirror sat at 150 to 250% for 7,200
 * frames with only tilts and jabs to kill with (docs/CPU_LEVELS_LEDGER.md loop 9). Uncharged
 * smashes (the 'smash' family) are therefore casual vocabulary; charged ones stay at L3.
 */
const VOCAB_L1: readonly PlanFamilyId[] = ['wait', 'walk', 'dash', 'poke', 'tilt', 'smash', 'fhAerial', 'airAerial',
  'doubleJump', 'drift', 'grab', 'throw', 'shield', 'recovery', 'ledgeOption', 'getup', 'tumbleExit', 'respawn',
  'finalSmash'];
const VOCAB_L2_ADD: readonly PlanFamilyId[] = ['spotDodge', 'roll', 'airDodge', 'shAerial',
  'fastFallAerial', 'retreatAerial', 'platform', 'tech', 'dashGrab', 'pummel'];
const VOCAB_L3_ADD: readonly PlanFamilyId[] = ['comboFollow', 'offstageAerial', 'ledgeTrap', 'dashDance',
  'chargedSmash', 'projectile', 'special', 'techChase', 'oos'];
const VOCAB_L4_ADD: readonly PlanFamilyId[] = ['killConfirm', 'spike', 'hog', 'baitProbe', 'emptyHop',
  'landingTrap', 'preGrabHit', 'shieldPressure'];
const VOCAB_L5_ADD: readonly PlanFamilyId[] = ['footstool', 'projectileWall', 'passiveRoute'];

function vocab(...parts: (readonly PlanFamilyId[])[]): ReadonlySet<PlanFamilyId> {
  const set = new Set<PlanFamilyId>();
  for (const p of parts) for (const id of p) set.add(id);
  return set;
}
const VOCABULARY: readonly [ReadonlySet<PlanFamilyId>, ReadonlySet<PlanFamilyId>, ReadonlySet<PlanFamilyId>,
  ReadonlySet<PlanFamilyId>, ReadonlySet<PlanFamilyId>] = [
  vocab(VOCAB_L1),
  vocab(VOCAB_L1, VOCAB_L2_ADD),
  vocab(VOCAB_L1, VOCAB_L2_ADD, VOCAB_L3_ADD),
  vocab(VOCAB_L1, VOCAB_L2_ADD, VOCAB_L3_ADD, VOCAB_L4_ADD),
  vocab(VOCAB_L1, VOCAB_L2_ADD, VOCAB_L3_ADD, VOCAB_L4_ADD, VOCAB_L5_ADD),
];
/** Every plan family; world's best and god both get all of them. */
const ALL_FAMILIES = VOCABULARY[4];

/** Value on the advanced-to-world's-best part of the curve (s in [0.5, 1]), knots at 0.5, 0.75, 1. */
function upper(k: readonly [number, number, number], s: number, shape: 'lin' | 'geo'): number {
  const knots: Knots = [k[0], k[0], k[0], k[1], k[2]];
  return shape === 'lin' ? lin(knots, s) : geo(knots, s);
}

function humanVector(sIn: number): LevelVector {
  const s = clamp01(sIn);
  const learn = s >= 0.5;
  return {
    s, god: false,
    perceptionAge: s < 0.5 ? 5 : 4,
    reactBase: 16 - 4 * s,
    reactSd: lin(REACT_SD, s),
    reactFloor: HUMAN_REACT_FLOOR,
    surprise: lin(SURPRISE, s),
    hickB: lin(HICK_B, s),
    kPrp: lin(K_PRP, s),
    sigmaJ: geo(SIGMA_J, s),
    lapse: geo(LAPSE, s),
    kWeber: lin(K_WEBER, s),
    noJitterWidth: s >= 0.5 ? NO_JITTER_WIDTH : Infinity,
    tau: geo(TAU, s),
    errorRate: geo(ERROR_RATE, s),
    menuCap: s >= 1 ? Infinity : Math.round(geo(MENU_CAP, s)),
    optionsCap: Math.round(lin(OPTIONS_CAP, s)),
    planHold: Math.round(lin(PLAN_HOLD, s)),
    stepBudget: Math.round(geo(STEP_BUDGET, s)),
    eventsPerSec: lin(EVENTS_PER_SEC, s),
    mashEvery: s < 0.5 ? 0 : Math.round(upper(MASH_EVERY, s, 'geo')),
    learning: {
      enabled: learn,
      gammaSlow: upper(GAMMA_SLOW, s, 'lin'),
      gammaFast: upper(GAMMA_FAST, s, 'lin'),
      z: upper(LEARN_Z, s, 'lin'),
      nMin: Math.round(upper(LEARN_N_MIN, s, 'lin')),
    },
    exploitCap: lin(EXPLOIT_CAP, s),
    giftBudget: false,
    openingRate: lin(OPENING_RATE, s),
    recognition: lin(RECOGNITION, s),
    comboDepth: step(COMBO_DEPTH, s),
    killPctError: s < 0.5 ? NaN : s >= 0.75 ? 0 : 0.10 * (0.75 - s) / 0.25,
    vocabulary: step(VOCABULARY, s),
    accidentTolerance: lin(ACCIDENT_TOLERANCE, s),
    baitWeakness: lin(BAIT_WEAKNESS, s),
  };
}

/** The god column of the 03 section 2 tables. */
function godVector(): LevelVector {
  return {
    s: 1, god: true,
    perceptionAge: GOD_PERCEPTION_AGE,
    reactBase: GOD_PERCEPTION_AGE, reactSd: 0, reactFloor: GOD_PERCEPTION_AGE, surprise: 0, hickB: 0, kPrp: 0,
    sigmaJ: 0, lapse: 0, kWeber: 0, noJitterWidth: NO_JITTER_WIDTH,
    tau: 0, errorRate: 0, menuCap: Infinity, optionsCap: Infinity,
    planHold: 2,          // 03 gives 1 to 3
    stepBudget: 2600,     // 03 gives 2,600 to 8,000; the brain may raise it under the p99 gate
    eventsPerSec: Infinity,
    mashEvery: 2,         // one fresh bit every 2 frames (02 section 14.5), equal to the sim cap
    learning: { enabled: true, gammaSlow: 0.98, gammaFast: 0.90, z: 1.282, nMin: 4 },
    exploitCap: 0.75, giftBudget: true, openingRate: 0, recognition: 1, comboDepth: Infinity,
    killPctError: 0, vocabulary: ALL_FAMILIES, accidentTolerance: 0, baitWeakness: 0,
  };
}

/** Level vector for skill scalar `s` (clamped to [0, 1]); `god` returns the god column and ignores s. */
export function levelVector(s: number, god: boolean): LevelVector {
  return god ? godVector() : humanVector(s);
}

/**
 * Calibrated s per archetype and guide level (plan decision 4): aggressive, defensive and countering
 * run casual to world's best for levels 1 to 5; balanced runs casual, intermediate, advanced, world's
 * best, god (its level 5 is the god vector, so its s is only nominal). W3.5 edits these values.
 */
const GUIDE_S: Readonly<Record<Archetype, Knots>> = {
  aggressive: [0, 0.25, 0.5, 0.75, 1],
  defensive: [0, 0.25, 0.5, 0.75, 1],
  countering: [0, 0.25, 0.5, 0.75, 1],
  balanced: [0, 0.25, 0.5, 1, 1],
};
/** s of the "top player" row used by UI level 7 (plan 2.1); balanced has no guide level there. */
const TOP_PLAYER_S = 0.75;

export function guideLevelS(archetype: Archetype, level: GuideLevel): number {
  return GUIDE_S[archetype][level - 1];
}

/**
 * UI level to spec (plan section 2.1). Every UI level is balanced. Odd UI levels 1, 3, 5, 7, 9 sit
 * on calibrated points (balanced L1, L2, L3, top player, balanced L4); even levels take the midpoint
 * of their neighbours' s. `level` is the balanced guide level at or below that s. UI 10 is the god.
 * Values outside 1 to 10 are clamped; level 0 (dummy) is routed away before this is called.
 */
export function specForUiLevel(level: number): CpuSpec {
  const ui = level >= 10 ? 10 : level > 1 ? Math.round(level) : 1;
  if (ui === 10) return { archetype: 'balanced', level: 5, god: true, s: guideLevelS('balanced', 5) };
  const points = [guideLevelS('balanced', 1), guideLevelS('balanced', 2), guideLevelS('balanced', 3),
    TOP_PLAYER_S, guideLevelS('balanced', 4)];
  const j = (ui - 1) >> 1;
  const s = (ui & 1) === 1 ? points[j] : (points[j] + points[j + 1]) / 2;
  const g: GuideLevel = ui <= 2 ? 1 : ui <= 4 ? 2 : ui <= 8 ? 3 : 4;
  return { archetype: 'balanced', level: g, god: false, s };
}

/** Same mapping as specForUiLevel in the { level, style, s } shape; `god` is true only at UI 10. */
export function uiLevelToSpec(level: number): { level: GuideLevel; style: Archetype; s: number; god: boolean } {
  const spec = specForUiLevel(level);
  return { level: spec.level, style: spec.archetype, s: spec.s, god: spec.god };
}

/** Both vectors for a spec. Pure; allocates, so call it at warm-up, not per frame. */
export function paramsFor(spec: CpuSpec): { level: LevelVector; style: StyleVector } {
  return { level: levelVector(spec.s, spec.god), style: styleVector(spec.archetype, spec.god) };
}
