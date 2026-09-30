/**
 * The one engine for every CPU tier (docs/CPU_PLAN.md W3.1, section 4.1; cpu-guide 02 sections 2,
 * 3, 7.5, 7.6, 14.1, 15; 03 sections 1 and 4).
 *
 * Per CPU slot the brain keeps: perception (a delayed view of everyone else, own fighter exact,
 * own-input delay on a LAN), a predictor bank per opponent (its gating and changepoint run inside
 * the bank), the targeter, affordances, tempo, the humanizer (human tiers only), the executor and
 * the reflex memory the executor carries.
 *
 * One frame (02 section 14.1): perception observes; the predictors read the delayed snapshot; the
 * targeter picks; the view is built; reflexes may claim the frame; otherwise, on cadence, a
 * decision runs; the executor steps the running plan (switching to a pre-buffered follow-up when
 * its hit lands), and `emit` applies the humanizer, the guard, the mash and rate caps and derives
 * `pressed` and `released`.
 *
 * A decision: affordances; candidates through the style filter and the level's vocabulary and
 * menu (plans/index.ts); one reply set per other fighter (model/replies.ts, teammates continue);
 * rollouts against the joint replies of every live opponent (search/rollout.ts runRolloutsJoint)
 * scored with the style weights and aggregated by CVaR at the style's alpha; selection with plan
 * hold, the gift budget and the god's fictitious-play tie mix (search/select.ts); the human
 * decision error (rank 2 or 3 at the level's rate); then the plan goes to the executor. The second
 * ply: when the chosen attack lands in most rollout samples, the hit frame is simulated once, the
 * advantage candidates are searched there and the best follow-up is pre-buffered for that frame.
 * Per-hit replanning: a hit or grab of ours that lands without a pending follow-up forces a new
 * decision on the next frame.
 *
 * Cadence (02 section 7.6): when the plan ended, when a committing plan ran its minimum frames and
 * the fighter can act again, every replan interval for an interruptible plan, on a new perceived
 * event (god at once; human tiers after their sampled reaction time), on a situation change, and
 * after our hit. Budget in sim steps only: the level's budget (600 for the first 240 frames), half
 * of it for a routine decision, and with more than two fighters the match's share of FRAME_POOL
 * among its searching CPUs (plan R5). The plan generators' own simulations follow the same share
 * through DecisionView.genScale.
 *
 * Match adaptations: a side outnumbered by its opponents plays a riskier copy of its style
 * (matchStyle); the neutral rollout window grows to WINDOW_KILL_RANGE once the target is in kill
 * range; candidates whose move is locked (moveLocked) are dropped unless the move has a recall.
 *
 * Profiles (02 section 6.9): at match start each human opponent's stored model is loaded into that
 * opponent's predictor as a prior; it is saved on every KO and when the match ends (or when the next
 * match starts, or on flushBrainProfiles). In node the default store is an in-memory map that
 * resetBrain() replaces, so each harness match starts from nothing and stays reproducible.
 *
 * Deterministic: randomness only from rng.ts keyed on (config.seed, slot, frame, stream); per-slot
 * memory resets on a new config object or a backward frame jump (plan R1). Allocation-light: every
 * per-slot object is built at match start (or warm-up) and reused.
 */
import type { FighterState, GameState, InputFrame, MatchConfig } from '../core/types';
import { Btn, DIRECT_CODES, DIRECT_MOVES } from '../core/types';
import { CHARACTER_DEFS } from '../characters/registry';
import { cloneGameState, createGameState, stepGame } from '../sim';
import { sameTeam, type SimFighter } from '../sim/state';
import { moveLocked } from '../sim/actions';
import { STAGE_DEFS } from '../stages/registry';
import type {
  BrainStats, BrainStatsFn, BrainInputFn, CharacterAiProfile, CpuSpec, DecisionView, Hypothesis, Intent, LevelVector,
  OpponentModel, PlanCtx, PlanInstance, ResetBrainFn, Scored, SearchResult, Situation, StyleVector, WarmBrainFn,
} from './contracts';
import { PF_ATTACK, PF_INTR, PF_STALE } from './contracts';
import { paramsFor, specForUiLevel } from './levels';
import {
  createPerception, isLive, MAX_FIGHTERS, MAX_OWN_DELAY, newPerceived, type PerceivedMulti, type TeamPerception,
} from './perception';
import {
  classifySituation, computeAffordances, matchupFor, newAffordances, profileFor, type TeamAffordances,
} from './affordances';
import { createTargeter, type TeamTargeter } from './targets';
import { createPredictorBank, type PredictorBank } from './model/predictor';
import { buildReplySets, createReplySets, type ReplySets } from './model/replies';
import { generateCandidates, newPlanCtx, passiveKind, preparePlanCtx } from './plans/index';
import './plans/edge';
import './plans/defense';
// Character plan packs register their families (each generates only for its own character).
import './characters/index';
import { resetPassive } from './plans/passive';
import { copyStateInto, runRolloutsJoint, setRolloutWindows } from './search/rollout';
import { noteGift, resetSelect, selectPlan } from './search/select';
import { createTempoExt, shouldDecide, stepBudgetAt, type TempoExt } from './tempo';
import { createHumanizerExt, reactionDelay, resetReactionMemory, type HumanizerExt } from './humanizer';
import { CpuExecutor, MOVE_CODE } from './executor';
import { runReflexes } from './reflexes';
import { STREAM, u01 } from './rng';
import {
  defaultProfileStore, loadPlayerProfile, MemoryProfileStore, profileKeyFor, savePlayerProfile, type ProfileStore,
} from './profile';
import { setBrainEngine } from './eval/runner';
import { specialForStick } from './charprofile/tags';

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

/** Snapshot ring age the perception pools for: the largest perceptionAge of any level. */
const MAX_AGE = 6;
/** Most slots a match can hold. */
const MAX_SLOTS = 8;
/** Second ply: share of the decision budget it may use, and candidates it re-expands. */
const PLY2_SHARE = 0.3;
const PLY2_CANDS = 5;
/** Second ply only when the chosen attack lands in at least this share of the rollout samples. */
const PLY2_HIT_SHARE = 0.5;
/** Frames the second ply simulates at most looking for the hit. */
const PLY2_LOOK = 40;
/** Passivity frames that map to a passivity of 1 for the tempo clock. */
const PASSIVE_FULL = 240;
/** Gift regime: share of a value rise between decisions booked as the opponent's gift. */
const GIFT_SHARE = 0.5;
/** Frames within which the previous decision's value still counts for the gift estimate. */
const GIFT_WINDOW = 30;
/** Frames past the predicted hit a second-ply follow-up still waits for it. */
const FOLLOW_SLACK = 6;
/**
 * Common rollout windows (02 section 7.2 gives about 45 and 60): the neutral window is shorter here
 * because a plan padded with a long neutral continuation scored alike against the attacking reply;
 * measured in the harness (head to head against the rule-based god and the 1v3 case).
 */
const WINDOW_NEUTRAL = 24;
const WINDOW_KILL_PLAN = 60;
/**
 * Neutral window while the target is in kill range (targetInKillRange): the 02 guide's 45. With the
 * 24-frame window the god let a wandering dummy reach 178% before a KO (harness al: first KO 2,381
 * frames against the 1,800 gate; 724 with 45) and timed out 3 of 40 1v3 matches (0 with 45).
 */
const WINDOW_KILL_RANGE = 45;
/**
 * An opponent this close (|dx| + |dy|, px) is the target whatever the targeter prefers: it is the one
 * that can hit us next (02 section 15; measured in the 1v3 harness case).
 */
