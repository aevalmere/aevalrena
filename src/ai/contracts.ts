/**
 * Frozen interfaces for the CPU engine (docs/CPU_PLAN.md section 4).
 *
 * Types and constants only. Each function named in the plan is implemented in the file given in
 * its doc comment; here it is exported as a function type with the suffix `Fn` so implementers can
 * write `export const brainInput: BrainInputFn = ...` or check a declaration against it.
 * Names and signatures are frozen; a change goes through the lead and this file.
 * Per-frame functions write into caller-owned objects (`out`) to stay allocation-free.
 */
import type {
  CharacterDef, FighterState, GameState, InputFrame, MatchConfig, MoveId, StageDef, ThrowId,
} from '../core/types';
import type { TUNING } from '../core/constants';

// ---------------------------------------------------------------------------------------------
// 4.1 Spec and brain entry
// ---------------------------------------------------------------------------------------------

export type Archetype = 'aggressive' | 'defensive' | 'countering' | 'balanced';
export type GuideLevel = 1 | 2 | 3 | 4 | 5;
/** One CPU: style axis (`archetype`), guide level, god flag and the skill scalar `s` in [0, 1]. */
export interface CpuSpec { archetype: Archetype; level: GuideLevel; god: boolean; s: number }

/** src/ai/brain.ts: one frame of input for `slot`, written into `out`. */
export type BrainInputFn = (state: GameState, slot: number, spec: CpuSpec, out: InputFrame) => InputFrame;
/** src/ai/brain.ts: builds profiles, tables and pools for a match before frame 0. */
export type WarmBrainFn = (config: MatchConfig, specs: ReadonlyMap<number, CpuSpec>) => void;
/** src/ai/brain.ts: clears per-slot memory (all slots when `slot` is omitted). */
export type ResetBrainFn = (slot?: number) => void;
export interface BrainStats { decisions: number; steps: number; plan: string; target: number;
  lastReaction: number; alternates: number; mashBits: number }
/** src/ai/brain.ts */
export type BrainStatsFn = (slot: number) => BrainStats;
/**
 * src/ai/index.ts keeps this signature. `rand` is accepted and ignored by the new engine; all
 * randomness comes from `u01` in src/ai/rng.ts.
 */
export type CpuInputFn = (state: GameState, slot: number, level: number, rand: () => number) => InputFrame;

// ---------------------------------------------------------------------------------------------
// 4.2 Level and style vectors (src/ai/levels.ts, src/ai/archetypes.ts)
// ---------------------------------------------------------------------------------------------

export type PlanFamilyId = 'wait' | 'walk' | 'dash' | 'dashDance' | 'emptyHop' | 'poke' | 'tilt' | 'smash'
  | 'chargedSmash' | 'grab' | 'dashGrab' | 'projectile' | 'shAerial' | 'fhAerial' | 'retreatAerial' | 'fastFallAerial'
  | 'platform' | 'shield' | 'spotDodge' | 'roll' | 'oos' | 'drift' | 'airAerial' | 'doubleJump' | 'airDodge' | 'special'
  | 'recovery' | 'ledgeOption' | 'getup' | 'tech' | 'tumbleExit' | 'throw' | 'pummel' | 'respawn' | 'finalSmash'
  | 'comboFollow' | 'killConfirm' | 'landingTrap' | 'techChase' | 'ledgeTrap' | 'preGrabHit' | 'hog' | 'offstageAerial'
  | 'spike' | 'footstool' | 'projectileWall' | 'baitProbe' | 'passiveRoute' | 'shieldPressure';

