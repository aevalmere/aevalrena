import type {
  CharacterDef, FighterState, GameState, GrabKit, InputFrame, MatchConfig, MoveDef, MoveId, ProjectileDef,
  ProjectileState, Rect,
} from '../core/types';
import { Btn, DIRECT_CODES, MAX_PLAYERS } from '../core/types';
import { FOOTSTOOL, FS_METER, KNOCKDOWN, ROLL, SPOT_DODGE, TECH, TUNING } from '../core/constants';
import { circleRectOverlap } from '../core/math';
import { STAGE_DEFS } from '../stages/registry';
import { CHARACTER_DEFS } from '../characters/registry';
import { DEFAULT_GRAB_KIT, grabKitOf } from '../characters/common/grabkit';
import { isLowHit } from '../sim/dodge';
import { canFinalSmash } from '../sim/finalsmash';
import { canBeHit, projectileChargePower, projectileChargeScale } from '../sim/hits';
import { isLedgeAction } from '../sim/ledge';
import { PROJECTILE_DEFS } from '../sim/projectiles';
import { fighterHurtbox, sameTeam, type SimFighter } from '../sim/state';
import { aevalmereInput, warmAevalmere } from './aevalmere';

export { warmAevalmere };

// Per-slot scratch state. Preallocated once; cpuInput only mutates these, never allocates.
interface CpuMem {
  prevHeld: number;
  dirHeld: number;      // persistent movement/hold bits carried between decisions
  cooldown: number;     // raw frames left before the next decision
  shieldTimer: number;  // raw frames left forcing Shield held (reaction defense)
  aerialCd: number;     // real frames left before another aerial attack from this slot
  lastAerial: number;   // sim frame the last aerial actually started on, or a far-past sentinel
  uairPhase: number;   // 0 idle, 1 = jumped intending to follow up with uair
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
  attackLock: number;  // 1 while a grounded Attack could be launched into an aerial before it resolves
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
  orbHold: number;      // real frames Special stays held to charge a neutral-special orb
  jabPending: number;   // 1 = an Attack held back off a dash/run, pressed next frame so it is not a dash attack

  // --- double-tap guard: sim frames of the last press of each direction, mirroring the sim's tap timers ---
  lastLeftPress: number;
  lastRightPress: number;
  lastUpPress: number;
  lastDownPress: number;
  intendedRolls: number; // debug: grounded Dodge presses with a direction held, i.e. rolls asked for on purpose

  // --- grabs ---
  pummelGoal: number;   // pummels wanted in the current hold, -1 until the hold is first seen
  pummels: number;      // pummels already pressed in the current hold
  mashLast: number;     // bit pressed on the last mash frame, so the next one is a different, fresh press

  // --- projectile counter ---
  counterWait: number;  // real frames a fired counter-shot's press is protected until its move starts

  // --- techs, knockdowns and footstools ---
  techPlan: number;     // TECH_UNROLLED / TECH_ARMED / TECH_DECLINED / TECH_PRESSED for the current airtime
  techDir: number;      // Btn.Left or Btn.Right held into the landing for a tech roll, 0 in place
  techAge: number;      // real frames since the tech press, so a window that closed in the air is re-thought
  downWait: number;     // real frames left lying downed before a get-up option, -1 until picked
  stoolRolled: number;  // 1 once the current footstool opportunity has been rolled for

  // --- Final Smash ---
  fsDelay: number;      // real frames left before a full meter is spent, -1 until it is seen full
  fsWait: number;       // real frames a ready Final Smash has been held for an invulnerable opponent

  // --- level 0 wandering, used only by dummyInput under the cpuZeroMoves rule ---
  wanderMode: number;   // WANDER_STAND / WANDER_WALK / WANDER_RUN / WANDER_JUMP
  wanderDir: number;    // -1 or 1, the way the current walk or run is heading
  wanderTimer: number;  // frames left on the current plan, 0 = pick a new one
  wanderJumpCd: number; // frames until another recovery jump is allowed
}

/**
 * The one place a CpuMem's initial values are written. Both the preallocation loop and resetCpu
 * go through it, so the two can never drift apart and leave a field un-reset.
 */
