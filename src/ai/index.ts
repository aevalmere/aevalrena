import type {
  FighterState, GameState, InputFrame, MatchConfig, MoveDef, MoveId,
} from '../core/types';
import { Btn, MAX_PLAYERS } from '../core/types';
import { ROLL, SPOT_DODGE, TUNING } from '../core/constants';
import { STAGE_DEFS } from '../stages/registry';
import { CHARACTER_DEFS } from '../characters/registry';

// Per-slot scratch state. Preallocated once; cpuInput only mutates these, never allocates.
interface CpuMem {
  prevHeld: number;
  dirHeld: number;      // persistent movement/hold bits carried between decisions
  cooldown: number;     // raw frames left before the next decision
  shieldTimer: number;  // raw frames left forcing Shield held (reaction defense)
  aerialCd: number;     // real frames left before another aerial attack from this slot
  lastAerial: number;   // sim frame the last aerial actually started on, or a far-past sentinel
  dashPhase: number;    // 0/1 toggle used to fake a tap-release-tap dash approach
  uairPhase: number;    // 0 idle, 1 = jumped intending to follow up with uair
  vertBit: number;      // Btn.Up or Btn.Down currently being held toward a tilt, or 0
  vertFrames: number;   // consecutive real frames vertBit has been held continuously
  smashPending: number; // direction bit released this frame, to be tapped fresh next frame, or 0
  egPhase: number;      // 0 = not edgeguarding, 1 = committed to going off-stage
  egFrames: number;     // real frames spent on the current edgeguard commitment
  ffPhase: number;      // 0/1 toggle so a fast-fall Down is a fresh press, not a stale hold
  dancePhase: number;   // 0/1 side of the current dash-dance step
  danceTimer: number;   // real frames left on the current dash-dance step
  spaceTimer: number;   // real frames spent hovering in the spacing band without committing
  prevMove: string | null; // move the fighter was performing last frame, to spot a real aerial start

  // --- vertical game and anti-stall ---
  stallFrames: number;  // real frames spent making no measurable progress at all
  stallSample: number;  // real frames since the last progress sample
  sampleX: number;      // our position at the last progress sample
  sampleY: number;
  sampleDamage: number; // total percent on the stage at the last progress sample
  forceMode: number;    // committed anti-stall action: 1 approach, 2 jump-in, 3 dash
  forceFrames: number;  // real frames left on that commitment

  // --- defensive mixups and pattern reading ---
  dodgeCd: number;      // real frames until another dodge is allowed
  dodgeIntent: number;  // 1 while a direction held under Shield is meant to become a roll/spot dodge
  attackLock: number;   // 1 while a grounded Attack could be launched into an aerial before it resolves
  oppMove: MoveId | null;    // opponent's move id last frame, so a move *start* can be spotted
  oppStarted: MoveId | null; // the last move the opponent actually started
  oppRepeat: number;         // how many times in a row they started that same move
  oppShots: number;          // committal ranged moves they have started in a row
  oppShotAge: number;        // frames since the last one, so the read decays

  // --- committed tilt: a held direction aging past the smash window ---
  tiltBit: number;      // Btn.Up or Btn.Down the CPU is holding toward a tilt, or 0
  tiltFrames: number;   // real frames left on that commitment

  // --- retreating back air ---
  bairPhase: number;    // frames a queued retreating bair stays armed for while still grounded

  // --- match identity, so scratch from one match never leaks into the next ---
  matchRef: MatchConfig | null;
  matchFrame: number;

  // --- deliberate movement and charging ---
  jumpHold: number;     // real frames Jump stays held, so a jump is a full hop and not a short hop
  chargePending: number; // charge frames waiting for the queued smash's tap frame
  chargeFrames: number; // real frames Attack stays held to charge a smash
  dropPhase: number;    // 0/1 toggle so a platform drop-through Down is a fresh press
}

/**
 * The one place a CpuMem's initial values are written. Both the preallocation loop and resetCpu
 * go through it, so the two can never drift apart and leave a field un-reset.
 */
function initMem(mem: CpuMem): void {
  mem.prevHeld = 0; mem.dirHeld = 0; mem.cooldown = 0; mem.shieldTimer = 0; mem.aerialCd = 0;
  mem.lastAerial = -99999;
  mem.dashPhase = 0; mem.uairPhase = 0; mem.vertBit = 0; mem.vertFrames = 0; mem.smashPending = 0;
  mem.egPhase = 0; mem.egFrames = 0; mem.ffPhase = 0; mem.dancePhase = 0; mem.danceTimer = 0;
  mem.spaceTimer = 0; mem.prevMove = null;
  mem.stallFrames = 0; mem.stallSample = 0; mem.sampleX = 0; mem.sampleY = 0; mem.sampleDamage = 0;
  mem.forceMode = 0; mem.forceFrames = 0;
  mem.dodgeCd = 0; mem.dodgeIntent = 0; mem.attackLock = 0; mem.oppMove = null; mem.oppStarted = null; mem.oppRepeat = 0;
  mem.oppShots = 0; mem.oppShotAge = 0;
  mem.tiltBit = 0; mem.tiltFrames = 0;
  mem.bairPhase = 0;
  mem.matchRef = null; mem.matchFrame = -1;
  mem.jumpHold = 0; mem.chargePending = 0; mem.chargeFrames = 0; mem.dropPhase = 0;
}

/**
 * Drops every slot's scratch state. A match is a fresh CPU: without this, timers and pattern
 * history from the previous match leak into the next one and identical seeds stop replaying
 * identically. cpuInput also calls it by itself when it sees a new match, so nothing has to
 * remember to; this export is the explicit seam for a host that would rather be sure.
 */
export function resetCpu(slot?: number): void {
  if (slot === undefined) {
    for (let i = 0; i < memSlots.length; i++) initMem(memSlots[i]);
    return;
  }
  if (slot >= 0 && slot < memSlots.length) initMem(memSlots[slot]);
}

interface GroundInfo {
  minX: number; maxX: number; topY: number;
  /** Ceiling blast line, for survival DI against an upward launch. */
  blastTop: number;
}

/**
 * One difficulty setting, fully describing how a CPU behaves. Every behavioural decision in this
 * file reads these weights; nothing anywhere branches on the raw level number (outside the clamp
 * and the table lookup in cpuInput), so retuning a level means editing one row here.
 */
interface CpuProfile {
  /** Frames between decisions, i.e. how long a stale plan is held. Lower = faster reactions. */
  period: number;
  /** Reaction latency in ms. An event is only reacted to if it is still that far from landing. */
  reactMs: number;
  /** Chance of shielding an incoming attack that was seen in time. */
  shieldChance: number;
  /** Chance of attacking the instant the opponent's recovery frames leave them vulnerable. */
  punishChance: number;
  /** Willingness to leave the stage to intercept a recovering opponent. */
  edgeguard: number;
  /** Chance of chasing a launched opponent for a follow-up instead of resetting to neutral. */
  comboChance: number;
  /** How disciplined smashes are: 0 throws them out at random, 1 only on a real opening. */
  smashAccuracy: number;
  /** Survival DI and fast-fall quality while in hitstun. */
  diQuality: number;
  /** Neutral discipline: hovering outside the opponent's reach and dash-dancing instead of walking in. */
  spacing: number;
  /** Chance any single decision is thrown away and the CPU just idles. */
  missChance: number;
  /**
   * How readily a threat is answered with invincibility (spot dodge, roll, air dodge) instead of
   * shield HP, and how well the timing is judged. A projectile is dodgeable; shielding it forever
   * is how a shield gets broken.
   */
  dodgeSkill: number;
  /** How much the defensive answer is randomised, so the same option is never twice predictable. */
  mixupRate: number;
  /**
   * Shield HP (0..SHIELD_MAX) that is never spent. Below this the shield is dropped and the CPU
   * gets out instead: a broken shield is 180 stunned frames, which is a guaranteed stock.
   */
  shieldFloor: number;
  /** How much of neutral is played with retreating back airs rather than walking in. */
  bairRate: number;
  /** Quality of the vertical game: juggling above, dair/fast-fall below, leading the target. */
  juggle: number;
  /** How fast a repeated opponent move is recognised as a pattern and run down during its recovery. */
  adaptRate: number;
}

/**
 * Index 1..9 are the real difficulties; index 0 is a copy of level 1 so a bad index can never
 * produce undefined. Frozen because nothing should ever write to a profile at runtime.
 */
const CPU_PROFILES: readonly CpuProfile[] = Object.freeze([
  // 0 (unused, mirrors level 1)
  { period: 14, reactMs: 250, shieldChance: 0.05, punishChance: 0, edgeguard: 0, comboChance: 0, smashAccuracy: 0, diQuality: 0, spacing: 0, missChance: 0.30, dodgeSkill: 0, mixupRate: 0, shieldFloor: 2, bairRate: 0, juggle: 0, adaptRate: 0 },
  { period: 14, reactMs: 250, shieldChance: 0.05, punishChance: 0, edgeguard: 0, comboChance: 0, smashAccuracy: 0, diQuality: 0, spacing: 0, missChance: 0.30, dodgeSkill: 0, mixupRate: 0, shieldFloor: 2, bairRate: 0, juggle: 0, adaptRate: 0 },
  { period: 11, reactMs: 200, shieldChance: 0.12, punishChance: 0, edgeguard: 0, comboChance: 0, smashAccuracy: 0.10, diQuality: 0, spacing: 0, missChance: 0.24, dodgeSkill: 0.03, mixupRate: 0.05, shieldFloor: 4, bairRate: 0.02, juggle: 0.05, adaptRate: 0.02 },
  { period: 8, reactMs: 155, shieldChance: 0.22, punishChance: 0, edgeguard: 0, comboChance: 0.05, smashAccuracy: 0.20, diQuality: 0.10, spacing: 0.05, missChance: 0.18, dodgeSkill: 0.08, mixupRate: 0.12, shieldFloor: 6, bairRate: 0.05, juggle: 0.12, adaptRate: 0.06 },
  { period: 6, reactMs: 120, shieldChance: 0.35, punishChance: 0.15, edgeguard: 0, comboChance: 0.15, smashAccuracy: 0.35, diQuality: 0.25, spacing: 0.15, missChance: 0.12, dodgeSkill: 0.18, mixupRate: 0.22, shieldFloor: 9, bairRate: 0.12, juggle: 0.22, adaptRate: 0.14 },
  { period: 5, reactMs: 95, shieldChance: 0.50, punishChance: 0.30, edgeguard: 0.10, comboChance: 0.30, smashAccuracy: 0.50, diQuality: 0.45, spacing: 0.30, missChance: 0.05, dodgeSkill: 0.32, mixupRate: 0.35, shieldFloor: 12, bairRate: 0.22, juggle: 0.35, adaptRate: 0.26 },
  { period: 4, reactMs: 75, shieldChance: 0.65, punishChance: 0.50, edgeguard: 0.30, comboChance: 0.50, smashAccuracy: 0.65, diQuality: 0.60, spacing: 0.50, missChance: 0.03, dodgeSkill: 0.48, mixupRate: 0.50, shieldFloor: 15, bairRate: 0.35, juggle: 0.50, adaptRate: 0.42 },
  { period: 3, reactMs: 55, shieldChance: 0.80, punishChance: 0.70, edgeguard: 0.55, comboChance: 0.70, smashAccuracy: 0.80, diQuality: 0.75, spacing: 0.70, missChance: 0.015, dodgeSkill: 0.65, mixupRate: 0.66, shieldFloor: 17, bairRate: 0.50, juggle: 0.66, adaptRate: 0.60 },
  { period: 2, reactMs: 35, shieldChance: 0.92, punishChance: 0.88, edgeguard: 0.80, comboChance: 0.88, smashAccuracy: 0.92, diQuality: 0.90, spacing: 0.85, missChance: 0.005, dodgeSkill: 0.82, mixupRate: 0.80, shieldFloor: 19, bairRate: 0.68, juggle: 0.82, adaptRate: 0.78 },
  { period: 1, reactMs: 17, shieldChance: 1.0, punishChance: 1.0, edgeguard: 1.0, comboChance: 1.0, smashAccuracy: 1.0, diQuality: 1.0, spacing: 1.0, missChance: 0, dodgeSkill: 0.95, mixupRate: 0.92, shieldFloor: 20, bairRate: 0.85, juggle: 0.95, adaptRate: 0.94 },
]);