const CONTACT_RANGE = 120;
/**
 * Budget share of a routine decision (the plan ran out, or its replan interval came up, with nothing
 * new seen): the full budget is kept for decisions a hit, a new situation or a new event triggered.
 */
const ROUTINE_SHARE = 0.5;
/**
 * Rollout steps per decision the CPUs of one match share with more than two fighters (plan R5):
 * each searching CPU gets its level's budget times FRAME_POOL over the sum of every CPU's budget,
 * capped at 1, and skips the second ply when cut. Measured: three gods and a UI 5 get about 1,270
 * steps each (what 2 / fighters gave) and a perf.4p sum of p99 near 29 ms against the 36 ms gate,
 * while a god alone against three UI 4s keeps its full budget, which the 1v3 gate needs (the
 * 2 / fighters cut took it from 13 to 15 of 40 down to 3 to 7 of 40; a 3,600 pool, 10 of 40).
 */
const FRAME_POOL = 4200;
/**
 * With a shared budget (budgetShare below 1) the plan generators' own simulations get the share
 * times this (DecisionView.genScale): their edge-guard and recovery searches ran 80 to 200 ms in a
 * decision with three gods on four fighters (perf.4p p99 sum 100 ms against the 36 ms gate).
 */
const GEN_SHARED = 0.25;
/**
 * genScale factor of a routine decision (nothing new seen; see ROUTINE_SHARE): a god waiting at the
 * edge while the target recovered re-ran the edge-guard search every 6 frames at 35 to 105 ms
 * (perf: god p99 21 ms against the 12 ms gate; 9 ms with this). Event-driven decisions keep it all.
 */
const GEN_ROUTINE = 0.25;
/** Outnumbered style multipliers (matchStyle). */
const OUT_RISK = 0.6;
const OUT_KILL = 1.6;
/** Passive route: taken while its value is within this many points of the best plan. */
const ROUTE_MARGIN = 150;

// ---------------------------------------------------------------------------------------------
// Profile store
// ---------------------------------------------------------------------------------------------

let store: ProfileStore | null = null;
/** True when the store is the default one this module made (resetBrain() may replace it in node). */
let storeOwned = true;

function profileStore(): ProfileStore {
  if (store === null) { store = defaultProfileStore(); storeOwned = true; }
  return store;
}

/** Replaces the profile store (tests, the harness, the host); null restores the default. */
export function setBrainProfileStore(s: ProfileStore | null): void {
  store = s;
  storeOwned = s === null;
}

// ---------------------------------------------------------------------------------------------
// Per-slot memory
// ---------------------------------------------------------------------------------------------

function newIntent(): Intent { return { held: 0, direct: 0, mash: 0 }; }
function newFrame(): InputFrame { return { held: 0, pressed: 0, released: 0, direct: 0 }; }

class SlotBrain {
  readonly slot: number;
  spec: CpuSpec | null = null;
  level!: LevelVector;
  /** The style in force this match: the spec's, or its outnumbered variant (matchStyle). */
  style!: StyleVector;
  baseStyle!: StyleVector;
  outStyle: StyleVector | null = null;

  config: MatchConfig | null = null;
  lastFrame = -1;
  meI = -1;
  fighters = 0;

  perception: TeamPerception | null = null;
  readonly perceived: PerceivedMulti = newPerceived();
  readonly preds: (PredictorBank | null)[] = [];
  readonly profKeys: (string | null)[] = [];
  /** Predictor handed to the view when there is no target. */
  spare: PredictorBank | null = null;
  predLevel: LevelVector | null = null;
  readonly targeter: TeamTargeter = createTargeter();
  readonly aff: TeamAffordances = newAffordances();
  tempo: TempoExt | null = null;
  tempoStyle: StyleVector | null = null;
  humanizer: HumanizerExt | null = null;
  exec: CpuExecutor;
  inputDelay = 0;
  /** Share of the level's step budget this match allows (budgetShareOf). */
  budgetShare = 1;

  view: DecisionView | null = null;
  readonly opps: OpponentModel[] = [];
  /** Per fighter index for this match: profile, and our matchup on that fighter. */
  readonly profs: CharacterAiProfile[] = [];
  readonly mus: OpponentModel['mu'][] = [];
  /** Three plan contexts: the running plan, a follow-up waiting for its hit, and one to prepare. */
  readonly ctxs: PlanCtx[] = [];
  follow: PlanInstance | null = null;
  followCtx: PlanCtx | null = null;
  readonly cands: PlanInstance[] = [];
  readonly scored: Scored[] = [];
  readonly result: SearchResult = { best: null, value: 0, steps: 0, scored: [], secondPly: false, vetoed: 0 };
  readonly cands2: PlanInstance[] = [];
  readonly scored2: Scored[] = [];
  readonly sets: ReplySets = createReplySets(3);
  readonly intent: Intent = newIntent();
  readonly pend: InputFrame[] = [];

  readonly stats: BrainStats = { decisions: 0, steps: 0, plan: '', target: -1, lastReaction: 0, alternates: 0, mashBits: 0 };

  // Decision bookkeeping.
  lastDecision = -1000;
  lastSit: Situation | '' = '';
  reactAt = -1;
  reactEvent = -1;
  hitReplan = false;
  followAt = -1;
  /** We were not actionable at some frame since the last decision (the running plan acted). */
  busySeen = false;
  /** Our fighter was on the ground at the last decision. */
  decidedGrounded = false;

  prevValue = NaN;
  prevValueFrame = -1000;
  savedAt = -1;

  // Second-ply scratch.
  ply: GameState | null = null;
  readonly plyPerceived: PerceivedMulti = newPerceived();
  readonly plyAff: TeamAffordances = newAffordances();
  plyView: DecisionView | null = null;
  readonly plyInputs: InputFrame[] = [];
  readonly plyIntent: Intent = newIntent();
  readonly plySets: ReplySets = createReplySets(3);

  constructor(slot: number) {
    this.slot = slot;
    this.exec = new CpuExecutor(slot, 0);
    for (let i = 0; i < MAX_FIGHTERS; i++) {
      this.preds.push(null);
      this.profKeys.push(null);
      this.opps.push({ index: -1, slot: -1, profile: null as unknown as CharacterAiProfile,
        mu: null as unknown as OpponentModel['mu'], pred: null });
      this.plyInputs.push(newFrame());
    }
    for (let k = 0; k < MAX_OWN_DELAY; k++) this.pend.push(newFrame());
  }
}

const slots: (SlotBrain | undefined)[] = [];

function slotBrain(slot: number): SlotBrain {
  const i = slot >= 0 && slot < MAX_SLOTS ? slot : 0;
  let m = slots[i];
  if (m === undefined) { m = new SlotBrain(i); slots[i] = m; }
  return m;
}

function sameSpec(a: CpuSpec | null, b: CpuSpec): boolean {
  return a !== null && a.archetype === b.archetype && a.level === b.level && a.god === b.god && a.s === b.s;
}

/** Level and style for a spec (allocates; only on a spec change). */
function applySpec(m: SlotBrain, spec: CpuSpec): void {
  if (m.spec === spec || sameSpec(m.spec, spec)) { m.spec = spec; return; }
  const p = paramsFor(spec);
  m.spec = spec;
  m.level = p.level;
  m.style = p.style;
  m.baseStyle = p.style;
  m.outStyle = null;
  m.config = null;   // a new level restarts the match memory
}

function indexOfSlot(state: GameState, slot: number): number {
  const fs = state.fighters;
  for (let i = 0; i < fs.length; i++) if (fs[i].slot === slot) return i;
  return -1;
}

