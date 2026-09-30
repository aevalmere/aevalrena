/**
 * The executor (docs/CPU_PLAN.md W2.13; 02 sections 14.1 to 14.5; 03 sections 2.2 and 4).
 *
 * Per frame the brain runs: reflexes (reflexes.ts) or the plan stepper (`stepPlan`, which also
 * switches to a pre-buffered follow-up), then `emit`, which runs the remaining stages in a fixed
 * order: humanizer (identity for god), guard, mash, input-rate cap, and the final frame. `pressed`
 * and `released` are derived here and nowhere else, from `held` and the previous output frame.
 *
 * Coordinates. `tick` is `state.frame` when the brain is called; the frame is consumed by the sim
 * `inputDelay` ticks later, so every timer the executor keeps (tap mirror, mash spacing, rate
 * bucket, humanizer ring) runs on output frames `of = tick + inputDelay` and never reads the sim's
 * own tap timers, which cannot see inputs sent but not yet consumed.
 *
 * Input programs. A plan's `script` writes an Intent per plan frame; the helpers below
 * (`shortHop`, `fullHop`, `hopAerial`, `jcUsmash`, `smashFlick`, `chargedSmash`, `fastFall`,
 * `airTrim`, `walkStop`) are the frame-exact programs for the timings the sim checks, taken from
 * src/sim/actions.ts and src/sim/moves.ts:
 * - short hop: Jump on plan frame 0 and released on frame 1 (stepJumpsquat marks a short hop on
 *   any squat frame without Jump held); full hop: Jump held on frames 0 to jumpSquat.
 * - smash flick: one neutral frame, then the direction and Attack rise on the same frame, so the
 *   sim's tap age is 0 when the attack is read. A tilt is Attack without a same-frame direction
 *   rise; the guard turns an Attack that would read as a smash by accident into a tilt (Walk).
 * - charge: a smash started with Attack held charges one frame per extra frame Attack stays held.
 *
 * Humanizer. When a Humanizer (humanizer.ts) is attached with `setHumanizer`, emit delegates to
 * it. Without one, a built-in edge scheduler applies the level vector's execution knobs (03 2.2):
 * each rising edge of a bit is delayed by max(0, round(sigmaJ * z)) frames (never earlier than
 * the decision), no jitter when the window is `noJitterWidth` or wider, and a lapse is a dropped
 * press the executor notices and repeats a few frames later. The whole pulse of a bit is shifted,
 * so a delayed Jump keeps its short-hop length.
 *
 * Randomness only from rng.ts, keyed on (config.seed, slot, output frame, stream, k).
 * Allocation-free per frame after the first call of a match (the spacing search pools a state).
 */
import { TUNING } from '../core/constants';
import { Btn, COMMAND_ACTIONS, DIRECT_CODES, DIRECT_MOVES } from '../core/types';
import type { CommandAction, DirectMoveId, FighterState, GameState, InputFrame, MatchConfig, MoveId } from '../core/types';
import { stepGame } from '../sim';
import { MASH_CREDIT_FRAMES } from '../sim/grab';
import { ACTION_BUTTONS, C_STICK, TECH_CODE } from '../sim/input';
import { castDelay } from '../sim/moves';
import { defOf, sameTeam, stageOf, type SimFighter } from '../sim/state';
import { copyStateInto, newSnapshot } from '../net/snapshot';
import type {
  CreateExecutorFn, Executor, Humanizer, Intent, LevelVector, PlanCtx, PlanInstance, ReactionDelayFn, Stimulus,
} from './contracts';
import { STREAM, randInt, skewNormal, u01 } from './rng';

// ---------------------------------------------------------------------------------------------
// Direct-code table (the only MoveId strings in brain files live here, per plan section 3)
// ---------------------------------------------------------------------------------------------

function buildCodes<K extends string>(names: readonly K[]): Readonly<Record<K, number>> {
  const out = {} as Record<K, number>;
  const all = DIRECT_CODES as readonly string[];
  for (let i = 0; i < names.length; i++) out[names[i]] = all.indexOf(names[i]) + 1;
  return out;
}
/** InputFrame.direct code of every direct move. */
export const MOVE_CODE: Readonly<Record<DirectMoveId, number>> = buildCodes(DIRECT_MOVES);
/** InputFrame.direct code of every command. */
export const CMD_CODE: Readonly<Record<CommandAction, number>> = buildCodes(COMMAND_ACTIONS);