/** Clamps any incoming level into 1..9 and returns its profile. */
function profileFor(level: number): CpuProfile {
  return CPU_PROFILES[Math.max(1, Math.min(9, Math.round(level) || 1))];
}

/**
 * Scales an urge expressed as "chance per 12 frames of thinking" into this profile's decision
 * cadence. Without it a level 9, which decides every single frame, would throw fourteen times as
 * many projectiles and committal aerials as a level 1 with the same weight.
 */
function rate(prof: CpuProfile, per12: number): number {
  return per12 * prof.period / 12;
}

/** Reaction latency as whole sim frames. An opening closing sooner than this is never seen. */
function reactFrames(prof: CpuProfile): number {
  return Math.max(1, Math.round(prof.reactMs * 0.06));
}

/**
 * Frames a held direction must age past a fresh press before Attack is safe from a smash. Read
 * live off TUNING (never baked into a frozen constant) so the debug panel's smash window slider
 * still has an effect.
 */
function turnHoldFrames(): number { return TUNING.input.smashTapWindow + 3; }
/** Real frames between aerial attacks from the same slot (spec: 45, plus a small safety margin). */
const AERIAL_COOLDOWN = 52;
/**
 * Aerials, by move id. cpuInput watches the sim for a real aerial start and arms the cooldown from
 * that, so an Attack that was buffered on the ground and only resolved as an aerial later (walking
 * off a ledge, getting bumped off a platform) is still counted and still cannot be followed up on.
 */
const AERIAL_IDS: Record<string, boolean> = { nair: true, fair: true, bair: true, uair: true, dair: true };
/** Startup of our own forward smash: the opening has to last at least this long to be worth one. */
const SMASH_STARTUP = 16;
/** Startup of our own fastest poke. */
const JAB_STARTUP = 4;
/** Never approach closer than this to a ledge we are targeting. */
const LEDGE_STOP = 30;
/** Back off if somehow drifted well past the stop distance toward the edge. */
const LEDGE_BACKOFF = LEDGE_STOP - 10;
/** How far mid-range counts, for a neutral-special poke. */
const MID_RANGE_MIN = 34;
const MID_RANGE_MAX = 120;
/** Horizontal reach of our own fastest grounded pokes (jab/ftilt), in px. */
const MY_REACH = 34;
/** Horizontal reach we credit the opponent with, i.e. the edge of their threat bubble. */
const THREAT_RANGE = 46;
/** Band we dash-dance in: outside the opponent's reach but close enough to punish a step in. */
const SPACING_MIN = 40;
const SPACING_MAX = 78;
/**
 * Spacing from which a CPU stutter-steps its approach (breaking the hold every other decision)
 * instead of walking straight in. Below it the approach is a plain hold, which is both what a
 * mediocre player does and, measurably, what works better without the follow-up game to back it.
 */
const STUTTER_SPACING = 0.45;
/** Real frames a dash-dance step is held before flipping, so a 1-frame CPU still actually moves. */
const DANCE_HOLD = 7;
/**
 * Real frames a CPU is allowed to hover in the spacing band before it has to commit to something.
 * Without this a level 9 (which passes the spacing roll on every single frame) dash-dances at the
 * edge of range forever and never converts an opening into damage.
 */
const SPACING_PATIENCE = 40;
/** Edgeguard safety envelope: never further out, further down, or longer than this. */
const EG_MAX_OUT = 44;
const EG_MAX_DOWN = 34;
const EG_MAX_FRAMES = 90;
/** Percent from which the point of the exchange is the kill rather than the damage. */
const KILL_PERCENT = 120;
/** Shield HP kept in hand on top of the profile floor before a block is even considered. */
const SHIELD_RESERVE = 8;
/** Estimated shield damage of one incoming melee hit / one incoming projectile. */
const SHIELD_COST_MELEE = 12;
const SHIELD_COST_SHOT = 8;
/** Real frames between dodges, so a dodge stays a reaction instead of becoming a tic. */
const DODGE_COOLDOWN = 26;
/** Times the opponent has to start the same move in a row before it counts as a pattern. */
const SPAM_REPEATS = 3;
/** Frames a zoning read survives without another projectile before it is forgotten. */
const SPAM_MEMORY = 120;
/** Total frames from which a move counts as a real commitment rather than a poke. */
const COMMITTAL_FRAMES = 26;
/** Vertical separation from which the opponent is "above" or "below" rather than level with us. */
const VERT_MIN = 44;
/** Horizontal band inside which a vertical option can plausibly connect at all. */
const VERT_ALIGN = 46;
/**
 * Anti-stall. Progress is sampled over a window rather than per frame, so a dash-dance that ends
 * where it started counts as going nowhere even though it moves on every single frame.
 */
const STALL_SAMPLE = 20;
const STALL_MOVE = 10;
const STALL_LIMIT = 60;
const STALL_COMMIT = 40;
/**
 * Frames the sim clock may run backwards before it is read as a new match rather than a rollback.
 * Rollback rewinds a handful of frames; a new match rewinds thousands.
 */
const MATCH_RESET_SLACK = 60;
/** Share of the profile's dodge skill actually spent on dodging rather than blocking. */
const DODGE_SHARE = 0.35;
/** Vertical gap from which an airborne CPU treats the opponent as being underneath it. */
const AIR_BELOW_MIN = 20;
/** Frames an armed uair chase stays alive before it is abandoned. */
const UAIR_WINDUP = 70;
/** Frames Jump stays held to turn a jump into a full hop instead of a short hop. */
const JUMP_HOLD = 7;
/**
 * Floors below which a profile simply does not own an option. A bad player does not juggle, does
 * not space with down tilt and does not cover a cross-up with a down smash; giving every level the
 * whole toolbox is how a ladder flattens into one player wearing nine hats.
 */
const JUGGLE_MIN = 0.1;
const SPACING_MIN_SKILL = 0.1;
/** Frames a smash is charged for when the opening is long enough to pay for them. */
const CHARGE_FRAMES = 14;
/** Shortest charge worth holding at all. */
const CHARGE_MIN = 7;
/**
 * Ledge trap standoff. Aeval's ledge attack reaches 32 px in from the corner, so a CPU that walks
 * to LEDGE_STOP is standing exactly where the free hit is. Disciplined profiles wait outside it.
 */
const LEDGE_TRAP = 44;
/**
 * Commits to a grounded up or down tilt. Up plus Attack is an up SMASH while the Up tap is still
 * fresh, so the direction has to be held past the smash window first. Re-rolling that choice every
 * frame just makes the CPU crouch and look at its feet, so the hold is a commitment.
 */
function armTilt(mem: CpuMem, bit: number): number {
  mem.tiltBit = bit;
  mem.tiltFrames = turnHoldFrames() + 6;
  mem.dirHeld = bit;
  return 0;
}

/** Grounded frames a queued retreating bair stays armed for before it is abandoned. */
const BAIR_WINDUP = 8;

const inputFrames: InputFrame[] = [];
const memSlots: CpuMem[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
  inputFrames.push({ held: 0, pressed: 0, released: 0 });
  const mem: CpuMem = {
    prevHeld: 0, dirHeld: 0, cooldown: 0, shieldTimer: 0, aerialCd: 0, lastAerial: -99999,
    dashPhase: 0, uairPhase: 0, vertBit: 0, vertFrames: 0, smashPending: 0,
    egPhase: 0, egFrames: 0, ffPhase: 0, dancePhase: 0, danceTimer: 0, spaceTimer: 0, prevMove: null,
    stallFrames: 0, stallSample: 0, sampleX: 0, sampleY: 0, sampleDamage: 0,
    forceMode: 0, forceFrames: 0,
    dodgeCd: 0, dodgeIntent: 0, attackLock: 0, oppMove: null, oppStarted: null, oppRepeat: 0,
    oppShots: 0, oppShotAge: 0,
    tiltBit: 0, tiltFrames: 0,
    bairPhase: 0, matchRef: null, matchFrame: -1,
    jumpHold: 0, chargePending: 0, chargeFrames: 0, dropPhase: 0,
  };
  initMem(mem);
  memSlots.push(mem);
}

const groundCache = new Map<string, GroundInfo>();

function getGround(stageId: string): GroundInfo {
  const cached = groundCache.get(stageId);
  if (cached) return cached;
  const stage = STAGE_DEFS[stageId];
  let minX = -180;
  let maxX = 180;
  let topY = 0;
  let found = false;
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
  const b = stage ? stage.blast : { x: -420, y: -300, w: 840, h: 540 };
  const info: GroundInfo = { minX, maxX, topY, blastTop: b.y };
  groundCache.set(stageId, info);
  return info;
}

/** Fighters are stored in config order, which is not the slot number when a slot is off. */
function fighterBySlot(state: GameState, slot: number): FighterState | null {
  for (let i = 0; i < state.fighters.length; i++) {
    if (state.fighters[i].slot === slot) return state.fighters[i];
  }
  return null;
}

function nearestOpponent(state: GameState, slot: number, me: FighterState): FighterState | null {
  let best: FighterState | null = null;
  let bestD = Infinity;
  for (let i = 0; i < state.fighters.length; i++) {
    const f = state.fighters[i];
    if (f.slot === slot) continue;
    if (f.stocks <= 0 || f.action === 'dead') continue;
    const dx = f.x - me.x;
    const dy = f.y - me.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

/** The move a fighter is currently performing, or null when they are not attacking. */
function activeMove(f: FighterState): MoveDef | null {
  if (f.action !== 'attack' || f.moveId === null) return null;
  const def = CHARACTER_DEFS[f.charId];
  if (!def) return null;
  const mv = def.moves[f.moveId];
  return mv === undefined ? null : mv;
}

/** First frame any hitbox of the move goes live, or -1 for a move with no melee hitbox. */
function moveStartup(mv: MoveDef): number {
  let best = -1;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const s = mv.hitboxes[i].start;
    if (best < 0 || s < best) best = s;
  }
  return best;
}

/** Last frame any hitbox of the move is live, or -1 for a move with no melee hitbox. */
function moveActiveEnd(mv: MoveDef): number {
  let best = -1;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const e = mv.hitboxes[i].end;
    if (e > best) best = e;
  }
  return best;
}

/** True while the opponent is winding up a melee attack that has not gone live yet. */
function inStartup(f: FighterState): boolean {
  const mv = activeMove(f);
  if (mv === null) return false;
  const s = moveStartup(mv);
  return s > 0 && f.actionFrame < s;
}

/** Frames until the opponent's wind-up goes live. Large when they are not winding anything up. */
function framesToActive(f: FighterState): number {
  const mv = activeMove(f);
  if (mv === null) return 999;
  const s = moveStartup(mv);
  if (s < 0 || f.actionFrame >= s) return 999;
  return s - f.actionFrame;
}