/** Skill axis (03 section 2). Every knob is a curve of the scalar `s` (03 section 2.5). */
export interface LevelVector {
  s: number; god: boolean;
  /** P, snapshot age of the opponent in frames. */
  perceptionAge: number;
  reactBase: number; reactSd: number; reactFloor: number; surprise: number; hickB: number; kPrp: number;
  sigmaJ: number; lapse: number; kWeber: number;
  /** 12 at advanced and up, Infinity below: windows this wide or wider get no timing jitter. */
  noJitterWidth: number;
  tau: number; errorRate: number; menuCap: number; optionsCap: number; planHold: number;
  /** Search steps per decision; 0 = static evaluation. */
  stepBudget: number;
  /** Sustained input events per second; god Infinity. */
  eventsPerSec: number;
  /** Frames between credited mash presses; 0 = no mash. */
  mashEvery: number;
  learning: { enabled: boolean; gammaSlow: number; gammaFast: number; z: number; nMin: number };
  exploitCap: number; giftBudget: boolean; openingRate: number; recognition: number; comboDepth: number;
  /** Error on the kill percent map as a fraction; NaN = kill map not used. */
  killPctError: number;
  vocabulary: ReadonlySet<PlanFamilyId>;
  accidentTolerance: number; baitWeakness: number;
}

export interface ObjectiveWeights { damageDealt: number; damageTaken: number; frameAdvantage: number;
  stageControl: number; killProbability: number; zone: number; shield: number; ledgeControl: number;
  stockRisk: number; repetition: number; continuity: number; healed: number }
export type CandidateFilterId = 'none' | 'aggressive' | 'defensive' | 'countering';
export type HabitKind = 'ledge' | 'recovery' | 'approach' | 'shield' | 'roll' | 'spotDodge' | 'airDodge' | 'tech';

/** Style axis (03 section 3.1). Independent of level. */
export interface StyleVector {
  archetype: Archetype; w: ObjectiveWeights; lambda: number; alpha: number; lambdaAheadMin: number;
  spacingMul: readonly [number, number] | 'adaptive'; filter: CandidateFilterId; tagBias: Partial<Record<MoveTag, number>>;
  trigger: 'clock' | 'commitment' | 'commitmentZone' | 'both'; clockForceFrames: number; baitShare: number;
  stallT0: number; shotBand: readonly [number, number]; shootSafeMargin: number; retreatAfterShot: readonly [number, number];
  predictorMixCap: number; exploitBias: readonly HabitKind[] | 'all'; edgeguardWillingness: number;
}

/** src/ai/levels.ts */
export type LevelVectorFn = (s: number, god: boolean) => LevelVector;
/** src/ai/levels.ts: calibrated s for an archetype and guide level. */
export type GuideLevelSFn = (archetype: Archetype, level: GuideLevel) => number;
/** src/ai/levels.ts: UI level 1 to 10 to spec (plan section 2.1). */
export type SpecForUiLevelFn = (level: number) => CpuSpec;
/** src/ai/archetypes.ts */
export type StyleVectorFn = (archetype: Archetype, god: boolean) => StyleVector;
/** src/ai/levels.ts */
export type ParamsForFn = (spec: CpuSpec) => { level: LevelVector; style: StyleVector };

// ---------------------------------------------------------------------------------------------
// 4.3 Character profile (src/ai/charprofile/*); schema from 04 section 4
// ---------------------------------------------------------------------------------------------

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type MoveTag = 'poke' | 'antiAir' | 'comboStarter' | 'extender' | 'killMove' | 'spike' | 'gimpTool'
  | 'oosOption' | 'ledgeTrapTool' | 'projectile' | 'getOffMe' | 'recovery' | 'landingOption' | 'commandGrab';
export type Spot = 'center' | 'ledge' | 'offstage';
/** Percent at which the move kills from each spot; NaN = no kill by 250. */
export type KillPct = Record<Spot, number>;

