import type { FighterState, GameState, InputFrame } from '../core/types';
import { Btn, MAX_PLAYERS } from '../core/types';
import { SMASH_TAP_WINDOW } from '../core/constants';
import { STAGE_DEFS } from '../stages/registry';

// Per-slot scratch state. Preallocated once; cpuInput only mutates these, never allocates.
interface CpuMem {
  prevHeld: number;
  dirHeld: number;      // persistent movement/hold bits carried between decisions
  cooldown: number;     // raw frames left before the next decision
  shieldTimer: number;  // raw frames left forcing Shield held (level 3 defense)
  aerialCd: number;     // decisions left before another close-range aerial attack
  dashPhase: number;    // 0/1 toggle used to fake a tap-release-tap dash approach
  uairPhase: number;    // 0 idle, 1 = jumped intending to follow up with uair
}

interface GroundInfo { minX: number; maxX: number; topY: number }

const inputFrames: InputFrame[] = [];
const memSlots: CpuMem[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
  inputFrames.push({ held: 0, pressed: 0, released: 0 });
  memSlots.push({ prevHeld: 0, dirHeld: 0, cooldown: 0, shieldTimer: 0, aerialCd: 0, dashPhase: 0, uairPhase: 0 });
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

function nearestOpponent(state: GameState, slot: number, me: FighterState): FighterState | null {
  let best: FighterState | null = null;
  let bestD = Infinity;
  for (let i = 0; i < state.fighters.length; i++) {
    if (i === slot) continue;
    const f = state.fighters[i];
    if (f.stocks <= 0 || f.action === 'dead') continue;
    const dx = f.x - me.x;
    const dy = f.y - me.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
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

  if (dy < -50 && adx < 40) {
    mem.dirHeld = 0;
    mem.uairPhase = level >= 2 ? 1 : 0;
    return Btn.Jump;
  }

  if (adx > 34) {
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

  // Close range: choose an attack, weighted by level.
  mem.dirHeld = 0;
  if (level === 1) return Btn.Attack;
  if (level === 2) {
    if (rand() < 0.5) return Btn.Attack;
    mem.dirHeld = towardBit;
    if (me.dirTapDir === towardNum && me.dirTapAge > SMASH_TAP_WINDOW) return Btn.Attack;
    return 0;
  }
  if (opp.percent > 60 && rand() < 0.2) {
    mem.dirHeld = towardBit;
    return Btn.Attack;
  }
  if (rand() < 0.4) return Btn.Attack;
  mem.dirHeld = towardBit;
  if (me.dirTapDir === towardNum && me.dirTapAge > SMASH_TAP_WINDOW) return Btn.Attack;
  return 0;
}

// Airborne fighting: follow-up uair, drift toward, fair/bair, occasional dair, fast fall.
function airFight(
  level: number, rand: () => number, me: FighterState, mem: CpuMem,
  ground: GroundInfo, dy: number, adx: number, towardBit: number,
): number {
  if (mem.uairPhase === 1) {
    mem.uairPhase = 0;
    mem.dirHeld = Btn.Up;
    return Btn.Attack;
  }
  if (me.hitstun > 0) { mem.dirHeld = 0; return 0; }

  let dir = towardBit;
  let pulse = 0;
  const ady = Math.abs(dy);

  if (mem.aerialCd > 0) mem.aerialCd--;
  if (adx < 40 && ady < 40 && mem.aerialCd === 0) {
    pulse |= Btn.Attack;
    mem.aerialCd = 2;
  }

  if (dy > 30 && level === 3 && rand() < 0.1) {
    dir |= Btn.Down;
    pulse |= Btn.Attack;
  }

  if (me.vy > 0) {
    const aboveStage = me.x > ground.minX && me.x < ground.maxX;
    if (dy > 100 && aboveStage) dir |= Btn.Down;
  }

  mem.dirHeld = dir;
  return pulse;
}

// Recovery, ledge climb, and dispatch into grounded/airborne fighting. Returns a one-frame
// button pulse; persistent movement/hold bits are written into mem.dirHeld.
function decide(state: GameState, slot: number, level: number, rand: () => number, me: FighterState, mem: CpuMem): number {
  const opp = nearestOpponent(state, slot, me);
  if (!opp) { mem.dirHeld = 0; return 0; }

  if (me.action === 'ledgeHang') {
    mem.dirHeld = 0;
    if (me.actionFrame > 20) {
      if (level === 3 && rand() < 0.3) return Btn.Attack;
      return Btn.Up;
    }
    return 0;
  }

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
  const me = state.fighters[slot];

  if (me && me.hitstun === 0 && mem.shieldTimer > 0) mem.shieldTimer--;
  else mem.shieldTimer = 0;

  let pulse = 0;
  if (!me || me.action === 'dead' || me.stocks <= 0) {
    mem.dirHeld = 0;
    mem.cooldown = 0;
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
