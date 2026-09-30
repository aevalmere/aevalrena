/**
 * CPU entry point: every CPU slot's input for one frame goes through `cpuInput`, which routes it to
 * one of three brains (docs/CPU_AEVALMERE.md, docs/CPU_PLAN.md section 2 and "Outcome").
 *
 *   level 0            the training dummy below (never attacks; wanders under cpuZeroMoves)
 *   levels 1 to 9      the search engine in ./brain.ts at specForUiLevel(level), every character
 *   level 10, Aeval    the legacy Aevalmere search brain (./aevalmere.ts), which picks its opponent
 *                      through the shared TeamTargeter (./targets.ts) in matches of three or more
 *   level 10, others   the search engine at the god spec
 *
 * The switch CPU_ENGINE picks the routing: 'auto' (the table above, the shipped default), 'new'
 * (the search engine for every level and character, including the Aeval god) or 'legacy' (as auto,
 * but the Aeval god keeps its own nearest-opponent targeting, i.e. Aevalmere exactly as it shipped
 * before the new engine). It is read once at load from `?cpu=auto|new|legacy` in the browser or the
 * CPU_ENGINE environment variable in node, and setCpuEngine changes it at run time.
 *
 * Determinism: the search engine ignores `rand` (its randomness comes from rng.ts keyed on the
 * match seed); Aevalmere and the dummy draw from `rand`. Every brain resets its per-slot memory on
 * a new config object or a backward frame jump, so identical seeds replay identically.
 */
import type { CpuSpec } from './contracts';
import type { FighterState, GameState, InputFrame, MatchConfig } from '../core/types';
import { Btn, DIRECT_CODES, MAX_PLAYERS } from '../core/types';
import { STAGE_DEFS } from '../stages/registry';
import {
  aevalmereInput, flushAevalmereProfiles as flushLegacyProfiles, setAevalmereTeamTargeting,
  warmAevalmere as warmLegacy,
} from './aevalmere';
import { brainInput, flushBrainProfiles, guardTeammateSwing, resetBrain, warmBrain } from './brain';
import { specForUiLevel } from './levels';

// ---------------------------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------------------------

export type CpuEngine = 'auto' | 'new' | 'legacy';

function parseEngine(v: unknown): CpuEngine | null {
  return v === 'auto' || v === 'new' || v === 'legacy' ? v : null;
}

/** ?cpu= in a browser, CPU_ENGINE in node, else 'auto'. */
function readEngineSwitch(): CpuEngine {
  const g = globalThis as {
    location?: { search?: string };
    process?: { env?: Record<string, string | undefined> };
  };
  try {
    if (g.location !== undefined && typeof g.location.search === 'string') {
      const m = /[?&]cpu=([a-z]+)/.exec(g.location.search);
      const e = m !== null ? parseEngine(m[1]) : null;
      if (e !== null) return e;
    }
    const env = g.process !== undefined && g.process.env !== undefined ? g.process.env.CPU_ENGINE : undefined;
    const e = parseEngine(env);
    if (e !== null) return e;
  } catch {
    // A sandboxed location or env read: fall through to the default.
  }
  return 'auto';
}

/** The active routing (see the file comment). */
export let CPU_ENGINE: CpuEngine = readEngineSwitch();
setAevalmereTeamTargeting(CPU_ENGINE !== 'legacy');