export interface MoveAiInfo {
  id: MoveId; tags: MoveTag[];
  startup: number; activeEnd: number; endlag: number; landingLag: number; total: number;
  reach: { front: number; back: number; up: number; down: number };
  maxDamage: number; advShield: number; safeShield: boolean; safeShieldMeasured: boolean;
  killPct: KillPct; killPctRecover: KillPct;
  /** W at p = 0, 20, ..., 200. */
  starterWindow: number[];
  chargeable: boolean; charge: { maxFrames: number; damageMul: number } | null;
}
export interface ShotProfile {
  moveId: MoveId; defId: string;
  castFrames(h: number): number; totalFrames(h: number): number; tail(h: number): number;
  speed(h: number): number; lifetime(h: number): number; range(h: number): number; radius(h: number): number;
  height: number; damage(h: number): number; strength(h: number): number;
  frozenOnHit(h: number, pct: number): number; frozenOnShield(h: number): number;
  pierces: boolean; returns: number | null; low: boolean; burstId: string | null;
  /** 0 and Infinity when unbounded. */
  cost: number; cap: number;
}
export interface RecoveryProfile {
  rise: { fullHop: number; shortHop: number; airJump: number };
  upSpecial: { rise: number; frames: number; helpless: boolean; grabsBefore: number };
  airDodge: Record<'l' | 'r' | 'u' | 'd' | 'lu' | 'ld' | 'ru' | 'rd' | 'n', { dx: number; dy: number }>;
  /** [jumpsLeft][upB][dodge][dxBin] -> max depth px. */
  recoverBox: Float32Array;
  /** Frames from ledge height, no fast fall. */
  fallToBlast: number;
}
export interface GrabAiInfo {
  standing: { total: number; active: [number, number]; reach: number };
  dash: { total: number; active: [number, number]; reach: number };
  holdBase: number; holdPerPercent: number; mashFrames: number;
  throws: Record<ThrowId, { release: number; damage: number; angle: number; bkb: number; kbg: number;
                            killPct: KillPct; starterWindow: number[] }>;
}
export interface CharacterAiProfile {
  /** dataHash: hash of CharacterDef + TUNING + StageDef. */
  charId: string; dataHash: string;
  physics: { weight: number; walk: number; run: number; dash: number; dashFrames: number; airSpeed: number;
             gravity: number; maxFall: number; fastFall: number; jumpSquat: number; hurtbox: { w: number; h: number } };
  moves: Record<MoveId, MoveAiInfo>;
  shots: ShotProfile[];
  grab: GrabAiInfo;
  recovery: RecoveryProfile;
  roles: { neutral: MoveId[]; antiAir: MoveId[]; juggle: MoveId[]; landing: MoveId[]; edgeguard: MoveId[];
           ledgeTrap: MoveId[]; techChase: MoveId[]; kill: MoveId[]; oos: MoveId[]; getOffMe: MoveId[]; recovery: MoveId[] };
  /** Mirror-matchup table (02 section 9.2); other victims come from buildComboTable through a cache. */
  comboTable: ComboTable;
  /** Informational. */
  styleAffinity: { aggressive: number; defensive: number; countering: number };
  overrides?: CharacterAiOverrides;
}
export interface CharacterAiOverrides {
  tags?: Partial<Record<MoveId, { add?: MoveTag[]; remove?: MoveTag[] }>>;
  numbers?: DeepPartial<Pick<CharacterAiProfile, 'moves' | 'shots' | 'grab' | 'recovery'>>;
  /** Hand routes, still gated by the true-combo test. */
  comboLists?: MoveId[][];
  /** preferredHolds e.g. [0, 15, 30, 45, 60]. */
  spacingMul?: number; preferredHolds?: number[];
  /** Named per-character choices. */
  slots?: Record<string, number>;
}

export type StarterId = MoveId | ThrowId;
export interface ComboKey { starter: StarterId; bracket: number; hitClass: 0 | 1 | 2;
  dxBucket: number; dyBucket: number; grounded: boolean; spot: Spot }
export interface ComboRoute { moves: readonly StarterId[]; damage: number; kills: boolean;
  endX: number; endAdvantage: number; offstage: boolean }