/**
 * How many frames the opponent is still stuck in something we can hit them out of: attack recovery
 * after the hitboxes died, landing lag, a broken shield, or hitstun they have not acted out of yet.
 * 0 means no opening. The length matters as much as the opening: committing a 16-frame-startup
 * smash to a 6-frame window is exactly the whiff a top-level CPU must never throw.
 */
function vulnerableFor(f: FighterState): number {
  if (f.invuln > 0) return 0;
  if (f.action === 'hitstun') return f.hitstun;
  if (f.action === 'tumble') return f.hitstun + 12;
  if (f.action === 'shieldBreak') return 60;
  if (f.action === 'airHelpless') return 24;
  if (f.action === 'shieldStun') return 4;
  if (f.action === 'land') return 4;
  const mv = activeMove(f);
  if (mv === null) return 0;
  const end = moveActiveEnd(mv);
  if (end >= 0 && f.actionFrame <= end) return 0;
  if (end < 0 && f.actionFrame <= 8) return 0;
  const free = mv.iasa === undefined ? mv.totalFrames : mv.iasa;
  return Math.max(0, free - f.actionFrame);
}

/**
 * Frames until the nearest hostile projectile that is actually heading at us arrives, or -1 when
 * nothing is inbound. Walking into a zoner's orb is how a fast CPU with no projectile awareness
 * loses to a slow one that only knows how to spam neutral special.
 */
function incomingProjectile(state: GameState, slot: number, me: FighterState): number {
  let soonest = -1;
  for (let i = 0; i < state.projectiles.length; i++) {
    const pr = state.projectiles[i];
    if (!pr.alive || pr.owner === slot) continue;
    const dx = me.x - pr.x;
    if (dx * pr.vx <= 0) continue;                       // moving away from us
    const dy = Math.abs((me.y - 22) - pr.y);
    if (dy > 42) continue;
    const t = Math.abs(dx) / Math.abs(pr.vx);
    if (t > 40) continue;
    if (soonest < 0 || t < soonest) soonest = t;
  }
  return soonest;
}

/** One of our own moves, straight out of the character data. Null when the id is missing. */
function myMove(f: FighterState, id: MoveId): MoveDef | null {
  const def = CHARACTER_DEFS[f.charId];
  if (!def) return null;
  const mv = def.moves[id];
  return mv === undefined ? null : mv;
}

/** Highest point any hitbox of a move covers, as a y offset from the feet (negative = above). */
function moveTop(mv: MoveDef): number {
  let top = 0;
  let any = false;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const h = mv.hitboxes[i];
    const t = h.y - h.r;
    if (!any || t < top) { top = t; any = true; }
  }
  return any ? top : 0;
}

/** Lowest point any hitbox of a move covers, as a y offset from the feet (positive = below). */
function moveBottom(mv: MoveDef): number {
  let bottom = 0;
  let any = false;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const h = mv.hitboxes[i];
    const b = h.y + h.r;
    if (!any || b > bottom) { bottom = b; any = true; }
  }
  return any ? bottom : 0;
}

/** Furthest sideways any hitbox of a move reaches from the fighter's origin. */
function moveSpan(mv: MoveDef): number {
  let span = 0;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const h = mv.hitboxes[i];
    const s = Math.abs(h.x) + h.r;
    if (s > span) span = s;
  }
  return span;
}

/** Standing hurtbox height we credit a fighter with, from their own character data. */
function hurtHeight(f: FighterState): number {
  const def = CHARACTER_DEFS[f.charId];
  return def ? def.hurtbox.h : 40;
}

/**
 * True when a move's hitbox band would overlap a body whose feet sit at `pdy` relative to our own
 * feet. Comparing feet to feet is exactly what left the dead zone at 60 px: utilt tops out at
 * -56, so an opponent whose feet are at -60 is genuinely out of reach even though their body is
 * only four pixels higher than the hitbox. The body span has to be part of the test.
 */
function bandHits(mv: MoveDef, pdy: number, h: number, pad: number): boolean {
  return moveTop(mv) - pad <= pdy && moveBottom(mv) + pad >= pdy - h;
}

/**
 * Where the opponent's feet will be in `frames` frames if they keep falling the way they are.
 * Gravity and terminal velocity come from their own character data, so leading a juggle is a read
 * of the real arc rather than a guess. This is still only present state: no future input is used.
 */
function predictY(opp: FighterState, frames: number): number {
  if (opp.onGround) return opp.y;
  const def = CHARACTER_DEFS[opp.charId];
  const grav = def ? def.gravity : 0.15;
  const maxFall = def ? def.maxFall : 3.2;
  let y = opp.y;
  let vy = opp.vy;
  for (let i = 0; i < frames; i++) {
    y += vy;
    // Hitstun drives velocity from the sim's knockback decay, so only free-fall frames accelerate.
    if (i >= opp.hitstun) {
      vy += grav;
      if (vy > maxFall) vy = maxFall;
    }
  }
  return y;
}

/** Where our own feet will be in `frames` frames, given our own gravity and fall speed. */
function predictSelfY(me: FighterState, frames: number): number {
  if (me.onGround) return me.y;
  const def = CHARACTER_DEFS[me.charId];
  const grav = def ? def.gravity : 0.15;
  const maxFall = def ? (me.fastFalling ? def.fastFall : def.maxFall) : 3.2;
  let y = me.y;
  let vy = me.vy;
  for (let i = 0; i < frames; i++) {
    y += vy;
    vy += grav;
    if (vy > maxFall) vy = maxFall;
  }
  return y;
}

/**
 * Frames until the opponent's falling body first enters a move's hitbox band, or -1 when it will
 * not inside `maxLook`. This is what turns a charged up smash into a read instead of a gamble:
 * the charge is only worth starting when the target is genuinely that far from arriving.
 */
function framesUntilBand(
  opp: FighterState, mv: MoveDef, myY: number, h: number, maxLook: number,
): number {
  const def = CHARACTER_DEFS[opp.charId];
  const grav = def ? def.gravity : 0.15;
  const maxFall = def ? def.maxFall : 3.2;
  let y = opp.y;
  let vy = opp.vy;
  for (let i = 0; i <= maxLook; i++) {
    if (bandHits(mv, y - myY, h, 0)) return i;
    y += vy;
    if (i >= opp.hitstun) {
      vy += grav;
      if (vy > maxFall) vy = maxFall;
    }
  }
  return -1;
}

/**
 * Frames until a falling opponent comes back down to our own level, or -1 if not inside maxLook.
 * This is the length of a landing trap, and therefore how long a smash can be charged for free.
 */
function framesUntilLevel(opp: FighterState, myY: number, maxLook: number): number {
  if (opp.onGround) return 0;
  const def = CHARACTER_DEFS[opp.charId];
  const grav = def ? def.gravity : 0.15;
  const maxFall = def ? def.maxFall : 3.2;
  let y = opp.y;
  let vy = opp.vy;
  for (let i = 0; i <= maxLook; i++) {
    if (y >= myY - 8) return i;
    y += vy;
    if (i >= opp.hitstun) {
      vy += grav;
      if (vy > maxFall) vy = maxFall;
    }
  }
  return -1;
}

/**
 * The survivability check every aggressive option shares with the edgeguard: are we still inside
 * an envelope we can certainly get home from? Suicide is a worse failure than passivity, so an
 * offstage bair, an air dodge and a dair chase all have to pass this before they are allowed.
 */
function canReturn(me: FighterState, g: GroundInfo): boolean {
  if (me.action === 'airHelpless') return false;
  if (me.onGround) return true;
  if (me.jumpsLeft < 1) return false;
  if (me.y > g.topY + EG_MAX_DOWN) return false;
  const outX = me.x < g.minX ? g.minX - me.x : me.x > g.maxX ? me.x - g.maxX : 0;
  return outX <= EG_MAX_OUT;
}

/** True while there is enough shield left to spend a block without flirting with a break. */
function shieldAffordable(prof: CpuProfile, me: FighterState, cost: number): boolean {
  return me.shieldHp - cost > prof.shieldFloor + SHIELD_RESERVE;
}

/**
 * Shield plus Down for a frame. The sim reads that out of `shield` (or straight out of idle) as a
 * spot dodge: invincible on frames 3-17 of 22. dodgeIntent tells cpuInput to let the direction
 * through instead of stripping it, which is what keeps a plain block a plain block.
 */
function spotDodgeNow(mem: CpuMem): number {
  mem.shieldTimer = 2;
  mem.dodgeIntent = 1;
  mem.dodgeCd = DODGE_COOLDOWN;
  mem.dirHeld = Btn.Down;
  return 0;
}

/** Shield plus a direction: a roll, invincible on frames 4-19 of 30, travelling ROLL.distance px. */
function rollNow(mem: CpuMem, dirBit: number): number {
  mem.shieldTimer = 2;
  mem.dodgeIntent = 1;
  mem.dodgeCd = DODGE_COOLDOWN;
  mem.dirHeld = dirBit;
  return 0;
}

/**
 * Shield pressed while airborne: an air dodge, invincible on frames 3-27 of 30. A held direction
 * gives it momentum, so it doubles as a movement and recovery mixup.
 */
function airDodgeSafe(me: FighterState, g: GroundInfo): boolean {
  return me.x > g.minX + 10 && me.x < g.maxX - 10 && me.y < g.topY + 10;
}

function airDodgeNow(mem: CpuMem, dirBit: number): number {
  mem.dodgeCd = DODGE_COOLDOWN;
  mem.dodgeIntent = 0;
  mem.shieldTimer = 0;
  mem.dirHeld = dirBit;
  return Btn.Shield;
}

/**
 * Jumps on purpose. The sim reads a Jump released during jumpsquat as a short hop and a Jump still
 * held as a full hop (actions.ts stepJumpsquat), so a one-frame pulse is a short hop by accident.
 * Undisciplined profiles simply hold the button, which is what an unskilled player does; the
 * disciplined ones pick the height the situation actually wants.
 */
function armJump(prof: CpuProfile, rand: () => number, mem: CpuMem, wantFull: boolean, dirBits: number): number {
  const deliberate = rand() < prof.spacing;
  mem.jumpHold = wantFull || !deliberate ? JUMP_HOLD : 0;
  mem.dirHeld = dirBits;
  return Btn.Jump;
}

/**
 * A smash, charged when it is free to charge. The sim starts a charge only if Attack is still
 * held on the move's first frame, so charging means keeping Attack down after the tap. Never in
 * neutral: only against someone already stuck for longer than the startup plus the charge.
 */
function chargeSmashFor(
  prof: CpuProfile, rand: () => number, mem: CpuMem, open: number, dirBit: number,
): number {
  const room = Math.min(CHARGE_FRAMES, open - SMASH_STARTUP - 1);
  // Armed, not applied: queueSmash releases everything this frame so the next frame's press is a
  // fresh smash tap, and an Attack held right now would eat that tap and come out as a jab.
  if (room >= CHARGE_MIN && rand() < prof.smashAccuracy) mem.chargePending = room;
  return queueSmash(mem, dirBit);
}

/**
 * Frames a charge can safely be held for. Being stuck is one way an opponent cannot punish a
 * charge; simply being too far away to arrive in time is the other, and it is the one a human
 * uses when they charge a smash at someone still walking back from the ledge.
 */
function chargeWindow(opp: FighterState, adx: number): number {
  let free = vulnerableFor(opp);
  if (opp.action === 'ledgeHang') free = Math.max(free, 24);
  if (opp.action === 'shieldBreak') free = Math.max(free, 60);
  if (opp.action === 'respawn' || opp.action === 'dead') free = Math.max(free, 40);
  if (!opp.onGround) free = Math.max(free, 10);
  const def = CHARACTER_DEFS[opp.charId];
  const speed = def ? def.runSpeed : 2.6;
  const travel = adx > MY_REACH ? (adx - MY_REACH) / speed : 0;
  return Math.max(free, Math.round(travel));
}