function isOpp(state: GameState, meI: number, j: number): boolean {
  return j !== meI && !sameTeam(state, state.fighters[meI].slot, state.fighters[j].slot);
}

// ---------------------------------------------------------------------------------------------
// Match start and end
// ---------------------------------------------------------------------------------------------

function ensurePools(m: SlotBrain, state: GameState): void {
  const n = state.fighters.length;
  if (m.perception === null || m.fighters !== n) {
    m.perception = createPerception(state, MAX_AGE);
    m.ply = null;
    m.fighters = n;
  }
  if (m.tempo === null || m.tempoStyle !== m.style) { m.tempo = createTempoExt(m.style); m.tempoStyle = m.style; }
  if (m.predLevel !== m.level) {
    for (let j = 0; j < MAX_FIGHTERS; j++) m.preds[j] = null;
    m.spare = createPredictorBank(m.level);
    m.predLevel = m.level;
  }
}

function startMatch(m: SlotBrain, state: GameState): void {
  if (m.config !== null && m.config !== state.config) saveProfiles(m);
  const cfg = state.config;
  m.config = cfg;
  m.lastFrame = -1;
  m.meI = indexOfSlot(state, m.slot);
  m.style = m.meI >= 0 ? matchStyle(m, state) : m.baseStyle;
  ensurePools(m, state);
  (m.perception as TeamPerception).reset();
  m.targeter.reset();
  (m.tempo as TempoExt).reset();
  m.exec.reset();
  m.budgetShare = budgetShareOf(cfg, m.slot, m.level.stepBudget);
  m.profs.length = 0; m.mus.length = 0;
  if (m.meI >= 0) {
    const mine = profileFor(state.fighters[m.meI].charId, state.stageId);
    for (let j = 0; j < state.fighters.length; j++) {
      const pj = profileFor(state.fighters[j].charId, state.stageId);
      m.profs.push(pj);
      m.mus.push(matchupFor(mine, pj, state.stageId));
    }
  }
  // Predictors: one per opponent, primed with a stored human profile.
  for (let j = 0; j < MAX_FIGHTERS; j++) m.profKeys[j] = null;
  for (let j = 0; j < state.fighters.length && j < MAX_FIGHTERS; j++) {
    if (m.meI < 0 || !isOpp(state, m.meI, j)) continue;
    let b = m.preds[j];
    if (b === null) { b = createPredictorBank(m.level); m.preds[j] = b; }
    b.reset();
    if (m.level.learning.enabled) {
      const key = profileKeyFor(cfg, state.fighters[j].slot);
      m.profKeys[j] = key;
      if (key !== null) {
        const prof = loadPlayerProfile(profileStore(), key);
        if (prof !== null) b.load(prof.model);
      }
    }
  }
  (m.spare as PredictorBank).reset();
  const perc = m.perception as TeamPerception;
  for (let j = 0; j < MAX_FIGHTERS; j++) perc.setPredictor(j, j < state.fighters.length ? m.preds[j] : null);
  perc.setOwnDelay(m.inputDelay, m.inputDelay > 0 ? m.pend : null);
  for (let k = 0; k < m.pend.length; k++) { const f = m.pend[k]; f.held = 0; f.pressed = 0; f.released = 0; f.direct = 0; }
  // Humanizer: human tiers only; identity (none) for the god.
  if (m.level.god) {
    m.humanizer = null;
    m.exec.setHumanizer(null);
    m.exec.setReactionFn(null);
  } else {
    m.humanizer = createHumanizerExt(cfg.seed, m.slot);
    m.humanizer.setLevel(m.level);
    m.exec.setHumanizer(m.humanizer);
    m.exec.setReactionFn(reactionDelay);
  }
  resetSelect(m.slot);
  resetReactionMemory(m.slot);
  m.exec.setPlan(null, null);
  m.follow = null;
  m.followCtx = null;
  m.view = null;
  m.plyView = null;
  const st = m.stats;
  st.decisions = 0; st.steps = 0; st.plan = ''; st.target = -1; st.lastReaction = 0; st.alternates = 0; st.mashBits = 0;
  m.lastDecision = -1000; m.lastSit = ''; m.reactAt = -1; m.reactEvent = -1; m.hitReplan = false;
  m.followAt = -1; m.prevValue = NaN; m.prevValueFrame = -1000; m.savedAt = -1; m.busySeen = false;
}

const uiBudget: number[] = [];
/** Step budget of a CPU at UI level `ui` (levels.ts), cached. */
function budgetOfUi(ui: number): number {
  const k = ui < 0 ? 0 : ui > 10 ? 10 : Math.round(ui);
  let b = uiBudget[k];
  if (b === undefined) { b = k <= 0 ? 0 : paramsFor(specForUiLevel(k)).level.stepBudget; uiBudget[k] = b; }
  return b;
}

/**
 * FRAME_POOL over the summed step budgets of the match's CPUs (this slot at `own`, the others at
 * their UI level), at most 1. Two fighters or fewer: 1.
 */
function budgetShareOf(cfg: MatchConfig, slot: number, own: number): number {
  if (cfg.players.length <= 2) return 1;
  let sum = 0;
  for (let i = 0; i < cfg.players.length; i++) {
    const pl = cfg.players[i];
    if (pl.slot === slot) sum += own;
    else if (pl.cpu) sum += budgetOfUi(pl.cpuLevel);
  }
  return sum > FRAME_POOL ? FRAME_POOL / sum : 1;
}

/**
 * The spec's style, or, when this CPU's side has fewer fighters than the opponents together, a
 * copy with damage taken and stock risk weighed OUT_RISK times and kill probability OUT_KILL times
 * (built once per spec). Outnumbered, trading is what wins: the opponents' stocks add up faster
 * than ours, and a god that waited for safe openings timed out or was worn down (brain harness,
 * god against three UI 4s, 40 matches: base weights 13 wins, risk x1.8 11, x0.6 19, x0.35 17,
 * x0.6 with kill x1.6 20, with kill x2.5 15).
 */
function matchStyle(m: SlotBrain, state: GameState): StyleVector {
  let mine = 0, foes = 0;
  const me = state.fighters[m.meI];
  for (let j = 0; j < state.fighters.length; j++) {
    if (j === m.meI || sameTeam(state, me.slot, state.fighters[j].slot)) mine++;
    else foes++;
  }
  if (!(foes > mine)) return m.baseStyle;
  if (m.outStyle === null) {
    const b = m.baseStyle;
    m.outStyle = { ...b, w: { ...b.w, damageTaken: b.w.damageTaken * OUT_RISK, stockRisk: b.w.stockRisk * OUT_RISK,
      killProbability: b.w.killProbability * OUT_KILL } };
  }
  return m.outStyle;
}

/** Writes every human opponent's model back to the store. */
function saveProfiles(m: SlotBrain): void {
  if (m.config === null) return;
  for (let j = 0; j < MAX_FIGHTERS; j++) {
    const key = m.profKeys[j];
    const b = m.preds[j];
    if (key === null || b === null) continue;
    const st = profileStore();
    const prev = loadPlayerProfile(st, key);
    savePlayerProfile(st, key, { model: b.serialize(), archetype: prev !== null ? prev.archetype : null,
      skill: prev !== null ? prev.skill : null, matches: (prev !== null ? prev.matches : 0) + 1 });
  }
}

/** Saves every slot's opponent profiles now (the host calls this when a match is abandoned). */
export function flushBrainProfiles(): void {
  for (let i = 0; i < slots.length; i++) {
    const m = slots[i];
    if (m !== undefined && m.config !== null) saveProfiles(m);
  }
}

// ---------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------