export interface ComboTable { readonly brackets: readonly number[]; bracketOf(percent: number): number;
  /** Best first, may build lazily. */
  routes(k: ComboKey): readonly ComboRoute[];
  /**
   * Routes of the nearest canonical entry (same starter and bracket; spot, stance, hit class and
   * geometry buckets by distance). Never builds an off-canonical entry, so its cost during play is
   * at most the bracket's canonical build. Optional: tables without it fall back to routes().
   */
  routesNear?(k: ComboKey): readonly ComboRoute[];
  /** Builds a bracket's canonical entries now (warm-up). Optional. */
  warm?(bracket: number): void;
  killConfirm(starter: StarterId, bracket: number, spot: Spot): boolean;
  summary(): { entries: number; chains3: number; chains4: number; kills: number } }
export interface MatchupProfile { attacker: string; defender: string; stageId: string; K: number;
  brackets: readonly number[];
  /** Defender's moves on the attacker. */
  danger: Partial<Record<MoveId, KillPct>>;
  safeVsB: ReadonlySet<MoveId> }

/** derive.ts */
export type DeriveAiProfileFn = (def: CharacterDef, stage: StageDef, tuning: typeof TUNING) => CharacterAiProfile;
/** derive.ts: cached by dataHash. */
export type GetAiProfileFn = (charId: string, stageId: string) => CharacterAiProfile;
/** derive.ts */
export type ProfileDataHashFn = (def: CharacterDef, stage: StageDef, tuning: typeof TUNING) => string;
/** overrides.ts */
export type ApplyOverridesFn = (p: CharacterAiProfile, o: CharacterAiOverrides) => { profile: CharacterAiProfile; warnings: string[] };
/** probeHit.ts */
export type ProbeShieldSafetyFn = (def: CharacterDef, stage: StageDef, id: MoveId) => { safe: boolean; bySpacing: readonly boolean[] };
/** probeHit.ts */
export type ProbeKillPctFn = (def: CharacterDef, victim: CharacterDef, stage: StageDef, id: MoveId, recover: boolean) => KillPct;
/** probeHit.ts */
export type ProbeThrowKillPctFn = (def: CharacterDef, victim: CharacterDef, stage: StageDef, t: ThrowId) => KillPct;
/** probeMotion.ts */
export type ProbeRecoveryFn = (def: CharacterDef, stage: StageDef) => RecoveryProfile;
/** probeMotion.ts */
export type ProbeShotsFn = (def: CharacterDef, stage: StageDef) => ShotProfile[];
/** combo.ts */
export type BuildComboTableFn = (p: CharacterAiProfile, victim: CharacterDef, stage: StageDef, brackets: readonly number[]) => ComboTable;
/** matchup.ts */
export type DeriveMatchupFn = (a: CharacterAiProfile, b: CharacterAiProfile, stage: StageDef) => MatchupProfile;

// ---------------------------------------------------------------------------------------------
// 4.4 Opponent model (src/ai/model/*)
// ---------------------------------------------------------------------------------------------

/** 30 existing classes + jabMash, recoveryRoute x4, bufferedOOH. */
export const ACTION_CLASS_COUNT: number = 30 + 1 + 4 + 1;
/**
 * Index of the counter-me member in `Predictor.memberScores` output. Members 0 to 5 are the six
 * ported from aevalmere.ts, 6 is win-stay/lose-shift, 7 is counter-me.
 */
export const COUNTER_ME = 7;

export interface ObsContext { sit: number; dist: number; ours: number; last: number; prev: number;
  phase: number; pctBucket: number; zone: number }
export interface Predictor { observe(state: GameState, meI: number, oppI: number, frame: number): void;
  /** Fills ACTION_CLASS_COUNT probabilities, returns confidence 0..1. */
  predict(ctx: ObsContext, out: Float64Array): number;
  /** Decayed, slow table. */
  counts(ctx: ObsContext, cls: number): { k: number; n: number };
  /** 0.85 table. */
  fastCounts(ctx: ObsContext, cls: number): { k: number; n: number };
  /** Includes counter-me at index COUNTER_ME. */
  memberScores(out: Float64Array): void;
  scaleCounts(f: number): void; serialize(): string; load(text: string): boolean }