function chargeSmash(
  prof: CpuProfile, rand: () => number, mem: CpuMem, opp: FighterState, dirBit: number, adx: number,
): number {
  return chargeSmashFor(prof, rand, mem, chargeWindow(opp, adx), dirBit);
}

/** A step that would walk us off the stage is no step at all. */
function safeStep(me: FighterState, g: GroundInfo, bit: number): number {
  if (bit === Btn.Left && me.x < g.minX + 26) return 0;
  if (bit === Btn.Right && me.x > g.maxX - 26) return 0;
  return bit;
}

/** True while our feet rest on a pass-through platform, i.e. one we could drop through. */
function onSoftPlatform(state: GameState, me: FighterState): boolean {
  if (!me.onGround) return false;
  const stage = STAGE_DEFS[state.stageId];
  if (!stage) return false;
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (p.solid) continue;
    if (Math.abs(me.y - p.y) > 0.5) continue;
    if (me.x < p.x || me.x > p.x + p.w) continue;
    return true;
  }
  return false;
}

/** A plain block, with nothing held that the sim could read as a roll or a spot dodge. */
function holdShield(mem: CpuMem, frames: number): number {
  mem.shieldTimer = frames;
  mem.dodgeIntent = 0;
  mem.dirHeld = 0;
  return 0;
}

/**
 * Picks an answer to a threat that is `frames` away and would cost `cost` shield HP to block.
 * Shield is one option among several and is never the answer once the shield is low: a break is
 * 180 stunned frames, i.e. a free stock, which is exactly how projectile spam used to beat this
 * CPU. `wantIn` asks for the answer that also closes distance, for running down a spammer.
 */
function defend(
  prof: CpuProfile, rand: () => number, me: FighterState, mem: CpuMem, g: GroundInfo,
  frames: number, cost: number, towardBit: number, awayBit: number, wantIn: boolean,
): number {
  const canShield = shieldAffordable(prof, me, cost);
  // Only part of the profile's dodge skill is spent dodging. A dodge is 22-30 committed frames,
  // so a CPU that answers everything with one is as readable as a CPU that only ever shields.
  const dodging = mem.dodgeCd === 0 && rand() < prof.dodgeSkill * DODGE_SHARE;

  if (!me.onGround) {
    if (dodging && frames >= 3 && airDodgeSafe(me, g) && canReturn(me, g)) {
      return airDodgeNow(mem, wantIn ? towardBit : awayBit);
    }
    mem.dirHeld = awayBit;
    return 0;
  }

  if (!canShield || dodging) {
    // Spot dodge covers frames 3-17, a roll covers 4-19 and relocates, a jump takes us out of a
    // low projectile's line entirely. Mixing between them is what stops the answer being read.
    if (frames >= 3 && frames <= SPOT_DODGE.invEnd - 1 && rand() < 0.34 + 0.24 * prof.mixupRate) {
      return spotDodgeNow(mem);
    }
    if (frames >= ROLL.invStart && frames <= ROLL.invEnd) {
      const inward = wantIn && rand() < 0.4 + 0.6 * prof.adaptRate;
      return rollNow(mem, inward ? towardBit : awayBit);
    }
    if (frames >= 7 && rand() < 0.35 + 0.45 * prof.mixupRate) {
      return armJump(prof, rand, mem, true, wantIn ? towardBit : 0);
    }
    if (!canShield) {
      // Out of shield budget and out of dodges: simply stop being in the line of fire.
      mem.dirHeld = awayBit;
      return 0;
    }
  }
  return holdShield(mem, Math.max(6, Math.min(18, Math.round(frames) + 5)));
}

/**
 * Turns a held approach direction into a dash: the sim only dashes on a second tap of the same
 * direction, so the hold is broken for one decision to produce that tap.
 */
function approachDir(prof: CpuProfile, mem: CpuMem, me: FighterState, dir: number): number {
  if (prof.spacing < STUTTER_SPACING || dir === 0) return dir;
  // Already dashing or running: releasing the direction now skids to a stop, which at a one-frame
  // decision cadence turns the whole approach into a stutter that never travels anywhere.
  if (me.action === 'dash' || me.action === 'run') return dir;
  mem.dashPhase = mem.dashPhase === 0 ? 1 : 0;
  return mem.dashPhase === 1 ? 0 : dir;
}

/**
 * Queues an intentional smash as a release-then-tap so it is never mistaken for a stale hold
 * (which the sim would read as a tilt instead). This call releases the direction; the very next
 * real frame (handled at the top of cpuInput, independent of the decision cadence) presses it
 * fresh alongside Attack, which the sim's smash window (SPEC 4.3) then reads as a smash. Firing
 * on the next real frame rather than the next decision keeps the fighter exposed for only one
 * frame instead of a whole decision period, so a faster opponent can't reliably interrupt it.
 */
function queueSmash(mem: CpuMem, dirBit: number): number {
  mem.smashPending = dirBit;
  mem.dirHeld = 0;
  return 0;
}

/**
 * Smash discipline. An inaccurate CPU throws smashes out more or less at random; an accurate one
 * only commits to 40-odd frames of ending lag when the opponent is at a percent worth killing and
 * is already stuck in something that cannot punish the whiff.
 */
function shouldSmash(prof: CpuProfile, rand: () => number, opp: FighterState, adx: number): boolean {
  if (adx > MY_REACH + 6) return false;
  // Undisciplined levels just throw it out.
  if (rand() < rate(prof, (1 - prof.smashAccuracy) * 0.35)) return true;
  if (opp.percent < 80) return false;
  // The opening has to outlast the smash's own startup, or the smash whiffs into 28 frames of
  // ending lag and hands the opponent the punish instead. A sharper CPU demands a longer one:
  // throwing a 44-frame move into every 18-frame window is how a level 9 spends a whole match
  // in ending lag and loses to a level 5 that simply jabs.
  if (vulnerableFor(opp) < SMASH_STARTUP + 2 + Math.round(6 * prof.smashAccuracy)) return false;
  return rand() < prof.smashAccuracy;
}

/**
 * Survival DI. The sim drives launch velocity directly while hitstun lasts, so the payoff is in
 * the frames right after it: hold away from the blast zone we are closest to (which is the stage
 * centre horizontally), and pulse Down to fast-fall back down through a ceiling-bound launch.
 * The Down pulse is toggled rather than held because fast-fall needs a fresh press, not a hold.
 */
function survivalDi(prof: CpuProfile, rand: () => number, me: FighterState, mem: CpuMem, g: GroundInfo): number {
  mem.dirHeld = 0;
  if (prof.diQuality <= 0 || rand() >= prof.diQuality) return 0;

  const center = (g.minX + g.maxX) / 2;
  let bits = me.x < center ? Btn.Right : Btn.Left;

  const overStage = me.x > g.minX && me.x < g.maxX;
  // Only ever fast-fall over the stage: away from it, cutting the launch short just drops us
  // under the ledge with the recovery still to pay for.
  const ceilingDanger = me.vy < 0 && overStage && (me.y - g.blastTop) < 180;
  const fallBack = me.vy > 0 && !me.fastFalling && overStage && me.y < g.topY - 50;
  if (ceilingDanger || fallBack) {
    mem.ffPhase = mem.ffPhase === 0 ? 1 : 0;
    if (mem.ffPhase === 1) bits |= Btn.Down;
  }
  mem.dirHeld = bits;
  return 0;
}

/**
 * A CPU can't reach an opponent hanging, climbing or rolling off a ledge by walking toward their
 * real (off-stage) position, and must never dash there. Treat the ledge as if the opponent stood
 * 24 px inward, walk over, and stop 30 px short of the edge. Once in range, poke with dtilt, or
 * with an armed forward smash toward the edge when the profile says the read is worth it.
 */
function ledgeApproach(
  prof: CpuProfile, rand: () => number, opp: FighterState, mem: CpuMem, me: FighterState,
  cornerX: number, inward: number,
): number {
  const towardEdgeBit = inward === 1 ? Btn.Left : Btn.Right;
  const stageBit = inward === 1 ? Btn.Right : Btn.Left;
  const distInward = (me.x - cornerX) * inward;

  // Ledge trap standoff. Disciplined profiles wait outside the ledge attack's reach instead of
  // walking into it; the rest still crowd the edge the way they always did.
  const stop = prof.spacing > 0.4 ? LEDGE_TRAP : LEDGE_STOP;
  const backoff = stop - (LEDGE_STOP - LEDGE_BACKOFF);
  if (distInward > stop) {
    mem.dirHeld = towardEdgeBit;
    return 0;
  }
  if (distInward < backoff) {
    mem.dirHeld = stageBit;
    return 0;
  }

  // A hanging opponent is the longest guaranteed opening there is, and their ledge invincibility
  // is exactly the time a charge wants: hold it and let go as they come up.
  if (opp.action === 'ledgeHang' && rand() < prof.smashAccuracy) {
    return chargeSmashFor(prof, rand, mem, SMASH_STARTUP + CHARGE_FRAMES + 2, towardEdgeBit);
  }

  // Cover the get-up options rather than guessing. A ledge roll comes up behind us, which only a
  // down smash covers; a climb comes up in front, into a forward smash.
  if (opp.action === 'ledgeRoll') {
    if (rand() < 0.35 + 0.65 * prof.smashAccuracy) return queueSmash(mem, Btn.Down);
    mem.dirHeld = 0;
    return 0;
  }
  if (opp.action === 'ledgeClimb' && rand() < prof.smashAccuracy) {
    return queueSmash(mem, towardEdgeBit);
  }

  if (opp.percent > 80 && opp.invuln === 0 && rand() < prof.smashAccuracy) {
    return queueSmash(mem, towardEdgeBit);
  }
  return armTilt(mem, Btn.Down);
}

/**
 * Everything that has to hold for a CPU to be allowed to stay off the stage hunting a recovering
 * opponent. Failing any of these drops the edgeguard and hands the frame back to the recovery
 * branch, which is what keeps a level 9 CPU from trading its own stock for the read.
 */
function edgeguardSafe(me: FighterState, opp: FighterState, mem: CpuMem, g: GroundInfo): boolean {
  if (mem.egFrames > EG_MAX_FRAMES) return false;
  if (me.action === 'airHelpless') return false;
  if (!me.onGround && me.jumpsLeft < 1) return false;   // the double jump is the ticket home
  if (me.y > g.topY + EG_MAX_DOWN) return false;
  const outX = me.x < g.minX ? g.minX - me.x : me.x > g.maxX ? me.x - g.maxX : 0;
  if (outX > EG_MAX_OUT) return false;
  if (opp.stocks <= 0 || opp.action === 'dead') return false;
  if (opp.onGround) return false;
  // Opponent already made it back over the stage: nothing left to guard, go home.
  if (opp.x > g.minX && opp.x < g.maxX && opp.y <= g.topY) return false;
  return true;
}

/** True when the opponent is off the stage and low enough to be worth chasing. */
function oppIsRecovering(opp: FighterState, g: GroundInfo): boolean {
  if (opp.onGround) return false;
  if (opp.action === 'dead' || opp.stocks <= 0) return false;
  const outX = opp.x < g.minX ? g.minX - opp.x : opp.x > g.maxX ? opp.x - g.maxX : -1;
  if (outX < 0) return false;
  if (outX > EG_MAX_OUT) return false;
  return opp.y > g.topY - 20 && opp.y < g.topY + EG_MAX_DOWN;
}