/** Direct code of a move, 0 when the move has no direct binding (taunt, ledge and getup attacks). */
export function moveCode(id: MoveId): number {
  const c = (MOVE_CODE as Readonly<Record<string, number>>)[id];
  return c === undefined ? 0 : c;
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const L = Btn.Left, R = Btn.Right, U = Btn.Up, D = Btn.Down;
const DIRS = L | R | U | D;
/** Every bit the sim reads from `held` (Start is never sent). */
const INPUT_BITS = 17;
const SEND_MASK = ((1 << INPUT_BITS) - 1) & ~Btn.Start;
/** Presses that start an action on the frame they land, so a same-frame direction tap cannot roll. */
const TAP_CONSUMERS = Btn.Jump | Btn.Attack | Btn.Special | Btn.Grab | C_STICK;
/** Presses a direct code owns the frame against (one action press per frame). */
const DIRECT_EXCLUSIVE = Btn.Attack | Btn.Special | Btn.Grab | Btn.Dodge | Btn.Shield | Btn.Taunt | C_STICK;
/** Mash bits: directions only, so nothing leaks into the buffer and nothing is a tech press. */
const MASH_BITS: readonly number[] = [L, U, R, D];
/** Humanizer ring (frames) and the longest shift it may apply. */
const RING = 32;
const RING_MASK = RING - 1;
const MAX_SHIFT = 15;
/** Lapse: the dropped press is noticed and repeated after NOTICE_MIN to NOTICE_MIN + NOTICE_SPAN - 1 frames. */
const NOTICE_MIN = 5;
const NOTICE_SPAN = 6;
/** Default timing window when the plan does not name one: a buffered press is good for 7 frames. */
const DEFAULT_WINDOW = TUNING.input.buffer + 1;
/**
 * Rate bucket burst: events back to back (a drift, a fast fall and an aerial inside a few frames).
 * Two starved the press that mattered: the drift and fast-fall presses took both tokens and the
 * aerial waited out its window (aitest h). The sustained rate is unchanged (RATE_WINDOW term).
 */
const RATE_BURST = 4;
/** Frames a press the rate cap held back may still go out late (one token at 2.5 per second is 24). */
const DEFER_FRAMES = 24;
/** Frames between aerial starts at human tiers (the harness gate is 45; 2 more for the start read). */
const AERIAL_GAP = 47;
const AERIAL_IDS: ReadonlySet<string> = new Set(['nair', 'fair', 'bair', 'uair', 'dair']);
/** 1 for the direct codes of the aerials. */
const AERIAL_CODE: Uint8Array = ((): Uint8Array => {
  const a = new Uint8Array(DIRECT_CODES.length + 2);
  for (const id of AERIAL_IDS) { const c = (DIRECT_CODES as readonly string[]).indexOf(id) + 1; if (c > 0) a[c] = 1; }
  return a;
})();
/** Frames the sustained rate is guaranteed over: C + W * r' <= W * r for every window W >= this. */
const RATE_WINDOW = 600;
/** Spacing holds searched, frames: 30 (02 14.4), stretched for a far target up to SPACING_K_MAX. */
const SPACING_K = 30;
const SPACING_K_MAX = 90;
/** Frames a spacing trial may take to stop after the release. */
const SPACING_SETTLE = 40;
const FAR = -1000000;

// ---------------------------------------------------------------------------------------------
// Reaction delay (the brain may inject humanizer.ts's reactionDelay with setReactionFn)
// ---------------------------------------------------------------------------------------------

/**
 * Fallback reaction delay in frames from stimulus to consumed input (03 2.1 without the Hick and
 * surprise terms): max(reactFloor, round(reactBase + reactSd * z)) for humans, reactFloor for god.
 */
export const defaultReaction: ReactionDelayFn = (st: Stimulus, level: LevelVector, seed: number, slot: number): number => {
  if (level.god) return level.reactFloor;
  const z = skewNormal(seed, slot, st.frame, STREAM.reaction, st.key & 0xffff);
  const r = Math.round(level.reactBase + (st.alert ? -1 : 0) + level.reactSd * z);
  return r > level.reactFloor ? r : level.reactFloor;
};

/** Standard normal by Irwin-Hall (12 uniforms), keyed like every other draw. */
function normal(seed: number, slot: number, frame: number, stream: number, k: number): number {
  let s = 0;
  for (let i = 0; i < 12; i++) s += u01(seed, slot, frame, stream, k * 16 + i);
  return s - 6;
}

// ---------------------------------------------------------------------------------------------
// Input programs (plan scripts call these to write exact frames)
// ---------------------------------------------------------------------------------------------

function clearIntent(out: Intent): void { out.held = 0; out.direct = 0; out.mash = 0; }

/** Short hop: Jump on plan frame 0, released from frame 1. `extra` stays held (drift). */
export function shortHop(t: number, extra: number, out: Intent): void {
  out.held = (t === 0 ? Btn.Jump : 0) | extra;
}

/** Full hop: Jump held on plan frames 0 to jumpSquat inclusive, so every squat frame sees it. */
export function fullHop(t: number, jumpSquat: number, extra: number, out: Intent): void {
  out.held = (t <= jumpSquat ? Btn.Jump : 0) | extra;
}

/**
 * Hop aerial: short or full hop with the aerial's direct code on plan frame 1. The code waits in
 * the buffer through the squat (only up smash and up special cancel it) and comes out on the first
 * airborne frame, frame jumpSquat + 1.
 */
export function hopAerial(t: number, short: boolean, jumpSquat: number, code: number, extra: number, out: Intent): void {
  if (short) shortHop(t, extra, out); else fullHop(t, jumpSquat, extra, out);
  out.direct = t === 1 ? code : 0;
}

/** Jump-cancel up smash (test `bg`): Jump on frame 0, the up smash code on frame 1. */
export function jcUsmash(t: number, out: Intent): void {
  out.held = t === 0 ? Btn.Jump : 0;
  out.direct = t === 1 ? MOVE_CODE.usmash : 0;
}

/**
 * Smash flick with a button: frame 0 neutral (so the direction press is fresh), frame 1 the
 * direction and Attack together. `dirBit` is Left, Right, Up or Down. Two frames long.
 */
export function smashFlick(t: number, dirBit: number, out: Intent): void {
  out.held = t === 1 ? (dirBit | Btn.Attack) : 0;
  out.direct = 0;
}

/**
 * Charged smash flick: the flick, then Attack held `n` more frames (charge = n, capped by the sim
 * at chargeMax), then released on frame n + 2.
 */
export function chargedSmash(t: number, dirBit: number, n: number, out: Intent): void {
  if (t <= 1) { smashFlick(t, dirBit, out); return; }
  out.held = t <= n + 1 ? Btn.Attack : 0;
  out.direct = 0;
}

/**
 * Charge frames so the first active frame lands on `targetTick` (02 14.4):
 * clamp(targetTick - nowTick - startup, 0, chargeMax).
 */
export function chargeFrames(targetTick: number, nowTick: number, startup: number): number {
  const n = targetTick - nowTick - startup;
  const max = TUNING.input.chargeMax;
  return n < 0 ? 0 : n > max ? max : n;
}

/**
 * Fast fall: sets a fresh Down press on the first frame the sim will read it with vy > 0 (the
 * check runs before that frame's gravity, `inputDelay` frames from now). When Down is still held
 * from the last output it is released instead, so the next frame is a fresh press. Returns true
 * when the press was written.
 */
export function fastFall(self: FighterState, inputDelay: number, lastHeld: number, out: Intent): boolean {
  if (self.onGround || self.fastFalling) return false;
  const def = defOf(self);
  if (self.vy + def.gravity * inputDelay <= 0) return false;
  if ((lastHeld & D) !== 0) { out.held &= ~D; return false; }
  out.held |= D;
  return true;
}

/**
 * Air drift trim toward `targetX` (02 14.4, "alternate hold and neutral"): holds toward the target
 * while the neutral stopping point falls short of it by more than `tol`, holds away when it
 * overshoots, neutral otherwise. Writes only the Left and Right bits.
 */
export function airTrim(self: FighterState, targetX: number, tol: number, out: Intent): void {
  out.held &= ~(L | R);
  if (self.onGround) return;
  const def = defOf(self);
  let v = self.vx, x = self.x;
  for (let i = 0; i < 64 && v !== 0; i++) {
    x += v;
    v = v > 0 ? Math.max(0, v - def.airFriction) : Math.min(0, v + def.airFriction);
  }
  const err = targetX - x;
  if (err > tol) out.held |= R;
  else if (err < -tol) out.held |= L;
}

/** Ground stop from a spacing search: hold `dirBit` (plus Walk when `walk`) for `k` frames, then neutral. */
export function walkStop(t: number, k: number, dirBit: number, walk: boolean, out: Intent): void {
  out.held = t < k ? (dirBit | (walk ? Btn.Walk : 0)) : 0;
  out.direct = 0;
}

/**
 * Tick at which to send a follow-up so it is consumed `k` frames (0 to the buffer, 6) before the
 * current move becomes interruptible (iasa, or its end), after the remaining hitlag. Pass the
 * result to `prebuffer`. Returns `state.frame` when the fighter is not in a move.
 */
export function followUpTick(state: GameState, self: FighterState, inputDelay: number, k: number): number {
  if (self.action !== 'attack' || self.moveId === null) return state.frame;
  const f = self as SimFighter;
  const mv = defOf(self).moves[self.moveId];
  if (f.charging) return state.frame + TUNING.input.chargeMax;
  const end = (mv.iasa !== undefined ? mv.iasa : mv.totalFrames + castDelay(f, mv));
  const kk = k < 0 ? 0 : k > TUNING.input.buffer ? TUNING.input.buffer : k;
  const left = (end > self.actionFrame ? end - self.actionFrame : 0) + self.hitlag;
  // Emitted at tick T, consumed on the step that makes frame T + 1 + inputDelay.
  const at = state.frame + left - kk - 1 - inputDelay;
  return at > state.frame ? at : state.frame;
}

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

/** Scratch another module keeps on the executor (reflexes.ts); cleared with it. */
export interface ExecutorScratch { reset(): void }

/** Result of `planSpacing`: hold `dirBit` (with Walk when `walk`) for `k` frames; `err` px. */
export interface SpacingResult { k: number; walk: boolean; dirBit: number; err: number; steps: number }

export class CpuExecutor implements Executor {
  readonly slot: number;
  readonly inputDelay: number;

  // ---- match identity ----
  private cfg: MatchConfig | null = null;
  private lastTick = FAR;

  // ---- output ----
  private prevHeld = 0;

  // ---- tap mirror, output-frame coordinates ----
  private horizDir = 0;
  private horizAt = FAR;
  private udDir = 0;
  private udAt = FAR;

  // ---- built-in humanizer ----
  private readonly histHeld = new Int32Array(RING);
  private readonly histDirect = new Int32Array(RING);
  private readonly shift = new Int32Array(INPUT_BITS);
  private shiftDirect = 0;
  private intentPrev = 0;
  private humanizer: Humanizer | null = null;
  private readonly shaped: Intent = { held: 0, direct: 0, mash: 0 };

  // ---- rate cap ----
  private tokens = RATE_BURST;
  private rateAt = FAR;
  /** An action press the cap held back, re-sent on the first frame with a token (until deferUntil). */
  private deferHeld = 0;
  private deferDirect = 0;
  private deferUntil = FAR;
  /** Start frame of our last aerial (human tiers' aerial rhythm). */
  private aerialAt = FAR;

  // ---- mash ----
  private mashAt = FAR;
  private mashIdx = 0;

  // ---- per-frame flags (cleared by emit) ----
  private claimed = false;
  private retapOk = false;
  private window = DEFAULT_WINDOW;

  // ---- plan stepper ----
  private plan: PlanInstance | null = null;
  private planT = 0;
  private ctx: PlanCtx | null = null;
  private next: PlanInstance | null = null;
  private nextAt = 0;
  private nextCtx: PlanCtx | null = null;

  // ---- hooks ----
  private reaction: ReactionDelayFn = defaultReaction;
  /** Owned by reflexes.ts. */
  reflexData: ExecutorScratch | null = null;

  // ---- spacing search pool ----
  private work: GameState | null = null;
  private readonly workInputs: InputFrame[] = [];

  // ---- stats ----
  /** Output frames with a fresh press or a direct code (the harness's `press` event). */
  events = 0;
  /** Mash presses sent. */
  mashBits = 0;

  constructor(slot: number, inputDelay: number) {
    this.slot = slot;
    this.inputDelay = inputDelay > 0 ? Math.floor(inputDelay) : 0;
  }

  // ---- contract ----

  reset(): void {
    this.resetOutput();
    this.plan = null; this.planT = 0; this.ctx = null; this.next = null; this.nextAt = 0; this.nextCtx = null;
  }

  /**
   * Clears everything tied to the output stream and the match (timers, rings, bucket, stats,
   * humanizer, reflex memory) and keeps the plan stepper, whose lifecycle belongs to the brain.
   * Runs by itself when a new config object or a backward frame jump is seen (plan section 5 R1).
   */
  private resetOutput(): void {
    this.cfg = null; this.lastTick = FAR; this.prevHeld = 0;
    this.horizDir = 0; this.horizAt = FAR; this.udDir = 0; this.udAt = FAR;
    this.histHeld.fill(0); this.histDirect.fill(0); this.shift.fill(0); this.shiftDirect = 0; this.intentPrev = 0;
    this.tokens = RATE_BURST; this.rateAt = FAR; this.deferHeld = 0; this.deferDirect = 0; this.deferUntil = FAR; this.aerialAt = FAR;
    this.mashAt = FAR; this.mashIdx = 0;
    this.claimed = false; this.retapOk = false; this.window = DEFAULT_WINDOW;
    this.events = 0; this.mashBits = 0;
    if (this.humanizer !== null) this.humanizer.reset();
    if (this.reflexData !== null) this.reflexData.reset();
  }

  outputFrameOf(tick: number): number { return tick + this.inputDelay; }

  /** Follow-up plan taken over at `atFrame`; `ctx` (brain.ts second ply) replaces the running context at the switch. */
  prebuffer(next: PlanInstance, atFrame: number, ctx: PlanCtx | null = null): void {
    this.next = next;
    this.nextAt = atFrame;
    this.nextCtx = ctx;
  }

  emit(state: GameState, meI: number, intent: Intent, level: LevelVector, out: InputFrame): InputFrame {
    const tick = state.frame;
    this.sync(state);
    const of = tick + this.inputDelay;
    const me = state.fighters[meI] as SimFighter | undefined;
    if (me === undefined) return this.finish(out, 0, 0, of);
    const seed = state.config.seed;

    // 1. Humanizer (identity for god).
    let held = intent.held & SEND_MASK;
    let direct = intent.direct > 0 ? intent.direct : 0;
    if (!level.god) {
      if (this.humanizer !== null) {
        this.humanizer.apply(intent, of, this.claimed ? Infinity : this.window, level, this.shaped);
        held = this.shaped.held & SEND_MASK;
        direct = this.shaped.direct > 0 ? this.shaped.direct : 0;
      } else {
        held = this.humanize(held, direct, of, level, seed);
        direct = this.humanDirect;
      }
    }

    // 2. Guard: mechanical invariants.
    held = this.guard(state, me, meI, held, direct, of, level, seed);
    direct = this.guardDirect;

    // 2a. No short hops below the level that has them (03 section 2.3: L1 jumps, short hop aerials
    // come with L2): a jump already held is kept through the jump squat, so a late press (jitter,
    // the rate cap) or a plan switch in the squat cannot cut it into a short hop by accident.
    if (!level.god && !level.vocabulary.has('shAerial') && me.action === 'jumpsquat' && (this.prevHeld & Btn.Jump) !== 0) {
      held |= Btn.Jump;
    }

    // 3. Mash (grabbed only), never faster than the level rate or the sim credit.
    let mashFrame = false;
    if (intent.mash !== 0 && me.action === 'grabbed') {
      mashFrame = true;
      held = 0;
      direct = 0;
      const every = level.mashEvery;
      if (every > 0) {
        const gap = Math.max(Math.ceil(every), MASH_CREDIT_FRAMES);
        if (of - this.mashAt >= gap && (this.humanizer === null || this.humanizer.mashAllowed(of))
            && this.mashCredited(state, me, meI)) {
          let bit = MASH_BITS[this.mashIdx % MASH_BITS.length];
          if ((this.prevHeld & bit) !== 0) { this.mashIdx++; bit = MASH_BITS[this.mashIdx % MASH_BITS.length]; }
          held = bit;
          this.mashAt = of;
          this.mashIdx++;
          this.mashBits++;
        }
      }
    }

    // 4. Input-rate cap (sustained events per second), god uncapped, mash exempt.
    if (!level.god && level.eventsPerSec !== Infinity && !mashFrame) {
      const perFrame = level.eventsPerSec / 60 - RATE_BURST / RATE_WINDOW;
      if (this.rateAt === FAR) this.rateAt = of;
      if (of > this.rateAt) {
        this.tokens += perFrame * (of - this.rateAt);
        if (this.tokens > RATE_BURST) this.tokens = RATE_BURST;
        this.rateAt = of;
      }
      const event = (held & ~this.prevHeld) !== 0 || direct !== 0;
      if (event) {
        if (this.claimed || direct === TECH_CODE) {
          this.tokens -= 1;
          if (this.tokens < -RATE_BURST) this.tokens = -RATE_BURST;
        } else if (this.tokens >= 1) {
          this.tokens -= 1;
        } else {
          // Out of tokens: the action press waits for the next token instead of being lost (a plan
          // script presses once and moves on, so a dropped grab or attack never came back and the
          // plan idled out its horizon). Direction changes are simply held back.
          const act = held & ~this.prevHeld & ACTION_BUTTONS;
          if (act !== 0 || direct !== 0) {
            this.deferHeld = act; this.deferDirect = direct; this.deferUntil = of + DEFER_FRAMES;
          }
          held &= this.prevHeld;
          direct = 0;
        }
      } else if ((this.deferHeld !== 0 || this.deferDirect !== 0) && this.tokens >= 1) {
        if (of <= this.deferUntil && me.hitstun === 0 && me.hitlag === 0 && me.action !== 'grabbed'
            && me.action !== 'tumble') {
          held |= this.deferHeld & ~this.prevHeld;
          if (direct === 0) direct = this.deferDirect;
          if ((held & ~this.prevHeld) !== 0 || direct !== 0) this.tokens -= 1;
        }
        this.deferHeld = 0; this.deferDirect = 0;
      }
      if (of > this.deferUntil) { this.deferHeld = 0; this.deferDirect = 0; }
    }

    // 5. Aerial rhythm (human tiers): no aerial starts within AERIAL_GAP frames of the last one.
    // A person lands, drifts or jumps between aerials; the harness holds every human level to it
    // (aitest e). Applied last, so a press the rate cap deferred is held to it too. Blocks a fresh
    // Attack or C-stick press in the air (and in the jump squat) and any aerial move code.
    if (!level.god) {
      if (me.action === 'attack' && me.moveId !== null && AERIAL_IDS.has(me.moveId)) {
        const start = tick - me.actionFrame;
        if (start > this.aerialAt) this.aerialAt = start;
      }
      if (of - this.aerialAt < AERIAL_GAP) {
        // Only where Attack starts an aerial: a hang is off the ground too, but its Attack is the
        // ledge attack, which the rhythm must not hold back.
        const airborne = me.action === 'air' || me.action === 'jumpsquat';
        const atk = Btn.Attack | C_STICK;
        if (airborne) held &= ~(held & ~this.prevHeld & atk);
        if (direct !== 0 && AERIAL_CODE[direct] === 1) direct = 0;
      }
    }

    return this.finish(out, held, direct, of);
  }

  // ---- stepper hook (wired by brain.ts) ----

  /** A new decision: `plan` from plan frame 0 with `ctx` (null keeps the current ctx). Clears any follow-up. */
  setPlan(plan: PlanInstance | null, ctx: PlanCtx | null): void {
    this.plan = plan;
    this.planT = 0;
    this.next = null;
    this.nextCtx = null;
    if (ctx !== null) this.ctx = ctx;
  }

  /** Drops a pre-buffered follow-up and keeps the running plan (its hit did not land). */
  cancelFollowUp(): void { this.next = null; this.nextCtx = null; }

  /**
   * Match identity: a new config object or a backward frame jump clears the output-side memory
   * (resetOutput). Called by emit, stepPlan and runReflexes, so whichever runs first in a frame
   * sees the reset and nothing set earlier in the same frame is lost.
   */
  sync(state: GameState): void {
    if (state.config !== this.cfg || state.frame < this.lastTick) {
      const keepCfg = state.config;
      this.resetOutput();
      this.cfg = keepCfg;
    }
    this.lastTick = state.frame;
  }

  /** Frames from state frame `tick` until the aerial rhythm lets a new aerial out (0 now; human tiers only). */
  aerialWait(tick: number): number {
    const w = this.aerialAt + AERIAL_GAP - (tick + this.inputDelay);
    return w > 0 ? w : 0;
  }

  /** True for the aerial move ids the rhythm applies to. */
  static isAerial(id: string | null): boolean { return id !== null && AERIAL_IDS.has(id); }

  /** Drops the plan and any pre-buffered follow-up (a reflex took over). */
  dropPlan(): void { this.plan = null; this.planT = 0; this.next = null; this.nextCtx = null; }

  currentPlan(): PlanInstance | null { return this.plan; }
  /** Context of the running plan (null before the first plan). */
  currentCtx(): PlanCtx | null { return this.ctx; }
  planTime(): number { return this.planT; }
  pendingFollowUp(): PlanInstance | null { return this.next; }

  /**
   * Runs the current plan's script for this frame into `out`. Switches to the pre-buffered
   * follow-up once `state.frame` reaches its tick and no more than the buffer's worth of hitlag is
   * left (a press made earlier in hitlag would expire). Plan time advances only when hitlag is 0.
   * Returns false when there is no plan (out is cleared).
   */
  stepPlan(state: GameState, meI: number, out: Intent): boolean {
    clearIntent(out);
    this.sync(state);
    const self = state.fighters[meI];
    if (self === undefined) return false;
    if (this.next !== null && state.frame >= this.nextAt && self.hitlag <= TUNING.input.buffer) {
      this.plan = this.next;
      this.next = null;
      this.planT = 0;
      if (this.nextCtx !== null) {
        // A context prepared for the follow-up (brain.ts second ply) keeps its own param.
        this.ctx = this.nextCtx;
        this.nextCtx = null;
        this.ctx.startFrame = state.frame;
      } else if (this.ctx !== null) { this.ctx.startFrame = state.frame; this.ctx.param = this.plan.param; }
    }
    if (this.plan === null || this.ctx === null) return false;
    this.ctx.frame = state.frame;
    this.plan.script(this.planT, self, this.ctx, out);
    if (self.hitlag === 0) this.planT++;
    return true;
  }

  // ---- other hooks ----

  /** Attach humanizer.ts; null restores the built-in scheduler. */
  setHumanizer(h: Humanizer | null): void { this.humanizer = h; }
  /** Attach humanizer.ts's reactionDelay; null restores `defaultReaction`. */
  setReactionFn(fn: ReactionDelayFn | null): void { this.reaction = fn === null ? defaultReaction : fn; }
  reactionFn(): ReactionDelayFn { return this.reaction; }
  /** Timing window of the frame about to be emitted (frames); resets to the default after emit. */
  setWindow(width: number): void { this.window = width; }
  /** The next emit may let a same-direction retap through: a deliberate tap roll or spot dodge. */
  allowRetap(): void { this.retapOk = true; }
  /** Marks the next emit as claimed by a reflex: no timing jitter (the reaction draw has it), rate exempt. */
  markClaimed(): void { this.claimed = true; }
  /** Held bits of the last emitted frame. */
  lastHeld(): number { return this.prevHeld; }

  /**
   * Perfect ground spacing (02 14.4): for k in 1..30 (more for a far target), dash or walk toward
   * `targetX` for k frames on a pooled copy, release, let the fighter stop, keep the k with the
   * least error. About 2,000 to 5,000 sim steps; call once per approach. Other fighters repeat
   * their held input.
   */
  planSpacing(state: GameState, meI: number, targetX: number, out: SpacingResult): void {
    const me = state.fighters[meI];
    out.k = 0; out.walk = false; out.err = Math.abs(targetX - me.x); out.steps = 0;
    out.dirBit = targetX >= me.x ? R : L;
    if (!me.onGround) return;
    if (this.work === null) this.work = newSnapshot();
    const n = state.fighters.length;
    while (this.workInputs.length < n) this.workInputs.push({ held: 0, pressed: 0, released: 0, direct: 0 });
    const work = this.work;
    const def = defOf(me);
    const far = Math.ceil(Math.abs(targetX - me.x) / Math.max(0.5, def.runSpeed)) + 6;
    const kRun = far > SPACING_K ? (far > SPACING_K_MAX ? SPACING_K_MAX : far) : SPACING_K;
    for (let w = 0; w < 2; w++) {
      const walk = w === 1;
      const kMax = walk ? SPACING_K : kRun;
      for (let k = 1; k <= kMax; k++) {
        copyStateInto(work, state);
        let prev = 0;
        let settled = false;
        for (let t = 0; t < k + SPACING_SETTLE; t++) {
          const held = t < k ? (out.dirBit | (walk ? Btn.Walk : 0)) : 0;
          for (let j = 0; j < n; j++) {
            const inp = this.workInputs[j];
            if (j === meI) { inp.held = held; inp.pressed = held & ~prev; inp.released = prev & ~held; }
            else { inp.held = work.fighters[j].inputHeld; inp.pressed = 0; inp.released = 0; }
            inp.direct = 0;
          }
          prev = held;
          stepGame(work, this.workInputs);
          out.steps++;
          const f = work.fighters[meI];
          if (t >= k && f.vx === 0 && f.onGround && (f.action === 'idle' || f.action === 'crouch')) { settled = true; break; }
        }
        if (!settled) continue;
        const err = Math.abs(work.fighters[meI].x - targetX);
        if (err < out.err) { out.err = err; out.k = k; out.walk = walk; }
      }
    }
  }

  // ---- stages ----

  private humanDirect = 0;

  /** Built-in edge scheduler; returns held and leaves the direct code in humanDirect. */
  private humanize(held: number, direct: number, of: number, level: LevelVector, seed: number): number {
    const slotI = of & RING_MASK;
    this.histHeld[slotI] = held;
    this.histDirect[slotI] = direct;
    const rising = held & ~this.intentPrev;
    const jitter = !this.claimed && this.window < level.noJitterWidth;
    if (rising !== 0) {
      for (let i = 0; i < INPUT_BITS; i++) {
        const b = 1 << i;
        if ((rising & b) === 0 || !this.quiet(b, of)) continue;
        this.shift[i] = this.drawShift(i, of, jitter, level, seed);
      }
    }
    if (direct !== 0 && this.quietDirect(of)) this.shiftDirect = this.drawShift(INPUT_BITS, of, jitter, level, seed);
    let outHeld = 0;
    for (let i = 0; i < INPUT_BITS; i++) {
      const b = 1 << i;
      if ((this.histHeld[(of - this.shift[i]) & RING_MASK] & b) !== 0) outHeld |= b;
    }
    this.humanDirect = this.histDirect[(of - this.shiftDirect) & RING_MASK];
    this.intentPrev = held;
    return outHeld;
  }

  /** True when bit `b` was low in the intent for the whole ring span behind `of`, so any shift is safe. */
  private quiet(b: number, of: number): boolean {
    for (let k = 1; k <= MAX_SHIFT; k++) if ((this.histHeld[(of - k) & RING_MASK] & b) !== 0) return false;
    return true;
  }

  private quietDirect(of: number): boolean {
    for (let k = 1; k <= MAX_SHIFT; k++) if (this.histDirect[(of - k) & RING_MASK] !== 0) return false;
    return true;
  }

  private drawShift(i: number, of: number, jitter: boolean, level: LevelVector, seed: number): number {
    let d = 0;
    if (jitter && level.sigmaJ > 0) {
      const j = Math.round(level.sigmaJ * normal(seed, this.slot, of, STREAM.jitter, i));
      d = j > 0 ? j : 0;
    }
    if (level.lapse > 0 && u01(seed, this.slot, of, STREAM.lapse, i) < level.lapse) {
      d += NOTICE_MIN + randInt(NOTICE_SPAN, seed, this.slot, of, STREAM.lapse, i + 32);
    }
    return d > MAX_SHIFT ? MAX_SHIFT : d;
  }

  private guardDirect = 0;

  /** Mechanical invariants; returns held and leaves the direct code in guardDirect. */
  private guard(state: GameState, me: SimFighter, meI: number, held: number, direct: number, of: number,
    level: LevelVector, seed: number): number {
    const prev = this.prevHeld;
    let rising = held & ~prev;
    const launched = me.action === 'hitstun' || me.action === 'tumble';
    const inStun = launched && (me.hitstun > 0 || me.hitlag > 0);

    // Launched or held: Shield and Dodge buttons are tech presses (40-frame lockout); the tech goes
    // through the tech command only. In hitstun and hitlag nothing but the tech may be pressed.
    if (launched || me.action === 'grabbed') {
      held &= ~(rising & (Btn.Shield | Btn.Dodge | Btn.Taunt));
      if (me.action === 'grabbed' && direct !== 0) direct = 0;
    }
    if (inStun) {
      held &= ~(rising & ACTION_BUTTONS);
      if (direct !== TECH_CODE) direct = 0;
    }
    rising = held & ~prev;

    // One action press per frame: a direct move code owns the frame against other action buttons
    // (Jump stays, for jump-cancel and hop-aerial programs).
    if (direct !== 0 && direct <= DIRECT_MOVES.length) {
      held &= ~(rising & DIRECT_EXCLUSIVE);
      rising = held & ~prev;
    }

    // Tap mirror: a second press of the same direction inside rollTapWindow rolls (or spot dodges)
    // on the ground. Wait instead, unless the frame's own action press consumes the tap first or a
    // retap is wanted. Levels 1 to 3 let a few through (accidentTolerance).
    const consumed = (rising & TAP_CONSUMERS) !== 0 || (direct > 0 && direct <= DIRECT_MOVES.length);
    if (!this.retapOk && !consumed && (rising & (L | R | D)) !== 0 && this.groundSoon(state, me)) {
      const win = TUNING.input.rollTapWindow;
      if ((rising & L) !== 0 && this.horizDir === -1 && of - this.horizAt <= win && !this.accident(of, level, seed, 0)) held &= ~L;
      else if ((rising & L) === 0 && (rising & R) !== 0 && this.horizDir === 1 && of - this.horizAt <= win
        && !this.accident(of, level, seed, 1)) held &= ~R;
      if ((rising & D) !== 0 && (rising & U) === 0 && this.udDir === -1 && of - this.udAt <= win
        && !this.accident(of, level, seed, 2)) held &= ~D;
      rising = held & ~prev;
    }

    // Tilt must not read as a smash: Attack rising with no direct code while a direction pressed
    // on an earlier frame is still inside smashTapWindow. A flick (direction rising with Attack
    // on this very frame) is meant; anything else gets Walk, which the sim reads as a tilt.
    if ((rising & Btn.Attack) !== 0 && direct === 0 && (rising & DIRS) === 0 && me.onGround) {
      const sw = TUNING.input.smashTapWindow;
      const hd = (held & L) !== 0 ? ((held & R) !== 0 ? 0 : -1) : (held & R) !== 0 ? 1 : 0;
      const horiz = hd !== 0 && hd === this.horizDir && of - this.horizAt <= sw;
      const vert = ((held & U) !== 0 && this.udDir === 1 && of - this.udAt <= sw)
        || ((held & D) !== 0 && this.udDir === -1 && of - this.udAt <= sw);
      if (horiz || vert) held |= Btn.Walk;
    }

    // Reaction floor as a hard gate (from level 10): no fresh grounded shield while an opponent's
    // attack is 0 or 1 frames old. Nobody sees that on reaction; a read shields earlier.
    if ((rising & Btn.Shield) !== 0 && me.onGround && !launched) {
      for (let i = 0; i < state.fighters.length; i++) {
        if (i === meI) continue;
        const o = state.fighters[i];
        if (sameTeam(state, me.slot, o.slot)) continue;
        if (o.action === 'attack' && o.actionFrame <= 1 && o.hitlag === 0) { held &= ~Btn.Shield; break; }
      }
    }

    this.guardDirect = direct;
    return held;
  }

  private accident(of: number, level: LevelVector, seed: number, k: number): boolean {
    return level.accidentTolerance > 0 && u01(seed, this.slot, of, STREAM.error, 100 + k) < level.accidentTolerance;
  }

  /** On the ground, or falling onto a platform before this frame is consumed. */
  private groundSoon(state: GameState, me: SimFighter): boolean {
    if (me.onGround) return true;
    if (me.vy < 0) return false;
    const def = defOf(me);
    const steps = this.inputDelay + 2;
    const reach = steps * Math.max(def.fastFall, me.vy + def.gravity * steps);
    const plats = stageOf(state).platforms;
    for (let i = 0; i < plats.length; i++) {
      const p = plats[i];
      if (me.x < p.x - 4 || me.x > p.x + p.w + 4) continue;
      const dy = p.y - me.y;
      if (dy >= -1 && dy <= reach) return true;
    }
    return false;
  }

  /**
   * Whether a mash press sent now is credited: the sim credits one bit when the victim's
   * actionFrame is even at the holder's check. The press is consumed inputDelay + 1 steps from
   * now; the victim's counter has advanced that many times if it updates before its holder, one
   * less otherwise.
   */
  private mashCredited(state: GameState, me: SimFighter, meI: number): boolean {
    const h = me.grabPartner;
    if (h < 0) return true;
    const inc = meI < h ? this.inputDelay + 1 : this.inputDelay;
    return ((me.actionFrame + inc) % MASH_CREDIT_FRAMES) === 0;
  }

  private finish(out: InputFrame, held: number, direct: number, of: number): InputFrame {
    const prev = this.prevHeld;
    out.held = held;
    out.pressed = held & ~prev;
    out.released = prev & ~held;
    out.direct = direct;
    const p = out.pressed;
    if ((p & L) !== 0) { this.horizDir = -1; this.horizAt = of; }
    else if ((p & R) !== 0) { this.horizDir = 1; this.horizAt = of; }
    if ((p & U) !== 0) { this.udDir = 1; this.udAt = of; }
    else if ((p & D) !== 0) { this.udDir = -1; this.udAt = of; }
    if (p !== 0 || direct !== 0) this.events++;
    this.prevHeld = held;
    this.claimed = false;
    this.retapOk = false;
    this.window = DEFAULT_WINDOW;
    return out;
  }
}

/** executor.ts: one executor per CPU slot. */
export const createExecutor: CreateExecutorFn = (slot: number, inputDelay: number): Executor => new CpuExecutor(slot, inputDelay);