function buildView(m: SlotBrain, p: PerceivedMulti, tgt: number, aff: TeamAffordances): DecisionView {
  const s = p.state;
  const meF = s.fighters[p.meI];
  const me = m.profs[p.meI];
  const oi = tgt >= 0 ? tgt : p.meI;
  const opp = m.profs[oi];
  const mu = m.mus[oi];
  const pred = tgt >= 0 && m.preds[tgt] !== null ? m.preds[tgt] as PredictorBank : m.spare as PredictorBank;
  const oppStocks = tgt >= 0 ? s.fighters[tgt].stocks : meF.stocks;
  let v = m.view;
  if (v === null || v.p !== p) {
    v = { p, aff, me, opp, mu, level: m.level, style: m.style, pred, tempo: m.tempo as TempoExt,
      seed: s.config.seed, slot: m.slot, stocksAhead: meF.stocks - oppStocks, opps: m.opps, nOpps: 0, replies: m.sets };
    if (p === m.perceived) m.view = v;
  } else {
    v.aff = aff; v.me = me; v.opp = opp; v.mu = mu; v.level = m.level; v.style = m.style; v.pred = pred;
    v.tempo = m.tempo as TempoExt; v.seed = s.config.seed; v.slot = m.slot; v.stocksAhead = meF.stocks - oppStocks;
  }
  return v;
}

/** Per-opponent profiles and predictors into `v.opps` (decision frames only). */
function fillOpps(m: SlotBrain, v: DecisionView): void {
  const s = v.p.state;
  let n = 0;
  for (let j = 0; j < s.fighters.length && j < MAX_FIGHTERS; j++) {
    if (!isOpp(s, v.p.meI, j) || !isLive(s.fighters[j])) continue;
    const o = m.opps[n++];
    o.index = j;
    o.slot = s.fighters[j].slot;
    o.profile = m.profs[j];
    o.mu = m.mus[j];
    o.pred = m.level.learning.enabled ? m.preds[j] : null;
  }
  v.nOpps = n;
}

// ---------------------------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------------------------

const order = new Int32Array(256);

/** Rank 2 or 3 of the non-vetoed candidates (the human decision error), or -1. */
function secondBest(m: SlotBrain, frame: number): number {
  const sc = m.scored;
  let n = 0;
  for (let i = 0; i < sc.length && n < order.length; i++) {
    if (sc[i].certainLoss) continue;
    const v = sc[i].value;
    let k = n++;
    while (k > 0 && sc[order[k - 1]].value < v) { order[k] = order[k - 1]; k--; }
    order[k] = i;
  }
  if (n < 2) return -1;
  const pick = n >= 3 && u01(m.config !== null ? m.config.seed : 0, m.slot, frame, STREAM.error, 7) < 0.5 ? 2 : 1;
  return order[pick];
}


/**
 * Drops candidates whose move cannot start now (sim/actions.ts moveLocked: a one-per-owner shot of
 * ours still alive, such as the crescent, or a spent air shadow step); returns the new count. A
 * move with `recall` stays: pressing it again while its shot lives teleports to the shot, which the
 * rollouts simulate and score like any other plan.
 */
function dropLocked(s: GameState, meI: number, cands: PlanInstance[], n: number): number {
  const me = s.fighters[meI] as SimFighter;
  const def = CHARACTER_DEFS[me.charId];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const c = cands[i];
    const id = c.move;
    const mv = id !== null ? def.moves[id] : undefined;
    if (mv !== undefined && mv.recall === undefined && moveLocked(s, me, def, id as NonNullable<typeof id>)) continue;
    cands[k++] = c;
  }
  cands.length = k;
  return k;
}
/**
 * Human tiers: drops aerial plans that would press their aerial while the executor's aerial rhythm
 * still holds it back (the press would be swallowed and the plan would idle out its horizon). A plan
 * that fires late (payoffAt) stays when the rhythm opens before it fires. Keeps at least one plan.
 */
function dropRhythm(m: SlotBrain, frame: number, cands: PlanInstance[], n: number): number {
  const wait = m.exec.aerialWait(frame);
  if (wait <= 0) return n;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const c = cands[i];
    const fireBy = c.payoffAt !== undefined ? c.payoffAt - 4 : 3;
    if ((c.flags & PF_ATTACK) !== 0 && CpuExecutor.isAerial(c.move) && wait > fireBy) continue;
    cands[k++] = c;
  }
  if (k === 0) return n;
  cands.length = k;
  return k;
}

function decide(m: SlotBrain, state: GameState, v: DecisionView, routine: boolean): void {
  const p = v.p as PerceivedMulti;
  const level = m.level;
  const F = state.frame;
  computeAffordances(p, v.me, v.opp, v.mu, m.aff);
  fillOpps(m, v);
  v.genScale = (m.budgetShare < 1 ? m.budgetShare * GEN_SHARED : 1) * (routine ? GEN_ROUTINE : 1);
  let n = dropLocked(p.state, p.meI, m.cands, generateCandidates(v, m.cands));
  if (!level.god) n = dropRhythm(m, F, m.cands, n);
  m.stats.decisions++;
  m.lastDecision = F;
  m.busySeen = false;
  m.decidedGrounded = state.fighters[p.meI].onGround;
  if (n === 0) return;
  buildReplySets(v, m.sets);
  v.replies = m.sets;
  // Steps: the level's budget (600 in the opening ramp), times the match's budget share with more
  // than two fighters (budgetShareOf, plan R5). The first ply gets all of it; the second ply, when
  // it runs, PLY2_SHARE more.
  let budget = stepBudgetAt(level, F);
  if (routine) budget = Math.floor(budget * ROUTINE_SHARE);
  if (state.fighters.length > 2 && budget > 0) budget = Math.floor(budget * m.budgetShare);
  // The second ply adds PLY2_SHARE to the decision's frame; a match that already shares its
  // budget (several searching CPUs) skips it to keep the per-frame peak down (perf.4p).
  const wantPly = level.god && budget > 0 && m.budgetShare >= 1;
  setRolloutWindows(targetInKillRange(v) ? WINDOW_KILL_RANGE : WINDOW_NEUTRAL, WINDOW_KILL_PLAN);
  const used = runRolloutsJoint(v, m.cands, m.sets, budget, m.scored);
  m.stats.steps += used;
  if (m.scored.length === 0) return;
  selectPlan(v, m.scored, m.result);
  let best = m.result.best;
  if (best === null) return;
  let bestScored: Scored | null = null;
  for (let i = 0; i < m.scored.length; i++) if (m.scored[i].plan === best) { bestScored = m.scored[i]; break; }

  // Passive opponent (02 section 13): the route's KO lies past the rollout window, so while the
  // target is classified passive the best route candidate is taken unless it risks the stock or
  // trails the best plan by more than ROUTE_MARGIN.
  if (level.vocabulary.has('passiveRoute') && passiveKind(v) !== 'none') {
    let ri = -1;
    for (let i = 0; i < m.scored.length; i++) {
      const s = m.scored[i];
      if (s.plan.family !== 'passiveRoute' || s.certainLoss) continue;
      if (ri < 0 || s.value > m.scored[ri].value) ri = i;
    }
    if (ri >= 0 && m.scored[ri].value >= m.result.value - ROUTE_MARGIN) { best = m.scored[ri].plan; bestScored = m.scored[ri]; }
  }

  // Human decision error: rank 2 or 3 at the level's rate (never a vetoed plan).
  if (m.humanizer !== null && m.humanizer.decisionError(level, F)) {
    const alt = secondBest(m, F);
    if (alt >= 0 && m.scored[alt].plan !== best) {
      best = m.scored[alt].plan;
      bestScored = m.scored[alt];
      m.stats.alternates++;
    }
  }

  // Gift regime (02 section 6.4): a rise in our expected value since the last decision, after the
  // opponent acted, is booked as what they gave away.
  if (level.giftBudget && p.newEvent && F - m.prevValueFrame <= GIFT_WINDOW && Number.isFinite(m.prevValue)) {
    const rise = m.result.value - m.prevValue;
    if (rise > 0) noteGift(m.slot, m.prevValue + rise * GIFT_SHARE, m.prevValue);
  }
  m.prevValue = m.result.value;
  m.prevValueFrame = F;

  // Hand the plan to the executor. An interruptible plan chosen again keeps running (its script
  // may have phases); anything else restarts from plan frame 0 with a fresh context.
  const cur = m.exec.currentPlan();
  if (!(cur !== null && cur === best && (best.flags & PF_INTR) !== 0 && m.exec.pendingFollowUp() === null)) {
    const ctx = takeCtx(m, state, v, m.exec.currentCtx(), null);
    preparePlanCtx(best, v, p.frame, ctx);
    m.exec.setPlan(best, ctx);
  }
  m.stats.plan = best.name;
  if ((best.flags & (PF_ATTACK | PF_STALE)) !== 0) (m.tempo as TempoExt).used(best.name, F);
  m.followAt = -1;
  m.follow = null;
  m.followCtx = null;

  // Second ply: the follow-up to a hit the rollouts expect, pre-buffered for the hit frame.
  if (wantPly && bestScored !== null && (best.flags & PF_ATTACK) !== 0
      && (bestScored as Scored & { hitShare?: number }).hitShare !== undefined
      && ((bestScored as Scored & { hitShare: number }).hitShare) >= PLY2_HIT_SHARE) {
    const left = Math.floor(budget * PLY2_SHARE);
    if (left > 0) secondPly(m, state, v, best, left);
  }
}

