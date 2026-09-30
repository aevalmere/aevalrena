/**
 * Combo table: true combos found by forward simulation (docs/CPU_PLAN.md W1.5; cpu-guide 02
 * sections 9.1 to 9.3, 04 sections 2 and 5).
 *
 * Every entry is keyed by a `ComboKey`: the starter that just landed, the victim percent
 * bracket (before the starter), the hit-frame class (early, mid, late in the starter's active
 * window), the victim offset at the hit in the attacker's facing space (dx in 10 px buckets,
 * dy in 16 px buckets, dy = victim feet minus attacker feet), whether the victim stood on the
 * ground and the stage spot of the victim (center, ledge within 60 px of a main-platform edge,
 * offstage past it).
 *
 * How an entry is built:
 * 1. A cloned sim places both fighters, runs the starter and teleports the victim into the
 *    starter's hitbox on the key's hit frame, at the percent under test.
 * 2. After the hit, a probe steps both fighters with no input to learn when the victim can act
 *    again and when the attacker can (hitlag, hitstun and the starter's own lag, straight from
 *    the sim). A lingering hit of the same move (a second group, a jab bead) re-roots the node.
 * 3. Follow-up scripts (grounded press, dash then press, short or full hop with drift then an
 *    aerial, drift or double jump then an aerial in the air, standing or dash grab then a throw)
 *    are prefiltered by timing and reach against the recorded victim path, then rolled out in
 *    the sim. A follow-up counts only if its hit lands while the victim is still frozen in
 *    hitlag or has two or more frames of hitstun left, which is the 02 section 9.1 test run by
 *    the sim itself. Chains grow by beam search up to 4 hits and stop at a KO.
 * 4. Each surviving route is replayed from the key setup at the bracket's low, middle and high
 *    percent against six victim policies pressed every frame from the first hit: no input,
 *    jump away, air dodge or roll away, fastest attack, shield (also a tech press), hold away.
 *    A link that any policy escapes truncates the route there.
 * 5. A route kills only when the last hit KOs at the bracket's low and high percent against a
 *    victim that does nothing, one that jumps then up-specials toward the stage, and one that
 *    air dodges toward it first (02 section 9.3: KO within the hitstun or no recovery).
 *
 * The sim has no DI (hitstun motion ignores input), so the "hold away" policy stands for DI
 * and matters only once hitstun ends.
 *
 * Canonical keys (one geometry per starter, hit class, grounded flag and spot) are built per
 * bracket on first use. Any other key is built on its own the first time `routes` asks for it,
 * at the bucket centre. Everything is cached in the table; nothing reads the clock or a
 * random source, so the same inputs give the same table.
 *
 * Victim defs and stages that are not the registry objects are registered under a temporary
 * id for the duration of each build, because the sim looks both up by id.
 */
import { CHARACTER_DEFS } from '../../characters/registry';
import { grabKitOf } from '../../characters/common/grabkit';
import { STAGE_DEFS } from '../../stages/registry';
import { Btn, DIRECT_CODES, DIRECT_MOVES } from '../../core/types';
import type {
  CharacterDef, GameState, InputFrame, MatchConfig, MoveDef, MoveId, StageDef, ThrowId,
} from '../../core/types';
import { cloneGameState, createGameState, stepGame } from '../../sim/index';
import { startMove } from '../../sim/moves';
import { forceGrab, startThrow } from '../../sim/grab';
import { PROJECTILE_DEFS } from '../../sim/projectiles';
import { simFighters, type SimFighter } from '../../sim/state';
import type {
  BuildComboTableFn, CharacterAiProfile, ComboKey, ComboRoute, ComboTable, Spot, StarterId,
} from '../contracts';

// ---------------------------------------------------------------------------------------------
// Public constants and key helpers
// ---------------------------------------------------------------------------------------------

/** dxBucket = floor(dx / COMBO_DX_BUCKET), dx in the attacker's facing space (victim ahead > 0). */
export const COMBO_DX_BUCKET = 10;
/** dyBucket = floor(dy / COMBO_DY_BUCKET), dy = victim feet y minus attacker feet y (down > 0). */
export const COMBO_DY_BUCKET = 16;
/** A victim this close to a main-platform edge (and on the stage side of it) is at the ledge. */
export const COMBO_LEDGE_BAND = 60;
/** Hits in a chain, starter included (02 section 9.2). */
export const COMBO_MAX_HITS = 4;

const ATK = 0;
const VIC = 1;
const THROW_IDS: readonly ThrowId[] = ['fthrow', 'bthrow', 'uthrow', 'dthrow'];

function isThrow(id: StarterId): id is ThrowId {
  return THROW_IDS.indexOf(id as ThrowId) >= 0;
}

/** Stage spot of a victim at x: offstage past a main-platform edge, ledge within COMBO_LEDGE_BAND of one. */
export function comboSpotOf(x: number, stage: StageDef): Spot {
  const g = stageGeo(stage);
  if (x < g.left || x > g.right) return 'offstage';
  if (x - g.left < COMBO_LEDGE_BAND || g.right - x < COMBO_LEDGE_BAND) return 'ledge';
  return 'center';
}

/** Hit-frame class of a melee move hitting on move frame `frame`: 0 early, 1 mid, 2 late. */
export function comboHitClassOf(mv: MoveDef, frame: number): 0 | 1 | 2 {
  const w = activeWindow(mv);
  if (w === null) return 0;
  const third = (w.hi - w.lo + 1) / 3;
  if (frame < w.lo + third) return 0;
  if (frame < w.lo + 2 * third) return 1;
  return 2;
}

/**
 * The key for a hit that just landed: `dx`, `dy` are raw px (dx in the attacker's facing
 * space), `percent` the victim's percent before the hit. Throws use dx = dy = 0 and class 0.
 */
export function makeComboKey(table: ComboTable, starter: StarterId, percent: number, hitClass: 0 | 1 | 2,
  dx: number, dy: number, grounded: boolean, spot: Spot): ComboKey {
  if (isThrow(starter)) {
    return { starter, bracket: table.bracketOf(percent), hitClass: 0, dxBucket: 0, dyBucket: 0, grounded: true, spot };
  }
  return {
    starter, bracket: table.bracketOf(percent), hitClass,
    dxBucket: Math.floor(dx / COMBO_DX_BUCKET), dyBucket: Math.floor(dy / COMBO_DY_BUCKET), grounded, spot,
  };
}

// ---------------------------------------------------------------------------------------------
// Link scripts: how the attacker performs one follow-up
// ---------------------------------------------------------------------------------------------

/** Script kinds. */
export const LK_GROUND = 0;
export const LK_DASH = 1;
export const LK_SHORTHOP = 2;
export const LK_FULLHOP = 3;
export const LK_AIR = 4;
export const LK_DOUBLEJUMP = 5;
export const LK_GRAB = 6;
export const LK_DASHGRAB = 7;

/**
 * One follow-up as the attacker's inputs, timed from the step after the previous hit (after a
 * lingering hit of the same move, if any). `drift` is relative to the victim: 1 toward, -1 away.
 * `code` is the DIRECT_CODES code (index + 1) of the move, or of the throw for grab kinds.
 */
export interface ComboLink {
  /** LK_* kind. */
  kind: number; move: StarterId; code: number; start: number; d: number; drift: -1 | 0 | 1;
}

const LINKS = new WeakMap<ComboRoute, readonly ComboLink[]>();

/** The input scripts behind a route returned by `routes`, or null for a foreign object. */
export function comboRouteLinks(route: ComboRoute): readonly ComboLink[] | null {
  const l = LINKS.get(route);
  return l === undefined ? null : l;
}

/**
 * Attacker input for `link` on the step `rel` steps after its start (rel 0 = the press frame).
 * `toward` is the victim's side (+1 right, -1 left), read once at rel 0.
 */