/**
 * Off-stage edgeguard. Drifts at the opponent and throws exactly one aerial, then drops the
 * commitment so the very next frame takes the recovery branch home. Never jumps out here: the
 * jumps are reserved for getting back, which edgeguardSafe enforces.
 */
function edgeguardAir(
  prof: CpuProfile, rand: () => number, me: FighterState, opp: FighterState, mem: CpuMem,
): number {
  const dx = opp.x - me.x;
  const dy = opp.y - me.y;
  const adx = Math.abs(dx);
  const towardBit = dx < 0 ? Btn.Left : Btn.Right;

  if (mem.aerialCd === 0 && adx < 42 && Math.abs(dy) < 46 && rand() < 0.5 + 0.5 * prof.edgeguard) {
    mem.aerialCd = AERIAL_COOLDOWN;
    mem.egPhase = 0;                 // hit thrown: bail out and recover
    mem.dirHeld = dy > 24 ? Btn.Down : towardBit;
    return Btn.Attack;
  }
  mem.dirHeld = towardBit;
  return 0;
}

/**
 * The opponent is above us and we are on the ground: juggle them. Startup, vertical reach and
 * sideways span all come out of CHARACTER_DEFS rather than being guessed, and the target is led
 * with their own fall arc so the hitbox is put where they are going to be. Standing under someone
 * doing nothing was the dead zone the owner reported; every branch here either hits or repositions.
 */
function juggle(
  prof: CpuProfile, rand: () => number, me: FighterState, opp: FighterState, mem: CpuMem,
  g: GroundInfo, dy: number, adx: number, towardBit: number,
): number {
  const us = myMove(me, 'usmash');
  const ut = myMove(me, 'utilt');
  const ua = myMove(me, 'uair');
  const skill = prof.juggle;
  const h = hurtHeight(opp);

  // No vertical hitbox reaches sideways, so being under them is the whole prerequisite.
  const usSpan = us === null ? 17 : moveSpan(us) + 12;
  if (adx > Math.max(usSpan, VERT_ALIGN)) {
    mem.dirHeld = towardBit;
    return 0;
  }

  // Highest point anything grounded can touch. Above it there is no grounded answer at all, and
  // pretending otherwise is what left the CPU holding Up at an opponent it could never reach.
  let ceiling = 0;
  if (us !== null) ceiling = moveTop(us);
  if (ut !== null && moveTop(ut) < ceiling) ceiling = moveTop(ut);

  // Charged up smash: they are above us and falling, and their arrival is far enough away to pay
  // for the charge. This is the read the whole juggle exists to set up.
  if (us !== null && adx <= usSpan && Math.abs(opp.vx) < 1.4 &&
      (opp.vy > 0.05 || opp.hitstun > 0)) {
    const eta = framesUntilBand(opp, us, me.y, h, 80);
    if (eta >= SMASH_STARTUP + CHARGE_MIN + 1 && rand() < 0.5 + 0.5 * skill) {
      return chargeSmashFor(prof, rand, mem, eta, Btn.Up);
    }
  }

  // Only lead a target that is actually moving. A stationary opponent is exactly where they are,
  // and leading one anyway throws hitbox after hitbox at air they were never going to be in.
  const moving = opp.vy > 0.05 || opp.hitstun > 0;
  const killing = opp.percent >= KILL_PERCENT;
  const usPdy = us === null ? 0
    : (moving ? predictY(opp, moveStartup(us) + 1) : opp.y) - me.y;

  // Up smash is the kill move and costs 40 frames, so it goes out when there is a stock in it.
  if (us !== null && adx <= usSpan && (killing || opp.hitstun > 0) &&
      bandHits(us, usPdy, h, 0) && rand() < (killing ? 0.55 + 0.45 * skill : 0.3 + 0.5 * skill)) {
    return chargeSmash(prof, rand, mem, opp, Btn.Up, adx);
  }

  // Up tilt: the juggle's bread and butter. Faster, cheaper, and it covers the band a falling
  // opponent drops through on the way down to the smash.
  if (ut !== null && adx <= moveSpan(ut) + 16) {
    const lead = moving ? moveStartup(ut) + 1 : 0;
    const pdy = (lead === 0 ? opp.y : predictY(opp, lead)) - me.y;
    if (bandHits(ut, pdy, h, 2) && rand() < 0.3 + 0.7 * skill) return armTilt(mem, Btn.Up);
  }

  // Too high for the tilt but still inside the smash's taller box: take the smash after all.
  if (us !== null && adx <= usSpan && opp.percent >= 45 && bandHits(us, usPdy, h, 0) &&
      rand() < 0.15 + 0.55 * skill) {
    return chargeSmash(prof, rand, mem, opp, Btn.Up, adx);
  }

  // Above everything grounded: chase with a jumped uair, held through jumpsquat so it is a full
  // hop rather than the short hop a one-frame tap produces. Only with the jumps to come home.
  if (ua !== null && dy < ceiling && mem.aerialCd === 0 && canReturn(me, g) &&
      rand() < 0.15 + 0.85 * skill) {
    mem.uairPhase = UAIR_WINDUP;
    return armJump(prof, rand, mem, true, 0);
  }

  // Nothing connects yet. Stay under them and wait for them to fall into something; never drift.
  mem.dirHeld = adx > 8 ? towardBit : 0;
  return 0;
}

/**
 * We are airborne with the opponent underneath. Either dair them or reclaim the ground: floating
 * over someone with nothing to do is the other half of the dead zone. Off-stage opponents are
 * deliberately not chased from here, so this never fights the edgeguard branch for the frame.
 */
function airVertical(
  prof: CpuProfile, rand: () => number, me: FighterState, opp: FighterState, mem: CpuMem,
  g: GroundInfo, dy: number, adx: number, towardBit: number,
): number {
  const da = myMove(me, 'dair');
  const overStage = me.x > g.minX + 4 && me.x < g.maxX - 4;
  const oppOverStage = opp.x > g.minX && opp.x < g.maxX;

  if (da !== null && mem.aerialCd === 0 && overStage && oppOverStage && canReturn(me, g) &&
      adx <= moveSpan(da) + 12) {
    const lead = moveStartup(da) + 1;
    const pdy = predictY(opp, lead) - predictSelfY(me, lead);
    if (bandHits(da, pdy, hurtHeight(opp), 10) && rand() < 0.25 + 0.75 * prof.juggle) {
      mem.aerialCd = AERIAL_COOLDOWN;
      mem.dirHeld = Btn.Down;
      return Btn.Attack;
    }
  }

  // No hit available: get back to the ground instead of floating. Fast-fall wants a fresh Down
  // press rather than a hold, so the bit is toggled. The further above them we are, the less
  // there is to think about: falling is the only thing that closes the gap.
  let dir = adx > 10 ? towardBit : 0;
  const mustFall = dy > VERT_MIN;
  if (overStage && me.vy > 0 && !me.fastFalling &&
      (mustFall || rand() < 0.3 + 0.7 * prof.juggle)) {
    mem.ffPhase = mem.ffPhase === 0 ? 1 : 0;
    if (mem.ffPhase === 1) dir |= Btn.Down;
  }
  mem.dirHeld = dir;
  return 0;
}