/** predictor.ts */
export type CreatePredictorFn = (level: LevelVector) => Predictor;
/** predictor.ts */
export type MakeContextFn = (state: GameState, meI: number, oppI: number, frame: number, out: ObsContext) => void;
/** gating.ts */
export type WilsonLBFn = (k: number, n: number, z: number) => number;
/** gating.ts: p*. */
export type BreakEvenFn = (G: number, L: number, vSafe: number, margin: number) => number;
/** gating.ts */
export type RestrictedWeightFn = (lb: number, pMax: number) => number;
export interface GiftBudget { add(vBestOpp: number, vChosen: number): void; allowance(): number; reset(): void }
/** gating.ts */
export type CreateGiftBudgetFn = () => GiftBudget;
export interface Changepoint {
  /** true = reset fired. */
  update(pSlow: number, pFast: number, frame: number): boolean;
  /** Count multiplier to apply now (0.7) or 1. */
  onStockChange(frame: number): number;
  poisoned(frame: number, llrVsPrior: number): boolean }
/** changepoint.ts */
export type CreateChangepointFn = () => Changepoint;
export interface ReplyModel { kind: number; arg: number; weight: number; name: string;
  step(t: number, self: FighterState, other: FighterState, ctx: PlanCtx, out: Intent): void }
/** replies.ts: returns count. */
export type BuildRepliesFn = (view: DecisionView, out: ReplyModel[]) => number;
// profile.ts keeps ProfileStore, MemoryProfileStore, CappedProfileStore, profileKeyFor, defaultProfileStore;
// PROFILE_PREFIX becomes 'aevalrena.cpu.profile.v2.'

// ---------------------------------------------------------------------------------------------
// 4.5 Harness (src/ai/eval/*)
// ---------------------------------------------------------------------------------------------

export type Tier = 'fast' | 'full' | 'nightly';
export interface BrainFactory { name: string; spec: CpuSpec | null;
  create(): (state: GameState, slot: number, out: InputFrame) => InputFrame; reset(): void }
/** runner.ts, wraps brainInput. */
export type NewBrainFn = (spec: CpuSpec) => BrainFactory;
/** runner.ts, wraps today's cpuInput. */
export type LegacyBrainFn = (level: number) => BrainFactory;
export type AdversaryId = 'rushdown' | 'turtle' | 'camper' | 'roller' | 'ledgeCamper' | 'jumper'
  | 'stationary' | 'wandering' | 'shieldOnly' | 'jumpOnly' | 'learnsPattern' | 'changesStyle';
// adversaries.ts exports ADVERSARIES: readonly AdversaryId[]
/** adversaries.ts */
export type AdversaryFn = (id: AdversaryId, playerName: string) => BrainFactory;
export interface MatchSpec { seed: number; stageId: string; stocks: number; frameCap: number;
  a: BrainFactory; b: BrainFactory; swap: boolean; record: boolean; inputDelay?: number;
  extraPlayers?: readonly { factory: BrainFactory; team: number }[] }
export interface ReplayEvent { frame: number; kind: string; slot: number; data: Readonly<Record<string, number | string>> }
export interface MatchResult { winner: number; stocksLost: readonly number[]; sds: readonly number[];
  frames: number; timeout: boolean; finalHash: string; inputHash: readonly string[];
  events: readonly ReplayEvent[] | null;
  cost: readonly { mean: number; p99: number; first: number; calls: number }[] }
