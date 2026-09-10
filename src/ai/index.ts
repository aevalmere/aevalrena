import type { FighterState, GameState, InputFrame } from '../core/types';
import { Btn, MAX_PLAYERS } from '../core/types';
import { TUNING } from '../core/constants';
import { STAGE_DEFS } from '../stages/registry';

// Per-slot scratch state. Preallocated once; cpuInput only mutates these, never allocates.
interface CpuMem {
  prevHeld: number;
  dirHeld: number;      // persistent movement/hold bits carried between decisions
  cooldown: number;     // raw frames left before the next decision
  shieldTimer: number;  // raw frames left forcing Shield held (level 3 defense)
  aerialCd: number;     // real frames left before another aerial attack from this slot
  dashPhase: number;    // 0/1 toggle used to fake a tap-release-tap dash approach
  uairPhase: number;    // 0 idle, 1 = jumped intending to follow up with uair
  vertBit: number;      // Btn.Up or Btn.Down currently being held toward a tilt, or 0
  vertFrames: number;   // consecutive real frames vertBit has been held continuously
  smashPending: number; // direction bit released this frame, to be tapped fresh next frame, or 0
}

interface GroundInfo { minX: number; maxX: number; topY: number }

/**
 * Frames a held direction must age past a fresh press before Attack is safe from a smash. Read
 * live off TUNING (never baked into a frozen constant) so the debug panel's smash window slider
 * still has an effect.
 */
function turnHoldFrames(): number { return TUNING.input.smashTapWindow + 3; }
/** Real frames between aerial attacks from the same slot (spec: 45, plus a small safety margin). */
const AERIAL_COOLDOWN = 46;
/** Never approach closer than this to a ledge we are targeting. */
const LEDGE_STOP = 30;
/** Back off if somehow drifted well past the stop distance toward the edge. */
const LEDGE_BACKOFF = LEDGE_STOP - 10;
/** How far mid-range counts, for a level 1 neutral special roll. */
const MID_RANGE_MIN = 34;
const MID_RANGE_MAX = 120;