/**
 * True when the target's percent has reached the kill percent (at its spot) of one of our kill
 * moves: the approach and the launch then take longer than the neutral window, so the rollouts
 * use WINDOW_KILL_RANGE to see the KO.
 */
function targetInKillRange(v: DecisionView): boolean {
  const ti = v.p.oppI;
  if (ti < 0) return false;
  const pct = v.p.state.fighters[ti].percent;
  const kill = v.me.roles.kill;
  for (let i = 0; i < kill.length; i++) {
    const kp = v.aff.killPctHere(kill[i]);
    if (kp === kp && pct >= kp) return true;
  }
  return false;
}

function stageOf(state: GameState): PlanCtx['stage'] { return STAGE_DEFS[state.stageId]; }

/** A plan context not in use by the running plan (`a`) or a waiting follow-up (`b`). */
function takeCtx(m: SlotBrain, state: GameState, v: DecisionView, a: PlanCtx | null, b: PlanCtx | null): PlanCtx {
  while (m.ctxs.length < 3) m.ctxs.push(newPlanCtx(v.me, stageOf(state)));
  for (let i = 0; i < 3; i++) {
    const c = m.ctxs[i];
    if (c !== a && c !== b && c !== m.followCtx) return c;
  }
  return m.ctxs[0];
}

/**
 * Simulates `plan` from the perceived state with everyone else continuing until our first hit on
 * an opponent; at that state searches the advantage candidates (top PLY2_CANDS) against the joint
 * replies and pre-buffers the best follow-up at the hit frame. Nothing when the hit does not come.
 */
function secondPly(m: SlotBrain, state: GameState, v: DecisionView, plan: PlanInstance, budget: number): void {
  const p = v.p as PerceivedMulti;
  const src = p.state;
  if (m.ply === null) m.ply = cloneGameState(src);
  const st = m.ply;
  copyStateInto(src, st);
  const meI = p.meI;
  const fs = st.fighters;
  const nf = fs.length;
  const ctx = takeCtx(m, state, v, m.exec.currentCtx(), null);
  preparePlanCtx(plan, v, p.frame, ctx);
  const meSlot = fs[meI].slot;
  let prev = fs[meI].inputHeld;
  let t = 0;
  let hit = -1;
  let steps = 0;
  for (let k = 0; k < PLY2_LOOK && steps < budget; k++) {
    const me = fs[meI];
    ctx.frame = st.frame;
    if (t < plan.horizon) plan.script(t, me, ctx, m.plyIntent);
    else { m.plyIntent.held = 0; m.plyIntent.direct = 0; m.plyIntent.mash = 0; }
    if (me.hitlag === 0) t++;
    for (let i = 0; i < nf; i++) {
      const inp = m.plyInputs[i];
      if (i === meI) {
        const h = m.plyIntent.held;
        inp.held = h; inp.pressed = h & ~prev; inp.released = prev & ~h; inp.direct = m.plyIntent.direct;
        prev = h;
      } else { inp.held = fs[i].inputHeld; inp.pressed = 0; inp.released = 0; inp.direct = 0; }
    }
    stepGame(st, m.plyInputs);
    steps++;
    const ev = st.events;
    for (let e = 0; e < ev.length; e++) {
      const x = ev[e];
      if ((x.type === 'hit' || x.type === 'grab') && x.attacker === meSlot) {
        const vi = indexOfSlot(st, x.victim);
        if (vi >= 0 && isOpp(st, meI, vi)) { hit = k; break; }
      }
    }
    if (hit >= 0 || st.finished) break;
  }
  m.stats.steps += steps;
  if (hit < 0) return;
  // The world at the hit frame, as a perceived view (own fighter and target exact in the copy).
  const pp = m.plyPerceived;
  pp.state = st; pp.meI = meI; pp.oppI = p.oppI; pp.frame = st.frame; pp.age = 0; pp.ownDelay = 0;
  pp.hyps = NO_HYPS; pp.passivity = p.passivity; pp.framesSinceEdge = p.framesSinceEdge;
  pp.framesSinceAttack = p.framesSinceAttack; pp.newEvent = true;
  for (let j = 0; j < MAX_FIGHTERS; j++) pp.others[j] = p.others[j];
  pp.nOpps = p.nOpps; pp.nMates = p.nMates; pp.friendlyFire = p.friendlyFire; pp.delayed = null;
  for (let j = 0; j < p.opps.length; j++) pp.opps[j] = p.opps[j];
  for (let j = 0; j < p.mates.length; j++) pp.mates[j] = p.mates[j];
  let v2 = m.plyView;
  if (v2 === null) {
    v2 = { p: pp, aff: m.plyAff, me: v.me, opp: v.opp, mu: v.mu, level: v.level, style: v.style, pred: v.pred,
      tempo: v.tempo, seed: v.seed, slot: v.slot, stocksAhead: v.stocksAhead, opps: m.opps, nOpps: 0, replies: m.plySets };
    m.plyView = v2;
  } else {
    v2.me = v.me; v2.opp = v.opp; v2.mu = v.mu; v2.level = v.level; v2.style = v.style; v2.pred = v.pred;
    v2.tempo = v.tempo; v2.seed = v.seed; v2.slot = v.slot; v2.stocksAhead = v.stocksAhead;
  }
  computeAffordances(pp, v2.me, v2.opp, v2.mu, m.plyAff);
  fillOpps(m, v2);
  const n = dropLocked(st, meI, m.cands2, generateCandidates(v2, m.cands2));
  if (n === 0) return;
  if (m.cands2.length > PLY2_CANDS) m.cands2.length = PLY2_CANDS;
  buildReplySets(v2, m.plySets);
  const used = runRolloutsJoint(v2, m.cands2, m.plySets, budget - steps, m.scored2);
  m.stats.steps += used;
  let bi = -1;
  for (let i = 0; i < m.scored2.length; i++) {
    const s = m.scored2[i];
    if (s.certainLoss) continue;
    if ((s.plan.flags & PF_ATTACK) === 0 && s.plan.family !== 'comboFollow' && s.plan.family !== 'killConfirm') continue;
    if (bi < 0 || s.value > m.scored2[bi].value) bi = i;
  }
  if (bi < 0) return;
  const follow = m.scored2[bi].plan;
  preparePlanCtx(follow, v2, pp.frame, ctx);
  const at = state.frame + hit + 1;
  // Held until the hit lands (brainInput hands it to the executor then), dropped if it never does.
  m.follow = follow;
  m.followCtx = ctx;
  m.followAt = at;
  m.result.secondPly = true;
}