/** runner.ts */
export type RunMatchFn = (m: MatchSpec) => MatchResult;
/** replay.ts */
export type HashStateFn = (s: GameState) => string;
/** Names listed in 06 section 2. */
export interface MatchMetrics { [name: string]: number }
/** metrics.ts */
export type ComputeMetricsFn = (r: MatchResult, slot: number) => MatchMetrics;
export interface WilsonResult { k: number; n: number; p: number; lo: number; hi: number }
/** stats.ts */
export type WilsonFn = (k: number, n: number, z?: number) => WilsonResult;
export interface SprtState { llr: number; n: number; decision: 'H1' | 'H0' | 'continue' }
/** stats.ts */
export type SprtFn = (p0: number, p1: number, alpha: number, beta: number) => { add(score: 0 | 0.5 | 1): SprtState };
/** stats.ts */
export type PFromEloFn = (d: number) => number;
/** stats.ts */
export type EloFromPFn = (p: number) => number;
/** stats.ts */
export type BradleyTerryFn = (games: readonly { a: string; b: string; scoreA: number }[]) => Map<string, { elo: number; se: number }>;
/** stats.ts */
export type CohensDFn = (a: readonly number[], b: readonly number[]) => number;
/** stats.ts */
export type MannWhitneyFn = (a: readonly number[], b: readonly number[]) => { u: number; p: number };
export interface GateResult { id: string; pass: boolean; info: boolean; detail: string;
  metrics: Readonly<Record<string, number>> }
export interface TestCase { id: string; tiers: readonly Tier[]; run(ctx: { tier: Tier; shard: number; shards: number }): GateResult }
// eval/cases/index.ts exports TEST_CASES: readonly TestCase[]

// ---------------------------------------------------------------------------------------------
// 4.6 Perception and affordances
// ---------------------------------------------------------------------------------------------

export type Situation = 'neutral' | 'advantage' | 'disadvantage' | 'bothOffstage' | 'respawn'
  | 'finalSmash' | 'grabHold' | 'grabbed' | 'ledge' | 'downed' | 'tumble' | 'oos' | 'airborne';
export type HypKind = 'none' | 'move' | 'shield' | 'spotDodge' | 'roll' | 'jump' | 'airDodge';
export interface Hypothesis { kind: HypKind; move: MoveId | null; ago: number; dir: number; weight: number }
export interface Perceived {
  /** Pooled, delayed world rolled to now, own fighter exact. */
  state: GameState;
  meI: number; oppI: number; frame: number; age: number; ownDelay: number;
  hyps: readonly Hypothesis[]; passivity: number; framesSinceEdge: number; framesSinceAttack: number;
  /** Opponent's delayed state visibly changed. */
  newEvent: boolean }
export interface Perception { observe(real: GameState, meI: number): void;
  view(real: GameState, meI: number, oppI: number, level: LevelVector, pred: Predictor, out: Perceived): void;
  reset(): void }
/** perception.ts */
export type CreatePerceptionFn = (poolFrom: GameState, maxAge: number) => Perception;
export interface Affordances { situation: Situation;
  framesToHit(who: 0 | 1, move: MoveId, dx: number, dy: number): number;
  inThreat(who: 0 | 1, x: number, y: number, frames: number): boolean;
  /** whiffPunish: frames margin; meCanGetBack, oppCanGetBack: px slack (negative = none). */
  whiffPunish: number; meCanGetBack: number; oppCanGetBack: number;
  oppInvuln: number; oppBusy: number; meBusy: number; killPctHere(move: MoveId): number; dangerHere: number }
/** affordances.ts */
export type ComputeAffordancesFn = (p: Perceived, me: CharacterAiProfile, opp: CharacterAiProfile,
  mu: MatchupProfile, out: Affordances) => void;
/** affordances.ts */
export type ClassifySituationFn = (s: GameState, meI: number, oppI: number) => Situation;
/** affordances.ts */
export type CanGetBackFn = (s: GameState, who: number, prof: CharacterAiProfile, work: GameState) => number;
/** affordances.ts: returns budget, < 1 = not a true combo. */
export type TrueComboFn = (s: GameState, attacker: number, victim: number, follow: MoveId, work: GameState) => number;

// ---------------------------------------------------------------------------------------------
// 4.7 Plans (src/ai/plans/*)
// ---------------------------------------------------------------------------------------------

export const PF_ATTACK = 1, PF_INTR = 2, PF_TAIL = 4, PF_MOVE = 8, PF_PROJ = 16, PF_EG = 32,
  PF_STALE = 64, PF_SPIKE = 128, PF_KILL = 256, PF_BAIT = 512;