const inputFrames: InputFrame[] = [];
const memSlots: CpuMem[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
  inputFrames.push({ held: 0, pressed: 0, released: 0 });
  memSlots.push({
    prevHeld: 0, dirHeld: 0, cooldown: 0, shieldTimer: 0, aerialCd: 0,
    dashPhase: 0, uairPhase: 0, vertBit: 0, vertFrames: 0, smashPending: 0,
  });
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
  const info: GroundInfo = { minX, maxX, topY };
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
 * A CPU can't reach an opponent hanging, climbing or rolling off a ledge by walking toward their
 * real (off-stage) position, and must never dash there. Treat the ledge as if the opponent stood
 * 24 px inward, walk over, and stop 30 px short of the edge. Once in range, poke with dtilt, or
 * at level 3 with the opponent deep in percent, an armed forward smash toward the edge.
 */
function ledgeApproach(
  level: number, opp: FighterState, mem: CpuMem, me: FighterState, cornerX: number, inward: number,
): number {
  const towardEdgeBit = inward === 1 ? Btn.Left : Btn.Right;
  const stageBit = inward === 1 ? Btn.Right : Btn.Left;
  const distInward = (me.x - cornerX) * inward;

  if (distInward > LEDGE_STOP) {
    mem.dirHeld = towardEdgeBit;
    return 0;
  }
  if (distInward < LEDGE_BACKOFF) {
    mem.dirHeld = stageBit;
    return 0;
  }

  if (level === 3 && opp.percent > 80) {
    return queueSmash(mem, towardEdgeBit);
  }
  mem.dirHeld = Btn.Down;
  if (mem.vertBit === Btn.Down && mem.vertFrames >= turnHoldFrames()) return Btn.Attack;
  return 0;
}

// Grounded fighting: defense, uair setup, approach with edge clamp, close-range attack choice.
function groundFight(
  level: number, rand: () => number, me: FighterState, opp: FighterState, mem: CpuMem,
  ground: GroundInfo, dy: number, adx: number, towardBit: number, awayBit: number, towardNum: number,
): number {
  if (level === 3 && me.hitstun === 0 && (me.action === 'idle' || me.action === 'walk') &&
      opp.action === 'attack' && opp.actionFrame < 6 && adx < 60) {
    const roll = rand();
    if (roll < 0.35) { mem.shieldTimer = 12; mem.dirHeld = 0; return 0; }
    if (roll < 0.5) { mem.dirHeld = awayBit; return Btn.Shield; }
  }

  // Opponent is overhead: levels 2/3 prefer a grounded utilt, only sometimes jumping in for a
  // uair (gated by the shared aerial cooldown so it can't be spammed the instant it lands).
  if (dy < -50 && adx < 40) {
    if (level === 1) {
      mem.dirHeld = 0;
      return Btn.Jump;
    }
    const aerialReady = mem.aerialCd === 0;
    if (!aerialReady || rand() < 0.7) {
      mem.dirHeld = Btn.Up;
      if (mem.vertBit === Btn.Up && mem.vertFrames >= turnHoldFrames()) return Btn.Attack;
      return 0;
    }
    mem.dirHeld = 0;
    mem.uairPhase = 1;
    return Btn.Jump;
  }

  if (adx > 34) {
    if (level === 1 && adx <= MID_RANGE_MAX && adx >= MID_RANGE_MIN && rand() < 0.25) {
      mem.dirHeld = 0;
      return Btn.Special;
    }
    let dir = towardBit;
    let pulse = 0;
    const blockedLeft = dir === Btn.Left && me.x - ground.minX < 12 && opp.x >= ground.minX;
    const blockedRight = dir === Btn.Right && ground.maxX - me.x < 12 && opp.x <= ground.maxX;
    if (blockedLeft || blockedRight) {
      dir = 0;
      if (level >= 2 && adx < 140) pulse |= Btn.Jump;
    }
    if (adx <= 90 && dir !== 0 && level >= 2 && rand() < 0.02) pulse |= Btn.Special;
    if (adx > 90 && dir !== 0 && level === 3) {
      mem.dashPhase = mem.dashPhase === 0 ? 1 : 0;
      if (mem.dashPhase === 1) dir = 0;
    }
    mem.dirHeld = dir;
    return pulse;
  }

  // Close range: choose an attack, weighted by level. A tilt only fires once the held direction
  // has aged past the smash window (fix for the turn-around-produces-a-smash bug); an intentional
  // smash instead goes through queueSmash so it is a genuine fresh tap regardless of that age.
  const staleTap = me.dirTapDir === towardNum && me.dirTapAge >= turnHoldFrames();

  if (level === 1) {
    let wantSmash = opp.percent > 140;
    if (!wantSmash && opp.percent > 90) wantSmash = rand() < 0.4;
    if (wantSmash) return queueSmash(mem, towardBit);
    mem.dirHeld = towardBit;
    return staleTap ? Btn.Attack : 0;
  }

  if (level === 2) {
    if (rand() < 0.5) {
      mem.dirHeld = 0;
      return Btn.Attack;
    }
    mem.dirHeld = towardBit;
    return staleTap ? Btn.Attack : 0;
  }

  // level 3
  if (opp.percent > 60 && rand() < 0.2) {
    mem.dirHeld = towardBit;
    return staleTap ? Btn.Attack : 0;
  }
  if (rand() < 0.4) {
    mem.dirHeld = 0;
    return Btn.Attack;
  }
  mem.dirHeld = towardBit;
  return staleTap ? Btn.Attack : 0;
}

// Airborne fighting: follow-up uair, drift toward, fair/bair, occasional dair, fast fall.
// Every aerial attack start sets a cooldown so the slot cannot spam aerials (fix #3).
function airFight(
  level: number, rand: () => number, me: FighterState, mem: CpuMem,
  ground: GroundInfo, dy: number, adx: number, towardBit: number,
): number {
  if (mem.uairPhase === 1) {
    mem.uairPhase = 0;
    if (mem.aerialCd > 0) {
      mem.dirHeld = towardBit;
      return 0;
    }
    mem.dirHeld = Btn.Up;
    mem.aerialCd = AERIAL_COOLDOWN;
    return Btn.Attack;
  }
  if (me.hitstun > 0) { mem.dirHeld = 0; return 0; }

  let dir = towardBit;
  let pulse = 0;
  const ady = Math.abs(dy);

  if (mem.aerialCd === 0) {
    if (adx < 40 && ady < 40) {
      pulse |= Btn.Attack;
      mem.aerialCd = AERIAL_COOLDOWN;
    } else if (dy > 30 && level === 3 && rand() < 0.1) {
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

// Recovery, ledge climb, opponent-on-ledge targeting, and dispatch into grounded/airborne
// fighting. Returns a one-frame button pulse; persistent movement/hold bits are written into
// mem.dirHeld.
function decide(state: GameState, slot: number, level: number, rand: () => number, me: FighterState, mem: CpuMem): number {
  const opp = nearestOpponent(state, slot, me);

  if (me.action === 'ledgeHang') {
    mem.dirHeld = 0;
    if (me.actionFrame > 20) {
      if (level === 3 && rand() < 0.3) return Btn.Attack;
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

  const ground = getGround(state.stageId);
  const airborne = !me.onGround;
  const offSide = me.x < ground.minX || me.x > ground.maxX;
  const belowMain = airborne && me.y > ground.topY + 40;
  if (offSide || belowMain) {
    const center = (ground.minX + ground.maxX) / 2;
    mem.dirHeld = me.x < center ? Btn.Right : Btn.Left;
    if (me.jumpsLeft > 0 && me.vy > 0.5) return Btn.Jump;
    if (me.jumpsLeft === 0 && me.vy > 0 && me.action === 'air') return Btn.Special | Btn.Up;
    return 0;
  }

  // Recovery above runs with or without a live opponent; there is nothing left
  // to chase once every other fighter is out or waiting to respawn.
  if (!opp) { mem.dirHeld = 0; return 0; }

  if (me.onGround && opp.ledge >= 0 &&
      (opp.action === 'ledgeHang' || opp.action === 'ledgeClimb' || opp.action === 'ledgeRoll')) {
    const stage = STAGE_DEFS[state.stageId];
    const pi = opp.ledge >> 1;
    const p = stage ? stage.platforms[pi] : undefined;
    if (p) {
      const side = opp.ledge & 1;
      const cornerX = side === 0 ? p.x : p.x + p.w;
      const inward = side === 0 ? 1 : -1;
      return ledgeApproach(level, opp, mem, me, cornerX, inward);
    }
  }

  const dx = opp.x - me.x;
  const dy = opp.y - me.y;
  const adx = Math.abs(dx);
  const towardBit = dx < 0 ? Btn.Left : Btn.Right;
  const awayBit = dx < 0 ? Btn.Right : Btn.Left;
  const towardNum = dx < 0 ? -1 : 1;

  if (me.onGround) {
    return groundFight(level, rand, me, opp, mem, ground, dy, adx, towardBit, awayBit, towardNum);
  }
  return airFight(level, rand, me, mem, ground, dy, adx, towardBit);
}

export function cpuInput(state: GameState, slot: number, level: number, rand: () => number): InputFrame {
  const frame = inputFrames[slot];
  const mem = memSlots[slot];
  const me = fighterBySlot(state, slot);

  if (me && me.hitstun === 0 && mem.shieldTimer > 0) mem.shieldTimer--;
  else mem.shieldTimer = 0;

  if (mem.aerialCd > 0) mem.aerialCd--;

  const curVert = mem.dirHeld & (Btn.Up | Btn.Down);
  if (curVert !== 0 && curVert === mem.vertBit) mem.vertFrames++;
  else { mem.vertBit = curVert; mem.vertFrames = curVert !== 0 ? 1 : 0; }

  let pulse = 0;
  if (!me || me.action === 'dead' || me.stocks <= 0) {
    mem.dirHeld = 0;
    mem.cooldown = 0;
    mem.smashPending = 0;
  } else if (mem.smashPending !== 0) {
    // A smash was queued last frame (direction released that frame); pressing it fresh now,
    // alongside Attack, lands inside the sim's smash window. This bypasses the normal decision
    // cadence entirely so the fighter is only exposed for the one frame in between.
    mem.dirHeld = mem.smashPending;
    pulse = Btn.Attack;
    mem.smashPending = 0;
  } else if (mem.cooldown > 0) {
    mem.cooldown--;
  } else {
    const period = level <= 1 ? 12 : level === 2 ? 6 : 3;
    mem.cooldown = period - 1;
    pulse = decide(state, slot, level, rand, me, mem);
  }

  let held = mem.dirHeld | pulse;
  if (mem.shieldTimer > 0) held |= Btn.Shield;

  frame.pressed = held & ~mem.prevHeld;
  frame.released = mem.prevHeld & ~held;
  frame.held = held;
  mem.prevHeld = held;
  return frame;
}