const NO_HYPS: readonly Hypothesis[] = [{ kind: 'none', move: null, ago: 0, dir: 0, weight: 1 }];

// ---------------------------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------------------------

/** Why the last decisions ran, by reason code (test and tuning hook). */
export const DECISION_REASONS = ['none', 'hit', 'situation', 'noPlan', 'horizon', 'reaction', 'actionable', 'cadence'] as const;
const reasonCount = new Int32Array(DECISION_REASONS.length);
export function brainDecisionReasons(): Readonly<Int32Array> { return reasonCount; }

function needDecision(m: SlotBrain, state: GameState, meI: number, p: PerceivedMulti, sit: Situation): number {
  const F = state.frame;
  const me = state.fighters[meI];
  const exec = m.exec;
  const plan = exec.currentPlan();
  const t = exec.planTime();
  const since = F - m.lastDecision;
  const level = m.level;
  // A pending follow-up owns the frames up to its hit.
  if (exec.pendingFollowUp() !== null) return 0;
  const act = actNow(me);
  // Per-hit replanning: the next frame we can act after our hit, with the victim's real launch.
  if (m.hitReplan && act) { m.hitReplan = false; return 1; }
  // A new situation class the plan did not make itself (launched, ledge, downed, a grab, an opening).
  if (sit !== m.lastSit && since >= 1 && (FORCED_SIT[sit] === 1 || FORCED_SIT[m.lastSit] === 1)) return 2;
  if (!act) { m.busySeen = true; return 0; }
  if (plan === null) return 3;
  if (t >= plan.horizon) return 4;
  // Human tiers answer a new event only once their sampled reaction time has passed.
  if (m.reactAt >= 0 && F >= m.reactAt) { m.reactAt = -1; if (t >= plan.minFrames || (plan.flags & PF_INTR) !== 0) return 5; }
  if (t < plan.minFrames) return 0;
  // A committing plan: once it has spent us (we were busy and are free again) the next choice is
  // due at once. Human tiers otherwise hold it for their plan hold (03 section 2.3) while it walks
  // in to fire, instead of re-deciding on every free frame of the approach (a low level's noisy
  // choice then swapped plans every few frames and never arrived to fire).
  // Leaving the ground under a plan decided on the ground (walked off a platform or the stage) ends
  // the hold too.
  if ((plan.flags & PF_INTR) === 0) {
    return level.god || m.busySeen || since >= level.planHold || (m.decidedGrounded && !me.onGround) ? 6 : 0;
  }
  // A recovery route runs to its end: switching routes every few frames restarts their timing.
  if (plan.family === 'recovery' && !(level.god && anyNewEvent(p))) return 0;
  // A passive route that left the ground (a ledge spike's hop) runs on: the route family only
  // generates from the ground, so a replan in the air always dropped it for something else and the
  // spike never came out (eval bf: a hanger that never lets go, 2,600 frames without a hit).
  if (plan.family === 'passiveRoute' && !me.onGround && !anyNewEvent(p)) return 0;
  const recovering = sit === 'disadvantage' || sit === 'bothOffstage';
  const newEvent = level.god ? anyNewEvent(p) : false;
  return shouldDecide({ planEnded: false, interruptible: true, recovering, runFrames: t, newEvent, sinceDecision: since }, level) ? 7 : 0;
}

/** Situation classes whose start or end forces a decision (the others follow from our own plan). */
const FORCED_SIT: Record<string, number> = {
  '': 1, neutral: 0, airborne: 0, advantage: 1, disadvantage: 1, bothOffstage: 1, respawn: 1, finalSmash: 1,
  grabHold: 1, grabbed: 1, ledge: 1, downed: 1, tumble: 1, oos: 1,
};

/** Can act on this frame (legacy aevalmere actionableNow): free states, shield, ledge, downed, a hold, IASA. */
function actNow(f: FighterState): boolean {
  switch (f.action) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'turn': case 'crouch': case 'air': case 'shield':
    case 'ledgeHang': case 'downed': case 'grabHold':
      return f.hitlag === 0;
    case 'attack': {
      if (f.moveId === null || f.hitlag > 0) return false;
      const mv = CHARACTER_DEFS[f.charId].moves[f.moveId];
      return mv !== undefined && mv.iasa !== undefined && f.actionFrame >= mv.iasa;
    }
    case 'land': case 'shieldStun': return (f as SimFighter).stateTimer <= 2;
    case 'tumble': return f.hitstun <= 0 && f.hitlag === 0;
    case 'hitstun': return f.hitstun <= 1 && f.hitlag === 0;
    default: return false;
  }
}

function anyNewEvent(p: PerceivedMulti): boolean {
  for (let i = 0; i < p.nOpps; i++) { const o = p.others[p.opps[i]]; if (o !== undefined && o.newEvent) return true; }
  return p.newEvent;
}

/** Human tiers: schedule the answer to a newly perceived event after the sampled reaction time. */
function scheduleReaction(m: SlotBrain, p: PerceivedMulti, F: number): void {
  if (m.level.god) return;
  let ev = -1;
  for (let i = 0; i < p.nOpps; i++) {
    const o = p.others[p.opps[i]];
    if (o !== undefined && o.newEvent && o.eventFrame > ev) ev = o.eventFrame;
  }
  if (ev < 0 || ev === m.reactEvent) return;
  m.reactEvent = ev;
  const st = reactStim;
  st.key = ev * 8 + m.slot; st.frame = ev; st.bits = 1; st.pCue = 0; st.stress = 0; st.alert = false;
  const R = reactionDelay(st, m.level, p.state.config.seed, m.slot);
  m.stats.lastReaction = R;
  const at = ev + R;
  if (m.reactAt < 0 || at < m.reactAt) m.reactAt = at > F ? at : F;
}
const reactStim = { key: 0, frame: 0, bits: 0, pCue: 0, stress: 0, alert: false };

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