function initMem(mem: CpuMem): void {
  mem.prevHeld = 0; mem.dirHeld = 0; mem.cooldown = 0; mem.shieldTimer = 0; mem.aerialCd = 0;
  mem.lastAerial = -99999;
  mem.uairPhase = 0; mem.vertBit = 0; mem.vertFrames = 0; mem.smashPending = 0;
  mem.egPhase = 0; mem.egFrames = 0; mem.ffPhase = 0; mem.dancePhase = 0; mem.danceTimer = 0;
  mem.spaceTimer = 0; mem.prevMove = null;
  mem.stallFrames = 0; mem.stallSample = 0; mem.sampleX = 0; mem.sampleY = 0; mem.sampleDamage = 0;
  mem.forceMode = 0; mem.forceFrames = 0;
  mem.dodgeCd = 0; mem.attackLock = 0; mem.oppMove = null; mem.oppStarted = null; mem.oppRepeat = 0;
  mem.oppShots = 0; mem.oppShotAge = 0;
  mem.tiltBit = 0; mem.tiltFrames = 0;
  mem.bairPhase = 0;
  mem.matchRef = null; mem.matchFrame = -1;
  mem.jumpHold = 0; mem.chargePending = 0; mem.chargeFrames = 0; mem.dropPhase = 0;
  mem.orbHold = 0; mem.jabPending = 0;
  mem.lastLeftPress = -99999; mem.lastRightPress = -99999; mem.lastUpPress = -99999; mem.lastDownPress = -99999;
  mem.intendedRolls = 0;
  mem.pummelGoal = -1; mem.pummels = 0; mem.mashLast = 0;
  mem.counterWait = 0;
  mem.techPlan = TECH_UNROLLED; mem.techDir = 0; mem.techAge = 0; mem.downWait = -1; mem.stoolRolled = 0;
  mem.fsDelay = -1; mem.fsWait = 0;
  mem.wanderMode = WANDER_STAND; mem.wanderDir = 1; mem.wanderTimer = 0; mem.wanderJumpCd = 0;
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

/**
 * Debug read for the harness: rolls this slot asked for on purpose (a grounded Dodge press with a
 * direction held) since its current match began. Any roll the sim saw beyond these was a double
 * tap the output guard let slip.
 */
export function cpuIntendedRolls(slot: number): number {
  return slot >= 0 && slot < memSlots.length ? memSlots[slot].intendedRolls : 0;
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
  /**
   * Chance per decision of grabbing a shield sitting inside grab reach. A shield is the one thing
   * a grab beats outright, so a CPU that never grabs lets a turtle block forever.
   */
  grabRate: number;
  /**
   * Chance of shooting an inbound projectile down with a quicker one of our own, when the clash is
   * one our shot wins or trades, instead of spending shield or a dodge on it.
   */
  projBlock: number;
  /**
   * Longest random extra wait, in frames, before a full Final Smash meter is spent. A bad player
   * sits on it for seconds; a good one takes it the moment it is safe.
   */
  fsPatience: number;
}

/**
 * Index 1..9 are the real difficulties; index 0 is a copy of level 1 so a bad index can never
 * produce undefined. Frozen because nothing should ever write to a profile at runtime.
 */
const CPU_PROFILES: readonly CpuProfile[] = Object.freeze([
  // 0 (unused, mirrors level 1)
  { period: 14, reactMs: 250, shieldChance: 0.05, punishChance: 0, edgeguard: 0, comboChance: 0, smashAccuracy: 0, diQuality: 0, spacing: 0, missChance: 0.30, dodgeSkill: 0, mixupRate: 0, shieldFloor: 2, bairRate: 0, juggle: 0, adaptRate: 0, grabRate: 0, projBlock: 0, fsPatience: 300 },
  { period: 14, reactMs: 250, shieldChance: 0.05, punishChance: 0, edgeguard: 0, comboChance: 0, smashAccuracy: 0, diQuality: 0, spacing: 0, missChance: 0.30, dodgeSkill: 0, mixupRate: 0, shieldFloor: 2, bairRate: 0, juggle: 0, adaptRate: 0, grabRate: 0, projBlock: 0, fsPatience: 300 },
  { period: 11, reactMs: 200, shieldChance: 0.12, punishChance: 0, edgeguard: 0, comboChance: 0, smashAccuracy: 0.10, diQuality: 0, spacing: 0, missChance: 0.24, dodgeSkill: 0.03, mixupRate: 0.05, shieldFloor: 4, bairRate: 0.02, juggle: 0.05, adaptRate: 0.02, grabRate: 0.05, projBlock: 0, fsPatience: 300 },
  { period: 8, reactMs: 155, shieldChance: 0.22, punishChance: 0, edgeguard: 0, comboChance: 0.05, smashAccuracy: 0.20, diQuality: 0.10, spacing: 0.05, missChance: 0.18, dodgeSkill: 0.08, mixupRate: 0.12, shieldFloor: 6, bairRate: 0.05, juggle: 0.12, adaptRate: 0.06, grabRate: 0.12, projBlock: 0.10, fsPatience: 10 },
  { period: 6, reactMs: 120, shieldChance: 0.35, punishChance: 0.15, edgeguard: 0, comboChance: 0.15, smashAccuracy: 0.35, diQuality: 0.25, spacing: 0.15, missChance: 0.12, dodgeSkill: 0.18, mixupRate: 0.22, shieldFloor: 9, bairRate: 0.12, juggle: 0.22, adaptRate: 0.14, grabRate: 0.25, projBlock: 0.22, fsPatience: 8 },
  { period: 5, reactMs: 95, shieldChance: 0.50, punishChance: 0.30, edgeguard: 0.10, comboChance: 0.30, smashAccuracy: 0.50, diQuality: 0.45, spacing: 0.30, missChance: 0.05, dodgeSkill: 0.32, mixupRate: 0.35, shieldFloor: 12, bairRate: 0.22, juggle: 0.35, adaptRate: 0.26, grabRate: 0.40, projBlock: 0.38, fsPatience: 6 },
  { period: 4, reactMs: 75, shieldChance: 0.65, punishChance: 0.50, edgeguard: 0.30, comboChance: 0.50, smashAccuracy: 0.65, diQuality: 0.60, spacing: 0.50, missChance: 0.03, dodgeSkill: 0.48, mixupRate: 0.50, shieldFloor: 15, bairRate: 0.35, juggle: 0.50, adaptRate: 0.42, grabRate: 0.55, projBlock: 0.55, fsPatience: 4 },
  { period: 3, reactMs: 55, shieldChance: 0.80, punishChance: 0.70, edgeguard: 0.55, comboChance: 0.70, smashAccuracy: 0.80, diQuality: 0.75, spacing: 0.70, missChance: 0.015, dodgeSkill: 0.65, mixupRate: 0.66, shieldFloor: 17, bairRate: 0.50, juggle: 0.66, adaptRate: 0.60, grabRate: 0.70, projBlock: 0.72, fsPatience: 3 },
  { period: 2, reactMs: 35, shieldChance: 0.92, punishChance: 0.88, edgeguard: 0.80, comboChance: 0.88, smashAccuracy: 0.92, diQuality: 0.90, spacing: 0.85, missChance: 0.005, dodgeSkill: 0.82, mixupRate: 0.80, shieldFloor: 19, bairRate: 0.68, juggle: 0.82, adaptRate: 0.78, grabRate: 0.85, projBlock: 0.88, fsPatience: 2 },
  { period: 1, reactMs: 17, shieldChance: 1.0, punishChance: 1.0, edgeguard: 1.0, comboChance: 1.0, smashAccuracy: 1.0, diQuality: 1.0, spacing: 1.0, missChance: 0, dodgeSkill: 0.95, mixupRate: 0.92, shieldFloor: 20, bairRate: 0.85, juggle: 0.95, adaptRate: 0.94, grabRate: 0.95, projBlock: 0.97, fsPatience: 1 },
]);

// Level 0 is not a difficulty and never reaches here: cpuInput hands it to dummyInput first, and
// level 10 and up never does either: cpuInput hands it to aevalmereInput.
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
/**
 * How far the neutral special's orb actually reaches: it spawns 18 px ahead and lives 48 frames
 * at 3.5 px/frame, so roughly 186 px, plus the burst it ends in. It is a mid-range tool now, not
 * the full-stage one it used to be, and every range gate below is kept inside this number.
 */
const ORB_RANGE = 186;
/**
 * Longest charge ever held on the orb, and the shortest one worth rooting the fighter for at all.
 * How much of that window is actually taken is arithmetic off the distance (see orbSafeRange):
 * a fixed hold was only ever right for one set of frame data.
 */
const ORB_CHARGE_FRAMES = 24;
const ORB_CHARGE_MIN_FRAMES = 6;
/**
 * How far in front of the thrower the side special's shot reaches before it turns around, and how
 * far behind the thrower it sweeps before it dies. Worked out once at module init from Aeval's own
 * sspecial projectile def (spawn offset, speed, returnFrame, lifetime), so a retune of the shot can
 * never leave these two readings stale. With the current def (x 20, vx 4.25, turn on 31, life 82)
 * that is about 152 px out and about 65 px back.
 */
function crescentReach(): { out: number; back: number } {
  const def = CHARACTER_DEFS.aeval;
  const shots = def ? def.moves.sspecial.projectiles : undefined;
  if (shots === undefined || shots.length === 0) return { out: 150, back: 65 };
  const pd = shots[0];
  const speed = Math.abs(pd.vx);
  const turn = pd.returnFrame === undefined ? pd.lifetime : Math.min(pd.returnFrame, pd.lifetime);
  const out = pd.x + speed * turn;
  const end = out - speed * (pd.lifetime - turn);
  return { out, back: end < 0 ? -end : 0 };
}
const CRESCENT = crescentReach();
const CRESCENT_OUT = CRESCENT.out;
const CRESCENT_BACK = CRESCENT.back;
/** How far mid-range counts, for a bare (uncharged) neutral-special poke; inside ORB_RANGE. */
const MID_RANGE_MIN = 34;
const MID_RANGE_MAX = 120;
/** Horizontal reach of our own fastest grounded pokes (jab/ftilt), in px. */
const MY_REACH = 34;
/** Horizontal reach we credit the opponent with, i.e. the edge of their threat bubble. */
const THREAT_RANGE = 46;
/** Band we dash-dance in: outside the opponent's reach but close enough to punish a step in. */
const SPACING_MIN = 40;
const SPACING_MAX = 78;
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
/**
 * Grab rate from which a profile owns the dash grab (the level 6 row and up). A dash grab whiffed
 * is 38 frames stood in front of someone, so the sloppier profiles only ever grab standing.
 */
const DASH_GRAB_RATE = 0.5;
/** Distance inside which a shielding opponent is worth closing on for a grab at all. */
const GRAB_APPROACH = 90;
/** Distance in px inside which the nearer ledge counts as near, for a back throw off it. */
const THROW_LEDGE_NEAR = 90;
/** Percent from which an up throw is taken for its height, and under which a down throw starts a combo. */
const UTHROW_PERCENT = 110;
const DTHROW_PERCENT = 50;
/** comboChance from which a hold is worth a pummel or two before the throw. */
const PUMMEL_COMBO = 0.3;
/**
 * Every bit a grabbed CPU mashes with. The sim counts each fresh press of any of these. Shield and
 * Dodge are left out on purpose: either press is a tech press, which starts TECH.lockout, and a
 * throw launches straight into the tumble that lockout would then stop us teching.
 */
const MASH_BITS: readonly number[] = [
  Btn.Left, Btn.Right, Btn.Up, Btn.Down, Btn.Jump, Btn.Attack, Btn.Special, Btn.Grab,
];

/** CpuMem.techPlan: nothing rolled yet for this airtime, a tech armed, declined, or already pressed. */
const TECH_UNROLLED = 0;
const TECH_ARMED = 1;
const TECH_DECLINED = 2;
const TECH_PRESSED = 3;
/**
 * Frames ahead of a predicted landing inside which the tech is decided and pressed. Half of
 * TECH.window, so the press still counts if the prediction is off by as much again either way.
 */
const TECH_LOOK = 10;
/** Distance from the main stage's edge inside which a tech or get-up roll goes toward the middle. */
const EDGE_ROLL = 50;
/** comboChance from which a profile owns the footstool at all. */
const FOOTSTOOL_COMBO = 0.3;
/** How close to a ledge the opponent has to be for a footstool to be worth taking. */
const FOOTSTOOL_LEDGE_NEAR = 60;
/** Share of the footstool urge left when the opponent is safely in the middle of the stage. */
const FOOTSTOOL_RARE = 0.05;
/** InputFrame.direct code of the footstool command: it jumps off a head, and does nothing without one. */
const FOOTSTOOL_CODE = DIRECT_CODES.indexOf('footstool') + 1;
/** Real frames a ready Final Smash is held back for an opponent who is invulnerable right now. */
const FS_INVULN_WAIT = 60;
/**
 * Slack on top of the sim's roll tap window. A second press of the same direction closer than
 * this to the first is held back, so the CPU never double taps into a roll or spot dodge it did
 * not ask for.
 */
const TAP_GUARD_SLACK = 2;
/** Buttons that, pressed on the same frame, start an action before locomotion ever reads a tap. */
const TAP_CONSUMERS = Btn.Attack | Btn.Special | Btn.Jump | Btn.Grab | Btn.Dodge;

/**
 * CpuMem.wanderMode: the four plans a level 0 CPU picks between under the cpuZeroMoves rule.
 * Declared above the preallocation loop below, because initMem reads WANDER_STAND while that loop
 * is still running.
 */
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

const inputFrames: InputFrame[] = [];
const memSlots: CpuMem[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
  inputFrames.push({ held: 0, pressed: 0, released: 0, direct: 0 });
  const mem: CpuMem = {
    prevHeld: 0, dirHeld: 0, cooldown: 0, shieldTimer: 0, aerialCd: 0, lastAerial: -99999,
    uairPhase: 0, vertBit: 0, vertFrames: 0, smashPending: 0,
    egPhase: 0, egFrames: 0, ffPhase: 0, dancePhase: 0, danceTimer: 0, spaceTimer: 0, prevMove: null,
    stallFrames: 0, stallSample: 0, sampleX: 0, sampleY: 0, sampleDamage: 0,
    forceMode: 0, forceFrames: 0,
    dodgeCd: 0, attackLock: 0, oppMove: null, oppStarted: null, oppRepeat: 0,
    oppShots: 0, oppShotAge: 0,
    tiltBit: 0, tiltFrames: 0,
    bairPhase: 0, matchRef: null, matchFrame: -1,
    jumpHold: 0, chargePending: 0, chargeFrames: 0, dropPhase: 0, orbHold: 0, jabPending: 0,
    lastLeftPress: 0, lastRightPress: 0, lastUpPress: 0, lastDownPress: 0, intendedRolls: 0,
    pummelGoal: -1, pummels: 0, mashLast: 0, counterWait: 0,
    techPlan: 0, techDir: 0, techAge: 0, downWait: -1, stoolRolled: 0, fsDelay: -1, fsWait: 0,
    wanderMode: WANDER_STAND, wanderDir: 1, wanderTimer: 0, wanderJumpCd: 0,
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
  const b = stage ? stage.blast : { x: -483, y: -480, w: 966, h: 720 };
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
    if (f.slot === slot || sameTeam(state, slot, f.slot)) continue;
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

/**
 * Last frame on which the move still has a projectile left to put out, or -1 when it never had
 * one. BURST_ONLY payloads (spawnFrame -1) are spawned by another projectile dying, not by the
 * move's own timeline, so they are not part of it. Read live, so retuning a shot's spawn frame
 * retunes every read of it below.
 */
function moveLastSpawn(mv: MoveDef): number {
  const list = mv.projectiles;
  if (list === undefined) return -1;
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const s = list[i].spawnFrame;
    if (s > best) best = s;
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
  // A move is over as a threat only once its last hitbox has died AND its last projectile has
  // actually left. The frames before a shot spawns look exactly like ending lag from the outside
  // and are not: walking in there is walking into the shot. Reading the spawn frame off the move
  // rather than assuming one is what keeps this honest when the owner retunes the timing.
  const threatEnd = Math.max(moveActiveEnd(mv), moveLastSpawn(mv));
  if (threatEnd >= 0 && f.actionFrame <= threatEnd) return 0;
  if (threatEnd < 0 && f.actionFrame <= 8) return 0;
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
    const t = inboundFrames(state, state.projectiles[i], slot, me);
    if (t < 0) continue;
    if (soonest < 0 || t < soonest) soonest = t;
  }
  return soonest;
}

/**
 * The one inbound test every projectile read shares: frames until a live hostile shot reaches us
 * along its current line, or -1 when it is ours, moving away, outside our height band, or more
 * than 40 frames out.
 */
function inboundFrames(state: GameState, pr: ProjectileState, slot: number, me: FighterState): number {
  // A teammate's shot cannot hurt us under the Teams rule, so it is never a threat.
  if (!pr.alive || pr.owner === slot || sameTeam(state, slot, pr.owner)) return -1;
  const dx = me.x - pr.x;
  if (dx * pr.vx <= 0) return -1;                        // moving away from us
  if (Math.abs((me.y - 22) - pr.y) > 42) return -1;
  const t = Math.abs(dx) / Math.abs(pr.vx);
  return t > 40 ? -1 : t;
}

/**
 * True when the soonest inbound projectile (the one incomingProjectile timed) would hit low, i.e.
 * a roll would not dodge it. Only its height is read: the projectile defs live inside the sim.
 */
function incomingLow(state: GameState, slot: number, me: FighterState): boolean {
  let soonest = -1;
  let low = false;
  for (let i = 0; i < state.projectiles.length; i++) {
    const pr = state.projectiles[i];
    const t = inboundFrames(state, pr, slot, me);
    if (t < 0) continue;
    if (soonest < 0 || t < soonest) {
      soonest = t;
      low = isLowHit(me, pr.y, undefined, null, true);
    }
  }
  return low;
}

// ---------------------------------------------------------------------------
// Projectile counter: shooting an inbound shot down with a quicker one of our own. Everything is
// a prediction off present state and the projectile data of both moves, stepped frame by frame
// exactly the way sim/projectiles.ts flies them and sim/hits.ts clashes them.
// ---------------------------------------------------------------------------

/**
 * Mirrors CLASH_TOLERANCE in sim/hits.ts, which is not exported: two shots whose effective damage
 * sits within this share of the stronger one both die, otherwise the stronger survives.
 */
const CLASH_TOLERANCE = 0.1;
/** projBlock from which a winning counter that flies on into the shooter is taken over any block. */
const PROJ_PRESSURE_SKILL = 0.55;
/** Real frames a fired counter's press is protected from being replaced before its move starts. */
const COUNTER_WAIT = 3;

/**
 * The inputs a counter-shot can be fired with. A `turns` move faces the held direction as it
 * starts (sim/actions.ts specialAttack); the rest keep the current facing. A `standing` move turns
 * into something else out of a dash or run (a jab becomes a dash attack). Whether each one throws
 * anything at all, and what, is read off the character's own move data.
 */
interface CounterInput { id: MoveId; btn: number; turns: boolean; standing: boolean }
const COUNTER_INPUTS: readonly CounterInput[] = [
  { id: 'jab', btn: Btn.Attack, turns: false, standing: true },
  { id: 'nspecial', btn: Btn.Special, turns: false, standing: false },
  { id: 'sspecial', btn: Btn.Special, turns: true, standing: false },
];

interface CounterPlan {
  moveBtn: number;
  dirBit: number;
  /** Frames from now until the two shots meet. */
  clashIn: number;
  outcome: 'win' | 'trade';
  /** A win whose surviving shot flies on into the shooter. Only worked out for profiles that use it. */
  pressure: boolean;
}

/** A shot being flown ahead of time. Two are preallocated: the inbound one and our answer. */
interface ShotSim { x: number; y: number; vx: number; vy: number; age: number; power: number; returned: boolean }

const counterPlan: CounterPlan = { moveBtn: 0, dirBit: 0, clashIn: 0, outcome: 'trade', pressure: false };
const simIn: ShotSim = { x: 0, y: 0, vx: 0, vy: 0, age: 0, power: 1, returned: false };
const simMine: ShotSim = { x: 0, y: 0, vx: 0, vy: 0, age: 0, power: 1, returned: false };
const COUNTER_HURT: Rect = { x: 0, y: 0, w: 0, h: 0 };
/** The last simulateClash: 0 they never meet, 1 ours survives, 2 both die, 3 ours dies. */
let clashResult = 0;
let clashT = -1;
/** Where the inbound shot was when they met, which is where its burst goes off. */
let clashX = 0;
let clashY = 0;

let projBlockOverride: number | null = null;

/**
 * TEST HOOK ONLY (src/ai/aitest.ts). Forces every profile's projBlock to `value`, or restores the
 * table with null, so the harness can replay a scenario with the counter switched off.
 */
export function setCpuProjBlockOverrideForTest(value: number | null): void {
  projBlockOverride = value;
}

function loadShot(s: ShotSim, pr: ProjectileState): void {
  s.x = pr.x; s.y = pr.y; s.vx = pr.vx; s.vy = pr.vy;
  s.age = pr.age; s.power = pr.power; s.returned = pr.returned;
}

/** One frame of sim/projectiles.ts stepProjectiles on a copy. False once the shot has expired. */
function stepShot(s: ShotSim, d: ProjectileDef): boolean {
  if (d.returnFrame !== undefined && !s.returned && s.age >= d.returnFrame) {
    s.vx = -s.vx;
    s.power *= d.returnPower === undefined ? 0.5 : d.returnPower;
    s.returned = true;
  }
  s.x += s.vx;
  s.y += s.vy;
  s.vy += d.gravity;
  s.age++;
  return s.age < d.lifetime;
}

/** Ground friction for one frame, as sim/physics.ts applies it. */
function frictionStep(vx: number, def: CharacterDef): number {
  if (vx > 0) return Math.max(0, vx - def.groundFriction);
  if (vx < 0) return Math.min(0, vx + def.groundFriction);
  return 0;
}

/** Standing hurtbox with the feet at (x, me.y). Firing anything leaves us standing. */
function standingHurt(me: FighterState, def: CharacterDef, x: number): Rect {
  COUNTER_HURT.x = x - def.hurtbox.w / 2;
  COUNTER_HURT.y = me.y - def.hurtbox.h;
  COUNTER_HURT.w = def.hurtbox.w;
  COUNTER_HURT.h = def.hurtbox.h;
  return COUNTER_HURT;
}

/**
 * Frames until a hostile shot really overlaps our hurtbox, flying its actual path (gravity, the
 * turnaround, its lifetime) rather than a straight line, or -1 when it never does. Our own slide
 * is stepped alongside, since whatever we do next roots us into ground friction.
 */
function shotHitIn(pr: ProjectileState, pd: ProjectileDef, me: FighterState, def: CharacterDef): number {
  loadShot(simIn, pr);
  const r = pd.r * pr.scale;
  let x = me.x;
  let vx = me.vx;
  for (let k = 1; k <= pd.lifetime; k++) {
    if (!stepShot(simIn, pd)) return -1;
    if (me.onGround) vx = frictionStep(vx, def);
    x += vx;
    if (circleRectOverlap(simIn.x, simIn.y, r, standingHurt(me, def, x))) return k;
  }
  return -1;
}

/**
 * Where our feet stand when a move pressed now reaches move frame `frame`, `delay` frames after
 * the press lands. Friction every frame, plus the move's own momentum as it comes due. Actions
 * run before physics, so the injection on `frame` itself has not moved us yet.
 */
function selfXAt(me: FighterState, def: CharacterDef, mv: MoveDef, facing: number, delay: number, frame: number): number {
  let x = me.x;
  let vx = me.vx;
  const vel = mv.velocity;
  for (let k = 1; k < delay + frame; k++) {
    const j = k - delay;
    if (vel !== undefined && j >= 0) {
      for (let i = 0; i < vel.length; i++) {
        const v = vel[i];
        if (v.frame !== j || v.vx === undefined) continue;
        vx = v.setX === true ? v.vx * facing : vx + v.vx * facing;
      }
    }
    if (me.onGround) vx = frictionStep(vx, def);
    x += vx;
  }
  return x;
}

/**
 * Flies an inbound shot and one of ours, spawned on step `spawnStep` (step 1 is the frame our
 * press is read on), together until they overlap or `limit` steps run out. A shot spawns before
 * the projectile step of its own frame and can clash on that same frame, and an expired shot is
 * gone before clashes are checked, both exactly as the sim orders them. Leaves the result in the
 * clash scratch, with simMine holding our shot as it stands after the meeting.
 */
function simulateClash(
  pr: ProjectileState, pd: ProjectileDef, sd: ProjectileDef, facing: number,
  spawnX: number, spawnY: number, spawnStep: number, power: number, scale: number, limit: number,
): void {
  clashResult = 0;
  clashT = -1;
  loadShot(simIn, pr);
  const reach = pd.r * pr.scale + sd.r * scale;
  for (let k = 1; k < limit; k++) {
    if (!stepShot(simIn, pd)) return;
    if (k < spawnStep) continue;
    if (k === spawnStep) {
      simMine.x = spawnX; simMine.y = spawnY; simMine.vx = sd.vx * facing; simMine.vy = sd.vy;
      simMine.age = 0; simMine.power = power; simMine.returned = false;
    }
    if (!stepShot(simMine, sd)) return;
    const dx = simIn.x - simMine.x;
    const dy = simIn.y - simMine.y;
    if (dx * dx + dy * dy > reach * reach) continue;
    const inD = pd.damage * simIn.power;
    const myD = sd.damage * simMine.power;
    const gap = inD > myD ? inD - myD : myD - inD;
    clashT = k;
    clashX = simIn.x;
    clashY = simIn.y;
    if (gap <= Math.max(inD, myD) * CLASH_TOLERANCE) {
      clashResult = 2;
    } else if (myD > inD) {
      clashResult = 1;
      simMine.power *= gap / myD;
    } else {
      clashResult = 3;
    }
    return;
  }
}

/** True when the burst an inbound shot leaves where it dies would still catch us. */
function burstHurts(pd: ProjectileDef, me: FighterState, def: CharacterDef): boolean {
  if (pd.burstId === undefined) return false;
  const bd = PROJECTILE_DEFS[pd.burstId];
  if (bd === undefined) return false;
  return circleRectOverlap(clashX, clashY, bd.r, standingHurt(me, def, me.x));
}

/**
 * True when our shot that just won (simMine) keeps flying into the shooter: it outlasts the burst
 * the dead shot leaves behind, is travelling at them, and has the life left to arrive.
 */
function counterPresses(state: GameState, pr: ProjectileState, pd: ProjectileDef, sd: ProjectileDef): boolean {
  if (pd.burstId !== undefined) {
    const bd = PROJECTILE_DEFS[pd.burstId];
    if (bd !== undefined) {
      const myD = sd.damage * simMine.power;
      if (myD <= bd.damage || myD - bd.damage <= myD * CLASH_TOLERANCE) return false;
    }
  }
  const shooter = fighterBySlot(state, pr.owner);
  if (shooter === null || shooter.stocks <= 0 || shooter.action === 'dead') return false;
  const gapX = shooter.x - simMine.x;
  if (gapX * simMine.vx <= 0) return false;
  let life = sd.lifetime - simMine.age;
  if (sd.returnFrame !== undefined && !simMine.returned) life = Math.min(life, sd.returnFrame - simMine.age);
  return Math.abs(simMine.vx) * life >= Math.abs(gapX) - hurtHalfWidth(shooter);
}

/** Half the standing hurtbox width we credit a fighter with, from their own character data. */
function hurtHalfWidth(f: FighterState): number {
  const def = CHARACTER_DEFS[f.charId];
  return def ? def.hurtbox.w / 2 : 13;
}

/**
 * Plans shooting an inbound projectile down. For every hostile shot heading at us, and every
 * projectile move we could start right now that throws toward it, both shots are flown frame by
 * frame to the first overlap. A plan counts only when the meeting lands before the soonest real
 * hit of any inbound shot (a counter that stops one shot while another connects has still eaten
 * the hit) and our shot wins or trades by the sim's clash rule, and when the burst the dead shot
 * leaves behind cannot reach us. Wins beat trades, then the earliest meeting wins. Returns the
 * preallocated plan, or null when nothing qualifies.
 */
function planProjectileCounter(
  state: GameState, slot: number, me: FighterState, def: CharacterDef, prof: CpuProfile,
): CounterPlan | null {
  let soonest = -1;
  for (let i = 0; i < state.projectiles.length; i++) {
    const pr = state.projectiles[i];
    if (inboundFrames(state, pr, slot, me) < 0) continue;
    const pd = PROJECTILE_DEFS[pr.defId];
    if (pd === undefined) continue;
    const h = shotHitIn(pr, pd, me, def);
    if (h >= 0 && (soonest < 0 || h < soonest)) soonest = h;
  }
  if (soonest < 0) return null;
  const limit = soonest - 1;
  const running = me.action === 'dash' || me.action === 'run';

  let bestRank = -1;
  let bestT = 0;
  for (let i = 0; i < state.projectiles.length; i++) {
    const pr = state.projectiles[i];
    if (inboundFrames(state, pr, slot, me) < 0) continue;
    const pd = PROJECTILE_DEFS[pr.defId];
    if (pd === undefined) continue;
    const facing = pr.x > me.x ? 1 : pr.x < me.x ? -1 : 0;
    if (facing === 0) continue;

    for (let c = 0; c < COUNTER_INPUTS.length; c++) {
      const ci = COUNTER_INPUTS[c];
      const mv = def.moves[ci.id];
      if (mv === undefined || mv.projectiles === undefined) continue;
      if ((mv.groundOnly === true && !me.onGround) || (mv.airOnly === true && me.onGround)) continue;
      if (ci.standing && running) continue;
      if (!ci.turns && me.facing !== facing) continue;
      // Out of a shield only an Attack comes straight out; anything else waits a frame for the
      // shield to drop. Otherwise a chargeable move pressed with its own charge button starts
      // charging and lets go into its frame 0 a frame later, as a tap.
      let delay = 1;
      if (me.action === 'shield' && ci.btn !== Btn.Attack) delay++;
      else if (mv.chargeable === true && (mv.chargeButton === 'special' ? Btn.Special : Btn.Attack) === ci.btn) delay++;
      const power = projectileChargePower(0, mv.chargeable);
      const scale = projectileChargeScale(0, mv.chargeable);
      const shots = mv.projectiles;
      for (let s = 0; s < shots.length; s++) {
        const sd = shots[s];
        if (sd.spawnFrame < 0) continue;              // a burst payload, not thrown by the move
        const spawnStep = delay + sd.spawnFrame;
        if (spawnStep >= limit) continue;
        const x = selfXAt(me, def, mv, facing, delay, sd.spawnFrame);
        simulateClash(pr, pd, sd, facing, x + sd.x * facing, me.y + sd.y, spawnStep, power, scale, limit);
        if (clashResult !== 1 && clashResult !== 2) continue;
        const rank = clashResult === 1 ? 1 : 0;
        if (rank < bestRank || (rank === bestRank && clashT >= bestT)) continue;
        if (burstHurts(pd, me, def)) continue;
        bestRank = rank;
        bestT = clashT;
        counterPlan.moveBtn = ci.btn;
        counterPlan.dirBit = ci.turns ? (facing === 1 ? Btn.Right : Btn.Left) : 0;
        counterPlan.clashIn = clashT;
        counterPlan.outcome = rank === 1 ? 'win' : 'trade';
        counterPlan.pressure = rank === 1 && prof.projBlock >= PROJ_PRESSURE_SKILL &&
          counterPresses(state, pr, pd, sd);
      }
    }
  }
  return bestRank < 0 ? null : counterPlan;
}

/**
 * Fires a planned counter. Everything that could eat or bend the press is let go first: a held
 * shield strips the direction a side special needs, and a pending charge or smash would replace
 * the buffer. The attack lock is dropped for this frame because the plan already proved the
 * clash lands before the shot does.
 */
function fireCounter(mem: CpuMem, plan: CounterPlan): number {
  mem.shieldTimer = 0;
  mem.orbHold = 0;
  mem.chargeFrames = 0;
  mem.chargePending = 0;
  mem.smashPending = 0;
  mem.tiltFrames = 0;
  mem.attackLock = 0;
  mem.counterWait = COUNTER_WAIT;
  mem.dirHeld = plan.dirBit;
  return plan.moveBtn;
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

/** Clearance in px a chasing jump's apex has to keep from the top blast line. */
const CEILING_MARGIN = 50;

/**
 * True when a jump launched now at `vel` px/frame peaks safely under the top blast line. A juggle
 * chase from a high platform toward an opponent already near the ceiling carries straight through
 * it: the uair keeps the rising momentum, so the chase has to be refused before the jump.
 */
function jumpClearsCeiling(me: FighterState, g: GroundInfo, vel: number): boolean {
  const def = CHARACTER_DEFS[me.charId];
  const grav = def ? def.gravity : 0.15;
  const rise = Math.max(vel, -me.vy);
  const peak = me.y - (rise * rise) / (2 * grav);
  return peak > g.blastTop + CEILING_MARGIN;
}

/** Full hop velocity, or the double jump's when `double` is set, from the character data. */
function jumpVel(me: FighterState, double: boolean): number {
  const def = CHARACTER_DEFS[me.charId];
  if (!def) return 5;
  return double ? def.doubleJumpVel : def.jumpVel;
}

/** True while there is enough shield left to spend a block without flirting with a break. */
function shieldAffordable(prof: CpuProfile, me: FighterState, cost: number): boolean {
  return me.shieldHp - cost > prof.shieldFloor + SHIELD_RESERVE;
}

/**
 * Dodge with no direction held on the ground: a spot dodge, invincible on frames 3-17 of 22. The
 * shield is dropped for it, since Shield only shields now and a held one adds nothing.
 */
function spotDodgeNow(mem: CpuMem): number {
  mem.shieldTimer = 0;
  mem.dodgeCd = DODGE_COOLDOWN;
  mem.dirHeld = 0;
  return Btn.Dodge;
}

/**
 * Dodge with a direction held on the same frame: a roll, travelling ROLL.distance px and dodging
 * frames 4-19 of 30. It dodges everything except low hits, so callers check the threat first.
 */
function rollNow(mem: CpuMem, dirBit: number): number {
  mem.shieldTimer = 0;
  mem.dodgeCd = DODGE_COOLDOWN;
  mem.dirHeld = dirBit;
  return Btn.Dodge;
}

/**
 * Dodge pressed while airborne: an air dodge, invincible on frames 3-27 of 30. A held direction
 * gives it momentum, so it doubles as a movement and recovery mixup.
 */
function airDodgeSafe(me: FighterState, g: GroundInfo): boolean {
  return me.x > g.minX + 10 && me.x < g.maxX - 10 && me.y < g.topY + 10;
}

function airDodgeNow(mem: CpuMem, dirBit: number): number {
  mem.dodgeCd = DODGE_COOLDOWN;
  mem.shieldTimer = 0;
  mem.dirHeld = dirBit;
  return Btn.Dodge;
}

/**
 * True when the move the opponent is in has any hitbox a roll cannot dodge (see sim/dodge.ts):
 * a flagged low box, a low move by id, or a box whose centre sits down by our feet. Rolling into
 * a sweep is rolling into the hit, so every roll answer checks this first.
 */
function threatIsLow(me: FighterState, opp: FighterState): boolean {
  const mv = activeMove(opp);
  if (mv === null) return false;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const h = mv.hitboxes[i];
    if (isLowHit(me, opp.y + h.y, h.low, opp.moveId, opp.onGround)) return true;
  }
  return false;
}

/** The grab data a fighter's character grabs with. */
function kitFor(f: FighterState): GrabKit {
  const def = CHARACTER_DEFS[f.charId];
  return def ? grabKitOf(def) : DEFAULT_GRAB_KIT;
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

/**
 * The distance from which throwing the orb is actually safe. The shot leaves her hands on the
 * move's own spawn frame and the fighter is rooted for every frame after it, so the punish window
 * a running opponent gets is exactly that tail, and the ground they cover in it is that tail times
 * their run speed, plus our own poke range to stand outside. Every number comes out of the move
 * and the character rather than being written down here, so the owner retuning the shot's spawn
 * frame or its total length moves this gate with it: the 7 extra frames of recovery behind the
 * new orb push the safe distance outward on their own.
 */
function orbSafeRange(me: FighterState, opp: FighterState): number {
  const mv = myMove(me, 'nspecial');
  if (mv === null) return MID_RANGE_MAX;
  const spawn = moveLastSpawn(mv);
  if (spawn < 0) return MID_RANGE_MAX;
  const free = mv.iasa === undefined ? mv.totalFrames : mv.iasa;
  const tail = Math.max(0, free - spawn);
  const def = CHARACTER_DEFS[opp.charId];
  const speed = def ? def.runSpeed : 2.6;
  return tail * speed + MY_REACH;
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

/** A plain block, with nothing held that the sim could read as a double-tap roll or spot dodge. */
function holdShield(mem: CpuMem, frames: number): number {
  mem.shieldTimer = frames;
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
  frames: number, cost: number, towardBit: number, awayBit: number, wantIn: boolean, low: boolean,
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
    // A roll dodges everything but a low hit, so against a sweep it is never the answer: the spot
    // dodge is fully invincible, and failing that a jump clears the sweep or the shield eats it.
    if (!low && frames >= ROLL.invStart && frames <= ROLL.invEnd) {
      const inward = wantIn && rand() < 0.4 + 0.6 * prof.adaptRate;
      return rollNow(mem, inward ? towardBit : awayBit);
    }
    if (low && frames >= 3 && frames <= SPOT_DODGE.invEnd - 1) return spotDodgeNow(mem);
    if (frames >= 7 && rand() < 0.35 + 0.45 * prof.mixupRate) {
      return armJump(prof, rand, mem, true, wantIn ? towardBit : 0);
    }
    if (!canShield) {
      // Out of shield budget and out of dodges: simply stop being in the line of fire.
      mem.dirHeld = safeStep(me, g, awayBit) | Btn.Walk;
      return 0;
    }
  }
  return holdShield(mem, Math.max(6, Math.min(18, Math.round(frames) + 5)));
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
  // Walked, never run: a dash carries far past a 10 px stop band and turns the approach into a
  // skid back and forth that never gets to throw anything.
  if (distInward > stop) {
    mem.dirHeld = towardEdgeBit | Btn.Walk;
    return 0;
  }
  if (distInward < backoff) {
    mem.dirHeld = stageBit | Btn.Walk;
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
    mem.dirHeld = towardBit | Btn.Walk;
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
      jumpClearsCeiling(me, g, jumpVel(me, false)) && rand() < 0.15 + 0.85 * skill) {
    mem.uairPhase = UAIR_WINDUP;
    return armJump(prof, rand, mem, true, 0);
  }

  // Nothing connects yet. Stay under them and wait for them to fall into something; never drift.
  mem.dirHeld = adx > 8 ? towardBit | Btn.Walk : 0;
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
    // Out of the same shield a sweep would catch the roll, so spot dodge that one instead.
    return threatIsLow(me, opp) ? spotDodgeNow(mem) : rollNow(mem, awayBit);
  }

  // Shielding against a grab wind-up is standing still for it: a grab goes straight through a
  // shield. Jump out or spot dodge before the box is live, as often as this profile blocks at all.
  if (me.action === 'shield' && opp.action === 'grab' && opp.onGround && Math.abs(dy) < 30) {
    // Which box is coming is not on the public state, so the longer dash grab bounds both.
    const kit = kitFor(opp);
    const reach = Math.max(kit.stand.x + kit.stand.r, kit.dash.x + kit.dash.r) + 8;
    const lastLive = Math.max(kit.stand.end, kit.dash.end);
    const facingUs = (me.x - opp.x) * opp.facing > 0;
    if (facingUs && adx <= reach && opp.actionFrame < lastLive && rand() < prof.shieldChance) {
      mem.shieldTimer = 0;
      if (mem.dodgeCd === 0 && rand() < 0.5) return spotDodgeNow(mem);
      return armJump(prof, rand, mem, false, 0);
    }
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
      mem.dirHeld = adx > MY_REACH - 8 ? towardBit | Btn.Walk : 0;
      return 0;
    }
    const left = Math.max(0, ROLL.total - opp.actionFrame);
    const destX = opp.x + opp.vx * left;
    const destAdx = Math.abs(destX - me.x);
    // Rolling through us: a forward smash covers one side, a down smash covers both.
    const through = (destX - me.x) * (opp.x - me.x) < 0;
    // So does the crescent, now that it comes home: thrown out in front it turns (returnFrame) and
    // sweeps back through us into the space they rolled to, which is a cleaner answer to a
    // cross-up roll than turning around and guessing. Only profiles that read patterns find it.
    if (through && destAdx < CRESCENT_BACK && prof.adaptRate > 0.5 && left >= 6 &&
        rand() < 0.3 * prof.adaptRate) {
      mem.dirHeld = towardBit;
      return Btn.Special;
    }
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
    mem.dirHeld = destAdx > 10 ? (destX < me.x ? Btn.Left : Btn.Right) | Btn.Walk : 0;
    return 0;
  }

  // Grab a shield. A shield blocks every hit and nothing else, and a long shield stun is the same
  // standing target. Standing grab from inside its reach while facing them; from a dash already
  // under way, the longer dash grab slides into them from further out.
  const shieldLocked = opp.action === 'shield' || opp.action === 'shieldStun';
  if (shieldLocked && prof.grabRate > 0 && opp.onGround && Math.abs(dy) < 24) {
    const kit = kitFor(me);
    const standReach = kit.stand.x + kit.stand.r + 6;
    const running = me.action === 'dash' || me.action === 'run';
    if (running && me.facing === towardNum && prof.grabRate >= DASH_GRAB_RATE) {
      const slide = Math.abs(me.vx) * kit.dash.start * 0.5;
      const dashReach = kit.dash.x + kit.dash.r + 6 + slide;
      if (adx <= dashReach && rand() < prof.grabRate) {
        mem.dirHeld = towardBit;
        return Btn.Grab;
      }
    }
    if (settled && !running && me.facing === towardNum && adx <= standReach && rand() < prof.grabRate) {
      mem.shieldTimer = 0;
      mem.dirHeld = 0;
      return Btn.Grab;
    }
    // Close the gap on purpose. A profile that owns the dash grab runs in; the rest walk up.
    if (settled && adx <= GRAB_APPROACH && rand() < prof.grabRate) {
      mem.shieldTimer = 0;
      if (adx > standReach || me.facing !== towardNum) {
        const dash = prof.grabRate >= DASH_GRAB_RATE && adx > standReach + 16;
        mem.dirHeld = safeStep(me, ground, towardBit) | (dash ? 0 : Btn.Walk);
        return 0;
      }
    }
  }

  // Whirlpool. 50 frames, four pulling hits and a launching fifth: a stock on a hard read and a
  // free punish on a whiff, so it only ever goes out against someone who cannot answer it before
  // the pull is live. Reach and wind-up are read off the move's own hitboxes rather than guessed,
  // so retuning the whirlpool retunes the read with it. Checked before the ordinary punishes,
  // which would otherwise always take the frame first.
  const wp = myMove(me, 'dspecial');
  if (wp !== null && settled && prof.smashAccuracy > 0.4 &&
      adx < moveSpan(wp) + 10 && Math.abs(dy) < 34) {
    const wind = moveStartup(wp) + 2;
    // Long enough that the pull actually chains into the launching fifth hit, rather than
    // trading 50 frames of ending lag for a single 2% tick.
    const worthIt = wind + 6;
    // Stuck for longer than the wind-up: hitstun, a broken shield, or the ending lag of something
    // long and committed. This is the read the whole move exists for.
    const stuck = vulnerableFor(opp) >= worthIt;
    // Covering a landing. They are falling and physics says when they touch down; starting the
    // pull now means the first hit is live as they arrive, with nothing they can do about it.
    let covering = false;
    if (!stuck && !opp.onGround && opp.vy > 0.05 && opp.hitstun === 0) {
      const eta = framesUntilLevel(opp, me.y, 40);
      covering = eta >= wind - 2 && eta <= wind + 10;
    }
    if ((stuck || covering) && rand() < rate(prof, 1.2 * prof.smashAccuracy)) {
      mem.dirHeld = Btn.Down;
      return Btn.Special;
    }
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
        mem.dirHeld = safeStep(me, ground, towardBit) | Btn.Walk;   // get under the landing spot first
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
                  towardBit, awayBit, false, threatIsLow(me, opp));
  }

  // Shoot it down. A shot met by a quicker shot of our own dies in the air, which costs neither
  // shield nor a dodge's committed frames, and a counter that wins flies on into the shooter.
  // Same reaction gate as the answers below; with no qualifying plan they run unchanged.
  if (settled && me.buffer.btn === 0 && mem.orbHold === 0) {
    const projBlock = projBlockOverride === null ? prof.projBlock : projBlockOverride;
    const inbound = projBlock > 0 ? incomingProjectile(state, slot, me) : -1;
    const def = CHARACTER_DEFS[me.charId];
    if (inbound >= reactFrames(prof) && def) {
      const plan = planProjectileCounter(state, slot, me, def, prof);
      // The output stage drops an Attack near an edge or on a soft platform while the aerial gate
      // is up, and a button still held from before is no press at all.
      const stripped = plan !== null && plan.moveBtn === Btn.Attack && mem.aerialCd > 0 &&
        (me.x < ground.minX + 24 || me.x > ground.maxX - 24 || onSoftPlatform(state, me));
      if (plan !== null && !stripped && (mem.prevHeld & plan.moveBtn) === 0) {
        // A disciplined profile takes a winning counter that carries on into the shooter outright,
        // even with shield to spare: blocking hands the tempo back, this takes it.
        const pressing = projBlock >= PROJ_PRESSURE_SKILL && plan.outcome === 'win' && plan.pressure;
        if (pressing || rand() < projBlock) return fireCounter(mem, plan);
      }
    }
  }

  // Answer an inbound projectile. Same reaction gate: it only counts if there is still time to do
  // anything about it. A projectile is dodgeable, and against a spammer the answer that also
  // closes distance is the right one, because their recovery is the punish window.
  if (settled) {
    const inbound = incomingProjectile(state, slot, me);
    if (inbound >= reactFrames(prof) && inbound < 26 && rand() < prof.shieldChance) {
      const wantIn = spammy && rand() < prof.adaptRate;
      return defend(prof, rand, me, mem, ground, inbound, SHIELD_COST_SHOT,
                    towardBit, awayBit, wantIn, incomingLow(state, slot, me));
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
      mem.dirHeld = towardBit;                   // a plain hold runs
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
    mem.dirHeld = towardBit;
    return 0;
  }

  // Combo follow-up: the opponent is still in hitstun and reachable, so keep hitting instead of
  // resetting to neutral.
  if (opp.hitstun > 0 && rand() < prof.comboChance) {
    if (dy < -40 && adx < 44) {
      if (mem.aerialCd === 0 && jumpClearsCeiling(me, ground, jumpVel(me, false)) &&
          rand() < prof.comboChance) {
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
      if (!jumpClearsCeiling(me, ground, jumpVel(me, false))) { mem.dirHeld = 0; return 0; }
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
    // Every step in the band is walked: a dash covers the whole band in a few frames and hands
    // the spacing away the moment it starts.
    if (inStartup(opp)) {
      mem.dirHeld = awayBit | Btn.Walk;
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
      mem.dirHeld = (mem.dancePhase === 1 ? towardBit : awayBit) | Btn.Walk;
      return 0;
    }
    mem.danceTimer = DANCE_HOLD;
    mem.dancePhase = mem.dancePhase === 1 ? 0 : 1;
    mem.dirHeld = (mem.dancePhase === 1 ? towardBit : awayBit) | Btn.Walk;
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
    // Charged orb. Holding Special roots the fighter with no hitbox out, so it is only correct
    // when zoning is genuinely free: they are out past the orb's own reach, they are not closing,
    // and nothing of theirs is in the air. cpuInput re-checks all of that every frame and lets go
    // early the moment it stops being true, exactly the way a charged smash is abandoned.
    // The charge itself is bought with distance: every frame Special is held is another frame they
    // get to run at a rooted fighter, on top of the recovery already owed behind the shot. Hold it
    // only for the surplus ground they would still have to cover, never longer.
    if (mem.orbHold === 0 && prof.spacing > 0.45 && adx <= ORB_RANGE &&
        Math.abs(dy) < 50 && (opp.x - me.x) * opp.vx >= -0.2 && !inStartup(opp) &&
        incomingProjectile(state, slot, me) < 0 &&
        rand() < rate(prof, 0.8 * prof.spacing)) {
      const oppDef = CHARACTER_DEFS[opp.charId];
      const oppSpeed = oppDef ? oppDef.runSpeed : 2.6;
      const room = Math.min(ORB_CHARGE_FRAMES, Math.floor((adx - orbSafeRange(me, opp)) / oppSpeed));
      if (room >= ORB_CHARGE_MIN_FRAMES) {
        mem.orbHold = room;
        mem.dirHeld = 0;
        return Btn.Special;
      }
    }
    // Side special. The crescent flies CRESCENT_OUT px out, turns on its returnFrame and sweeps
    // back through the thrower for the rest of its lifetime, so one throw covers both sides and an
    // opponent who jumps or rolls behind is still in its path. Thrown from outside the
    // dash-dance band, where the move's own 42 frames cannot be walked through and punished.
    if (adx > SPACING_MAX && adx < CRESCENT_OUT && Math.abs(dy) < 60 && vulnerableFor(opp) === 0 &&
        !inStartup(opp) && rand() < rate(prof, 0.45 * prof.spacing)) {
      mem.dirHeld = towardBit;
      return Btn.Special;
    }
    // Bare orb. A sloppy profile throws it from the middle of the screen and pays the recovery;
    // a disciplined one stands outside the punish the shot now owes and pokes from there instead.
    // The band is interpolated by the profile's own spacing, so nothing branches on a level.
    const orbSafe = orbSafeRange(me, opp);
    const orbMin = MID_RANGE_MIN + (orbSafe - MID_RANGE_MIN) * prof.spacing;
    const orbMax = MID_RANGE_MAX + (ORB_RANGE - MID_RANGE_MAX) * prof.spacing;
    if (adx <= orbMax && adx >= orbMin &&
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
    // Run the long approach, walk the last stretch: arriving at a run turns the first Attack into
    // a dash attack and carries the fighter straight through the range it meant to stop at.
    if (adx <= 90 && dir !== 0) dir |= Btn.Walk;
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
  mem.dirHeld = towardBit | Btn.Walk;
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
    if (pdy < moveTop(ua) && me.jumpsLeft > 0 && me.vy > -1.2 && overStage && canReturn(me, ground) &&
        jumpClearsCeiling(me, ground, jumpVel(me, true))) {
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

/**
 * A hold. Profiles with a follow-up game pummel once or twice while the hold timer still has room
 * for a whole pummel against a mashing victim, then throw. The throw is picked by position: a back
 * throw off a ledge close behind us, a forward throw toward the ledge we face, an up throw for a
 * kill at high percent in the middle of the stage, a down throw to start a combo at low percent.
 */
function holdDecision(
  state: GameState, prof: CpuProfile, rand: () => number, me: FighterState, mem: CpuMem, g: GroundInfo,
): number {
  const kit = kitFor(me);
  // Hold timer and partner are sim-side fields rather than FighterState ones, but they live on the
  // very object the sim steps, so reading them is reading the game state.
  const sim = me as SimFighter;
  if (mem.pummelGoal < 0) {
    mem.pummelGoal = prof.comboChance >= PUMMEL_COMBO ? 1 + (rand() < 0.5 ? 1 : 0) : 0;
    mem.pummels = 0;
  }
  // Room for a whole pummel even while the victim mashes the timer down several frames at a time.
  if (mem.pummels < mem.pummelGoal && sim.grabTimer > kit.pummel.totalFrames * 3 &&
      (mem.prevHeld & Btn.Attack) === 0) {
    mem.pummels++;
    mem.dirHeld = 0;
    return Btn.Attack;
  }

  const vi = sim.grabPartner;
  const victimPercent = vi >= 0 && vi < state.fighters.length ? state.fighters[vi].percent : 0;

  const leftDist = me.x - g.minX;
  const rightDist = g.maxX - me.x;
  const ledgeDir = leftDist < rightDist ? -1 : 1;
  const ledgeDist = Math.min(leftDist, rightDist);
  const forwardBit = me.facing === 1 ? Btn.Right : Btn.Left;
  const backBit = me.facing === 1 ? Btn.Left : Btn.Right;
  let bit: number;
  if (me.facing !== ledgeDir && ledgeDist <= THROW_LEDGE_NEAR) bit = backBit;
  else if (me.facing === ledgeDir) bit = forwardBit;
  else if (victimPercent >= UTHROW_PERCENT) bit = Btn.Up;
  else if (victimPercent < DTHROW_PERCENT) bit = Btn.Down;
  else bit = forwardBit;
  // The hold reads a fresh press, so a direction still held from before is let go for a frame.
  if ((mem.prevHeld & bit) !== 0) {
    mem.dirHeld = 0;
    return 0;
  }
  mem.dirHeld = bit;
  return 0;
}

/**
 * Frames until a launched fighter's feet touch a platform top, or -1 when nothing is under it
 * inside `maxLook`. Stepped the way sim/physics.ts moves it: knockback decay while hitstun lasts
 * (the sim ticks hitstun down before it moves the fighter), plain gravity after, no drift. The
 * launch speed and direction are sim-side fields on the object the sim steps, so reading them is
 * reading the game state, the same way holdDecision reads the grab timer.
 */
function framesToLanding(state: GameState, me: FighterState, maxLook: number): number {
  if (me.onGround) return 0;
  const stage = STAGE_DEFS[state.stageId];
  const def = CHARACTER_DEFS[me.charId];
  if (!stage || !def) return -1;
  const sim = me as SimFighter;
  const cap = me.fastFalling ? def.fastFall : def.maxFall;
  let x = me.x;
  let y = me.y;
  let vx = me.vx;
  let vy = me.vy;
  let kbSpeed = sim.kbSpeed;
  let kbFall = sim.kbFall;
  for (let k = 1; k <= maxLook; k++) {
    if (me.hitstun - k > 0) {
      kbSpeed = Math.max(0, kbSpeed - TUNING.knockback.decay);
      kbFall = Math.min(def.maxFall, kbFall + def.gravity);
      vx = sim.kbDirX * kbSpeed;
      vy = sim.kbDirY * kbSpeed + kbFall;
    } else {
      vy = Math.min(vy + def.gravity, Math.max(cap, vy));
    }
    const prevY = y;
    x += vx;
    y += vy;
    if (vy < 0) continue;
    for (let i = 0; i < stage.platforms.length; i++) {
      const p = stage.platforms[i];
      if (x < p.x || x > p.x + p.w || y < p.y || prevY > p.y + 0.001) continue;
      if (!p.solid && sim.dropTimer - k > 0) continue;
      return k;
    }
  }
  return -1;
}

/**
 * Which way a tech rolls. Near the edge the roll goes toward the middle, since a tech in place
 * there is a free ledge trap; otherwise disciplined profiles mix in place with both rolls so the
 * getup cannot be covered on reflex, and the rest simply stay where they land.
 */
function techDirFor(prof: CpuProfile, rand: () => number, me: FighterState, g: GroundInfo): number {
  const inward = me.x < (g.minX + g.maxX) / 2 ? Btn.Right : Btn.Left;
  if (me.x < g.minX + EDGE_ROLL || me.x > g.maxX - EDGE_ROLL) {
    return rand() < 0.5 + 0.5 * prof.mixupRate ? inward : 0;
  }
  const r = rand();
  if (r < 0.3 * prof.mixupRate) return Btn.Left;
  if (r < 0.6 * prof.mixupRate) return Btn.Right;
  return 0;
}

/**
 * The tech, run every real frame while tumbling, outside the decision cadence: a tech is a timing
 * and a level 1's 14-frame thinking period is longer than half the window. Once per airtime, when
 * the landing is TECH_LOOK frames out, the profile rolls for it; an armed tech presses Shield once,
 * after any lockout from an earlier press has run out so the press actually counts. Returns the
 * pulse; cpuInput holds mem.techDir into the landing for as long as the plan is live.
 */
function planTech(state: GameState, prof: CpuProfile, rand: () => number, me: FighterState, mem: CpuMem): number {
  if (mem.techPlan === TECH_PRESSED) {
    mem.techAge++;
    if (mem.techAge < TECH.window) return 0;
    // Still in the air with the window closed (a second hit, a bad read): think again.
    mem.techPlan = TECH_UNROLLED;
  }
  if (mem.techPlan === TECH_DECLINED) return 0;
  const land = framesToLanding(state, me, TECH_LOOK);
  // Hitlag freezes the fighter without freezing the clock the prediction counts in.
  if (land < 0 || land + me.hitlag > TECH_LOOK) return 0;
  if (mem.techPlan === TECH_UNROLLED) {
    if (rand() >= 0.05 + 0.95 * prof.diQuality) {
      mem.techPlan = TECH_DECLINED;
      return 0;
    }
    mem.techPlan = TECH_ARMED;
    mem.techDir = techDirFor(prof, rand, me, getGround(state.stageId));
  }
  // consumeInput ticks the lockout before it reads the press, so a lockout of 1 has already expired.
  if ((me as SimFighter).techLockout > 1) return 0;
  // The output stage keeps Shield released while launched, so waiting a frame makes the press fresh.
  if ((mem.prevHeld & Btn.Shield) !== 0) return 0;
  mem.techPlan = TECH_PRESSED;
  mem.techAge = 0;
  return Btn.Shield;
}

/**
 * Lying downed. The wait before acting is drawn once per knockdown: a weak profile lies there for
 * most of KNOCKDOWN.maxFrames, a strong one moves on reaction. Then a get-up attack if the opponent
 * is inside its reach, a roll toward the middle when the edge is close (or as a mixup), and a plain
 * stand otherwise. The sim reads the get-up directions as presses, so a direction still held from
 * DI is let go for a frame first.
 */
function getUpDecision(
  prof: CpuProfile, rand: () => number, me: FighterState, opp: FighterState | null, mem: CpuMem, g: GroundInfo,
): number {
  mem.dirHeld = 0;
  if (mem.downWait < 0) {
    const most = Math.round(KNOCKDOWN.maxFrames * (1 - prof.diQuality));
    mem.downWait = reactFrames(prof) + Math.floor(rand() * (most + 1));
  }
  if (mem.downWait > 0) return 0;

  let bit = Btn.Up;
  const gu = myMove(me, 'getupatk');
  if (gu !== null && opp !== null && opp.invuln === 0 && Math.abs(opp.y - me.y) < 30 &&
      Math.abs(opp.x - me.x) <= moveSpan(gu) + hurtHalfWidth(opp) &&
      rand() < 0.4 + 0.6 * prof.punishChance) {
    bit = Btn.Attack;
  } else {
    const inward = me.x < (g.minX + g.maxX) / 2 ? Btn.Right : Btn.Left;
    const nearEdge = me.x < g.minX + EDGE_ROLL || me.x > g.maxX - EDGE_ROLL;
    if (nearEdge || rand() < 0.4 * prof.mixupRate) bit = inward;
  }
  if ((mem.prevHeld & bit) !== 0) return 0;
  return bit;
}

/**
 * The fighter whose head our feet are on right now, by the sim's own footstool reach
 * (sim/footstool.ts), or null. Present state only: the command is consumed next frame and simply
 * does nothing if the head has moved away by then.
 */
const STOOL_HURT: Rect = { x: 0, y: 0, w: 0, h: 0 };
function footstoolTarget(state: GameState, slot: number, me: FighterState): FighterState | null {
  for (let i = 0; i < state.fighters.length; i++) {
    const v = state.fighters[i];
    if (v.slot === slot || sameTeam(state, slot, v.slot) || v.stocks <= 0 || !canBeHit(v as SimFighter)) continue;
    if (v.action === 'grabbed' || v.action === 'finalSmashVictim' || isLedgeAction(v.action)) continue;
    const def = CHARACTER_DEFS[v.charId];
    if (!def) continue;
    fighterHurtbox(v, def, STOOL_HURT);
    const above = STOOL_HURT.y - me.y;
    if (above < 0 || above > FOOTSTOOL.reachY) continue;
    if (Math.abs(me.x - v.x) > STOOL_HURT.w / 2 + FOOTSTOOL.reachX) continue;
    return v;
  }
  return null;
}

/**
 * Footstool, run every real frame: the reach is a 12 px band a falling fighter crosses in a few
 * frames. Rolled once per head. Worth it against someone airborne near a ledge or already off the
 * stage, where the push down is a real threat and the jump back costs nothing; almost never on the
 * ground or in the middle, where it only hands them a reset. Footstooling grounded heads at the
 * ledge measurably cost the level 9 profile games against level 5 in the matrix. Sent as the footstool command rather than a Jump press, so a
 * head that slips away turns into nothing instead of a spent double jump. True when sent.
 */
function wantsFootstool(state: GameState, slot: number, prof: CpuProfile, rand: () => number, me: FighterState, mem: CpuMem): boolean {
  if (me.onGround || me.action !== 'air' || me.hitstun > 0 || me.hitlag > 0) { mem.stoolRolled = 0; return false; }
  const v = footstoolTarget(state, slot, me);
  if (v === null) { mem.stoolRolled = 0; return false; }
  if (mem.stoolRolled === 1 || prof.comboChance < FOOTSTOOL_COMBO) return false;
  mem.stoolRolled = 1;
  const g = getGround(state.stageId);
  // Only an airborne head is a real threat: the push down is what costs a recovering opponent the
  // stock. A grounded one near the ledge just stands back up 30 frames later with us above it.
  const exposed = !v.onGround &&
    (v.x < g.minX + FOOTSTOOL_LEDGE_NEAR || v.x > g.maxX - FOOTSTOOL_LEDGE_NEAR || v.y > g.topY);
  const urge = exposed ? 0.5 + 0.5 * prof.comboChance : FOOTSTOOL_RARE * prof.comboChance;
  return rand() < urge;
}

/**
 * True when the Final Smash's own 'nearestFacing' pick (sim/finalsmash.ts pickTarget, which does not
 * skip teammates) would land on a teammate right now.
 */
function fsCatchIsTeammate(state: GameState, slot: number, me: FighterState): boolean {
  let bestD = -1;
  let teammate = false;
  for (let i = 0; i < state.fighters.length; i++) {
    const v = state.fighters[i];
    if (v.slot === slot || v.stocks <= 0 || v.action === 'dead' || v.action === 'respawn' ||
        v.action === 'finalSmash' || v.action === 'finalSmashVictim') continue;
    const dx = v.x - me.x;
    if (dx * me.facing < -8) continue;
    const dy = v.y - me.y;
    const d = dx * dx + dy * dy;
    if (bestD >= 0 && d >= bestD) continue;
    bestD = d;
    teammate = sameTeam(state, slot, v.slot);
  }
  return teammate;
}

/**
 * Final Smash, run every real frame. Under the rule with a full meter: wait the profile's random
 * patience out, never spend it while off the stage, face the nearest opponent (holding toward them
 * turns a grounded fighter for a frame; in the air the facing we have is the one we keep), prefer
 * an opponent who is not invulnerable, then press Special. Returns the pulse, with mem.dirHeld set,
 * or -1 when this frame is not the Final Smash's.
 */
function finalSmashInput(state: GameState, slot: number, prof: CpuProfile, rand: () => number, me: FighterState, mem: CpuMem): number {
  const def = CHARACTER_DEFS[me.charId];
  if (state.config.finalSmash !== true || me.fsMeter < FS_METER.max || !def || def.finalSmash === undefined) {
    mem.fsDelay = -1;
    mem.fsWait = 0;
    return -1;
  }
  if (mem.fsDelay < 0) mem.fsDelay = Math.floor(rand() * (prof.fsPatience + 1));
  if (mem.fsDelay > 0) { mem.fsDelay--; return -1; }
  const opp = nearestOpponent(state, slot, me);
  if (opp === null) return -1;
  const g = getGround(state.stageId);
  if (me.x <= g.minX || me.x >= g.maxX || me.y > g.topY + 4) return -1;
  if (!canFinalSmash(state, me as SimFighter, def)) return -1;
  if ((opp.invuln > 0 || opp.action === 'respawn') && mem.fsWait < FS_INVULN_WAIT) { mem.fsWait++; return -1; }

  mem.orbHold = 0; mem.chargeFrames = 0; mem.chargePending = 0; mem.smashPending = 0; mem.tiltFrames = 0;
  mem.jabPending = 0; mem.shieldTimer = 0; mem.jumpHold = 0; mem.uairPhase = 0; mem.bairPhase = 0;
  mem.counterWait = 0;
  mem.dirHeld = 0;
  // The catch picks whoever is in front, up to 8 px behind the feet (sim/finalsmash.ts), and it does
  // not know about teams: hold the meter while a teammate is the one it would catch.
  if (fsCatchIsTeammate(state, slot, me)) return -1;
  if ((opp.x - me.x) * me.facing < -8) {
    if (!me.onGround) return -1;
    mem.dirHeld = opp.x < me.x ? Btn.Left : Btn.Right;
    return 0;
  }
  if ((mem.prevHeld & Btn.Special) !== 0) return 0;
  return Btn.Special;
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
    // An armed tech owns the landing: jumping out of the tumble now would throw it away.
    if ((mem.techPlan === TECH_ARMED || mem.techPlan === TECH_PRESSED) &&
        framesToLanding(state, me, TECH.window) >= 0) {
      return 0;
    }
    return Btn.Jump;
  }

  if (me.action === 'downed') {
    mem.egPhase = 0;
    return getUpDecision(prof, rand, me, opp, mem, ground);
  }
  // Nothing to decide while someone else owns the fighter: footstooled, or either side of a Final
  // Smash. Anything pressed would only sit in a buffer the sim keeps clearing.
  if (me.action === 'footstooled' || me.action === 'finalSmash' || me.action === 'finalSmashVictim') {
    mem.dirHeld = 0;
    mem.egPhase = 0;
    return 0;
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
      // Ledge roll is the Dodge button; it comes up past someone standing on the ledge.
      if (close && mem.dodgeCd === 0 && rand() < 0.3 * prof.dodgeSkill) {
        mem.dodgeCd = DODGE_COOLDOWN;
        return Btn.Dodge;
      }
      return Btn.Up;
    }
    return 0;
  }

  // Holding someone: pummel while the hold can afford it, then throw.
  if (me.action === 'grabHold') {
    mem.egPhase = 0;
    return holdDecision(state, prof, rand, me, mem, ground);
  }
  // The rest of a grab runs on its own; anything pressed now would only sit in the buffer.
  if (me.action === 'grab' || me.action === 'pummel' || me.action === 'throw') {
    mem.dirHeld = 0;
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
    // Just past the corner and high over the lip, drifting home lands on the stage by itself; an up
    // special there only swings at whoever stands below.
    const edgeOut = me.x < ground.minX ? ground.minX - me.x : me.x > ground.maxX ? me.x - ground.maxX : 0;
    const driftsHome = edgeOut < 30 && me.y < ground.topY - 100;
    if (me.jumpsLeft === 0 && me.vy > 0 && me.action === 'air' && !driftsHome) return Btn.Special | Btn.Up;
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
      mem.dirHeld = towardBit | Btn.Walk;
      // Walk off toward a low opponent; hop out to meet one still near stage level.
      if (me.onGround && Math.abs(me.x - corner) < 26 && opp.y < ground.topY + 8) return Btn.Jump;
      return 0;
    }
  }

  // A fired counter-shot owns the frames until its move starts: any new press would replace the
  // buffered one, and out of a shield it waits a frame for the shield to drop.
  if (mem.counterWait > 0) return 0;

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
    // Mode 3 is the dash commitment and runs; the plain relocation walks, as it always did.
    mem.dirHeld = mem.forceMode === 3 ? bit : bit | Btn.Walk;
    return 0;
  }

  if (me.onGround) {
    return groundFight(state, slot, prof, rand, me, opp, mem, ground, dy, adx, towardBit, awayBit, towardNum);
  }
  return airFight(prof, rand, me, opp, mem, ground, dy, adx, towardBit, awayBit, towardNum);
}

/**
 * Holds back a direction press that the sim would read as the second tap of a double tap: Left or
 * Right again inside the roll tap window is a roll, Down again is a spot dodge. The press simply
 * waits until the window has passed. A press that shares its frame with a button that starts an
 * action is let through, because that action is taken before locomotion ever looks at the tap;
 * that covers every deliberate dodge, which is a Dodge press. Mirrors sim/input.ts consumeInput:
 * the press being built now is consumed on frame state.frame + 1.
 */
function guardTaps(state: GameState, me: FighterState, mem: CpuMem, held: number): number {
  let pressed = held & ~mem.prevHeld;
  if ((pressed & TAP_CONSUMERS) !== 0) return held;
  const now = state.frame + 1;
  const span = TUNING.input.rollTapWindow + TAP_GUARD_SLACK;
  if ((pressed & Btn.Left) !== 0 && mem.lastLeftPress > mem.lastRightPress &&
      now - mem.lastLeftPress <= span) {
    held &= ~Btn.Left;
    pressed &= ~Btn.Left;
  }
  if ((pressed & Btn.Right) !== 0 && (pressed & Btn.Left) === 0 &&
      mem.lastRightPress > mem.lastLeftPress && now - mem.lastRightPress <= span) {
    held &= ~Btn.Right;
  }
  // On a pass-through platform a second Down drops through before it could spot dodge.
  if ((pressed & Btn.Down) !== 0 && (pressed & Btn.Up) === 0 &&
      mem.lastDownPress > mem.lastUpPress && now - mem.lastDownPress <= span &&
      !onSoftPlatform(state, me)) {
    held &= ~Btn.Down;
  }
  return held;
}

/** Records this frame's direction presses the way the sim's tap timers will, and counts deliberate rolls. */
function trackTaps(state: GameState, me: FighterState | null, mem: CpuMem, held: number): void {
  const pressed = held & ~mem.prevHeld;
  const now = state.frame + 1;
  if ((pressed & Btn.Left) !== 0) mem.lastLeftPress = now;
  else if ((pressed & Btn.Right) !== 0) mem.lastRightPress = now;
  if ((pressed & Btn.Up) !== 0) mem.lastUpPress = now;
  else if ((pressed & Btn.Down) !== 0) mem.lastDownPress = now;
  if (me !== null && me.onGround && (pressed & Btn.Dodge) !== 0 && (held & (Btn.Left | Btn.Right)) !== 0) {
    mem.intendedRolls++;
  }
}

/**
 * Level 0: a training dummy, not a difficulty. It never attacks, shields, dodges, grabs or taunts,
 * whatever the rules say. With the cpuZeroMoves rule off it presses nothing at all and simply
 * stands where it spawned; with the rule on it wanders the stage on walk, run and jump alone,
 * turning back from the ledges and recovering if it does end up in the air off-stage.
 *
 * Every roll comes off the passed-in `rand` and every timer lives in the slot's CpuMem, so a
 * level 0 replays exactly as deterministically as any other CPU.
 */
function dummyInput(state: GameState, slot: number, rand: () => number, out: InputFrame): InputFrame {
  out.held = 0;
  out.pressed = 0;
  out.released = 0;
  out.direct = 0;

  const mem = memSlots[slot];
  // Level 0 returns before cpuInput's own match-identity check runs, so it repeats it here: wander
  // timers left over from the previous match would stop an identical seed replaying identically.
  if (mem.matchRef !== null &&
      (state.config !== mem.matchRef || state.frame + MATCH_RESET_SLACK < mem.matchFrame)) {
    initMem(mem);
  }
  mem.matchRef = state.config;
  mem.matchFrame = state.frame;

  if (state.config.cpuZeroMoves !== true) return out;
  const me = fighterBySlot(state, slot);
  if (me === null) return out;
  const g = getGround(state.stageId);

  if (mem.wanderTimer > 0) mem.wanderTimer--;
  if (mem.wanderJumpCd > 0) mem.wanderJumpCd--;

  // A level 0 that tumbles in without teching would otherwise lie downed for the full
  // KNOCKDOWN.maxFrames: dummyInput never pressed anything else while downed. Jump, Shield or Up
  // stands it up (see stepDowned in sim/tech.ts); Attack would throw a get-up attack and a
  // direction would roll, so only Jump is ever pressed here, and only once every WANDER_JUMP_CD
  // frames so a downed level 0 does not mash it every single frame.
  if (me.action === 'downed') {
    if (mem.wanderJumpCd === 0) {
      out.held = Btn.Jump;
      out.pressed = Btn.Jump;
      mem.wanderJumpCd = WANDER_JUMP_CD;
    }
    return out;
  }

  // A fresh plan only ever starts on the frame the old one ran out, which is the only frame a
  // WANDER_JUMP is allowed to press Jump on; the rest of its timer is spent standing.
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

  // Edge safety: heading at a ledge from close enough to walk off it turns the plan around instead.
  if (me.onGround) {
    if ((mem.wanderDir < 0 && me.x < g.minX + WANDER_EDGE) ||
        (mem.wanderDir > 0 && me.x > g.maxX - WANDER_EDGE)) {
      mem.wanderDir = -mem.wanderDir;
    }
  }

  const offStage = !me.onGround &&
    (me.x < g.minX || me.x > g.maxX || me.y > g.topY + WANDER_FALL);

  let held = 0;
  let pressed = 0;
  if (offStage) {
    // Drift back toward the middle, and spend a jump on the way down. Never Down: a fast fall out
    // here is the one input that turns a recoverable fall into a self-destruct.
    const mid = (g.minX + g.maxX) * 0.5;
    held |= me.x < mid ? Btn.Right : Btn.Left;
    if (me.jumpsLeft > 0 && me.vy > 0 && mem.wanderJumpCd === 0) {
      held |= Btn.Jump;
      pressed |= Btn.Jump;
      mem.wanderJumpCd = WANDER_JUMP_CD;
    }
  } else if (mem.wanderMode === WANDER_WALK) {
    held |= Btn.Walk | (mem.wanderDir < 0 ? Btn.Left : Btn.Right);
  } else if (mem.wanderMode === WANDER_RUN) {
    held |= mem.wanderDir < 0 ? Btn.Left : Btn.Right;
  } else if (mem.wanderMode === WANDER_JUMP && picked) {
    held |= Btn.Jump;
    pressed |= Btn.Jump;
  }

  out.held = held;
  out.pressed = pressed;
  return out;
}

export function cpuInput(state: GameState, slot: number, level: number, rand: () => number): InputFrame {
  const frame = inputFrames[slot];
  // Level 0 is a dummy, not a difficulty: it is answered here and never sees a profile.
  if (level <= 0) return dummyInput(state, slot, rand, frame);
  // Level 10 and up is Aevalmere, the search-based brain in ./aevalmere.ts. It keeps its own
  // per-slot memory; the profile table below only ever serves levels 1 to 9.
  if (level >= 10) {
    // Lazily, on the first level 10 frame of a match. A no-op once this config is warm, including
    // when the host already warmed it before frame 0.
    warmAevalmere(state.config);
    return aevalmereInput(state, slot, rand, frame);
  }
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
  // A hold's pummel plan belongs to that hold; the next catch rolls a fresh one.
  if (me === null || (me.action !== 'grabHold' && me.action !== 'pummel')) mem.pummelGoal = -1;

  if (mem.dodgeCd > 0) mem.dodgeCd--;
  // A get-up wait belongs to one knockdown; the next one draws its own.
  if (me === null || me.action !== 'downed') mem.downWait = -1;
  else if (mem.downWait > 0) mem.downWait--;
  if (mem.counterWait > 0) {
    // Released once the move is under way, or the moment anything else has taken the fighter.
    if (me === null || me.action === 'attack' || me.hitstun > 0 || !me.onGround) mem.counterWait = 0;
    else mem.counterWait--;
  }
  if (mem.jumpHold > 0) mem.jumpHold--;
  if (me === null || me.action === 'dead') {
    mem.chargeFrames = 0; mem.chargePending = 0; mem.orbHold = 0;
  }
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

    // A charge is only free while nothing can reach us. The fighter is rooted with actionFrame
    // pinned at 0 for every frame of it, so the instant the opponent closes, starts something, or
    // puts a projectile in the air, let go: an early orb beats a charged one that never comes out.
    if (mem.orbHold > 0) {
      const charging = me.action === 'attack' && me.moveId === 'nspecial' && me.hitstun === 0;
      let bail = !charging;
      if (!bail && foe !== null) {
        const gap = Math.abs(foe.x - me.x);
        if (gap < orbSafeRange(me, foe)) bail = true;
        else if ((foe.x - me.x) * foe.vx < -0.2) bail = true;
        else if (inStartup(foe)) bail = true;
        else if (!foe.onGround && gap < ORB_RANGE) bail = true;
      }
      if (!bail && incomingProjectile(state, slot, me) >= 0) bail = true;
      if (bail) mem.orbHold = 0;
    }

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

  // Read off what was actually sent last frame, not what was intended: the output stage can hold
  // a press back, and a tilt timed off a Down the sim never saw comes out as a smash.
  const curVert = mem.prevHeld & (Btn.Up | Btn.Down);
  if (curVert !== 0 && curVert === mem.vertBit) mem.vertFrames++;
  else { mem.vertBit = curVert; mem.vertFrames = curVert !== 0 ? 1 : 0; }

  // The gate as it stood before this frame's decision. The decision itself arms it when it
  // throws an aerial, so reading it afterwards would veto that aerial on the spot.
  const gateBefore = mem.aerialCd;

  // Launched: in tumble, or airborne in hitstun that is still running. Nothing but the deliberate
  // tech is pressed as a tech press while launched. The tech itself is only planned for a tumble:
  // a plain hitstun landing never becomes a knockdown, so there is nothing to save it from, and the
  // plan lives exactly as long as the tumble's airtime does.
  const launched = me !== null && !me.onGround &&
    (me.action === 'tumble' || (me.action === 'hitstun' && me.hitstun > 0));
  let techPulse = 0;
  if (launched && me !== null && me.action === 'tumble') {
    techPulse = planTech(state, prof, rand, me, mem);
  } else {
    mem.techPlan = TECH_UNROLLED;
    mem.techDir = 0;
    mem.techAge = 0;
  }

  // Final Smash and footstool run every real frame, outside the decision cadence, like the tech.
  let fsPulse = -1;
  let stool = false;
  if (me !== null && me.action !== 'dead' && me.stocks > 0 && me.action !== 'grabbed') {
    fsPulse = finalSmashInput(state, slot, prof, rand, me, mem);
    if (fsPulse < 0) stool = wantsFootstool(state, slot, prof, rand, me, mem);
  }

  let pulse = 0;
  if (!me || me.action === 'dead' || me.stocks <= 0) {
    mem.dirHeld = 0;
    mem.cooldown = 0;
    mem.smashPending = 0;
    mem.jabPending = 0;
    mem.egPhase = 0;
  } else if (me.action === 'grabbed') {
    // Mashing runs every frame, outside the decision cadence: each fresh press takes frames off
    // the hold. A different bit every time, so each one is a press and never a stale hold.
    mem.dirHeld = 0;
    mem.smashPending = 0; mem.chargePending = 0; mem.chargeFrames = 0; mem.orbHold = 0;
    mem.jabPending = 0; mem.jumpHold = 0; mem.shieldTimer = 0; mem.tiltFrames = 0;
    if (rand() < 0.1 + 0.9 * prof.diQuality) {
      let idx = Math.min(MASH_BITS.length - 1, Math.floor(rand() * MASH_BITS.length));
      for (let k = 0; k < MASH_BITS.length && (MASH_BITS[idx] & (mem.mashLast | mem.prevHeld)) !== 0; k++) {
        idx = (idx + 1) % MASH_BITS.length;
      }
      pulse = MASH_BITS[idx];
      mem.mashLast = pulse;
    } else {
      mem.mashLast = 0;
    }
  } else if (fsPulse >= 0) {
    // A full meter is spent before anything else is thought about; finalSmashInput set the facing.
    pulse = fsPulse;
  } else if (mem.jabPending !== 0) {
    // The Attack held back off a run last frame: the run has let go into a skid by now, so this
    // press reads as the jab or tilt that was meant rather than a dash attack.
    mem.jabPending = 0;
    if (me.onGround && me.hitstun === 0) pulse = Btn.Attack;
  } else if (mem.smashPending !== 0 && (!me.onGround || me.action === 'jumpsquat')) {
    // The fighter left the ground between queueing the smash and firing it: a jumpsquat that
    // took off, a walk-off, a platform that dropped away. Attack from here is an aerial, not a
    // smash, and one fired off this path would bypass the aerial cooldown entirely, because it
    // skips the whole decision cadence. Drop the queue and let the next decision think again.
    mem.smashPending = 0;
    mem.chargePending = 0;
    mem.dirHeld = 0;
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
  // A charge only exists on the ground. Airborne or in jumpsquat the held Attack is an aerial,
  // so drop the charge and let the aerial gate below see the press.
  if (mem.chargeFrames > 0 && me !== null && (!me.onGround || me.action === 'jumpsquat')) {
    mem.chargeFrames = 0;
  }
  if (mem.chargeFrames > 0) {
    held |= Btn.Attack;
    mem.chargeFrames--;
  }
  // The orb charges on Special exactly the way a smash charges on Attack: a hold, not a press.
  if (mem.orbHold > 0) {
    held |= Btn.Special;
    mem.orbHold--;
  }
  // An Attack pressed while grounded is only resolved when the buffer is spent, which may be
  // after a walk-off, a platform drop or a bump into the air. While the aerial gate is up, never
  // let one out from anywhere the fighter could be airborne by then.
  // A pummel is not an attack that can turn into an aerial, so a hold is exempt.
  const holding = me !== null && (me.action === 'grabHold' || me.action === 'pummel');
  // Neither is a get-up attack, and a downed fighter's presses never reach locomotion's tap reads.
  const lying = me !== null && me.action === 'downed';
  if (gateBefore > 0 && mem.chargeFrames === 0 && me !== null && me.onGround && !holding && !lying &&
      (held & Btn.Attack) !== 0) {
    const edge = getGround(state.stageId);
    if (mem.attackLock === 1 || me.x < edge.minX + 24 || me.x > edge.maxX - 24 ||
        onSoftPlatform(state, me)) {
      held &= ~Btn.Attack;
    }
  }
  if (mem.shieldTimer > 0) {
    held |= Btn.Shield;
    // A plain block has to stay a plain block: a direction pressed under Shield can still double
    // tap into a roll or spot dodge, and one held as the shield drops is a dash out of it.
    held &= ~(Btn.Left | Btn.Right | Btn.Down);
  }
  if (launched) {
    // Shield and Dodge are tech presses, and every one starts TECH.lockout. The only one sent while
    // launched is the deliberate tech, so no stray block or dodge can lock that tech out.
    held &= ~(Btn.Shield | Btn.Dodge);
    // The landing reads the held direction: none techs in place, one tech rolls that way.
    if (mem.techPlan === TECH_ARMED || mem.techPlan === TECH_PRESSED) {
      held = (held & ~(Btn.Left | Btn.Right)) | mem.techDir;
    }
    held |= techPulse;
  }
  if (stool) {
    // The command owns this frame. A fresh Attack or Special beside it would still sit in the buffer
    // and come out of the jump as an aerial nobody decided on; holds are left as they are.
    held &= ~(Btn.Attack | Btn.Special | Btn.Dodge | Btn.Jump) | mem.prevHeld;
  }

  if (me !== null && me.onGround && me.action !== 'grabbed' && !holding && !lying) {
    // Attack out of a dash or run is a dash attack whatever else is held. When the decision wanted
    // a jab or a walked tilt instead, hold the press one frame: letting go of the run (or holding
    // Walk) turns it into a skid or a walk first, and the press lands on that.
    const running = me.action === 'dash' || me.action === 'run';
    const attackNow = (held & ~mem.prevHeld & Btn.Attack) !== 0;
    const horiz = held & (Btn.Left | Btn.Right);
    if (running && attackNow && mem.chargeFrames === 0 && (held & (Btn.Up | Btn.Down)) === 0 &&
        (horiz === 0 || (held & Btn.Walk) !== 0)) {
      held &= ~Btn.Attack;
      mem.jabPending = 1;
    }
    held = guardTaps(state, me, mem, held);
  }
  trackTaps(state, me, mem, held);

  frame.pressed = held & ~mem.prevHeld;
  frame.released = mem.prevHeld & ~held;
  frame.held = held;
  frame.direct = stool ? FOOTSTOOL_CODE : 0;
  mem.prevHeld = held;
  return frame;
}