/** `pressed` is derived by the executor. */
export interface Intent { held: number; direct: number; mash: number }
export interface PlanCtx { dir: number; home: number; edgeX: number; fireAt: number; param: number;
  startFrame: number; frame: number; me: CharacterAiProfile; stage: StageDef;
  /** W3.1 addition: fighters[] index of the target the plan started against (-1 none; absent = unknown). */
  target?: number }
export interface PlanInstance { family: PlanFamilyId; name: string; move: MoveId | null; param: number;
  minFrames: number; horizon: number; flags: number; bonus: number; priority: number;
  /**
   * Optional (strength ledger loop 6): plan frame by which the plan's payoff has landed or failed
   * (a recall that returns at 60, a charged shot, a setup kill). The rollouts stretch the decision's
   * common window to cover it (search/rollout.ts PAYOFF_SLACK, at most WINDOW_MAX) while the budget
   * still pays one sample per candidate. Absent: the plan is judged in the usual window.
   */
  payoffAt?: number;
  /** t advances only when hitlag == 0. */
  script(t: number, self: FighterState, ctx: PlanCtx, out: Intent): void }
export interface PlanFamily { id: PlanFamilyId; situations: readonly Situation[];
  generate(v: DecisionView, out: PlanInstance[]): void }
export interface DecisionView { p: Perceived; aff: Affordances; me: CharacterAiProfile;
  opp: CharacterAiProfile; mu: MatchupProfile; level: LevelVector; style: StyleVector;
  pred: Predictor; tempo: Tempo; seed: number; slot: number; stocksAhead: number;
  /**
   * W3.1 additions (02 section 15), filled by brain.ts; optional so hand-built views stay valid.
   * `opps`: one model per live opponent (the named target `p.oppI` included), first `nOpps` valid.
   * `replies`: the joint reply sets the rollouts run against (model/replies.ts ReplySets).
   * `genScale`: share (0 to 1] of the level's step allowance the plan generators' own simulations
   * may use this decision (edge.ts and defense.ts stepAllowance); below 1 when several searching
   * CPUs share a four-player frame. Absent means 1.
   */
  opps?: readonly OpponentModel[]; nOpps?: number; replies?: JointReplySets; genScale?: number }
/** W3.1 addition: what the brain knows about one opponent for a decision. */
export interface OpponentModel { index: number; slot: number; profile: CharacterAiProfile; mu: MatchupProfile;
  /** That opponent's predictor bank, null when the level does not learn. */
  pred: Predictor | null }
/** W3.1 addition: the shape of model/replies.ts ReplySets (one reply set per other fighter). */
export interface JointReplySets { count: number; fighter: Int32Array; teammate: Uint8Array; sets: ReplyModel[][]; n: Int32Array }
// plans/index.ts exports PLAN_FAMILIES (concatenates the four below); plans/advantage.ts
// ADVANTAGE_FAMILIES; plans/edge.ts EDGE_FAMILIES; plans/defense.ts DEFENSE_FAMILIES;
// plans/passive.ts PASSIVE_FAMILIES; each is readonly PlanFamily[].
export type PassiveKind = 'none' | 'stationary' | 'shieldOnly' | 'jumpOnly' | 'rollOnly' | 'loop';
/** plans/passive.ts */
export type PassiveKindFn = (v: DecisionView) => PassiveKind;
/** plans/index.ts: prefiltered, priority order; returns count. */
export type GenerateCandidatesFn = (v: DecisionView, out: PlanInstance[]) => number;
/** plans/defense.ts: returns the mix over routes. */
export type SolveRecoveryFn = (v: DecisionView, routes: readonly PlanInstance[], seed: number) => Float64Array;

// ---------------------------------------------------------------------------------------------
// 4.8 Search, zoning, tempo
// ---------------------------------------------------------------------------------------------