/** Changes the routing for the next frame on; a match already running keeps its brains' memory. */
export function setCpuEngine(e: CpuEngine): void {
  CPU_ENGINE = e;
  setAevalmereTeamTargeting(e !== 'legacy');
  for (let i = 0; i < warmedCfg.length; i++) warmedCfg[i] = null;
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

const ROUTE_DUMMY = 0;
const ROUTE_NEW = 1;
const ROUTE_LEGACY = 2;

/** One spec object per UI level, so the brain sees the same object every frame. */
const SPECS: readonly CpuSpec[] = ((): CpuSpec[] => {
  const out: CpuSpec[] = [];
  for (let l = 0; l <= 10; l++) out.push(specForUiLevel(l));
  return out;
})();

function specOf(level: number): CpuSpec {
  return SPECS[level >= 10 ? 10 : level <= 1 ? 1 : Math.round(level)];
}

function routeOf(level: number, charId: string): number {
  if (level <= 0) return ROUTE_DUMMY;
  if (level < 10) return ROUTE_NEW;
  if (CPU_ENGINE === 'new' || charId !== 'aeval') return ROUTE_NEW;
  return ROUTE_LEGACY;
}

/** Which brain a CPU at `level` playing `charId` runs under the active switch. */
export function cpuBrainName(level: number, charId: string): 'dummy' | 'engine' | 'aevalmere' {
  const r = routeOf(level, charId);
  return r === ROUTE_DUMMY ? 'dummy' : r === ROUTE_NEW ? 'engine' : 'aevalmere';
}

function charOf(config: MatchConfig, slot: number): string {
  const ps = config.players;
  for (let i = 0; i < ps.length; i++) if (ps[i].slot === slot) return ps[i].charId;
  return 'aeval';
}

// ---------------------------------------------------------------------------------------------
// Per-slot state kept here: warm-up, the dummy, and the roll counter the tests read
// ---------------------------------------------------------------------------------------------

/** The config each slot's search-engine brain was warmed for (warmBrain is not idempotent by itself). */
const warmedCfg: (MatchConfig | null)[] = [];
const specMaps: Map<number, CpuSpec>[] = [];
const inputFrames: InputFrame[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
  warmedCfg.push(null);
  specMaps.push(new Map());
  inputFrames.push({ held: 0, pressed: 0, released: 0, direct: 0 });
}

/** What the Aeval god's slot really sent last frame (after the teammate guard), per match. */
const sentHeld: { cfg: MatchConfig | null; frame: number; held: number }[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) sentHeld.push({ cfg: null, frame: -1, held: 0 });

/** Rolls asked for on purpose: a grounded Dodge press with a direction held, per slot and match. */
interface RollTrack { cfg: MatchConfig | null; frame: number; prevHeld: number; rolls: number }
const rollTrack: RollTrack[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) rollTrack.push({ cfg: null, frame: -1, prevHeld: 0, rolls: 0 });

function warmSlot(config: MatchConfig, slot: number, spec: CpuSpec): void {
  if (warmedCfg[slot] === config) return;
  warmedCfg[slot] = config;
  const m = specMaps[slot];
  m.clear();
  m.set(slot, spec);
  warmBrain(config, m);
}

/**
 * Gets every CPU slot of `config` ready before frame 0: the search engine's profiles, tables and
 * pools for the slots it runs, and Aevalmere's pools, combo table and JIT warm-up when a slot routes
 * there. Idempotent per config object; cpuInput warms lazily on a slot's first frame otherwise.
 * (The name is kept so src/main.ts and src/net/nettest.ts need no edit.)
 */
export function warmAevalmere(config: MatchConfig): void {
  let legacy = false;
  for (let i = 0; i < config.players.length; i++) {
    const p = config.players[i];
    if (!p.cpu || p.slot < 0 || p.slot >= MAX_PLAYERS) continue;
    const r = routeOf(p.cpuLevel, p.charId);
    if (r === ROUTE_NEW) warmSlot(config, p.slot, specOf(p.cpuLevel));
    else if (r === ROUTE_LEGACY) legacy = true;
  }
  if (legacy) warmLegacy(config);
}

/** Saves every CPU's opponent profiles now (the host calls this when a match is abandoned). */
export function flushAevalmereProfiles(): void {
  flushBrainProfiles();
  flushLegacyProfiles();
}

/**
 * Drops per-slot memory (every slot when omitted). Each brain also resets by itself on a new match,
 * so this is the explicit seam for a host or harness that wants to be sure; in node it also gives
 * the search engine a fresh in-memory profile store, which keeps harness matches independent.
 */
export function resetCpu(slot?: number): void {
  if (slot === undefined) {
    for (let i = 0; i < MAX_PLAYERS; i++) { initDummy(dummies[i]); warmedCfg[i] = null; rollTrack[i].cfg = null; sentHeld[i].cfg = null; }
    resetBrain();
    return;
  }
  if (slot < 0 || slot >= MAX_PLAYERS) return;
  initDummy(dummies[slot]);
  warmedCfg[slot] = null;
  rollTrack[slot].cfg = null;
  sentHeld[slot].cfg = null;
  resetBrain(slot);
}

/**
 * Debug read for the harness: rolls this slot asked for on purpose (a grounded Dodge press with a
 * direction held) since its current match began, counted on the input any brain sent. Any roll the
 * sim saw beyond these was a double tap the brain's output let slip.
 */
export function cpuIntendedRolls(slot: number): number {
  return slot >= 0 && slot < MAX_PLAYERS ? rollTrack[slot].rolls : 0;
}

/**
 * Test hook kept for aitest.ts: it set the retired rule brain's projectile-counter skill. The search
 * engine has no such knob (it shoots a shot down when a rollout says the clash pays), so this is a
 * no-op.
 */
export function setCpuProjBlockOverrideForTest(value: number | null): void {
  void value;
}

const ROLL_FORWARD_CODE = DIRECT_CODES.indexOf('rollForward') + 1;
const ROLL_BACK_CODE = DIRECT_CODES.indexOf('rollBack') + 1;

function trackRolls(state: GameState, slot: number, out: InputFrame): void {
  const t = rollTrack[slot];
  if (t.cfg !== state.config || state.frame < t.frame) { t.cfg = state.config; t.prevHeld = 0; t.rolls = 0; }
  t.frame = state.frame;
  const me = fighterBySlot(state, slot);
  const pressed = out.held & ~t.prevHeld;
  const code = out.direct ?? 0;
  if (me !== null && me.onGround &&
      (((pressed & Btn.Dodge) !== 0 && (out.held & (Btn.Left | Btn.Right)) !== 0) || code === ROLL_FORWARD_CODE || code === ROLL_BACK_CODE)) {
    t.rolls++;
  }
  t.prevHeld = out.held;
}

// ---------------------------------------------------------------------------------------------
// Level 0: the training dummy
// ---------------------------------------------------------------------------------------------

const WANDER_STAND = 0;
const WANDER_WALK = 1;
const WANDER_RUN = 2;
const WANDER_JUMP = 3;
/** Distance from the main platform's edge at which a wandering level 0 turns around. */
const WANDER_EDGE = 40;
/** Depth below the main platform's top from which a level 0 in the air counts as needing to recover. */
const WANDER_FALL = 40;
/** Frames between one recovery jump and the next, so a level 0 never burns every jump at once. */
const WANDER_JUMP_CD = 30;
/** A frame counter that jumps back further than this is a new match, not a rollback. */
const MATCH_RESET_SLACK = 60;

interface DummyMem {
  matchRef: MatchConfig | null; matchFrame: number;
  wanderMode: number; wanderDir: number; wanderTimer: number; wanderJumpCd: number;
}

function initDummy(m: DummyMem): void {
  m.matchRef = null; m.matchFrame = -1;
  m.wanderMode = WANDER_STAND; m.wanderDir = 1; m.wanderTimer = 0; m.wanderJumpCd = 0;
}

const dummies: DummyMem[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
  const m: DummyMem = { matchRef: null, matchFrame: -1, wanderMode: WANDER_STAND, wanderDir: 1, wanderTimer: 0, wanderJumpCd: 0 };
  dummies.push(m);
}

interface GroundInfo { minX: number; maxX: number; topY: number }
const groundCache = new Map<string, GroundInfo>();

/** Span and top of the stage's solid ground, read from the live StageDef into one cached object per stage. */
function getGround(stageId: string): GroundInfo {
  const stage = STAGE_DEFS[stageId];
  let minX = -180, maxX = 180, topY = 0, found = false;
  if (stage) {
    for (const p of stage.platforms) {
      if (!p.solid) continue;
      if (!found) { minX = p.x; maxX = p.x + p.w; topY = p.y; found = true; }
      else {
        if (p.x < minX) minX = p.x;
        if (p.x + p.w > maxX) maxX = p.x + p.w;
        if (p.y < topY) topY = p.y;
      }
    }
  }
  let info = groundCache.get(stageId);
  if (info === undefined) { info = { minX, maxX, topY }; groundCache.set(stageId, info); }
  else { info.minX = minX; info.maxX = maxX; info.topY = topY; }
  return info;
}

/** Fighters are stored in config order, which is not the slot number when a slot is off. */
function fighterBySlot(state: GameState, slot: number): FighterState | null {
  for (let i = 0; i < state.fighters.length; i++) if (state.fighters[i].slot === slot) return state.fighters[i];
  return null;
}

/**
 * Level 0: a training dummy, not a difficulty. It never attacks, shields, dodges, grabs or taunts,
 * whatever the rules say. With the cpuZeroMoves rule off it presses nothing at all and simply
 * stands where it spawned; with the rule on it wanders the stage on walk, run and jump alone,
 * turning back from the ledges and recovering if it does end up in the air off-stage. Every roll
 * comes off the passed-in `rand`, so a level 0 replays as deterministically as any other CPU.
 */
function dummyInput(state: GameState, slot: number, rand: () => number, out: InputFrame): InputFrame {
  out.held = 0; out.pressed = 0; out.released = 0; out.direct = 0;
  const mem = dummies[slot];
  if (mem.matchRef !== null && (state.config !== mem.matchRef || state.frame + MATCH_RESET_SLACK < mem.matchFrame)) initDummy(mem);
  mem.matchRef = state.config;
  mem.matchFrame = state.frame;

  if (state.config.cpuZeroMoves !== true) return out;
  const me = fighterBySlot(state, slot);
  if (me === null) return out;
  const g = getGround(state.stageId);

  if (mem.wanderTimer > 0) mem.wanderTimer--;
  if (mem.wanderJumpCd > 0) mem.wanderJumpCd--;

  // Downed: Jump stands it up (Attack would be a get-up attack, a direction a roll), at most once
  // every WANDER_JUMP_CD frames.
  if (me.action === 'downed') {
    if (mem.wanderJumpCd === 0) { out.held = Btn.Jump; out.pressed = Btn.Jump; mem.wanderJumpCd = WANDER_JUMP_CD; }
    return out;
  }

  // A fresh plan only starts on the frame the old one ran out, the only frame a WANDER_JUMP presses Jump.
  let picked = false;
  if (mem.wanderTimer === 0) {
    picked = true;
    const r = rand();
    if (r < 0.45) {
      mem.wanderMode = WANDER_WALK;
      mem.wanderDir = rand() < 0.5 ? -1 : 1;
      mem.wanderTimer = 30 + Math.floor(rand() * 60);
    } else if (r < 0.70) {
      mem.wanderMode = WANDER_STAND;
      mem.wanderTimer = 20 + Math.floor(rand() * 40);
    } else if (r < 0.85) {
      mem.wanderMode = WANDER_RUN;
      mem.wanderDir = rand() < 0.5 ? -1 : 1;
      mem.wanderTimer = 20 + Math.floor(rand() * 25);
    } else {
      mem.wanderMode = WANDER_JUMP;
      mem.wanderTimer = 30;
    }
  }

  // Edge safety: heading at a ledge from close enough to walk off it turns the plan around.
  if (me.onGround) {
    if ((mem.wanderDir < 0 && me.x < g.minX + WANDER_EDGE) || (mem.wanderDir > 0 && me.x > g.maxX - WANDER_EDGE)) {
      mem.wanderDir = -mem.wanderDir;
    }
  }

  const offStage = !me.onGround && (me.x < g.minX || me.x > g.maxX || me.y > g.topY + WANDER_FALL);
  let held = 0;
  let pressed = 0;
  if (offStage) {
    // Drift back toward the middle and spend a jump on the way down; never Down (a fast fall here
    // turns a recoverable fall into a self-destruct).
    const mid = (g.minX + g.maxX) * 0.5;
    held |= me.x < mid ? Btn.Right : Btn.Left;
    if (me.jumpsLeft > 0 && me.vy > 0 && mem.wanderJumpCd === 0) {
      held |= Btn.Jump; pressed |= Btn.Jump; mem.wanderJumpCd = WANDER_JUMP_CD;
    }
  } else if (mem.wanderMode === WANDER_WALK) {
    held |= Btn.Walk | (mem.wanderDir < 0 ? Btn.Left : Btn.Right);
  } else if (mem.wanderMode === WANDER_RUN) {
    held |= mem.wanderDir < 0 ? Btn.Left : Btn.Right;
  } else if (mem.wanderMode === WANDER_JUMP && picked) {
    held |= Btn.Jump; pressed |= Btn.Jump;
  }
  out.held = held;
  out.pressed = pressed;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

/**
 * One frame of input for the CPU in `slot` at UI `level` (0 to 10). The returned object is reused
 * per slot. Called once per frame per CPU slot on the live state; no brain mutates it.
 */
export function cpuInput(state: GameState, slot: number, level: number, rand: () => number): InputFrame {
  const out = inputFrames[slot];
  const route = routeOf(level, charOf(state.config, slot));
  if (route === ROUTE_DUMMY) return dummyInput(state, slot, rand, out);
  if (route === ROUTE_LEGACY) {
    // A no-op once this config is warm, including when the host warmed it before frame 0.
    warmLegacy(state.config);
    aevalmereInput(state, slot, rand, out);
    if (CPU_ENGINE === 'auto') {
      // The search engine's teammate guard on Aevalmere's output (no friendly fire, so a swing
      // that can only reach a teammate is wasted); edges are re-derived from what was really sent.
      const sent = sentHeld[slot];
      const prev = sent.cfg === state.config && state.frame >= sent.frame - MATCH_RESET_SLACK ? sent.held : 0;
      guardTeammateSwing(state, slot, out, prev);
      out.pressed = out.held & ~prev;
      out.released = prev & ~out.held;
      sent.cfg = state.config; sent.frame = state.frame; sent.held = out.held;
    }
  } else {
    const spec = specOf(level);
    warmSlot(state.config, slot, spec);
    brainInput(state, slot, spec, out);
  }
  trackRolls(state, slot, out);
  return out;
}