// Grounded fighting: reaction defense, punishes, combos, spacing, approach, attack choice.
function groundFight(
  state: GameState, slot: number, prof: CpuProfile, rand: () => number, me: FighterState,
  opp: FighterState, mem: CpuMem, ground: GroundInfo, dy: number, adx: number,
  towardBit: number, awayBit: number, towardNum: number,
): number {
  const settled = me.hitstun === 0 &&
    (me.action === 'idle' || me.action === 'walk' || me.action === 'dash' ||
     me.action === 'run' || me.action === 'turn' || me.action === 'shield');
  // Zoning read. Alternating two projectile specials is still one plan, so the counter that
  // matters is "committal ranged moves in a row", not "the same move id in a row".
  const spammy = mem.oppShots >= SPAM_REPEATS ||
    (mem.oppRepeat >= SPAM_REPEATS + 2 && adx > THREAT_RANGE);

  // Shield HP budgeting. Holding a shield down to zero is a shield break, and a shield break is
  // 180 stunned frames, i.e. a free stock. Bail out well before that: roll away and reset.
  if (me.action === 'shield' && me.shieldHp <= prof.shieldFloor + SHIELD_RESERVE) {
    return rollNow(mem, awayBit);
  }

  // Punish a dodge. A spot dodge and a roll both end in a window with no invincibility left, and a
  // roll's destination is arithmetic: it travels ROLL.distance px in the direction they held.
  if (settled && (opp.action === 'spotDodge' || opp.action === 'roll') &&
      rand() < prof.punishChance) {
    if (opp.action === 'spotDodge') {
      const left = SPOT_DODGE.total - opp.actionFrame;
      if (adx < MY_REACH && left <= JAB_STARTUP + 2) {
        mem.dirHeld = 0;
        return Btn.Attack;
      }
      mem.dirHeld = adx > MY_REACH - 8 ? towardBit : 0;
      return 0;
    }
    const left = Math.max(0, ROLL.total - opp.actionFrame);
    const destX = opp.x + opp.vx * left;
    const destAdx = Math.abs(destX - me.x);
    // Rolling through us: a forward smash covers one side, a down smash covers both.
    const through = (destX - me.x) * (opp.x - me.x) < 0;
    if (through && destAdx < MY_REACH + 12 && left >= 8 && left <= 16 &&
        rand() < 0.15 + 0.35 * prof.smashAccuracy) {
      return queueSmash(mem, Btn.Down);
    }
    if (destAdx < MY_REACH && left >= SMASH_STARTUP - 4 && left <= SMASH_STARTUP + 3 &&
        opp.percent >= KILL_PERCENT && rand() < prof.smashAccuracy) {
      return queueSmash(mem, destX < me.x ? Btn.Left : Btn.Right);
    }
    if (destAdx < MY_REACH && left <= JAB_STARTUP + 1) {
      mem.dirHeld = 0;
      return Btn.Attack;
    }
    mem.dirHeld = destAdx > 10 ? (destX < me.x ? Btn.Left : Btn.Right) : 0;
    return 0;
  }

  // Whirlpool. 50 frames, four pulling hits and a launching fifth: a stock on a hard read and a
  // free punish on a whiff, so it only ever goes out against someone already stuck for longer
  // than its own wind-up. Checked before the ordinary punishes, which would otherwise always
  // take the frame first.
  if (settled && adx < 30 && Math.abs(dy) < 34 && prof.smashAccuracy > 0.4 &&
      vulnerableFor(opp) >= 22 && rand() < rate(prof, 1.2 * prof.smashAccuracy)) {
    mem.dirHeld = Btn.Down;
    return Btn.Special;
  }

  // Free charge. They cannot act for longer than a charged smash takes to come out, whether that
  // is because they are stuck or simply because they are too far away to arrive in time.
  if (settled && mem.chargeFrames === 0 && mem.chargePending === 0 && prof.smashAccuracy > 0.5 &&
      Math.abs(dy) < 50 && adx < 120) {
    const open = chargeWindow(opp, adx);
    const closing = (opp.x - me.x) * opp.vx < 0 || vulnerableFor(opp) > 0;
    if (open >= SMASH_STARTUP + CHARGE_MIN + 1 && closing &&
        rand() < rate(prof, 5.0 * prof.smashAccuracy)) {
      return chargeSmashFor(prof, rand, mem, open, towardBit);
    }
  }

  // Landing trap. They are in the air and physics says exactly when they come back down, which
  // is the one window where charging a smash costs nothing. Stand under it and hold it.
  if (settled && !opp.onGround && opp.vy > 0.05 && Math.abs(opp.vx) < 2.5 &&
      dy < -20 && adx < 80 && mem.chargeFrames === 0 && mem.chargePending === 0 &&
      opp.percent >= 20 && prof.smashAccuracy > 0.5) {
    const eta = framesUntilLevel(opp, me.y, 80);
    if (eta >= SMASH_STARTUP + CHARGE_MIN + 1 && rand() < rate(prof, 6.0 * prof.smashAccuracy)) {
      if (adx > MY_REACH) {
        mem.dirHeld = safeStep(me, ground, towardBit);   // get under the landing spot first
        return 0;
      }
      return chargeSmashFor(prof, rand, mem, eta, towardBit);
    }
  }

  // Out-of-shield / whiff punish. The opponent's hitboxes are gone and they are still stuck in
  // ending lag inside our range: drop the shield and hit them now.
  if (settled && adx < MY_REACH && Math.abs(dy) < 40 &&
      vulnerableFor(opp) >= JAB_STARTUP + 1 && rand() < prof.punishChance) {
    mem.shieldTimer = 0;
    if (opp.percent > 80 && vulnerableFor(opp) >= SMASH_STARTUP + 2 && rand() < prof.smashAccuracy) {
      return chargeSmash(prof, rand, mem, opp, towardBit, adx);
    }
    mem.dirHeld = 0;
    return Btn.Attack;
  }

  // Beat the wind-up instead of respecting it. Our jab is live on frame 4, so anything slower
  // than that simply loses the race, and shielding it hands back a tempo we had already won.
  if (settled && inStartup(opp) && adx < MY_REACH && Math.abs(dy) < 36 &&
      framesToActive(opp) > JAB_STARTUP + 2 && rand() < prof.punishChance) {
    mem.shieldTimer = 0;
    mem.dirHeld = 0;
    return Btn.Attack;
  }

  // Answer a melee wind-up on reaction. The answer is shield, spot dodge or roll depending on the
  // profile and on how much shield is left; it is never unconditionally shield.
  if (settled && inStartup(opp) && adx < THREAT_RANGE &&
      framesToActive(opp) >= reactFrames(prof) && rand() < prof.shieldChance) {
    return defend(prof, rand, me, mem, ground, framesToActive(opp), SHIELD_COST_MELEE,
                  towardBit, awayBit, false);
  }

  // Answer an inbound projectile. Same reaction gate: it only counts if there is still time to do
  // anything about it. A projectile is dodgeable, and against a spammer the answer that also
  // closes distance is the right one, because their recovery is the punish window.
  if (settled) {
    const inbound = incomingProjectile(state, slot, me);
    if (inbound >= reactFrames(prof) && inbound < 26 && rand() < prof.shieldChance) {
      const wantIn = spammy && rand() < prof.adaptRate;
      return defend(prof, rand, me, mem, ground, inbound, SHIELD_COST_SHOT,
                    towardBit, awayBit, wantIn);
    }
  }

  // Anti-spam. The same move started three times running is a pattern, and a projectile spammer
  // commits to long recovery every single time. Run it down instead of sitting in shield.
  if (settled && spammy && rand() < prof.adaptRate) {
    const open = vulnerableFor(opp);
    if (adx > MY_REACH) {
      mem.spaceTimer = 0;
      if ((me.action === 'dash' || me.action === 'run') && adx < MY_REACH + 30 &&
          me.dirTapDir === towardNum && me.dirTapAge >= turnHoldFrames()) {
        mem.dirHeld = towardBit;
        return Btn.Attack;                       // dash attack straight out of the run-in
      }
      mem.dirHeld = approachDir(prof, mem, me, towardBit);
      return 0;
    }
    if (open >= SMASH_STARTUP + 2 && rand() < prof.smashAccuracy) {
      return chargeSmash(prof, rand, mem, opp, towardBit, adx);
    }
    mem.dirHeld = 0;
    return Btn.Attack;
  }

  // Whiff punish from range: a long opening (a missed smash, a projectile's recovery) is worth
  // running at, not just worth answering when it happens to be in jab range.
  if (settled && adx <= 120 && adx > MY_REACH && vulnerableFor(opp) >= 18 &&
      Math.abs(dy) < 50 && rand() < prof.punishChance) {
    mem.spaceTimer = 0;
    mem.dirHeld = approachDir(prof, mem, me, towardBit);
    return 0;
  }

  // Combo follow-up: the opponent is still in hitstun and reachable, so keep hitting instead of
  // resetting to neutral.
  if (opp.hitstun > 0 && rand() < prof.comboChance) {
    if (dy < -40 && adx < 44) {
      if (mem.aerialCd === 0 && rand() < prof.comboChance) {
        mem.uairPhase = UAIR_WINDUP;
        return armJump(prof, rand, mem, true, 0);
      }
      mem.dirHeld = Btn.Up;
      if (mem.vertBit === Btn.Up && mem.vertFrames >= turnHoldFrames()) return Btn.Attack;
      return 0;
    }
    if (adx < MY_REACH) {
      if (shouldSmash(prof, rand, opp, adx)) return queueSmash(mem, towardBit);
      mem.dirHeld = 0;
      return Btn.Attack;
    }
    mem.dirHeld = towardBit;
    return 0;
  }

  // Platform drop-through. Standing on a pass-through platform with the opponent underneath, the
  // fastest way down is straight through the floor; Down has to be a fresh press, so it toggles.
  if (dy > 30 && me.buffer.btn === 0 && onSoftPlatform(state, me) &&
      rand() < 0.25 + 0.75 * prof.juggle) {
    mem.dropPhase = mem.dropPhase === 0 ? 1 : 0;
    mem.dirHeld = mem.dropPhase === 1 ? Btn.Down : 0;
    return 0;
  }

  // Opponent is overhead. Weak CPUs still jump at them with no plan; from there up it is a real
  // juggle read off our own frame data, with their fall arc led.
  if (dy < -VERT_MIN) {
    if (prof.juggle < JUGGLE_MIN || rand() > 0.15 + 0.85 * prof.juggle) {
      if (adx > VERT_ALIGN) { mem.dirHeld = towardBit; return 0; }
      return armJump(prof, rand, mem, true, 0);
    }
    return juggle(prof, rand, me, opp, mem, ground, dy, adx, towardBit);
  }

  // Spacing / dash-dance: hover just outside the opponent's reach rather than walking into it,
  // and step back the moment they start something. Bounded by SPACING_PATIENCE so hovering is a
  // phase of the approach and not a substitute for one.
  const inBand = adx > SPACING_MIN && adx < SPACING_MAX;
  if (!inBand) mem.spaceTimer = 0;
  else if (mem.spaceTimer < 1000) mem.spaceTimer += prof.period;
  if (inBand && mem.spaceTimer <= SPACING_PATIENCE && opp.hitstun === 0 &&
      me.x > ground.minX + 34 && me.x < ground.maxX - 34 && rand() < prof.spacing) {
    if (inStartup(opp)) {
      mem.dirHeld = awayBit;
      return 0;
    }
    // Retreating back air. Jump while still facing them, then hold away in the air: the sim reads
    // a direction opposite to `facing` as a bair, which is 28 frames against fair's 30 and the
    // strongest spacing tool in the genre. Core neutral from the middle levels up.
    if (mem.aerialCd === 0 && me.facing === towardNum && canReturn(me, ground) &&
        safeStep(me, ground, awayBit) !== 0 &&
        rand() < rate(prof, 0.6 * prof.bairRate)) {
      mem.bairPhase = BAIR_WINDUP;
      // A retreating bair wants the short hop: 28 frames of bair out of a low, fast jump.
      return armJump(prof, rand, mem, false, 0);
    }
    if (mem.danceTimer > 0) {
      mem.dirHeld = mem.dancePhase === 1 ? towardBit : awayBit;
      return 0;
    }
    mem.danceTimer = DANCE_HOLD;
    mem.dancePhase = mem.dancePhase === 1 ? 0 : 1;
    mem.dirHeld = mem.dancePhase === 1 ? towardBit : awayBit;
    return 0;
  }

  if (adx > MY_REACH) {
    // Dash attack: Attack while a dash or run is already under way. Converts the approach itself
    // into a hit rather than stopping dead at the edge of range.
    if ((me.action === 'dash' || me.action === 'run') && adx < MY_REACH + 30 &&
        Math.abs(dy) < 40 && me.dirTapDir === towardNum && me.dirTapAge >= turnHoldFrames() &&
        (vulnerableFor(opp) >= 8 || opp.hitstun > 0 || adx < MY_REACH + 12) &&
        rand() < 0.1 + 0.4 * prof.punishChance) {
      mem.dirHeld = towardBit;
      return Btn.Attack;
    }
    // Side special pierces and lives 45 frames: the kit's real zoning tool. Thrown from outside
    // the dash-dance band, where its own 42 frames cannot be walked through and punished.
    if (adx > SPACING_MAX && adx < 220 && Math.abs(dy) < 60 && vulnerableFor(opp) === 0 &&
        !inStartup(opp) && rand() < rate(prof, 0.45 * prof.spacing)) {
      mem.dirHeld = towardBit;
      return Btn.Special;
    }
    if (adx <= MID_RANGE_MAX && adx >= MID_RANGE_MIN &&
        rand() < rate(prof, 0.10 + 0.25 * (1 - prof.spacing))) {
      mem.dirHeld = 0;
      return Btn.Special;
    }
    let dir = towardBit;
    let pulse = 0;
    const blockedLeft = dir === Btn.Left && me.x - ground.minX < 12 && opp.x >= ground.minX;
    const blockedRight = dir === Btn.Right && ground.maxX - me.x < 12 && opp.x <= ground.maxX;
    if (blockedLeft || blockedRight) {
      dir = 0;
      if (adx < 140 && rand() < 0.3 + 0.7 * prof.spacing) pulse |= Btn.Jump;
    }
    if (adx <= 90 && dir !== 0 && rand() < rate(prof, 0.02 * (1 - prof.spacing))) pulse |= Btn.Special;
    if (adx > 90) dir = approachDir(prof, mem, me, dir);
    mem.dirHeld = dir;
    return pulse;
  }

  // Close range: choose an attack, weighted by the profile. A tilt only fires once the held
  // direction has aged past the smash window (fix for the turn-around-produces-a-smash bug); an
  // intentional smash instead goes through queueSmash so it is a genuine fresh tap regardless.
  const staleTap = me.dirTapDir === towardNum && me.dirTapAge >= turnHoldFrames();

  // Down tilt: a low, fast poke that comes out in 5 frames and recovers in 22. The held Down has
  // to age past the smash window, or the sim reads Down plus Attack as a down smash instead.
  if (opp.percent < KILL_PERCENT && dy > -12 && prof.spacing >= SPACING_MIN_SKILL &&
      rand() < 0.05 + 0.12 * prof.spacing) {
    return armTilt(mem, Btn.Down);
  }

  // They got behind us. A forward smash only covers one side; a down smash covers both. Still 42
  // frames of commitment, so it wants a real opening rather than every frame we are turned around.
  if (me.facing !== towardNum && prof.smashAccuracy >= 0.3 &&
      vulnerableFor(opp) >= SMASH_STARTUP + CHARGE_MIN + 2 &&
      rand() < 0.04 + 0.12 * prof.smashAccuracy) {
    return chargeSmash(prof, rand, mem, opp, Btn.Down, adx);
  }

  // Kill confirm: at kill percent take the move that actually kills from this position rather
  // than whichever smash the dice pick. Up smash under a high opponent, forward smash toward a
  // near blast line; anything else is damage the opponent gets to keep playing after.
  if (opp.percent >= KILL_PERCENT && vulnerableFor(opp) >= SMASH_STARTUP + CHARGE_MIN + 1 &&
      rand() < prof.smashAccuracy) {
    if (dy < -24 && adx < 22) return chargeSmash(prof, rand, mem, opp, Btn.Up, adx);
    const edgeDist = Math.min(Math.abs(opp.x - ground.minX), Math.abs(opp.x - ground.maxX));
    if (edgeDist < 90) return chargeSmash(prof, rand, mem, opp, towardBit, adx);
  }

  if (shouldSmash(prof, rand, opp, adx)) return chargeSmash(prof, rand, mem, opp, towardBit, adx);

  // Sharper CPUs lean on the fast neutral jab; slower ones lumber in with a tilt.
  if (rand() < 0.25 + 0.35 * prof.punishChance) {
    mem.dirHeld = 0;
    return Btn.Attack;
  }
  mem.dirHeld = towardBit;
  return staleTap ? Btn.Attack : 0;
}