export interface Outcome { damageDealt: number; damageTaken: number; stockDelta: number; projectedKO: number;
  ourStockRisk: number; frameAdvantage: number; stageControl: number; shieldHealth: number; ledgeControl: number;
  zone: number; repetition: number; continuity: number; healed: number; hitLanded: boolean; hitFrame: number }
export interface Scored { plan: PlanInstance; w: Float64Array; J: Float64Array; n: number;
  cvar: number; mean: number; value: number; stockLossWeight: number; certainLoss: boolean }
export interface SearchResult { best: PlanInstance | null; value: number; steps: number;
  scored: readonly Scored[]; secondPly: boolean; vetoed: number }
/** search/rollout.ts: returns steps used. */
export type RunRolloutsFn = (v: DecisionView, cands: readonly PlanInstance[], replies: readonly ReplyModel[],
  budget: number, out: Scored[]) => number;
/** search/outcome.ts */
export type ScoreOutcomeFn = (o: Outcome, w: ObjectiveWeights) => number;
/** search/select.ts */
export type CvarFn = (w: Float64Array, J: Float64Array, n: number, alpha: number) => number;
/** search/select.ts */
export type SelectPlanFn = (v: DecisionView, scored: readonly Scored[], out: SearchResult) => void;
/** search/mix.ts */
export type FictitiousPlayFn = (M: Float64Array, rows: number, cols: number, iters: number, seed: number, out: Float64Array) => void;
/** zoning.ts */
export type ShootSafeFn = (v: DecisionView, shot: ShotProfile, h: number, range: number) =>
  { safe: boolean; safeIfAnswered: boolean };
/** zoning.ts: returns a hold, -1 no shot, -2 no charge shot. */
export type ChargeDecisionFn = (v: DecisionView, shot: ShotProfile, distance: number, shareUsed: number) => number;
/** zoning.ts */
export type AnswerProjectileFn = (v: DecisionView) => PlanFamilyId | null;
export interface Tempo { update(s: GameState, meI: number, oppI: number): void; pressure(): number;
  clock(): number; stale(name: string): number; used(name: string, frame: number): void;
  cycle(): boolean; reset(): void }
/** tempo.ts */
export type CreateTempoFn = (style: StyleVector) => Tempo;

// ---------------------------------------------------------------------------------------------
// 4.9 Executor, reflexes, humanizer, targets
// ---------------------------------------------------------------------------------------------

export interface Executor { reset(): void;
  /** tick + inputDelay. */
  outputFrameOf(tick: number): number;
  emit(state: GameState, meI: number, intent: Intent, level: LevelVector, out: InputFrame): InputFrame;
  prebuffer(next: PlanInstance, atFrame: number): void }
/** executor.ts */
export type CreateExecutorFn = (slot: number, inputDelay: number) => Executor;
/** reflexes.ts: true = frame claimed. */
export type RunReflexesFn = (v: DecisionView, exec: Executor, out: Intent) => boolean;
export interface Stimulus { key: number; frame: number; bits: number; pCue: number; stress: number; alert: boolean }
/** humanizer.ts */
export type ReactionDelayFn = (st: Stimulus, level: LevelVector, seed: number, slot: number) => number;
export interface Humanizer { reset(): void;
  apply(intent: Intent, frame: number, windowWidth: number, level: LevelVector, out: Intent): void;
  decisionError(level: LevelVector, frame: number): boolean; mashAllowed(frame: number): boolean }
/** humanizer.ts */
export type CreateHumanizerFn = (seed: number, slot: number) => Humanizer;
export interface Targeter { pick(s: GameState, meI: number, frame: number): number; reset(): void }
/** targets.ts */
export type CreateTargeterFn = () => Targeter;
// rng.ts exports STREAM, u01 and skewNormal (typed below for reference).
/** rng.ts */
export type U01Fn = (seed: number, slot: number, frame: number, stream: number, k?: number) => number;
/** rng.ts */
export type SkewNormalFn = (seed: number, slot: number, frame: number, stream: number, k?: number) => number;
