import { SHIELD_MAX } from '../core/constants';
import { createRng } from '../core/rng';
import type {
  ActionId, CharacterDef, FighterState, GameState, MatchConfig, ProjectileState, Rect, StageDef,
} from '../core/types';
import { CHARACTER_DEFS } from '../characters/registry';
import { STAGE_DEFS } from '../stages/registry';

/**
 * Sim-private extension of the frozen FighterState contract. The contract has no room
 * for the scratch values the state machine needs (up/down tap tracking, timed action
 * counters, knockback decay), so the sim stores them on the same object and copies them
 * in cloneGameState. Everything outside the sim sees a plain FighterState.
 */
export interface SimFighter extends FighterState {
  inputPressed: number;    // last InputFrame.pressed
  udTapAge: number;        // frames since the last up or down press
  udTapDir: number;        // 1 = up, -1 = down, 0 = none
  stateTimer: number;      // frames left in a timed action (land, shieldStun, getup)
  charging: boolean;       // holding a smash at charge frame 0
  shortHop: boolean;       // jump released during jumpsquat
  skipGravity: boolean;    // a move injected vy this frame, it owns the vertical speed
  prevY: number;           // feet y before this frame's integration
  dropTimer: number;       // frames left ignoring pass-through platforms
  ledgeCooldown: number;   // frames left unable to grab a ledge
  kbDirX: number;          // unit launch direction
  kbDirY: number;
  kbSpeed: number;         // remaining launch speed, px/frame
  kbFall: number;          // gravity accumulated during hitstun
}

export function defOf(f: FighterState): CharacterDef {
  return CHARACTER_DEFS[f.charId];
}

export function stageOf(state: GameState): StageDef {
  return STAGE_DEFS[state.stageId];
}

export function simFighters(state: GameState): SimFighter[] {
  return state.fighters as SimFighter[];
}

/** Enters an action and resets its frame counter. Move scratch is cleared unless attacking. */
export function setAction(f: SimFighter, action: ActionId): void {
  f.action = action;
  f.actionFrame = 0;
  if (action !== 'attack') {
    f.moveId = null;
    f.charge = 0;
    f.charging = false;
    f.hitGroups = 0;
  }
}

/** Enters an action only if the fighter is not already in it, so animations keep running. */
export function enterAction(f: SimFighter, action: ActionId): void {
  if (f.action !== action) setAction(f, action);
}

/** Feet at (x, y), body from y - h to y, centered on x. */
export function fighterHurtbox(f: FighterState, def: CharacterDef, out: Rect): Rect {
  const low = f.action === 'crouch'
    || f.action === 'ledgeHang'
    || (f.action === 'attack' && f.moveId === 'dtilt');
  const src = low ? def.crouchHurtbox : def.hurtbox;
  out.x = f.x - src.w / 2;
  out.y = f.y - src.h;
  out.w = src.w;
  out.h = src.h;
  return out;
}

function makeFighter(
  slot: number, charId: string, x: number, y: number, facing: 1 | -1, stocks: number, def: CharacterDef,
): SimFighter {
  return {
    slot,
    charId,
    x, y,
    vx: 0, vy: 0,
    facing,
    onGround: false,
    action: 'air',
    actionFrame: 0,
    moveId: null,
    charge: 0,
    percent: 0,
    stocks,
    jumpsLeft: def.jumps,
    fastFalling: false,
    hitstun: 0,
    hitlag: 0,
    invuln: 0,
    shieldHp: SHIELD_MAX,
    ledge: -1,
    ledgeRegrabs: 0,
    lastHitBy: -1,
    hitGroups: 0,
    respawnTimer: 0,
    buffer: { btn: 0, age: 0 },
    inputHeld: 0,
    dirTapAge: 999,
    dirTapDir: 0,
    inputPressed: 0,
    udTapAge: 999,
    udTapDir: 0,
    stateTimer: 0,
    charging: false,
    shortHop: false,
    skipGravity: false,
    prevY: y,
    dropTimer: 0,
    ledgeCooldown: 0,
    kbDirX: 0,
    kbDirY: 0,
    kbSpeed: 0,
    kbFall: 0,
  };
}