export function comboLinkInput(link: ComboLink, rel: number, atk: SimFighter, toward: number,
  jumpSquat: number, out: InputFrame): void {
  out.held = 0; out.pressed = 0; out.released = 0; out.direct = 0;
  if (rel < 0) return;
  const dirBit = toward > 0 ? Btn.Right : Btn.Left;
  const driftBit = link.drift === 0 ? 0 : (link.drift * toward > 0 ? Btn.Right : Btn.Left);
  switch (link.kind) {
    case LK_GROUND:
      if (rel === 0) { out.held = dirBit; out.direct = link.code; }
      return;
    case LK_DASH:
    case LK_DASHGRAB:
      if (rel < link.d) {
        out.held = dirBit;
        if (rel === 0) out.pressed = dirBit;
        return;
      }
      if (rel === link.d) {
        out.held = dirBit;
        if (link.kind === LK_DASH) out.direct = link.code;
        else out.pressed = Btn.Grab;
        return;
      }
      if (link.kind === LK_DASHGRAB && atk.action === 'grabHold') out.direct = link.code;
      return;
    case LK_GRAB:
      if (rel === 0) { out.pressed = Btn.Grab; return; }
      if (atk.action === 'grabHold') out.direct = link.code;
      return;
    case LK_SHORTHOP:
    case LK_FULLHOP:
      out.held = driftBit;
      if (rel === 0) { out.pressed = Btn.Jump; out.held |= Btn.Jump; }
      else if (link.kind === LK_FULLHOP && rel <= jumpSquat) out.held |= Btn.Jump;
      if (rel === jumpSquat + link.d) out.direct = link.code;
      return;
    case LK_AIR:
      out.held = driftBit;
      if (rel === link.d) out.direct = link.code;
      return;
    case LK_DOUBLEJUMP:
      out.held = driftBit;
      if (rel === 0) { out.pressed = Btn.Jump; out.held |= Btn.Jump; }
      if (rel === link.d) out.direct = link.code;
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Victim policies
// ---------------------------------------------------------------------------------------------

export const VP_NONE = 0;
export const VP_JUMP = 1;
export const VP_DODGE = 2;
export const VP_ATTACK = 3;
export const VP_SHIELD = 4;
export const VP_AWAY = 5;
/** The escapes every link is verified against (VP_NONE is the search policy). */
export const VP_ESCAPES: readonly number[] = [VP_NONE, VP_JUMP, VP_DODGE, VP_ATTACK, VP_SHIELD, VP_AWAY];

/** Victim input for an escape policy pressed every frame (the buffer releases it on the first free frame). */
export function comboVictimInput(policy: number, vic: SimFighter, atk: SimFighter, out: InputFrame): void {
  out.held = 0; out.pressed = 0; out.released = 0; out.direct = 0;
  const away = vic.x > atk.x ? Btn.Right : vic.x < atk.x ? Btn.Left : (atk.facing > 0 ? Btn.Right : Btn.Left);
  switch (policy) {
    case VP_JUMP: out.pressed = Btn.Jump; out.held = Btn.Jump | away; return;
    case VP_DODGE: out.pressed = Btn.Dodge; out.held = away; return;
    case VP_ATTACK: out.pressed = Btn.Attack; return;
    case VP_SHIELD: out.pressed = Btn.Shield; out.held = Btn.Shield; return;
    case VP_AWAY: out.held = away; return;
    default: return;
  }
}

// Recovery policies for the kill test.
const RP_NONE = 0;
const RP_JUMP_UPB = 1;
const RP_DODGE_JUMP_UPB = 2;
const RECOVERY_POLICIES: readonly number[] = [RP_NONE, RP_JUMP_UPB, RP_DODGE_JUMP_UPB];
const USPECIAL_CODE = DIRECT_CODES.indexOf('uspecial') + 1;

// ---------------------------------------------------------------------------------------------
// Stage and move geometry
// ---------------------------------------------------------------------------------------------

interface Geo { groundY: number; left: number; right: number; cx: number }

function stageGeo(stage: StageDef): Geo {
  let best = -1;
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (!p.solid) continue;
    if (best < 0 || p.w > stage.platforms[best].w) best = i;
  }
  if (best < 0) best = 0;
  const p = stage.platforms[best];
  return { groundY: p.y, left: p.x, right: p.x + p.w, cx: p.x + p.w / 2 };
}

function activeWindow(mv: MoveDef): { lo: number; hi: number } | null {
  if (mv.hitboxes.length === 0) return null;
  let lo = Infinity; let hi = -Infinity;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const h = mv.hitboxes[i];
    if (h.grab !== undefined) continue;
    if (h.start < lo) lo = h.start;
    if (h.end > hi) hi = h.end;
  }
  return lo === Infinity ? null : { lo, hi };
}

/** Timing and reach of one follow-up candidate, for the prefilter. */
interface FollowGeo {
  id: StarterId; code: number; airOnly: boolean; groundOnly: boolean; grab: boolean;
  startup: number; activeEnd: number; reachX: number; up: number; down: number; slackX: number; slackUp: number;
}

function moveGeo(id: MoveId, mv: MoveDef): FollowGeo | null {
  let startup = Infinity; let activeEnd = -Infinity;
  let reachX = 0; let up = 0; let down = 0;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const h = mv.hitboxes[i];
    if (h.start < startup) startup = h.start;
    if (h.end > activeEnd) activeEnd = h.end;
    reachX = Math.max(reachX, Math.abs(h.x) + h.r);
    up = Math.max(up, -(h.y - h.r));
    down = Math.max(down, h.y + h.r);
  }
  const shots = mv.projectiles;
  if (shots !== undefined) {
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      if (s.spawnFrame < 0) continue;
      if (s.spawnFrame < startup) startup = s.spawnFrame;
      activeEnd = Math.max(activeEnd, s.spawnFrame + s.lifetime);
      reachX = Math.max(reachX, Math.abs(s.x) + Math.abs(s.vx) * s.lifetime + s.r * 1.5);
      up = Math.max(up, -(s.y - s.r * 1.5));
      down = Math.max(down, s.y + s.r * 1.5);
    }
  }
  if (startup === Infinity) return null;
  let slackX = 6; let slackUp = 0;
  const vel = mv.velocity;
  if (vel !== undefined) {
    for (let i = 0; i < vel.length; i++) {
      if (vel[i].vx !== undefined) slackX += Math.abs(vel[i].vx as number) * 12;
      if (vel[i].vy !== undefined) slackUp += Math.abs(vel[i].vy as number) * 14;
    }
  }
  return {
    id, code: DIRECT_CODES.indexOf(id as typeof DIRECT_CODES[number]) + 1,
    airOnly: mv.airOnly === true, groundOnly: mv.groundOnly === true, grab: false,
    startup, activeEnd, reachX, up, down, slackX, slackUp: Math.min(160, slackUp),
  };
}

// ---------------------------------------------------------------------------------------------
// Build context
// ---------------------------------------------------------------------------------------------

interface Ctx {
  atkDef: CharacterDef; vicDef: CharacterDef; stage: StageDef; geo: Geo;
  atkId: string; vicId: string; stageId: string;
  template: GameState;
  follows: FollowGeo[];
  grabGeo: { stand: FollowGeo; dash: FollowGeo };
  throws: ThrowId[];
  starters: StarterId[];
  hand: StarterId[][];
  maxDashFrames: number;
  steps: number;
}

const IN_A: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };
const IN_V: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };
const INPUTS: InputFrame[] = [IN_A, IN_V];

function clearInput(i: InputFrame): void { i.held = 0; i.pressed = 0; i.released = 0; i.direct = 0; }

function step(ctx: Ctx, st: GameState): void {
  ctx.steps++;
  stepGame(st, INPUTS);
}

/** Registers a foreign victim def or stage under a temporary id for one build call. */
function enter(ctx: Ctx): string[] {
  const added: string[] = [];
  if (CHARACTER_DEFS[ctx.vicId] === undefined) {
    CHARACTER_DEFS[ctx.vicId] = ctx.vicDef;
    added.push(`c:${ctx.vicId}`);
    const ids = Object.keys(ctx.vicDef.moves) as MoveId[];
    for (let m = 0; m < ids.length; m++) {
      const list = ctx.vicDef.moves[ids[m]].projectiles;
      if (list === undefined) continue;
      for (let i = 0; i < list.length; i++) {
        if (PROJECTILE_DEFS[list[i].id] === undefined) {
          PROJECTILE_DEFS[list[i].id] = list[i];
          added.push(`p:${list[i].id}`);
        }
      }
    }
  }
  if (STAGE_DEFS[ctx.stageId] === undefined) {
    STAGE_DEFS[ctx.stageId] = ctx.stage;
    added.push(`s:${ctx.stageId}`);
  }
  return added;
}

function leave(added: string[]): void {
  for (let i = 0; i < added.length; i++) {
    const k = added[i].slice(2);
    if (added[i].startsWith('c:')) delete CHARACTER_DEFS[k];
    else if (added[i].startsWith('p:')) delete PROJECTILE_DEFS[k];
    else delete STAGE_DEFS[k];
  }
}

