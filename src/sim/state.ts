import { SHIELD_MAX } from '../core/constants';
import { createRng } from '../core/rng';
import type {
  ActionId, CharacterDef, FighterState, FighterStats, GameState, MatchConfig, ProjectileState, Rect, StageDef, ThrowDef, ThrowId,
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
  dirRetap: boolean;       // the last direction press was a second tap of the same direction
  stateTimer: number;      // frames left in a timed action (land, shieldStun, getup)
  charging: boolean;       // holding a smash at charge frame 0
  chargeMask: number;      // buttons that keep the current move charging, 0 when it cannot charge
  shortHop: boolean;       // jump released during jumpsquat
  skipGravity: boolean;    // a move injected vy this frame, it owns the vertical speed
  prevY: number;           // feet y before this frame's integration
  dropTimer: number;       // frames left ignoring pass-through platforms
  ledgeCooldown: number;   // frames left unable to grab a ledge
  kbDirX: number;          // unit launch direction
  kbDirY: number;
  kbSpeed: number;         // remaining launch speed, px/frame
  kbFall: number;          // gravity accumulated during hitstun
  bufDirect: number;       // buffered DIRECT_CODES code, cleared whenever the buffer clears
  downRetap: boolean;      // the last down press was a second tap inside TUNING.input.rollTapWindow
  highDodge: number;       // frames left dodging every hit except low hits (the roll)
  grabPartner: number;     // fighters[] index of the other side of a grab, -1 none
  grabTimer: number;       // frames left in a hold before the victim is let go
  grabForce: boolean;      // command grab: mashing does nothing
  grabDash: boolean;       // the current grab came out of a dash or run
  activeThrow: ThrowDef | null;               // the throw in progress, immutable def data
  activeThrowId: ThrowId | 'custom' | null;
  techWindow: number;      // frames left in which a tumble landing techs
  techLockout: number;     // frames before another tech press counts
  downTimer: number;       // frames spent downed
  fsVictim: number;        // fighters[] index caught by this fighter's Final Smash, -1 none
  fsAttacker: number;      // fighters[] index whose Final Smash holds this fighter, -1 none
  // Stats scratch (results screen only; never read by gameplay).
  lastHitFrame: number;    // state.frame of the last hit taken from lastHitBy, -1 = no KO credit
  comboBy: number;         // slot of the attacker whose chain this fighter is in, -1 none
  comboCount: number;      // hits in that chain so far
  statX: number;           // x at the last stats tick, for distanceRun
  moveCounted: boolean;    // the current attack's start is already in stats.mostUsedMove
}

/** Frames after a hit in which the hitter still gets the KO credit. */
export const KO_CREDIT_FRAMES = 300;

export function emptyStats(): FighterStats {
  return {
    kos: 0, falls: 0, sds: 0,
    damageGiven: 0, damageTaken: 0, peakDamage: 0,
    maxCombo: 0, totalHits: 0, hitsTaken: 0,
    mostUsedMove: {},
    grabs: 0, throws: 0, shieldBreaks: 0, ledgeGrabs: 0, techs: 0, dodges: 0,
    shieldTime: 0, airTime: 0, groundTime: 0, distanceRun: 0, jumps: 0,
    finalSmashes: 0, finalSmashHits: 0, projectilesFired: 0, projectilesHit: 0,
    timeInLead: 0, firstBloodFrame: -1,
  };
}

function cloneStats(src: FighterStats): FighterStats {
  const moves: Record<string, number> = {};
  for (const k of Object.keys(src.mostUsedMove)) moves[k] = src.mostUsedMove[k];
  return {
    kos: src.kos, falls: src.falls, sds: src.sds,
    damageGiven: src.damageGiven, damageTaken: src.damageTaken, peakDamage: src.peakDamage,
    maxCombo: src.maxCombo, totalHits: src.totalHits, hitsTaken: src.hitsTaken,
    mostUsedMove: moves,
    grabs: src.grabs, throws: src.throws, shieldBreaks: src.shieldBreaks,
    ledgeGrabs: src.ledgeGrabs, techs: src.techs, dodges: src.dodges,
    shieldTime: src.shieldTime, airTime: src.airTime, groundTime: src.groundTime,
    distanceRun: src.distanceRun, jumps: src.jumps,
    finalSmashes: src.finalSmashes, finalSmashHits: src.finalSmashHits,
    projectilesFired: src.projectilesFired, projectilesHit: src.projectilesHit,
    timeInLead: src.timeInLead, firstBloodFrame: src.firstBloodFrame,
  };
}

/** Adds one start of `id` to the fighter's move tally. */
export function countMoveStart(f: FighterState, id: string): void {
  const m = f.stats.mostUsedMove;
  m[id] = (m[id] ?? 0) + 1;
}

/**
 * Stats for one damaging hit (melee, projectile, throw, pummel, Final Smash hit). Call it
 * before the hit changes the victim's action, so the combo check sees the pre-hit state.
 * A hit chains when the victim is still in hitstun, frozen in hitlag, held, or caught.
 */