export function createGameState(config: MatchConfig): GameState {
  const stage = STAGE_DEFS[config.stageId];
  const fighters: FighterState[] = [];
  for (let i = 0; i < config.players.length; i++) {
    const p = config.players[i];
    const def = CHARACTER_DEFS[p.charId];
    const spawn = stage.spawns[i % stage.spawns.length];
    const facing: 1 | -1 = spawn.x > 0 ? -1 : 1;
    fighters.push(makeFighter(p.slot, p.charId, spawn.x, spawn.y, facing, config.stocks, def));
  }
  return {
    frame: 0,
    rng: createRng(config.seed),
    config,
    stageId: config.stageId,
    fighters,
    projectiles: [],
    events: [],
    finished: false,
    winner: -1,
    timeLeft: config.timeLimitSec > 0 ? Math.floor(config.timeLimitSec * 60) : -1,
    nextProjectileId: 1,
  };
}

function cloneFighter(src: SimFighter): SimFighter {
  return {
    slot: src.slot,
    charId: src.charId,
    x: src.x, y: src.y,
    vx: src.vx, vy: src.vy,
    facing: src.facing,
    onGround: src.onGround,
    action: src.action,
    actionFrame: src.actionFrame,
    moveId: src.moveId,
    charge: src.charge,
    percent: src.percent,
    stocks: src.stocks,
    jumpsLeft: src.jumpsLeft,
    fastFalling: src.fastFalling,
    hitstun: src.hitstun,
    hitlag: src.hitlag,
    invuln: src.invuln,
    shieldHp: src.shieldHp,
    ledge: src.ledge,
    ledgeRegrabs: src.ledgeRegrabs,
    lastHitBy: src.lastHitBy,
    hitGroups: src.hitGroups,
    respawnTimer: src.respawnTimer,
    buffer: { btn: src.buffer.btn, age: src.buffer.age },
    inputHeld: src.inputHeld,
    dirTapAge: src.dirTapAge,
    dirTapDir: src.dirTapDir,
    inputPressed: src.inputPressed,
    udTapAge: src.udTapAge,
    udTapDir: src.udTapDir,
    stateTimer: src.stateTimer,
    charging: src.charging,
    shortHop: src.shortHop,
    skipGravity: src.skipGravity,
    prevY: src.prevY,
    dropTimer: src.dropTimer,
    ledgeCooldown: src.ledgeCooldown,
    kbDirX: src.kbDirX,
    kbDirY: src.kbDirY,
    kbSpeed: src.kbSpeed,
    kbFall: src.kbFall,
  };
}

function cloneProjectile(src: ProjectileState): ProjectileState {
  return {
    id: src.id,
    owner: src.owner,
    defId: src.defId,
    x: src.x, y: src.y, vx: src.vx, vy: src.vy,
    facing: src.facing,
    age: src.age,
    hitSlots: src.hitSlots,
    alive: src.alive,
  };
}

function cloneConfig(src: MatchConfig): MatchConfig {
  const players: MatchConfig['players'] = [];
  for (let i = 0; i < src.players.length; i++) {
    const p = src.players[i];
    players.push({ slot: p.slot, charId: p.charId, cpu: p.cpu, cpuLevel: p.cpuLevel });
  }
  return {
    stageId: src.stageId,
    players,
    stocks: src.stocks,
    timeLimitSec: src.timeLimitSec,
    seed: src.seed,
  };
}

/** Deep copy, field by field. Used by the rollback seam and by the self test. */
export function cloneGameState(state: GameState): GameState {
  const src = simFighters(state);
  const fighters: FighterState[] = [];
  for (let i = 0; i < src.length; i++) fighters.push(cloneFighter(src[i]));
  const projectiles: ProjectileState[] = [];
  for (let i = 0; i < state.projectiles.length; i++) projectiles.push(cloneProjectile(state.projectiles[i]));
  const events = state.events.slice();
  return {
    frame: state.frame,
    rng: { s: state.rng.s },
    config: cloneConfig(state.config),
    stageId: state.stageId,
    fighters,
    projectiles,
    events,
    finished: state.finished,
    winner: state.winner,
    timeLeft: state.timeLeft,
    nextProjectileId: state.nextProjectileId,
  };
}