/** One frame of input for `slot`, written into `out` (contract 4.1). */
export const brainInput: BrainInputFn = (state, slot, spec, out) => {
  const m = slotBrain(slot);
  applySpec(m, spec);
  if (state.config !== m.config || state.frame < m.lastFrame || m.perception === null) startMatch(m, state);
  m.lastFrame = state.frame;
  const meI = indexOfSlot(state, slot);
  m.meI = meI;
  if (meI < 0) { out.held = 0; out.pressed = 0; out.released = 0; out.direct = 0; return out; }
  const F = state.frame;
  const level = m.level;
  const perc = m.perception as TeamPerception;
  const nf = state.fighters.length;

  perc.observe(state, meI);
  // The predictors read the delayed snapshot only.
  const age = level.perceptionAge;
  const D = perc.delayedAt(F - age);
  if (D !== null && level.learning.enabled) {
    for (let j = 0; j < nf && j < MAX_FIGHTERS; j++) {
      const b = m.preds[j];
      if (b !== null) b.observe(D, meI, j, D.frame);
    }
  }
  let tgt = m.targeter.pick(D !== null ? D : state, meI, F);
  const S0 = D !== null ? D : state;
  const near = nearestOpp(S0, meI);
  if (near >= 0 && near !== tgt && manhattan(S0, meI, near) < CONTACT_RANGE) tgt = near;
  m.stats.target = tgt;
  const p = m.perceived;
  const pred = tgt >= 0 && m.preds[tgt] !== null ? m.preds[tgt] as PredictorBank : m.spare as PredictorBank;
  perc.view(state, meI, tgt, level, pred, p);
  const v = buildView(m, p, tgt, m.aff);
  const tempo = m.tempo as TempoExt;
  tempo.update(p.state, meI, tgt >= 0 ? tgt : meI);
  tempo.setPassivity(tgt >= 0 ? (p.passivity >= PASSIVE_FULL ? 1 : p.passivity / PASSIVE_FULL) : 0);
  if (level.vocabulary.has('passiveRoute')) passiveKind(v);
  if (m.humanizer !== null) m.humanizer.setStress(stressOf(state, meI, tgt));

  // Our hit or grab landed on an opponent on the last step: replan now unless a follow-up waits.
  const me = state.fighters[meI];
  const evs = state.events;
  let hitNow = false;
  for (let e = 0; e < evs.length; e++) {
    const x = evs[e];
    if ((x.type === 'hit' || x.type === 'grab') && x.attacker === me.slot) {
      const vi = indexOfSlot(state, x.victim);
      if (vi >= 0 && isOpp(state, meI, vi)) hitNow = true;
    } else if (x.type === 'ko') {
      if (F !== m.savedAt) { saveProfiles(m); m.savedAt = F; }
    }
  }
  if (hitNow) {
    if (m.follow !== null) {
      // The second ply's follow-up takes over once the buffer can hold its first press.
      m.exec.prebuffer(m.follow, F, m.followCtx);
      m.follow = null; m.followCtx = null; m.followAt = -1;
    } else m.hitReplan = true;
  }
  // A follow-up whose hit never came is dropped a few frames after the predicted hit.
  if (m.follow !== null && F > m.followAt + FOLLOW_SLACK) { m.follow = null; m.followCtx = null; m.followAt = -1; }
  const intent = m.intent;
  if (!runReflexes(v, m.exec, intent)) {
    const sit = classifySituation(p.state, meI, tgt >= 0 ? tgt : -1);
    scheduleReaction(m, p, F);
    const why = tgt >= 0 ? needDecision(m, state, meI, p, sit) : 0;
    if (why > 0) { reasonCount[why]++; decide(m, state, v, why === 4 || why === 6 || why === 3 || (why === 7 && !anyNewEvent(p))); }
    m.lastSit = sit;
    if (!m.exec.stepPlan(state, meI, intent)) { intent.held = 0; intent.direct = 0; intent.mash = 0; }
    const cur = m.exec.currentPlan();
    if (cur !== null) m.stats.plan = cur.name;
  } else {
    m.lastSit = '';
  }
  // The live state, not the perceived one: the guard is a rule about where teammates stand now.
  if (m.perceived.nMates > 0) mateGuard(state, meI, intent, m.exec.lastHeld());
  m.exec.emit(state, meI, intent, level, out);
  m.stats.mashBits = m.exec.mashBits;

  // Own inputs not yet consumed, for the own-delay roll of the next view.
  const d = m.inputDelay;
  if (d > 0) {
    for (let k = 0; k + 1 < d; k++) { const a = m.pend[k], b = m.pend[k + 1]; a.held = b.held; a.pressed = b.pressed; a.released = b.released; a.direct = b.direct; }
    const z = m.pend[d - 1];
    z.held = out.held; z.pressed = out.pressed; z.released = out.released; z.direct = out.direct ?? 0;
  }
  return out;
};

/** Stress 0..1 (03 section 2.1): last stock, trailing on stocks, high percent. */
function stressOf(state: GameState, meI: number, tgt: number): number {
  const me = state.fighters[meI];
  let s = 0;
  if (me.stocks <= 1) s += 0.4;
  if (tgt >= 0 && state.fighters[tgt].stocks > me.stocks) s += 0.3;
  if (me.percent >= 100) s += 0.3;
  return s > 1 ? 1 : s;
}

/** Profiles, tables and pools for a match before frame 0 (contract 4.1). */
export const warmBrain: WarmBrainFn = (config, specs) => {
  const st = createGameState(config);
  // Character profiles and matchups for every pair on this stage (cached by data hash).
  for (let i = 0; i < st.fighters.length; i++) {
    const a = profileFor(st.fighters[i].charId, config.stageId);
    for (let j = 0; j < st.fighters.length; j++) matchupFor(a, profileFor(st.fighters[j].charId, config.stageId), config.stageId);
  }
  let search = false;
  for (const [slot, spec] of specs) {
    const m = slotBrain(slot);
    applySpec(m, spec);
    ensurePools(m, st);
    if (m.level.stepBudget > 0) search = true;
  }
  // With warmTables on, the opening bracket (0%) of each character's combo table is built now
  // (200 to 350 ms per character and stage, once per session); the later brackets build the first
  // time a percent reaches them. Building every bracket here cost 1.5 to 5.5 s on the first call,
  // over the harness's 1.5 s first-call gate. The result is the same either way; only when the
  // cost is paid differs.
  if (search && warmTables) {
    for (let i = 0; i < st.fighters.length; i++) {
      const t = profileFor(st.fighters[i].charId, config.stageId).comboTable;
      if (!warmedTables.has(t)) { warmedTables.add(t); if (t.warm !== undefined) t.warm(0); else t.summary(); }
    }
  }
};
const warmedTables = new WeakSet<object>();

/** Clears per-slot memory; every slot when `slot` is omitted (contract 4.1). */
export const resetBrain: ResetBrainFn = (slot) => {
  if (slot === undefined) {
    for (let i = 0; i < slots.length; i++) { const m = slots[i]; if (m !== undefined) clearSlot(m); }
    resetSelect();
    resetReactionMemory();
    resetPassive();
    // A fresh in-memory store per match in node, so harness matches stay independent.
    if (storeOwned && typeof localStorage === 'undefined') { store = new MemoryProfileStore(); storeOwned = true; }
    return;
  }
  const m = slots[slot];
  if (m !== undefined) clearSlot(m);
  resetSelect(slot);
  resetReactionMemory(slot);
};

function clearSlot(m: SlotBrain): void {
  m.config = null;
  m.lastFrame = -1;
  m.exec.setPlan(null, null);
}

/** Counters for the harness and the HUD (contract 4.1). The object is reused. */
export const brainStats: BrainStatsFn = (slot) => slotBrain(slot).stats;

/** Own-input delay `d` (0 to 4) for a slot on a LAN host; takes effect from the next match. */
export function setBrainInputDelay(slot: number, d: number): void {
  const m = slotBrain(slot);
  const dd = d > 0 ? (d > MAX_OWN_DELAY ? MAX_OWN_DELAY : Math.floor(d)) : 0;
  if (dd === m.inputDelay) return;
  m.inputDelay = dd;
  m.exec = new CpuExecutor(m.slot, dd);
  m.config = null;
}

/** Test hook: the perceived view of `slot` from its last frame. */
export function brainPerceived(slot: number): Readonly<PerceivedMulti> { return slotBrain(slot).perceived; }

/**
 * Registers this engine with the harness runner (newBrain). src/ai/index.ts imports this file and
 * the runner imports index.ts, so when the runner is the first module loaded it is still being
 * evaluated here and its binding is not initialised yet: then the registration waits one microtask,
 * which runs before any harness code can call newBrain.
 */