function makeCtx(p: CharacterAiProfile, victim: CharacterDef, stage: StageDef): Ctx {
  const atkDef = CHARACTER_DEFS[p.charId];
  if (atkDef === undefined) throw new Error(`buildComboTable: attacker ${p.charId} is not in the registry`);
  const vicId = CHARACTER_DEFS[victim.id] === victim ? victim.id : `${victim.id}~combo`;
  const stageId = STAGE_DEFS[stage.id] === stage ? stage.id : `${stage.id}~combo`;
  const kit = grabKitOf(atkDef);

  const follows: FollowGeo[] = [];
  const starters: StarterId[] = [];
  const profileMoves = Object.keys(p.moves) as MoveId[];
  for (let i = 0; i < DIRECT_MOVES.length; i++) {
    const id = DIRECT_MOVES[i] as MoveId;
    const mv = atkDef.moves[id];
    if (mv === undefined || profileMoves.indexOf(id) < 0) continue;
    const g = moveGeo(id, mv);
    if (g === null) continue;
    follows.push(g);
    starters.push(id);
  }
  const throws: ThrowId[] = [];
  const pt = Object.keys(p.grab.throws) as ThrowId[];
  for (let i = 0; i < THROW_IDS.length; i++) {
    if (pt.indexOf(THROW_IDS[i]) >= 0) { throws.push(THROW_IDS[i]); starters.push(THROW_IDS[i]); }
  }
  const grabBox = (b: typeof kit.stand): FollowGeo => ({
    id: 'fthrow', code: 0, airOnly: false, groundOnly: true, grab: true,
    startup: b.start, activeEnd: b.end, reachX: Math.abs(b.x) + b.r, up: -(b.y - b.r), down: b.y + b.r,
    slackX: 8, slackUp: 0,
  });
  const hand: StarterId[][] = [];
  const lists = p.overrides?.comboLists;
  if (lists !== undefined) for (let i = 0; i < lists.length; i++) hand.push(lists[i].slice());

  const config: MatchConfig = {
    stageId,
    players: [
      { slot: 0, charId: atkDef.id, cpu: false, cpuLevel: 0 },
      { slot: 1, charId: vicId, cpu: false, cpuLevel: 0 },
    ],
    stocks: 3, timeLimitSec: 0, seed: 1,
  };
  const ctx: Ctx = {
    atkDef, vicDef: victim, stage, geo: stageGeo(stage), atkId: atkDef.id, vicId, stageId,
    template: null as unknown as GameState, follows, grabGeo: { stand: grabBox(kit.stand), dash: grabBox(kit.dash) },
    throws, starters, hand, maxDashFrames: 16, steps: 0,
  };
  const added = enter(ctx);
  try {
    ctx.template = createGameState(config);
  } finally {
    leave(added);
  }
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Sim helpers
// ---------------------------------------------------------------------------------------------

function place(f: SimFighter, def: CharacterDef, x: number, y: number, grounded: boolean, facing: 1 | -1): void {
  f.x = x; f.y = y; f.prevY = y; f.vx = 0; f.vy = 0;
  f.onGround = grounded; f.action = grounded ? 'idle' : 'air'; f.actionFrame = 0; f.moveId = null;
  f.charge = 0; f.charging = false; f.hitGroups = 0; f.hitstun = 0; f.hitlag = 0; f.invuln = 0;
  f.kbSpeed = 0; f.kbFall = 0; f.kbDirX = 0; f.kbDirY = 0; f.fastFalling = false; f.facing = facing;
  f.jumpsLeft = grounded ? def.jumps : def.jumps - 1; f.airDodgeUsed = false; f.ledge = -1;
  f.buffer.btn = 0; f.buffer.age = 0; f.bufDirect = 0; f.airJumped = false; f.stateTimer = 0;
  f.shieldHp = 60; f.highDodge = 0; f.dropTimer = 0; f.ledgeCooldown = 0; f.skipGravity = false;
}

function fighters(st: GameState): SimFighter[] { return simFighters(st); }

/** Victim cannot act on the coming step: frozen in hitlag, two or more hitstun frames, or held. */
function stuck(v: SimFighter): boolean {
  return v.hitlag > 0 || v.hitstun >= 2 || v.action === 'grabbed';
}

/** True when a buffered press would be consumed on the attacker's next step. */
function attackerFreeNext(f: SimFighter, def: CharacterDef): boolean {
  if (f.hitlag > 0) return false;
  switch (f.action) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'crouch': case 'turn': case 'air':
      return true;
    case 'land':
      return f.stateTimer <= 1;
    case 'attack': {
      if (f.moveId === null || f.charging) return false;
      const mv = def.moves[f.moveId];
      const next = f.actionFrame + 1;
      if (mv.iasa !== undefined && next >= mv.iasa) return true;
      if (next >= mv.totalFrames) return !(mv.helplessAfter === true && !f.onGround);
      return false;
    }
    default:
      return false;
  }
}

interface EvScan { ourHit: boolean; theirHit: boolean; caught: boolean; ko: boolean; damage: number }
const SCAN: EvScan = { ourHit: false, theirHit: false, caught: false, ko: false, damage: 0 };

function scan(st: GameState): EvScan {
  SCAN.ourHit = false; SCAN.theirHit = false; SCAN.caught = false; SCAN.ko = false; SCAN.damage = 0;
  const ev = st.events;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (e.type === 'hit') {
      if (e.attacker === ATK && e.victim === VIC) { SCAN.ourHit = true; SCAN.damage += e.damage; }
      else if (e.attacker === VIC && e.victim === ATK) SCAN.theirHit = true;
    } else if (e.type === 'grab') {
      if (e.attacker === ATK && e.victim === VIC) SCAN.caught = true;
    } else if (e.type === 'ko' && e.slot === VIC) {
      SCAN.ko = true;
    }
  }
  return SCAN;
}

// ---------------------------------------------------------------------------------------------
// Starter setup
// ---------------------------------------------------------------------------------------------

interface Geometry { hitClass: 0 | 1 | 2; dx: number; dy: number; grounded: boolean; spot: Spot }

function classFrame(mv: MoveDef, c: number): number {
  const w = activeWindow(mv);
  if (w === null) return 0;
  if (c === 0) return w.lo;
  if (c === 2) return w.hi;
  return Math.floor((w.lo + w.hi) / 2);
}

/** Strongest non-grab hitbox active on move frame `frame`. */
function boxAt(mv: MoveDef, frame: number): MoveDef['hitboxes'][number] | null {
  let best: MoveDef['hitboxes'][number] | null = null;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const h = mv.hitboxes[i];
    if (h.grab !== undefined || frame < h.start || frame > h.end) continue;
    if (best === null || h.damage > best.damage || (h.damage === best.damage && h.r > best.r)) best = h;
  }
  return best;
}

/**
 * State right after the starter's first hit on a victim at `percent`, or null when the key's
 * geometry cannot be set up or the starter does not connect.
 */