export function recordHit(state: GameState, victim: SimFighter, attackerSlot: number, damage: number): void {
  if (state.finished) return;
  const fighters = simFighters(state);
  let attacker: SimFighter | null = null;
  for (let i = 0; i < fighters.length; i++) {
    if (fighters[i].slot === attackerSlot) attacker = fighters[i];
  }
  victim.lastHitFrame = state.frame;
  victim.stats.damageTaken += damage;
  victim.stats.hitsTaken++;
  if (attacker === null || attacker === victim) {
    victim.comboBy = -1;
    victim.comboCount = 0;
    return;
  }
  const held = victim.hitstun > 0 || victim.hitlag > 0
    || victim.action === 'grabbed' || victim.action === 'finalSmashVictim';
  if (held && victim.comboBy === attackerSlot) victim.comboCount++;
  else {
    victim.comboBy = attackerSlot;
    victim.comboCount = 1;
  }
  attacker.stats.damageGiven += damage;
  attacker.stats.totalHits++;
  if (victim.comboCount > attacker.stats.maxCombo) attacker.stats.maxCombo = victim.comboCount;
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
  if (action === 'spotDodge' || action === 'roll' || action === 'airDodge') f.stats.dodges++;
  else if (action === 'attack') f.moveCounted = false;
  f.action = action;
  f.actionFrame = 0;
  f.airJumped = false;
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
    airJumped: false,
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
    fsMeter: 0,
    inputPressed: 0,
    udTapAge: 999,
    udTapDir: 0,
    dirRetap: false,
    stateTimer: 0,
    charging: false,
    chargeMask: 0,
    shortHop: false,
    skipGravity: false,
    prevY: y,
    dropTimer: 0,
    ledgeCooldown: 0,
    kbDirX: 0,
    kbDirY: 0,
    kbSpeed: 0,
    kbFall: 0,
    bufDirect: 0,
    downRetap: false,
    highDodge: 0,
    grabPartner: -1,
    grabTimer: 0,
    grabForce: false,
    grabDash: false,
    activeThrow: null,
    activeThrowId: null,
    techWindow: 0,
    techLockout: 0,
    downTimer: 0,
    fsVictim: -1,
    fsAttacker: -1,
    stats: emptyStats(),
    lastHitFrame: -1,
    comboBy: -1,
    comboCount: 0,
    statX: x,
    moveCounted: true,
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
    endFrame: -1,
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
    airJumped: src.airJumped,
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
    fsMeter: src.fsMeter,
    inputPressed: src.inputPressed,
    udTapAge: src.udTapAge,
    udTapDir: src.udTapDir,
    dirRetap: src.dirRetap,
    stateTimer: src.stateTimer,
    charging: src.charging,
    chargeMask: src.chargeMask,
    shortHop: src.shortHop,
    skipGravity: src.skipGravity,
    prevY: src.prevY,
    dropTimer: src.dropTimer,
    ledgeCooldown: src.ledgeCooldown,
    kbDirX: src.kbDirX,
    kbDirY: src.kbDirY,
    kbSpeed: src.kbSpeed,
    kbFall: src.kbFall,
    bufDirect: src.bufDirect,
    downRetap: src.downRetap,
    highDodge: src.highDodge,
    grabPartner: src.grabPartner,
    grabTimer: src.grabTimer,
    grabForce: src.grabForce,
    grabDash: src.grabDash,
    activeThrow: src.activeThrow,     // immutable def data, so sharing the reference is a copy
    activeThrowId: src.activeThrowId,
    techWindow: src.techWindow,
    techLockout: src.techLockout,
    downTimer: src.downTimer,
    fsVictim: src.fsVictim,
    fsAttacker: src.fsAttacker,
    stats: cloneStats(src.stats),
    lastHitFrame: src.lastHitFrame,
    comboBy: src.comboBy,
    comboCount: src.comboCount,
    statX: src.statX,
    moveCounted: src.moveCounted,
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
    power: src.power,
    scale: src.scale,
    returned: src.returned,
  };
}

function cloneConfig(src: MatchConfig): MatchConfig {
  const players: MatchConfig['players'] = [];
  for (let i = 0; i < src.players.length; i++) {
    const p = src.players[i];
    const copy: MatchConfig['players'][number] = { slot: p.slot, charId: p.charId, cpu: p.cpu, cpuLevel: p.cpuLevel };
    if (p.name !== undefined) copy.name = p.name;
    if (p.team !== undefined) copy.team = p.team;
    players.push(copy);
  }
  return {
    stageId: src.stageId,
    players,
    stocks: src.stocks,
    timeLimitSec: src.timeLimitSec,
    seed: src.seed,
    finalSmash: src.finalSmash,
    cpuZeroMoves: src.cpuZeroMoves,
    teams: src.teams,
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
    endFrame: state.endFrame,
    ...(state.winnerTeam === undefined ? {} : { winnerTeam: state.winnerTeam }),
  };
}

/**
 * Team of a slot under the Teams rule: its config team, else its own slot index (a solo
 * side). Without the rule every slot is its own team. Allocation free.
 */
export function teamOf(state: GameState, slot: number): number {
  if (state.config.teams !== true) return slot;
  const players = state.config.players;
  for (let i = 0; i < players.length; i++) {
    if (players[i].slot === slot) {
      const t = players[i].team;
      return t === undefined ? slot : t;
    }
  }
  return slot;
}

/** True when two different slots are teammates under the Teams rule (friendly fire is off). */
export function sameTeam(state: GameState, a: number, b: number): boolean {
  if (a === b || state.config.teams !== true) return false;
  return teamOf(state, a) === teamOf(state, b);
}