// Airborne fighting: follow-up uair, drift toward, fair/bair, occasional dair, fast fall.
// Every aerial attack start sets a cooldown so the slot cannot spam aerials (fix #3).
function airFight(
  prof: CpuProfile, rand: () => number, me: FighterState, opp: FighterState, mem: CpuMem,
  ground: GroundInfo, dy: number, adx: number, towardBit: number, awayBit: number, towardNum: number,
): number {
  // Armed uair chase. The hit is thrown on the frame their predicted body is actually inside the
  // hitbox, and the double jump is spent to get there when the first jump was not enough.
  if (mem.uairPhase > 0) {
    const ua = myMove(me, 'uair');
    if (ua === null || mem.aerialCd > 0) {
      mem.uairPhase = 0;
      mem.dirHeld = towardBit;
      return 0;
    }
    const lead = moveStartup(ua) + 1;
    const pdy = predictY(opp, lead) - predictSelfY(me, lead);
    // Tight tolerance on purpose: a generous pad fires the uair the moment the opponent is
    // merely near the band, which at a big vertical gap means throwing it on the way up from
    // far below and watching it whiff.
    if (bandHits(ua, pdy, hurtHeight(opp), 2)) {
      mem.uairPhase = 0;
      mem.dirHeld = Btn.Up;
      mem.aerialCd = AERIAL_COOLDOWN;
      return Btn.Attack;
    }
    const overStage = me.x > ground.minX + 8 && me.x < ground.maxX - 8;
    if (pdy < moveTop(ua) && me.jumpsLeft > 0 && me.vy > -1.2 && overStage && canReturn(me, ground)) {
      // A double jump needs a fresh press, so release for one frame if Jump is still held.
      if ((mem.prevHeld & Btn.Jump) !== 0) {
        mem.jumpHold = 0;
        mem.dirHeld = 0;
        return 0;
      }
      return armJump(prof, rand, mem, true, adx > 12 ? towardBit : 0);
    }
    if (me.vy > 1.5 || pdy > moveBottom(ua) + 24) mem.uairPhase = 0;
    mem.dirHeld = adx > 12 ? towardBit : 0;
    return 0;
  }

  // Retreating bair. We jumped without turning, so we are still facing them: a direction held the
  // other way is read by the sim as a back air while the drift carries us out of their range.
  if (mem.bairPhase > 0) {
    mem.bairPhase = 0;
    mem.dirHeld = awayBit;
    if (mem.aerialCd === 0 && canReturn(me, ground)) {
      mem.aerialCd = AERIAL_COOLDOWN;
      return Btn.Attack;
    }
    return 0;
  }

  if (me.hitstun > 0) { mem.dirHeld = 0; return 0; }

  // Air dodge an anti-air on reaction: 25 invincible frames beats eating the hit, and the held
  // direction gives it momentum. Only from somewhere we can still get home from.
  if (mem.dodgeCd === 0 && inStartup(opp) && adx < THREAT_RANGE + 18 && Math.abs(dy) < 76 &&
      framesToActive(opp) >= reactFrames(prof) && airDodgeSafe(me, ground) &&
      canReturn(me, ground) && rand() < prof.dodgeSkill) {
    return airDodgeNow(mem, dy > 0 ? awayBit : towardBit);
  }

  // Opponent underneath: dair or reclaim the ground. Off-stage opponents were already handed to
  // the edgeguard and recovery branches upstream, so this never fights them for the frame.
  if (dy > AIR_BELOW_MIN) {
    return airVertical(prof, rand, me, opp, mem, ground, dy, adx, towardBit);
  }

  let dir = towardBit;
  let pulse = 0;
  const ady = Math.abs(dy);

  if (mem.aerialCd === 0) {
    if (adx < 40 && ady < 40) {
      // Any aerial thrown with a direction held opposite to `facing` is a back air. That is a
      // deliberate option, not an accident: unless the profile actually wants the bair, hold
      // nothing and take the neutral air instead.
      if (me.facing !== towardNum && rand() >= prof.bairRate) dir = 0;
      pulse |= Btn.Attack;
      mem.aerialCd = AERIAL_COOLDOWN;
    } else if (dy > 30 && dy < 90 && rand() < rate(prof, 0.25 * prof.comboChance)) {
      dir |= Btn.Down;
      pulse |= Btn.Attack;
      mem.aerialCd = AERIAL_COOLDOWN;
    }
  }

  if (me.vy > 0) {
    const aboveStage = me.x > ground.minX && me.x < ground.maxX;
    if (dy > 100 && aboveStage) dir |= Btn.Down;
  }

  mem.dirHeld = dir;
  return pulse;
}

// Recovery, ledge climb, opponent-on-ledge targeting, edgeguarding, and dispatch into grounded /
// airborne fighting. Returns a one-frame button pulse; persistent movement/hold bits are written
// into mem.dirHeld.
function decide(state: GameState, slot: number, prof: CpuProfile, rand: () => number, me: FighterState, mem: CpuMem): number {
  const opp = nearestOpponent(state, slot, me);
  const ground = getGround(state.stageId);

  // Being launched: survival DI comes before everything else, there is nothing else to do.
  if (me.hitstun > 0 || me.action === 'hitstun') {
    mem.egPhase = 0;
    return survivalDi(prof, rand, me, mem, ground);
  }

  // Tumble ends only when the victim presses something (sim: stepHitstun). Left alone, a launched
  // fighter rides the tumble all the way to the bottom blast line with its double jump and its
  // up-special still in its pocket, which is exactly how this CPU was losing stocks it had won.
  // The sim clears the buffer on the way out, so the press costs nothing.
  if (me.action === 'tumble') {
    mem.egPhase = 0;
    survivalDi(prof, rand, me, mem, ground);
    return Btn.Jump;
  }

  if (me.action === 'ledgeHang') {
    mem.dirHeld = 0;
    mem.egPhase = 0;
    if (me.actionFrame > 12) {
      // Mix the get-up options: a ledge attack has 18 invincible frames and a hitbox, a plain
      // climb is fast. Sitting on one answer is what a human learns to camp.
      const foe = nearestOpponent(state, slot, me);
      const close = foe !== null && Math.abs(foe.x - me.x) < 70;
      if (rand() < (close ? 0.8 : 0.4) * prof.punishChance) return Btn.Attack;
      return Btn.Up;
    }
    return 0;
  }

  // 'land' is a brief transient the physics step can still bounce back out of (an edge, a
  // pass-through platform) before a buffered Attack from here is consumed. The sim resolves a
  // buffered attack against whatever action is current *then*, not when it was pressed, so an
  // Attack buffered while grounded here can still resolve as an aerial later and dodge every
  // aerial-cooldown check below. Simplest fix: never press anything while landing; the next
  // decision, at most a handful of frames later, sees a settled action instead.
  if (me.action === 'land') { mem.dirHeld = 0; return 0; }

  const airborne = !me.onGround;
  const offSide = me.x < ground.minX || me.x > ground.maxX;
  const belowMain = airborne && me.y > ground.topY + 40;
  if (offSide || belowMain) {
    // A committed edgeguard may keep us out here, but only while every safety margin holds.
    if (mem.egPhase === 1 && opp !== null && edgeguardSafe(me, opp, mem, ground)) {
      return edgeguardAir(prof, rand, me, opp, mem);
    }
    mem.egPhase = 0;
    mem.uairPhase = 0;
    mem.bairPhase = 0;
    const center = (ground.minX + ground.maxX) / 2;
    mem.dirHeld = me.x < center ? Btn.Right : Btn.Left;
    // Below the stage lip is already late: jump now rather than waiting to be sure we are falling.
    const low = me.y > ground.topY - 4;
    if (me.jumpsLeft > 0 && (me.vy > 0.5 || low) && me.action === 'air') return Btn.Jump;
    if (me.jumpsLeft === 0 && me.vy > 0 && me.action === 'air') return Btn.Special | Btn.Up;
    return 0;
  }

  // Recovery above runs with or without a live opponent; there is nothing left
  // to chase once every other fighter is out or waiting to respawn.
  if (!opp) { mem.dirHeld = 0; mem.egPhase = 0; return 0; }

  if (me.onGround && opp.ledge >= 0 &&
      (opp.action === 'ledgeHang' || opp.action === 'ledgeClimb' || opp.action === 'ledgeRoll')) {
    const stage = STAGE_DEFS[state.stageId];
    const pi = opp.ledge >> 1;
    const p = stage ? stage.platforms[pi] : undefined;
    if (p) {
      const side = opp.ledge & 1;
      const cornerX = side === 0 ? p.x : p.x + p.w;
      const inward = side === 0 ? 1 : -1;
      mem.egPhase = 0;
      return ledgeApproach(prof, rand, opp, mem, me, cornerX, inward);
    }
  }

  const dx = opp.x - me.x;
  const dy = opp.y - me.y;
  const adx = Math.abs(dx);
  const towardBit = dx < 0 ? Btn.Left : Btn.Right;
  const awayBit = dx < 0 ? Btn.Right : Btn.Left;
  const towardNum = dx < 0 ? -1 : 1;

  // Commit to going off-stage after a recovering opponent. Only from a safe position, only with
  // the jumps still in hand, and the commitment is re-checked every frame from here on.
  if (prof.edgeguard > 0 && mem.egPhase === 0 && oppIsRecovering(opp, ground) &&
      me.jumpsLeft >= 1 && me.percent < 90 && me.y <= ground.topY + 8 &&
      rand() < prof.edgeguard) {
    mem.egPhase = 1;
    mem.egFrames = 0;
  }
  if (mem.egPhase === 1) {
    if (!edgeguardSafe(me, opp, mem, ground)) {
      mem.egPhase = 0;
    } else {
      const corner = opp.x < 0 ? ground.minX : ground.maxX;
      mem.dirHeld = towardBit;
      // Walk off toward a low opponent; hop out to meet one still near stage level.
      if (me.onGround && Math.abs(me.x - corner) < 26 && opp.y < ground.topY + 8) return Btn.Jump;
      return 0;
    }
  }

  // A committed tilt owns its frames: the hold has to age past the smash window uninterrupted.
  if (mem.tiltFrames > 0) {
    mem.tiltFrames--;
    if (me.onGround && me.hitstun === 0) {
      mem.dirHeld = mem.tiltBit;
      if (mem.vertBit === mem.tiltBit && mem.vertFrames >= turnHoldFrames()) {
        mem.tiltFrames = 0;
        return Btn.Attack;
      }
      return 0;
    }
    mem.tiltFrames = 0;
  }

  // A queued aerial owns the jumpsquat frames: nothing else may spend them, and Jump has to stay
  // held through them or an intended full hop silently becomes a short hop.
  if ((mem.bairPhase > 0 || mem.uairPhase > 0) && me.onGround) {
    if (me.action !== 'jumpsquat' && mem.uairPhase > 0 && mem.uairPhase < UAIR_WINDUP - 4) {
      mem.uairPhase = 0;      // landed without ever throwing it: think again
    }
    mem.dirHeld = 0;
    return 0;
  }

  // Anti-stall. Nothing has moved and nothing has been damaged for long enough that whatever plan
  // is in play is not a plan. Stop deliberating and commit, so a stalemate can never soft-lock.
  if (mem.forceFrames > 0) {
    // Always actually relocate: step off the spot for the first half, come back for the second.
    // A commitment that leaves the CPU standing where it was is not a commitment.
    const out = mem.forceFrames > STALL_COMMIT / 2;
    let bit = out ? awayBit : towardBit;
    // Committing is not an excuse to walk off the stage.
    if (bit === Btn.Left && me.x < ground.minX + 40) bit = Btn.Right;
    else if (bit === Btn.Right && me.x > ground.maxX - 40) bit = Btn.Left;
    if (!me.onGround) {
      mem.dirHeld = bit;
      return 0;
    }
    if (mem.forceMode === 2 && !out && me.action !== 'jumpsquat') {
      return armJump(prof, rand, mem, true, towardBit);
    }
    mem.dirHeld = mem.forceMode === 3 ? approachDir(prof, mem, me, bit) : bit;
    return 0;
  }

  if (me.onGround) {
    return groundFight(state, slot, prof, rand, me, opp, mem, ground, dy, adx, towardBit, awayBit, towardNum);
  }
  return airFight(prof, rand, me, opp, mem, ground, dy, adx, towardBit, awayBit, towardNum);
}