function registerEngine(): void { setBrainEngine({ brainInput, warmBrain, resetBrain }); }
try {
  registerEngine();
} catch {
  queueMicrotask(registerEngine);
}

/** Test hook: the last decision's scored candidates and result for `slot`. */
export function brainLastSearch(slot: number): { scored: readonly Scored[]; result: SearchResult } {
  const m = slotBrain(slot);
  return { scored: m.scored, result: m.result };
}

// ---------------------------------------------------------------------------------------------
// Teammate guard (02 section 15, harness `ak`)
// ---------------------------------------------------------------------------------------------

/** The up special slot (recovery off the stage is never dropped). */
const UP_SPECIAL = specialForStick(true, false, false);
/** Enemy distance past which an attack started nearer a teammate is thrown at the teammate. */
const MATE_FAR = 170;
const ATTACK_BITS = Btn.Attack | Btn.Special | Btn.Grab;
/** 1 for direct codes that start a move (DIRECT_MOVES), 2 for moves that fire a projectile. */
const MOVE_KIND: Uint8Array = ((): Uint8Array => {
  const k = new Uint8Array(DIRECT_CODES.length + 1);
  for (const id of DIRECT_MOVES) k[MOVE_CODE[id]] = 1;
  return k;
})();

/**
 * Drops a fresh attack press or move code when the nearest live enemy is far (over MATE_FAR) and a
 * teammate is nearer on another side: that swing could only reach the teammate (no friendly fire,
 * so it is wasted and reads as an attack on them). A shot fired toward the enemy stays; an up
 * special off the stage (recovery) stays. Reads the live state.
 */
function mateGuard(s: GameState, meI: number, intent: Intent, prevHeld: number): void {
  const fresh = intent.held & ~prevHeld & ATTACK_BITS;
  const code = intent.direct > 0 && intent.direct < MOVE_KIND.length ? intent.direct : 0;
  if (fresh === 0 && (code === 0 || MOVE_KIND[code] === 0)) return;
  const me = s.fighters[meI];
  // The move this frame starts: the direct code's, the special the stick picks, or null (a normal).
  const h = intent.held;
  const id = code > 0 ? (DIRECT_CODES as readonly string[])[code - 1]
    : (fresh & Btn.Special) !== 0 ? specialForStick((h & Btn.Up) !== 0, (h & Btn.Down) !== 0, (h & (Btn.Left | Btn.Right)) !== 0) : null;
  // Off the stage (past a main-platform edge by 2 px, or 6 px under its top, as the harness reads
  // it) an up special is a recovery and always stays.
  if (id === UP_SPECIAL && !me.onGround && me.action !== 'ledgeHang') {
    const g = STAGE_DEFS[s.stageId];
    for (let i = 0; i < g.platforms.length; i++) {
      const pl = g.platforms[i];
      if (!pl.solid) continue;
      if (me.x < pl.x - 2 || me.x > pl.x + pl.w + 2 || me.y > pl.y + 6) return;
      break;
    }
  }
  // Judged now and GUARD_LOOK frames on (positions carried by their velocities): a press made in
  // jump squat or a buffer starts its move a few frames later, when the fighters have moved.
  if (!swingAtMate(s, meI, id, 0) && !swingAtMate(s, meI, id, GUARD_LOOK)) return;
  intent.held &= ~fresh;
  if (code !== 0 && MOVE_KIND[code] !== 0) intent.direct = 0;
}

const guardIntent: Intent = { held: 0, direct: 0, mash: 0 };

/**
 * Legacy bridge: the same teammate guard for a frame another brain produced (src/ai/index.ts runs it
 * on the Aeval god's output). Drops a fresh attack press or move code that could only reach a
 * teammate; `prevHeld` is what was actually sent last frame. Writes `out.held` and `out.direct` only.
 * A no-op without a live teammate.
 */
export function guardTeammateSwing(s: GameState, slot: number, out: InputFrame, prevHeld: number): void {
  const meI = indexOfSlot(s, slot);
  if (meI < 0) return;
  let mate = false;
  for (let j = 0; j < s.fighters.length; j++) if (j !== meI && !isOpp(s, meI, j) && isLive(s.fighters[j])) mate = true;
  if (!mate) return;
  guardIntent.held = out.held; guardIntent.direct = out.direct ?? 0; guardIntent.mash = 0;
  mateGuard(s, meI, guardIntent, prevHeld);
  out.held = guardIntent.held; out.direct = guardIntent.direct;
}

/**
 * Horizontal px either side that count as straight above or below (in line): the harness reads 24
 * for both; the guard reads a teammate wider and an enemy narrower, so a near-vertical case counts
 * against the swing.
 */
const MATE_LINE_X = 32;
const FOE_LINE_X = 16;
function lineSide(dx: number, band: number): number { return Math.abs(dx) <= band ? 0 : dx > 0 ? 1 : -1; }
/** A teammate within this many px of the nearest enemy's distance counts as the nearer one. */
const MATE_NEAR_SLACK = 40;
/** Frames ahead the guard also judges a swing at (jump squat plus a frame). */
const GUARD_LOOK = 5;

/**
 * True when a move `id` (null: a normal) started by fighter `meI` with every fighter moved `look`
 * frames along its velocity would be thrown at a teammate: a teammate is the nearest live fighter
 * (within MATE_NEAR_SLACK), every enemy is past MATE_FAR and on another side (in-line bands above), and it is not a shot
 * fired toward the enemy.
 */
function swingAtMate(s: GameState, meI: number, id: string | null, look: number): boolean {
  const me = s.fighters[meI];
  const mx = me.x + me.vx * look, my = me.y + me.vy * look;
  let dMate = Infinity, dFoe = Infinity, mateX = 0, foeX = 0;
  for (let j = 0; j < s.fighters.length; j++) {
    if (j === meI) continue;
    const f = s.fighters[j];
    if (!isLive(f)) continue;
    const fx = f.x + f.vx * look, fy = f.y + f.vy * look;
    const dx = fx - mx, dy = fy - my;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (isOpp(s, meI, j)) { if (d < dFoe) { dFoe = d; foeX = fx; } }
    else if (d < dMate) { dMate = d; mateX = fx; }
  }
  if (!(dMate < dFoe + MATE_NEAR_SLACK) || !(dFoe > MATE_FAR)) return false;
  const foeSide = lineSide(foeX - mx, FOE_LINE_X), mateSide = lineSide(mateX - mx, MATE_LINE_X);
  if (foeSide === 0 || foeSide === mateSide) return false;
  if (foeSide === me.facing) {
    // A shot fired toward the enemy stays.
    const def = CHARACTER_DEFS[me.charId];
    const mv = id !== null ? def.moves[id as keyof typeof def.moves] : undefined;
    if (mv !== undefined && mv.projectiles !== undefined) return false;
  }
  return true;
}

/** Nearest live opponent by |dx| + |dy|, -1 none. */
function nearestOpp(s: GameState, meI: number): number {
  let bd = Infinity, bj = -1;
  for (let j = 0; j < s.fighters.length; j++) {
    if (!isOpp(s, meI, j) || !isLive(s.fighters[j])) continue;
    const d = manhattan(s, meI, j);
    if (d < bd) { bd = d; bj = j; }
  }
  return bj;
}

function manhattan(s: GameState, a: number, b: number): number {
  return Math.abs(s.fighters[a].x - s.fighters[b].x) + Math.abs(s.fighters[a].y - s.fighters[b].y);
}

let warmTables = true;
/** Builds whole combo tables in warmBrain (default) instead of lazily during play; false defers them. */
export function setBrainWarmTables(on: boolean): void { warmTables = on; }