function setupStarter(ctx: Ctx, starter: StarterId, g: Geometry, percent: number): GameState | null {
  const st = cloneGameState(ctx.template);
  const [atk, vic] = fighters(st);
  const geo = ctx.geo;
  const vh = ctx.vicDef.hurtbox.h;

  if (isThrow(starter)) {
    if (g.spot === 'offstage') return null;
    const facing: 1 | -1 = starter === 'bthrow' ? -1 : 1;
    const ax = g.spot === 'ledge' ? geo.right - 30 : geo.cx - 10;
    place(atk, ctx.atkDef, ax, geo.groundY, true, facing);
    place(vic, ctx.vicDef, ax + 20 * facing, geo.groundY, true, facing === 1 ? -1 : 1);
    vic.percent = percent;
    if (!forceGrab(st, atk, vic)) return null;
    startThrow(st, atk, starter);
    for (let i = 0; i < 80; i++) {
      clearInput(IN_A); clearInput(IN_V);
      step(ctx, st);
      if (scan(st).ourHit) return st;
    }
    return null;
  }

  const mv = ctx.atkDef.moves[starter];
  const atkAir = mv.airOnly === true;
  const facing: 1 | -1 = g.dx >= 0 ? 1 : -1;
  if (g.spot === 'offstage' && (!atkAir || g.grounded)) return null;
  if (g.grounded && !atkAir && g.dy !== 0) return null;

  let vx = g.spot === 'offstage' ? geo.right + 45 : g.spot === 'ledge' ? geo.right - 15 : geo.cx + Math.abs(g.dx) / 2;
  let ax = vx - g.dx * facing;
  let ay: number; let vy: number;
  if (!atkAir) {
    ay = geo.groundY;
    vy = g.grounded ? geo.groundY : geo.groundY + g.dy;
    if (!g.grounded && vy > geo.groundY - 4) return null;
    if (ax < geo.left + 4 || ax > geo.right - 4) return null;
  } else if (g.grounded) {
    vy = geo.groundY;
    ay = geo.groundY - g.dy;
    if (ay > geo.groundY - 4) return null;
  } else {
    ay = g.spot === 'offstage' ? geo.groundY - 20 : geo.groundY - 60;
    vy = ay + g.dy;
    if (g.spot !== 'offstage' && vy > geo.groundY - 4) { const s = vy - (geo.groundY - 4); ay -= s; vy -= s; }
  }
  if (g.grounded && (vx < geo.left + 2 || vx > geo.right - 2)) return null;

  place(atk, ctx.atkDef, ax, atkAir ? ay - 120 : ay, !atkAir, facing);
  // Parked out of reach and invulnerable until the hit frame.
  place(vic, ctx.vicDef, geo.left + 20, geo.groundY, true, facing === 1 ? -1 : 1);
  vic.invuln = 100000;
  startMove(st, atk, ctx.atkDef, starter);

  const melee = activeWindow(mv) !== null;
  clearInput(IN_A); clearInput(IN_V);
  if (melee) {
    const fh = classFrame(mv, g.hitClass);
    for (let i = 0; i < fh + 4 && atk.actionFrame < fh - 1; i++) step(ctx, st);
    if (atk.action !== 'attack' || atk.actionFrame !== fh - 1) return null;
  } else {
    // Projectile starter: wait for the shot to fly `dx` px ahead of the attacker.
    let found = false;
    for (let i = 0; i < 90 && !found; i++) {
      step(ctx, st);
      for (let k = 0; k < st.projectiles.length; k++) {
        const p = st.projectiles[k];
        if (!p.alive || p.owner !== ATK) continue;
        if ((p.x + p.vx - atk.x) * facing >= g.dx - Math.abs(p.vx)) {
          vx = p.x + p.vx; found = true;
          if (!g.grounded) vy = p.y + p.vy + vh / 2;
          break;
        }
      }
    }
    if (!found) return null;
    ax = atk.x; ay = atk.y;
    if (g.grounded) vy = geo.groundY;
  }
  if (atkAir) {
    atk.x = ax; atk.y = ay; atk.prevY = ay;
    if (atk.onGround) return null;
  }
  place(vic, ctx.vicDef, vx, vy, g.grounded, facing === 1 ? -1 : 1);
  vic.percent = percent;
  for (let i = 0; i < 3; i++) {
    step(ctx, st);
    const s = scan(st);
    if (s.ourHit) return st;
    if (s.ko) return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Node probe: when can each side act, where does the victim fly
// ---------------------------------------------------------------------------------------------

const REC_CAP = 150;

interface Rec {
  /** Steps before the first lingering hit of the same move, 0 when none. */
  linger: number;
  /** Last step on which the victim is still stuck (0 = free on the first step). */
  F: number;
  /** First step on which the attacker consumes a press, -1 if not found. */
  a0: number;
  ko: boolean;
  /** Victim hurtbox per step (index = step, after the step's movement). */
  x0: Float64Array; x1: Float64Array; y0: Float64Array; y1: Float64Array;
  /** Attacker state before step a0. */
  ax: number; ay: number; avx: number; avy: number; aGround: boolean; aJumps: number;
  endX: number;
}

function newRec(): Rec {
  return {
    linger: 0, F: 0, a0: -1, ko: false,
    x0: new Float64Array(REC_CAP + 2), x1: new Float64Array(REC_CAP + 2),
    y0: new Float64Array(REC_CAP + 2), y1: new Float64Array(REC_CAP + 2),
    ax: 0, ay: 0, avx: 0, avy: 0, aGround: true, aJumps: 0, endX: 0,
  };
}

/** Probes `st0` on a clone with no attacker input and victim policy `vp`. */
function record(ctx: Ctx, st0: GameState, vp: number, out: Rec): Rec {
  const st = cloneGameState(st0);
  const [atk, vic] = fighters(st);
  out.linger = 0; out.F = -1; out.a0 = -1; out.ko = false;
  for (let i = 1; i <= REC_CAP; i++) {
    const vs = stuck(vic);
    if (!vs && out.F < 0) { out.F = i - 1; out.endX = vic.x; }
    if (out.a0 < 0 && attackerFreeNext(atk, ctx.atkDef)) {
      out.a0 = i; out.ax = atk.x; out.ay = atk.y; out.avx = atk.vx; out.avy = atk.vy;
      out.aGround = atk.onGround; out.aJumps = atk.jumpsLeft;
    }
    if (out.F >= 0 && out.a0 >= 0) return out;
    clearInput(IN_A);
    comboVictimInput(vp, vic, atk, IN_V);
    step(ctx, st);
    const s = scan(st);
    if (s.ourHit && out.F < 0) { out.linger = i; return out; }
    if (s.ko) { out.ko = true; if (out.F < 0) { out.F = i; out.endX = vic.x; } return out; }
    const hw = ctx.vicDef.hurtbox.w / 2;
    const hh = vic.action === 'crouch' ? ctx.vicDef.crouchHurtbox.h : ctx.vicDef.hurtbox.h;
    out.x0[i] = vic.x - hw; out.x1[i] = vic.x + hw; out.y0[i] = vic.y - hh; out.y1[i] = vic.y;
  }
  if (out.F < 0) { out.F = REC_CAP; out.endX = vic.x; }
  return out;
}

/**
 * Advances `st` past lingering hits of the move that just landed (a second hitbox group, a
 * jab bead), with no attacker input and victim policy `vp`. Returns false on a KO.
 */
function settle(ctx: Ctx, st: GameState, vp: number, rec: Rec): boolean {
  for (let guard = 0; guard < 8; guard++) {
    record(ctx, st, vp, rec);
    if (rec.linger === 0) return !rec.ko;
    const [atk, vic] = fighters(st);
    for (let i = 0; i < rec.linger; i++) {
      clearInput(IN_A);
      comboVictimInput(vp, vic, atk, IN_V);
      step(ctx, st);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Running one link
// ---------------------------------------------------------------------------------------------

interface LinkResult { ok: boolean; hitStep: number; move: StarterId | null; damage: number }
const LR: LinkResult = { ok: false, hitStep: 0, move: null, damage: 0 };

/**
 * Runs `link` on `st` in place (from the settled node) until it lands, whiffs or is escaped.
 * `strict` (the search) also requires the victim to be stuck on the landing step.
 */
function runLink(ctx: Ctx, st: GameState, link: ComboLink, vp: number, limit: number, strict: boolean): LinkResult {
  const [atk, vic] = fighters(st);
  LR.ok = false; LR.hitStep = 0; LR.move = null; LR.damage = 0;
  let toward = 0;
  let caught = false;
  const grabKind = link.kind === LK_GRAB || link.kind === LK_DASHGRAB;
  const js = ctx.atkDef.jumpSquat;
  const cap = limit + (grabKind ? 90 : 0);
  for (let i = 1; i <= cap; i++) {
    if (i === link.start) {
      const d = vic.x - atk.x;
      toward = d > 0.5 ? 1 : d < -0.5 ? -1 : atk.facing;
    }
    const vs = stuck(vic);
    if (!caught && i > limit) return LR;
    comboLinkInput(link, i - link.start, atk, toward, js, IN_A);
    comboVictimInput(vp, vic, atk, IN_V);
    step(ctx, st);
    const s = scan(st);
    if (s.theirHit) return LR;
    if (s.ko && !s.ourHit) return LR;
    if (grabKind) {
      if (!caught && s.caught) {
        if (strict && !vs) return LR;
        caught = true;
        continue;
      }
      if (!caught && s.ourHit) return LR;
      if (caught && s.ourHit) {
        LR.ok = true; LR.hitStep = i; LR.move = link.move; LR.damage = s.damage;
        return LR;
      }
      if (caught && vic.action !== 'grabbed' && atk.action !== 'throw') return LR;
      continue;
    }
    if (s.ourHit) {
      if (strict && !vs) return LR;
      if (atk.action !== 'attack' || atk.moveId === null) return LR;
      LR.ok = true; LR.hitStep = i; LR.move = atk.moveId; LR.damage = s.damage;
      return LR;
    }
  }
  return LR;
}

// ---------------------------------------------------------------------------------------------
// Follow-up search
// ---------------------------------------------------------------------------------------------

const GROUND_WAITS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 17, 20, 24, 28];
const DASH_FRAMES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16];
const AIR_DELAYS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 17, 20, 24, 28, 32];
const DJ_DELAYS = [1, 2, 3, 4, 6, 8, 10, 13, 16, 20];

interface Cand { link: ComboLink; est: number }

/** Can some hit of `fg`, started at step `start` after `pre` lead frames, reach the victim path while stuck? */
function reachable(ctx: Ctx, rec: Rec, fg: FollowGeo, start: number, pre: number,
  hSpeed: number, riseMax: number, fallPerFrame: number): number {
  const t0 = start + pre + fg.startup;
  const t1 = Math.min(rec.F, start + pre + fg.activeEnd);
  for (let t = t0; t <= t1; t++) {
    if (t < 1) continue;
    const travel = hSpeed * (t - start) + fg.slackX;
    const lx = rec.ax - travel - fg.reachX;
    const hx = rec.ax + travel + fg.reachX;
    if (hx < rec.x0[t] || lx > rec.x1[t]) continue;
    const ly = rec.ay - riseMax - fg.slackUp - fg.up - 6;
    const hy = rec.ay + fallPerFrame * (t - start) + fg.down + 6;
    if (hy < rec.y0[t] || ly > rec.y1[t]) continue;
    return t;
  }
  return -1;
}

function collectCandidates(ctx: Ctx, rec: Rec, out: Cand[]): void {
  out.length = 0;
  const d = ctx.atkDef;
  const a0 = rec.a0;
  const js = d.jumpSquat;
  const fhRise = (d.jumpVel * d.jumpVel) / (2 * d.gravity);
  const shRise = (d.shortHopVel * d.shortHopVel) / (2 * d.gravity);
  const djRise = (d.doubleJumpVel * d.doubleJumpVel) / (2 * d.gravity);
  const airH = Math.max(d.airSpeed, Math.abs(rec.avx));
  const push = (kind: number, fg: FollowGeo, code: number, start: number, dd: number, drift: -1 | 0 | 1, est: number): void => {
    out.push({ link: { kind, move: fg.id, code, start, d: dd, drift }, est });
  };
  if (rec.aGround) {
    for (let m = 0; m < ctx.follows.length; m++) {
      const fg = ctx.follows[m];
      if (!fg.airOnly) {
        for (let w = 0; w < GROUND_WAITS.length; w++) {
          const t = reachable(ctx, rec, fg, a0 + GROUND_WAITS[w], 0, 0, 0, 0);
          if (t >= 0) push(LK_GROUND, fg, fg.code, a0 + GROUND_WAITS[w], 0, 0, t);
        }
        for (let k = 0; k < DASH_FRAMES.length; k++) {
          const t = reachable(ctx, rec, fg, a0, DASH_FRAMES[k], Math.max(d.dashSpeed, d.runSpeed), 0, 0);
          if (t >= 0) push(LK_DASH, fg, fg.code, a0, DASH_FRAMES[k], 0, t);
        }
      } else {
        for (let hop = 0; hop < 2; hop++) {
          const rise = hop === 0 ? shRise : fhRise;
          for (let k = 0; k < AIR_DELAYS.length; k++) {
            const pre = js + AIR_DELAYS[k] + (AIR_DELAYS[k] === 0 ? 1 : 0);
            const t = reachable(ctx, rec, fg, a0, pre, d.airSpeed, rise, 0);
            if (t < 0) continue;
            for (let dr = -1; dr <= 1; dr++) {
              push(hop === 0 ? LK_SHORTHOP : LK_FULLHOP, fg, fg.code, a0, AIR_DELAYS[k], dr as -1 | 0 | 1, t + (dr === 1 ? 0 : 1));
            }
          }
        }
      }
    }
    for (let ti = 0; ti < ctx.throws.length; ti++) {
      const code = DIRECT_CODES.indexOf(ctx.throws[ti]) + 1;
      const sg = { ...ctx.grabGeo.stand, id: ctx.throws[ti] as StarterId };
      const dg = { ...ctx.grabGeo.dash, id: ctx.throws[ti] as StarterId };
      for (let w = 0; w < GROUND_WAITS.length; w++) {
        const t = reachable(ctx, rec, sg, a0 + GROUND_WAITS[w], 0, 0, 0, 0);
        if (t >= 0 && rec.y1[t] >= ctx.geo.groundY - 0.5) push(LK_GRAB, sg, code, a0 + GROUND_WAITS[w], 0, 0, t);
      }
      for (let k = 0; k < DASH_FRAMES.length; k++) {
        const t = reachable(ctx, rec, dg, a0, DASH_FRAMES[k], Math.max(d.dashSpeed, d.runSpeed), 0, 0);
        if (t >= 0 && rec.y1[t] >= ctx.geo.groundY - 0.5) push(LK_DASHGRAB, dg, code, a0, DASH_FRAMES[k], 0, t);
      }
    }
  } else {
    const riseNow = rec.avy < 0 ? (rec.avy * rec.avy) / (2 * d.gravity) : 0;
    for (let m = 0; m < ctx.follows.length; m++) {
      const fg = ctx.follows[m];
      if (fg.groundOnly) continue;
      for (let k = 0; k < AIR_DELAYS.length; k++) {
        const t = reachable(ctx, rec, fg, a0, AIR_DELAYS[k], airH, riseNow, d.fastFall);
        if (t < 0) continue;
        for (let dr = -1; dr <= 1; dr++) push(LK_AIR, fg, fg.code, a0, AIR_DELAYS[k], dr as -1 | 0 | 1, t + (dr === 1 ? 0 : 1));
      }
      if (rec.aJumps > 0) {
        for (let k = 0; k < DJ_DELAYS.length; k++) {
          const t = reachable(ctx, rec, fg, a0, DJ_DELAYS[k], airH, djRise, 0);
          if (t < 0) continue;
          for (let dr = -1; dr <= 1; dr++) push(LK_DOUBLEJUMP, fg, fg.code, a0, DJ_DELAYS[k], dr as -1 | 0 | 1, t + 1 + (dr === 1 ? 0 : 1));
        }
      }
    }
  }
  // Earliest estimated hit first; stable on ties so the order is deterministic.
  const idx = out.map((c, i) => i);
  idx.sort((i, j) => out[i].est - out[j].est || i - j);
  const sorted = idx.map((i) => out[i]);
  out.length = 0;
  for (let i = 0; i < sorted.length; i++) out.push(sorted[i]);
}

interface Found { link: ComboLink; st: GameState; move: StarterId; damage: number; hitStep: number; kills: boolean }

const CANDS: Cand[] = [];

/** Every follow-up (one per resulting move, earliest landing) that truly combos from the settled node `st`. */
function followUps(ctx: Ctx, st: GameState, rec: Rec): Found[] {
  const found: Found[] = [];
  if (rec.ko || rec.a0 < 0 || rec.a0 > rec.F) return found;
  collectCandidates(ctx, rec, CANDS);
  const cands = CANDS.slice();
  const done = new Set<string>();
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const famKey = `${c.link.move}`;
    if (done.has(famKey)) continue;
    const trial = cloneGameState(st);
    const r = runLink(ctx, trial, c.link, VP_NONE, rec.F, true);
    if (!r.ok || r.move === null) continue;
    const move = r.move;
    if (done.has(move)) continue;
    done.add(move);
    done.add(famKey);
    found.push({ link: { ...c.link, move }, st: trial, move, damage: r.damage, hitStep: r.hitStep, kills: false });
  }
  for (let i = 0; i < found.length; i++) found[i].kills = killsFrom(ctx, found[i].st);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Kill test
// ---------------------------------------------------------------------------------------------

const KILL_HORIZON = 300;

/** Whether the victim of `st0` (just hit) is KO'd whatever it does to recover. */
function killsFrom(ctx: Ctx, st0: GameState): boolean {
  for (let p = 0; p < RECOVERY_POLICIES.length; p++) {
    const st = cloneGameState(st0);
    const vic = fighters(st)[VIC];
    const pol = RECOVERY_POLICIES[p];
    let dodged = pol !== RP_DODGE_JUMP_UPB;
    let upb = false;
    let ko = false;
    for (let i = 0; i < KILL_HORIZON; i++) {
      clearInput(IN_A); clearInput(IN_V);
      const free = !stuck(vic) && vic.action !== 'airHelpless' && vic.action !== 'airDodge' && vic.action !== 'attack';
      const side = vic.x >= ctx.geo.cx ? 1 : -1;
      const home = side > 0 ? Btn.Left : Btn.Right;
      const away = side > 0 ? Btn.Right : Btn.Left;
      const target = (side > 0 ? ctx.geo.right : ctx.geo.left) + side * 12;
      const below = vic.y > ctx.geo.groundY + 2;
      const off = below || (side > 0 ? vic.x > ctx.geo.right : vic.x < ctx.geo.left);
      if (pol !== RP_NONE && !vic.onGround) {
        // Above the stage: drift home and land. Off it: steer to just outside the ledge (out from
        // under the stage), air dodge up and home first (one policy), jump once level with or
        // below the ledge, then the up special once falling below it.
        const past = (vic.x - target) * side;
        IN_V.held = !off ? home : past > 4 ? home : (past < -4 && below ? away : 0);
        if (free && off) {
          if (!dodged) { IN_V.pressed = Btn.Dodge; IN_V.held = home | Btn.Up; dodged = true; }
          else if (vic.jumpsLeft > 0 && vic.vy > -1 && vic.y > ctx.geo.groundY - 40) { IN_V.pressed = Btn.Jump; IN_V.held |= Btn.Jump; }
          else if (!upb && vic.vy > 0 && vic.y > ctx.geo.groundY - 10 && (vic.jumpsLeft === 0 || vic.y > ctx.geo.groundY + 40)) {
            IN_V.direct = USPECIAL_CODE; IN_V.held |= Btn.Up; upb = true;
          }
        }
      }
      step(ctx, st);
      if (scan(st).ko) { ko = true; break; }
      if (vic.action === 'ledgeHang' || vic.action === 'ledgeGrab' || vic.action === 'ledgeClimb') return false;
      if (vic.onGround && vic.hitstun === 0 && vic.action !== 'tumble' && vic.action !== 'hitstun') return false;
    }
    if (!ko) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Beam search over chains
// ---------------------------------------------------------------------------------------------

const BEAM = [0, 4, 2, 1];
const KILL_BONUS = 100;

interface Draft { links: ComboLink[]; moves: StarterId[]; value: number; kills: boolean }

function search(ctx: Ctx, st: GameState, hits: number, path: StarterId[]): Draft[] {
  if (hits >= COMBO_MAX_HITS) return [];
  const rec = newRec();
  if (!settle(ctx, st, VP_NONE, rec)) return [];
  const kids = followUps(ctx, st, rec);
  kids.sort((a, b) => (b.damage + (b.kills ? KILL_BONUS : 0)) - (a.damage + (a.kills ? KILL_BONUS : 0)) || a.hitStep - b.hitStep);
  const keep = BEAM[Math.min(hits, BEAM.length - 1)];
  const chosen: Found[] = [];
  for (let i = 0; i < kids.length; i++) {
    if (chosen.length < keep || handWants(ctx, path, kids[i].move)) chosen.push(kids[i]);
  }
  const drafts: Draft[] = [];
  for (let i = 0; i < chosen.length; i++) {
    const k = chosen[i];
    let tail: Draft | null = null;
    if (!k.kills) {
      path.push(k.move);
      const sub = search(ctx, k.st, hits + 1, path);
      path.pop();
      if (sub.length > 0) tail = sub[0];
    }
    const links = [k.link]; const moves: StarterId[] = [k.move];
    let value = k.damage + (k.kills ? KILL_BONUS : 0);
    let kills = k.kills;
    if (tail !== null) {
      for (let j = 0; j < tail.links.length; j++) { links.push(tail.links[j]); moves.push(tail.moves[j]); }
      value += tail.value; kills = tail.kills;
    }
    drafts.push({ links, moves, value, kills });
  }
  drafts.sort((a, b) => b.value - a.value || a.moves.length - b.moves.length);
  return drafts;
}

/** A hand route (overrides.comboLists) whose next move after `path` is `move`. */
function handWants(ctx: Ctx, path: readonly StarterId[], move: StarterId): boolean {
  for (let i = 0; i < ctx.hand.length; i++) {
    const h = ctx.hand[i];
    if (h.length <= path.length) continue;
    let same = true;
    for (let j = 0; j < path.length && same; j++) same = h[j] === path[j];
    if (same && h[path.length] === move) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Verification replay
// ---------------------------------------------------------------------------------------------

interface Replay { hits: number; st: GameState | null; damage: number; endX: number; endAdvantage: number; offstage: boolean }

/** Replays `links` from the key setup at `percent` with victim policy `vp`. `hits` counts landed links. */
function replay(ctx: Ctx, starter: StarterId, g: Geometry, percent: number, links: readonly ComboLink[], vp: number): Replay {
  const out: Replay = { hits: -1, st: null, damage: 0, endX: 0, endAdvantage: 0, offstage: false };
  const st = setupStarter(ctx, starter, g, percent);
  if (st === null) return out;
  out.hits = 0;
  const rec = newRec();
  const vic = fighters(st)[VIC];
  const base = vic.percent;
  for (let k = 0; k < links.length; k++) {
    if (!settle(ctx, st, vp, rec)) return out;
    if (rec.a0 < 0) return out;
    const r = runLink(ctx, st, links[k], vp, Math.max(rec.F, links[k].start) + 40, false);
    if (!r.ok || r.move !== links[k].move) return out;
    out.hits = k + 1;
  }
  settle(ctx, st, vp, rec);
  out.st = st;
  out.damage = vic.percent - base;
  out.endX = rec.endX;
  out.endAdvantage = rec.ko ? 99 : rec.a0 < 0 ? -99 : rec.F + 1 - rec.a0;
  out.offstage = rec.endX < ctx.geo.left || rec.endX > ctx.geo.right;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------------------------

interface Entry { key: ComboKey; geometry: Geometry; routes: ComboRoute[]; starterKills: boolean }

function keyString(k: ComboKey): string {
  return `${k.starter}|${k.bracket}|${k.hitClass}|${k.dxBucket}|${k.dyBucket}|${k.grounded ? 1 : 0}|${k.spot}`;
}

function geometryKey(starter: StarterId, bracket: number, g: Geometry): ComboKey {
  if (isThrow(starter)) return { starter, bracket, hitClass: 0, dxBucket: 0, dyBucket: 0, grounded: true, spot: g.spot };
  return {
    starter, bracket, hitClass: g.hitClass, dxBucket: Math.floor(g.dx / COMBO_DX_BUCKET),
    dyBucket: Math.floor(g.dy / COMBO_DY_BUCKET), grounded: g.grounded, spot: g.spot,
  };
}

/** The canonical geometries of a starter: the strongest box per distinct hit class, per victim stance and spot. */
function canonicalGeometries(ctx: Ctx, starter: StarterId): Geometry[] {
  const out: Geometry[] = [];
  if (isThrow(starter)) {
    out.push({ hitClass: 0, dx: 0, dy: 0, grounded: true, spot: 'center' });
    out.push({ hitClass: 0, dx: 0, dy: 0, grounded: true, spot: 'ledge' });
    return out;
  }
  const mv = ctx.atkDef.moves[starter];
  const h = ctx.vicDef.hurtbox.h;
  const atkAir = mv.airOnly === true;
  const spotsFor = (grounded: boolean): Spot[] => grounded ? ['center', 'ledge'] : atkAir ? ['center', 'ledge', 'offstage'] : ['center', 'ledge'];
  if (activeWindow(mv) === null) {
    const shots = mv.projectiles;
    if (shots === undefined) return out;
    let first = null as typeof shots[number] | null;
    for (let i = 0; i < shots.length; i++) if (shots[i].spawnFrame >= 0 && (first === null || shots[i].spawnFrame < first.spawnFrame)) first = shots[i];
    if (first === null) return out;
    const dx = Math.round(first.x + Math.abs(first.vx) * 4);
    if (!atkAir) for (const s of spotsFor(true)) out.push({ hitClass: 0, dx, dy: 0, grounded: true, spot: s });
    return out;
  }
  let prev: MoveDef['hitboxes'][number] | null = null;
  for (let c = 0; c < 3; c++) {
    const hb = boxAt(mv, classFrame(mv, c));
    if (hb === null) continue;
    if (prev !== null && hb.damage === prev.damage && hb.angle === prev.angle && hb.bkb === prev.bkb
      && hb.kbg === prev.kbg && hb.x === prev.x && hb.y === prev.y) continue;
    prev = hb;
    const cls = c as 0 | 1 | 2;
    if (!atkAir) {
      if (hb.y + hb.r >= -h && hb.y - hb.r <= 0) for (const s of spotsFor(true)) out.push({ hitClass: cls, dx: hb.x, dy: 0, grounded: true, spot: s });
      if (hb.y + h / 2 <= -8) for (const s of spotsFor(false)) out.push({ hitClass: cls, dx: hb.x, dy: Math.round(hb.y + h / 2), grounded: false, spot: s });
    } else {
      const liftMax = h + hb.y + hb.r - 2;
      if (liftMax >= 12) {
        const lift = Math.round(Math.max(12, Math.min(liftMax, h / 2 + hb.y)));
        for (const s of spotsFor(true)) out.push({ hitClass: cls, dx: hb.x, dy: lift, grounded: true, spot: s });
      }
      for (const s of spotsFor(false)) out.push({ hitClass: cls, dx: hb.x, dy: Math.round(hb.y + h / 2), grounded: false, spot: s });
    }
  }
  return out;
}

/** Geometry at the centre of a key's buckets, for keys built on demand. */
function geometryOfKey(ctx: Ctx, k: ComboKey): Geometry {
  if (isThrow(k.starter)) return { hitClass: 0, dx: 0, dy: 0, grounded: true, spot: k.spot };
  const mv = ctx.atkDef.moves[k.starter];
  const dx = (k.dxBucket + 0.5) * COMBO_DX_BUCKET;
  let dy = (k.dyBucket + 0.5) * COMBO_DY_BUCKET;
  if (k.grounded && mv.airOnly !== true) dy = 0;
  else if (k.grounded && k.dyBucket === 0) dy = 12;
  return { hitClass: k.hitClass, dx, dy, grounded: k.grounded, spot: k.spot };
}

interface Bracket { lo: number; mid: number; hi: number }

function bracketPercents(brackets: readonly number[], b: number): Bracket {
  const lo = brackets[b];
  let hi: number;
  if (b + 1 < brackets.length) hi = Math.max(lo, brackets[b + 1] - 1);
  else {
    const span = b > 0 ? brackets[b] - brackets[b - 1] : 20;
    hi = lo + Math.max(10, span) - 1;
  }
  return { lo, mid: Math.round((lo + hi) / 2), hi };
}

/** Longest prefix of `links` that lands at every percent in `pcts` against every escape. */
function verifiedPrefix(ctx: Ctx, starter: StarterId, g: Geometry, pcts: readonly number[], links: readonly ComboLink[]): number {
  let n = links.length;
  for (let p = 0; p < pcts.length && n > 0; p++) {
    for (let e = 0; e < VP_ESCAPES.length && n > 0; e++) {
      const r = replay(ctx, starter, g, pcts[p], links.slice(0, n), VP_ESCAPES[e]);
      if (r.hits < n) n = Math.max(0, r.hits);
    }
  }
  return n;
}

function buildEntry(ctx: Ctx, key: ComboKey, g: Geometry, br: Bracket): Entry {
  const entry: Entry = { key, geometry: g, routes: [], starterKills: false };
  const root = setupStarter(ctx, key.starter, g, br.mid);
  if (root === null) return entry;
  const lowRoot = setupStarter(ctx, key.starter, g, br.lo);
  const highRoot = setupStarter(ctx, key.starter, g, br.hi);
  entry.starterKills = lowRoot !== null && highRoot !== null && killsFrom(ctx, lowRoot) && killsFrom(ctx, highRoot);
  if (entry.starterKills) return entry;
  const drafts = search(ctx, root, 1, [key.starter]);
  const pcts = [br.lo, br.mid, br.hi];
  const seen = new Set<string>();
  for (let i = 0; i < drafts.length; i++) {
    const n = verifiedPrefix(ctx, key.starter, g, pcts, drafts[i].links);
    if (n === 0) continue;
    const links = drafts[i].links.slice(0, n);
    const sig = links.map((l) => l.move).join('>');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const mid = replay(ctx, key.starter, g, br.mid, links, VP_NONE);
    if (mid.hits < n || mid.st === null) continue;
    let kills = false;
    if (drafts[i].kills && n === drafts[i].links.length) {
      const a = replay(ctx, key.starter, g, br.lo, links, VP_NONE);
      const b = replay(ctx, key.starter, g, br.hi, links, VP_NONE);
      kills = a.st !== null && b.st !== null && a.hits === n && b.hits === n
        && killsFromReplay(ctx, key.starter, g, br.lo, links) && killsFromReplay(ctx, key.starter, g, br.hi, links);
    }
    const route: ComboRoute = {
      moves: links.map((l) => l.move), damage: Math.round(mid.damage * 10) / 10, kills,
      endX: Math.round(mid.endX), endAdvantage: mid.endAdvantage, offstage: mid.offstage,
    };
    LINKS.set(route, links);
    entry.routes.push(route);
  }
  entry.routes.sort((a, b) => (b.damage + (b.kills ? KILL_BONUS : 0)) - (a.damage + (a.kills ? KILL_BONUS : 0))
    || a.moves.length - b.moves.length);
  return entry;
}

/** KO test on the state right after the last link lands (before any settle). */
function killsFromReplay(ctx: Ctx, starter: StarterId, g: Geometry, percent: number, links: readonly ComboLink[]): boolean {
  const st = setupStarter(ctx, starter, g, percent);
  if (st === null) return false;
  const rec = newRec();
  for (let k = 0; k < links.length; k++) {
    if (!settle(ctx, st, VP_NONE, rec)) return false;
    const r = runLink(ctx, st, links[k], VP_NONE, Math.max(rec.F, links[k].start) + 40, false);
    if (!r.ok) return false;
  }
  return killsFrom(ctx, st);
}

interface TableImpl extends ComboTable {
  /** Canonical and on-demand entries built so far. */
  entries(): readonly { key: ComboKey; routes: readonly ComboRoute[]; starterKills: boolean }[];
  /** Forces every canonical entry of every bracket. */
  buildAll(): void;
  /** Canonical entries built (or loaded) so far, bracket by bracket in build order. */
  canonical(): readonly Entry[];
  /** Sim steps spent so far. */
  steps(): number;
  /** State right after the starter of `key` lands at `percent`, or null (for tests and replays). */
  setup(key: ComboKey, percent: number): GameState | null;
  /** The attacker def's jump squat, for `comboLinkInput`. */
  jumpSquat: number;
}

const TABLES = new WeakMap<ComboTable, TableImpl>();

function asImpl(t: ComboTable): TableImpl {
  const impl = TABLES.get(t);
  if (impl === undefined) throw new Error('not a table from buildComboTable');
  return impl;
}

/** Built entries (canonical and on demand) of a table from buildComboTable. */
export function comboTableEntries(t: ComboTable): readonly { key: ComboKey; routes: readonly ComboRoute[]; starterKills: boolean }[] {
  return asImpl(t).entries();
}

/** A canonical entry as the profile cache stores it: plain JSON, links included. */
export interface StoredComboEntry {
  key: ComboKey; geometry: { hitClass: 0 | 1 | 2; dx: number; dy: number; grounded: boolean; spot: Spot };
  starterKills: boolean; routes: { route: ComboRoute; links: ComboLink[] }[];
}
/** Every bracket's canonical entries of one table. */
export interface StoredComboTable { brackets: number[]; byBracket: StoredComboEntry[][] }

function sameBrackets(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function entryFromStored(x: StoredComboEntry): Entry {
  const g = x.geometry;
  const e: Entry = { key: { ...x.key }, geometry: { hitClass: g.hitClass, dx: g.dx, dy: g.dy, grounded: g.grounded, spot: g.spot },
    routes: [], starterKills: x.starterKills };
  for (let i = 0; i < x.routes.length; i++) {
    const r = x.routes[i].route;
    const route: ComboRoute = { moves: r.moves.slice(), damage: r.damage, kills: r.kills, endX: r.endX,
      endAdvantage: r.endAdvantage, offstage: r.offstage };
    LINKS.set(route, x.routes[i].links.map((l) => ({ ...l })));
    e.routes.push(route);
  }
  return e;
}

/** Builds every bracket of a table from buildComboTable and returns its canonical entries for the cache. */
export function exportComboTable(t: ComboTable): StoredComboTable {
  const impl = asImpl(t);
  impl.buildAll();
  const byBracket: StoredComboEntry[][] = t.brackets.map(() => []);
  const canon = impl.canonical();
  for (let i = 0; i < canon.length; i++) {
    const e = canon[i];
    byBracket[e.key.bracket].push({
      key: { ...e.key }, geometry: { ...e.geometry }, starterKills: e.starterKills,
      routes: e.routes.map((r) => ({ route: { ...r, moves: r.moves.slice() }, links: (LINKS.get(r) ?? []).map((l) => ({ ...l })) })),
    });
  }
  return { brackets: t.brackets.slice(), byBracket };
}

/** Builds every canonical entry now (otherwise each bracket is built on first use). */
export function buildAllComboEntries(t: ComboTable): void { asImpl(t).buildAll(); }

/** Sim steps a table has spent. */
export function comboTableSteps(t: ComboTable): number { return asImpl(t).steps(); }

/** State right after the starter of `key` lands on a victim at `percent`, or null. */
export function comboSetupState(t: ComboTable, key: ComboKey, percent: number): GameState | null {
  return asImpl(t).setup(key, percent);
}

/** The attacker's jump squat for `comboLinkInput`. */
export function comboJumpSquat(t: ComboTable): number { return asImpl(t).jumpSquat; }

export const buildComboTable: BuildComboTableFn = (p, victim, stage, brackets) => buildComboTableFrom(p, victim, stage, brackets, null);

/**
 * buildComboTable with the canonical entries of some brackets taken from `preset` (the committed
 * profile cache) instead of simulated. Used only when the preset was generated from the same data
 * hash, overrides and brackets, so the table is identical either way; only the cost differs.
 */
export function buildComboTableFrom(p: CharacterAiProfile, victim: CharacterDef, stage: StageDef, brackets: readonly number[],
  preset: StoredComboTable | null): ComboTable {
  if (preset !== null && !sameBrackets(preset.brackets, brackets)) preset = null;
  const ctx = makeCtx(p, victim, stage);
  const bl = brackets.slice();
  const byKey = new Map<string, Entry>();
  const bracketBuilt: boolean[] = bl.map(() => false);
  const order: Entry[] = [];
  /** Entries built from the canonical geometries (ensureBracket), in build order. */
  const canonEntries: Entry[] = [];
  const canonKeys = new Set<string>();
  const canon: { starter: StarterId; g: Geometry }[] = [];
  for (let s = 0; s < ctx.starters.length; s++) {
    const gs = canonicalGeometries(ctx, ctx.starters[s]);
    for (let i = 0; i < gs.length; i++) canon.push({ starter: ctx.starters[s], g: gs[i] });
  }

  const bracketOf = (percent: number): number => {
    let b = 0;
    for (let i = 0; i < bl.length; i++) if (percent >= bl[i]) b = i;
    return b;
  };

  const withSim = <T>(fn: () => T): T => {
    const added = enter(ctx);
    try { return fn(); } finally { leave(added); }
  };

  const ensureBracket = (b: number): void => {
    if (b < 0 || b >= bl.length || bracketBuilt[b]) return;
    bracketBuilt[b] = true;
    const stored = preset !== null ? preset.byBracket[b] : undefined;
    if (stored !== undefined) {
      for (let i = 0; i < stored.length; i++) {
        const x = stored[i];
        const ks = keyString(x.key);
        if (canonKeys.has(ks)) continue;
        canonKeys.add(ks);
        let e = byKey.get(ks);
        if (e === undefined) { e = entryFromStored(x); byKey.set(ks, e); order.push(e); }
        canonEntries.push(e);
      }
      return;
    }
    withSim(() => {
      const br = bracketPercents(bl, b);
      for (let i = 0; i < canon.length; i++) {
        const key = geometryKey(canon[i].starter, b, canon[i].g);
        const ks = keyString(key);
        if (canonKeys.has(ks)) continue;
        canonKeys.add(ks);
        // An on-demand build of the same key (routes) is the same entry: the build is a pure function of the key.
        let e = byKey.get(ks);
        if (e === undefined) { e = buildEntry(ctx, key, canon[i].g, br); byKey.set(ks, e); order.push(e); }
        canonEntries.push(e);
      }
    });
  };

  const table: ComboTable = {
    brackets: bl,
    bracketOf,
    routes(k: ComboKey): readonly ComboRoute[] {
      if (k.bracket < 0 || k.bracket >= bl.length) return [];
      if (ctx.starters.indexOf(k.starter) < 0) return [];
      const norm: ComboKey = isThrow(k.starter)
        ? { starter: k.starter, bracket: k.bracket, hitClass: 0, dxBucket: 0, dyBucket: 0, grounded: true, spot: k.spot }
        : k;
      ensureBracket(norm.bracket);
      const ks = keyString(norm);
      let e = byKey.get(ks);
      if (e === undefined) {
        const g = geometryOfKey(ctx, norm);
        e = withSim(() => buildEntry(ctx, { ...norm }, g, bracketPercents(bl, norm.bracket)));
        byKey.set(ks, e);
        order.push(e);
      }
      return e.routes;
    },
    routesNear(k: ComboKey): readonly ComboRoute[] {
      if (k.bracket < 0 || k.bracket >= bl.length) return [];
      if (ctx.starters.indexOf(k.starter) < 0) return [];
      ensureBracket(k.bracket);
      const thr = isThrow(k.starter);
      let best: Entry | null = null;
      let bestD = Infinity;
      for (let i = 0; i < canonEntries.length; i++) {
        const e = canonEntries[i];
        const q = e.key;
        if (q.starter !== k.starter || q.bracket !== k.bracket) continue;
        let d = q.spot === k.spot ? 0 : 1000;
        if (!thr) {
          d += (q.grounded === k.grounded ? 0 : 100) + (q.hitClass === k.hitClass ? 0 : 10);
          d += Math.abs(q.dxBucket - k.dxBucket) + Math.abs(q.dyBucket - k.dyBucket);
        }
        if (d < bestD) { bestD = d; best = e; }
      }
      return best !== null ? best.routes : [];
    },
    warm(bracket: number): void { ensureBracket(bracket); },
    killConfirm(starter: StarterId, bracket: number, spot: Spot): boolean {
      ensureBracket(bracket);
      // Canonical entries only, so the answer does not depend on which keys were built on demand before.
      for (let i = 0; i < canonEntries.length; i++) {
        const e = canonEntries[i];
        if (e.key.starter !== starter || e.key.bracket !== bracket || e.key.spot !== spot) continue;
        if (e.starterKills) return true;
        for (let r = 0; r < e.routes.length; r++) if (e.routes[r].kills) return true;
      }
      return false;
    },
    summary() {
      for (let b = 0; b < bl.length; b++) ensureBracket(b);
      let entries = 0; let chains3 = 0; let chains4 = 0; let kills = 0;
      for (let i = 0; i < order.length; i++) {
        const e = order[i];
        if (e.routes.length === 0) continue;
        entries++;
        let longest = 0; let k = false;
        for (let r = 0; r < e.routes.length; r++) {
          longest = Math.max(longest, e.routes[r].moves.length);
          if (e.routes[r].kills) k = true;
        }
        if (longest + 1 >= 3) chains3++;
        if (longest + 1 >= 4) chains4++;
        if (k) kills++;
      }
      return { entries, chains3, chains4, kills };
    },
  };
  const impl: TableImpl = {
    ...table,
    entries: () => order,
    canonical: () => canonEntries,
    buildAll: () => { for (let b = 0; b < bl.length; b++) ensureBracket(b); },
    steps: () => ctx.steps,
    setup: (key, percent) => {
      const ks = keyString(key);
      const e = byKey.get(ks);
      const g = e !== undefined ? e.geometry : geometryOfKey(ctx, key);
      return withSim(() => setupStarter(ctx, key.starter, g, percent));
    },
    jumpSquat: ctx.atkDef.jumpSquat,
  };
  TABLES.set(table, impl);
  return table;
};