export function cpuInput(state: GameState, slot: number, level: number, rand: () => number): InputFrame {
  const frame = inputFrames[slot];
  const mem = memSlots[slot];
  const me = fighterBySlot(state, slot);
  const prof = profileFor(level);

  // New match: a different seed, or a frame counter that jumped backwards further than any
  // plausible rollback. Scratch from the previous match would otherwise make an identical seed
  // replay differently, which breaks both replays and any future rollback netcode.
  if (mem.matchRef !== null &&
      (state.config !== mem.matchRef || state.frame + MATCH_RESET_SLACK < mem.matchFrame)) {
    initMem(mem);
  }
  mem.matchRef = state.config;
  mem.matchFrame = state.frame;

  if (me && me.hitstun === 0 && mem.shieldTimer > 0) mem.shieldTimer--;
  else mem.shieldTimer = 0;
  if (mem.shieldTimer === 0) mem.dodgeIntent = 0;

  if (mem.dodgeCd > 0) mem.dodgeCd--;
  if (mem.jumpHold > 0) mem.jumpHold--;
  if (me === null || me.action === 'dead') { mem.chargeFrames = 0; mem.chargePending = 0; }
  if (mem.forceFrames > 0) mem.forceFrames--;
  // Hitlag freezes the fighter without freezing this function, so ticking the gate through it
  // would let the next aerial come out while the last one is still on screen.
  if (mem.aerialCd > 0 && (me === null || me.hitlag === 0)) mem.aerialCd--;
  // Arm the gate from what the sim actually started, not only from what we intended: an Attack
  // pressed on the ground can still resolve as an aerial a few frames later.
  const curMove = me === null ? null : me.action === 'attack' ? me.moveId : null;
  if (curMove !== null && curMove !== mem.prevMove && AERIAL_IDS[curMove] === true) {
    mem.aerialCd = AERIAL_COOLDOWN;
    mem.lastAerial = state.frame;
  }
  // The countdown can be shortened by hitlag bookkeeping or by an attack that only resolved as an
  // aerial later; the sim's own frame number cannot. Never let the gate read as open before it is.
  const sinceAerial = state.frame - mem.lastAerial;
  if (sinceAerial < AERIAL_COOLDOWN && AERIAL_COOLDOWN - sinceAerial > mem.aerialCd) {
    mem.aerialCd = AERIAL_COOLDOWN - sinceAerial;
  }
  mem.prevMove = curMove;
  if (mem.danceTimer > 0) mem.danceTimer--;
  if (mem.egPhase === 1) mem.egFrames++;
  else mem.egFrames = 0;

  if (me === null || me.hitstun > 0 || me.action === 'dead') { mem.bairPhase = 0; mem.uairPhase = 0; }
  else {
    if (mem.bairPhase > 0 && me.onGround) mem.bairPhase--;
    if (mem.uairPhase > 0) mem.uairPhase--;
  }
  if (mem.oppShotAge < 600) mem.oppShotAge++;
  // The read decays rather than resetting: an opponent who mixes one poke into a wall of
  // projectiles is still zoning, and resetting on every other move meant the read never fired.
  if (mem.oppShotAge > SPAM_MEMORY) {
    if (mem.oppShots > 0) mem.oppShots--;
    mem.oppShotAge = 0;
  }

  if (me !== null && me.action !== 'dead' && me.stocks > 0) {
    const foe = nearestOpponent(state, slot, me);

    // Pattern reading: remember what the opponent *started*, not what they are in the middle of,
    // so three neutral specials in a row read as one pattern rather than 120 frames of noise.
    // Zoning is tracked separately by category, because alternating two projectiles is still one
    // plan even though no single move id repeats.
    const started = foe !== null && foe.action === 'attack' ? foe.moveId : null;
    if (started !== null && started !== mem.oppMove && foe !== null) {
      const def = CHARACTER_DEFS[foe.charId];
      const mv = def ? def.moves[started] : undefined;
      const committal = mv !== undefined && mv.totalFrames >= COMMITTAL_FRAMES;
      const ranged = committal && mv.projectiles !== undefined && mv.projectiles.length > 0;
      mem.oppRepeat = started === mem.oppStarted && committal ? Math.min(99, mem.oppRepeat + 1) : 1;
      mem.oppStarted = started;
      if (ranged) { mem.oppShots = Math.min(9, mem.oppShots + 1); mem.oppShotAge = 0; }
    }
    mem.oppMove = started;

    // A grounded attack is only resolved when its buffer is spent, and a hit that launches us
    // first turns it into an aerial, slipping one past the aerial gate entirely. While the gate
    // is up, do not throw one anywhere a hit could land inside the buffer window.
    mem.attackLock = 0;
    if (mem.aerialCd > 0 && me.onGround) {
      const threat = foe !== null && Math.abs(foe.x - me.x) < THREAT_RANGE + 12 &&
        activeMove(foe) !== null && framesToActive(foe) <= 8;
      const shot = incomingProjectile(state, slot, me);
      if (threat || (shot >= 0 && shot <= 10)) mem.attackLock = 1;
    }

    // Anti-stall bookkeeping. Horizontal displacement and total damage on the stage, sampled on a
    // window, so a dash-dance that ends where it started still reads as going nowhere.
    let damage = me.percent;
    for (let i = 0; i < state.fighters.length; i++) {
      if (state.fighters[i].slot !== slot) damage += state.fighters[i].percent;
    }
    mem.stallSample++;
    if (mem.stallSample >= STALL_SAMPLE) {
      const progressed = Math.abs(me.x - mem.sampleX) > STALL_MOVE || damage > mem.sampleDamage + 0.01;
      mem.stallFrames = progressed ? 0 : mem.stallFrames + mem.stallSample;
      mem.stallSample = 0;
      mem.sampleX = me.x;
      mem.sampleY = me.y;
      mem.sampleDamage = damage;
    }
    if (mem.stallFrames >= STALL_LIMIT && mem.forceFrames === 0) {
      mem.stallFrames = 0;
      mem.forceFrames = STALL_COMMIT;
      mem.forceMode = 1 + Math.min(2, Math.floor(rand() * 3));
    }
  } else {
    mem.stallFrames = 0;
    mem.stallSample = 0;
    mem.forceFrames = 0;
    mem.oppRepeat = 0;
    mem.oppShots = 0;
    mem.oppMove = null;
    mem.oppStarted = null;
  }

  const curVert = mem.dirHeld & (Btn.Up | Btn.Down);
  if (curVert !== 0 && curVert === mem.vertBit) mem.vertFrames++;
  else { mem.vertBit = curVert; mem.vertFrames = curVert !== 0 ? 1 : 0; }

  // The gate as it stood before this frame's decision. The decision itself arms it when it
  // throws an aerial, so reading it afterwards would veto that aerial on the spot.
  const gateBefore = mem.aerialCd;

  let pulse = 0;
  if (!me || me.action === 'dead' || me.stocks <= 0) {
    mem.dirHeld = 0;
    mem.cooldown = 0;
    mem.smashPending = 0;
    mem.egPhase = 0;
  } else if (mem.smashPending !== 0) {
    // A smash was queued last frame (direction released that frame); pressing it fresh now,
    // alongside Attack, lands inside the sim's smash window. This bypasses the normal decision
    // cadence entirely so the fighter is only exposed for the one frame in between.
    mem.dirHeld = mem.smashPending;
    pulse = Btn.Attack;
    mem.smashPending = 0;
    mem.chargeFrames = mem.chargePending;
    mem.chargePending = 0;
  } else if (mem.cooldown > 0) {
    mem.cooldown--;
  } else {
    mem.cooldown = prof.period - 1;
    // A thrown-away decision is what makes a low level feel human-bad: the CPU just stands there
    // for a beat. Never thrown away while off-stage or falling below it, because idling there is
    // a self-destruct rather than a mistake.
    const g = getGround(state.stageId);
    const safeToIdle = me.onGround ||
      (me.x > g.minX && me.x < g.maxX && me.y < g.topY + 40 && me.hitstun === 0);
    if (safeToIdle && prof.missChance > 0 && rand() < prof.missChance) {
      mem.dirHeld = 0;
      mem.egPhase = 0;
    } else {
      pulse = decide(state, slot, prof, rand, me, mem);
    }
  }

  let held = mem.dirHeld | pulse;
  // A held Jump through jumpsquat is what makes a jump a full hop; a held Attack on a smash's
  // first frame is what makes it a charged smash. Both are holds, not extra presses.
  if (mem.jumpHold > 0) held |= Btn.Jump;
  if (mem.chargeFrames > 0) {
    held |= Btn.Attack;
    mem.chargeFrames--;
  }
  // An Attack pressed while grounded is only resolved when the buffer is spent, which may be
  // after a walk-off, a platform drop or a bump into the air. While the aerial gate is up, never
  // let one out from anywhere the fighter could be airborne by then.
  if (gateBefore > 0 && mem.chargeFrames === 0 && me !== null && me.onGround &&
      (held & Btn.Attack) !== 0) {
    const edge = getGround(state.stageId);
    if (mem.attackLock === 1 || me.x < edge.minX + 24 || me.x > edge.maxX - 24 ||
        onSoftPlatform(state, me)) {
      held &= ~Btn.Attack;
    }
  }
  if (mem.shieldTimer > 0) {
    held |= Btn.Shield;
    // A plain block has to stay a plain block: the sim turns a direction held under Shield into a
    // roll and Down into a spot dodge, so a stale movement bit would silently become a dodge.
    if (mem.dodgeIntent === 0) held &= ~(Btn.Left | Btn.Right | Btn.Down);
  }

  frame.pressed = held & ~mem.prevHeld;
  frame.released = mem.prevHeld & ~held;
  frame.held = held;
  mem.prevHeld = held;
  return frame;
}
