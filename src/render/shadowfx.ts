import { CHARACTER_DEFS } from '../characters/registry';
import { ECHO_TAIL } from '../core/constants';
import { MAX_PLAYERS } from '../core/types';
import type { FighterState, GameState, HitboxDef, MoveDef, ProjectileDef, ProjectileState } from '../core/types';
import { AIM_COS, AIM_SIN, aimHoldOf } from './fx';
import { echoEndAge, echoPlace, hiddenRange } from './fighters';
import {
  LAYER_BACK,
  LAYER_FRONT,
  PIECE_DSMOKE,
  PIECE_MOTE,
  PIECE_SHARD,
  PIECE_SLIVER,
  PIECE_SMOKE,
  PIECE_SPIKE,
  clearSpritePool,
  createSpritePool,
  drawSpritePool,
  emitSprite,
  seedSprites,
  srand,
  sspread,
  stepSpritePool,
} from './sprparticles';
import type { SpritePool } from './sprparticles';
import { getProjectileVisual } from './visuals';

/**
 * Trekmore's particle effects (docs/TREKMORE_POLISH.md Render 2 and 3), spawned into the sprite
 * particle pool from fighter and projectile state:
 * - swing trails (slivers and motes on the active hitboxes of the crescent swings), also on the
 *   shadow clone's replayed swing;
 * - hiddenFrames moves (up special): phase-out into smoke and shards streaming toward the thrown
 *   sword, a stream between the hidden body and the sword, then a burst out of the sword and
 *   particles converging back into the body;
 * - the flying sword's trail, denser the further it has flown (the damage scaling cue);
 * - shadow step and recall phase-out and materialize bursts;
 * - the counter branch: a shard burst on the arc and a spike fountain on the eruption;
 * - the shadow clone's smoke: a puff on his body as it splits off, a wake as it darts to its
 *   strike point in front of him, trailing smoke, dissolving;
 * - the neutral special aim hold: motes drifting out along the aim;
 * - the dash attack's thrust impact at the blade's tip (frames 11 to 13);
 * - shard and mote bursts on his hits (echo hits too) and KOs (KO smoke from pSmoke4..5).
 *
 * update() runs once per newly consumed sim frame (the renderer's event gate). Each fighter
 * remembers the last (move, branch, move frame) and the last echo age it spawned for, so a frame
 * where those did not advance (hitlag, a repeat render) spawns nothing, and a render that catches
 * up several sim frames spawns the frames it skipped. Every spawn reseeds the scatter from the
 * sim frame, slot and move frame, so what appears depends only on the state.
 */

/** Characters that get these effects. */
const SHADOW_CHARS: readonly string[] = ['trekmore'];
/** Moves whose active hitboxes leave the crescent trail. */
const TRAIL_MOVES: readonly string[] = ['utilt', 'usmash', 'uair', 'ftilt', 'fsmash', 'fair', 'bair', 'uspecial'];
/** A hitbox active longer than this is a drag or a lingering hit, not a swing: no trail. */
const TRAIL_MAX_WINDOW = 10;
/** Per active hitbox per frame: chance of a sliver and of a mote. */
const SLIVER_CHANCE = 0.7;
const MOTE_CHANCE = 0.55;
/** Slivers are small glowing fragments: scale 0.35 to 0.7, starting at 0.8 alpha (drawn additive). */
const SLIVER_SCALE_MIN = 0.35;
const SLIVER_SCALE_SPAN = 0.35;
const SLIVER_ALPHA = 0.8;
/** Chest height above the feet for Trekmore (55 px tall). */
const CHEST = -28;
/** The raised hand, where the thrown sword is caught: feet-relative. */
const HAND_X = 6;
const HAND_Y = -64;
/** The flying sword: one trail puff per this many px flown, capped. */
const TRAIL_PX_PER_PUFF = 72;
const TRAIL_MAX_PUFFS = 5;
/** Most move frames one update spawns for (the renderer's catch-up cap). */
const MAX_BACKFILL = 4;
const PROJ_KEYS = 32;

export interface ShadowFx {
  pool: SpritePool;
  lastMove: (string | null)[];
  lastBranch: Uint8Array;
  lastAf: Int32Array;
  lastEchoMove: (string | null)[];
  lastEchoAge: Int32Array;
  /** Last seen position of the sword thrown by a hiddenFrames move, per fighter index. */
  swordX: Float32Array;
  swordY: Float32Array;
  swordSeen: Uint8Array;
  /** Projectile id and age last trailed. */
  projId: Int32Array;
  projAge: Int32Array;
  projCursor: number;
}

export function createShadowFx(): ShadowFx {
  return {
    pool: createSpritePool(),
    lastMove: new Array<string | null>(MAX_PLAYERS).fill(null),
    lastBranch: new Uint8Array(MAX_PLAYERS),
    lastAf: new Int32Array(MAX_PLAYERS).fill(-1),
    lastEchoMove: new Array<string | null>(MAX_PLAYERS).fill(null),
    lastEchoAge: new Int32Array(MAX_PLAYERS),
    swordX: new Float32Array(MAX_PLAYERS),
    swordY: new Float32Array(MAX_PLAYERS),
    swordSeen: new Uint8Array(MAX_PLAYERS),
    projId: new Int32Array(PROJ_KEYS).fill(-1),
    projAge: new Int32Array(PROJ_KEYS),
    projCursor: 0,
  };
}

export function clearShadowFx(fx: ShadowFx): void {
  clearSpritePool(fx.pool);
  fx.lastMove.fill(null);
  fx.lastBranch.fill(0);
  fx.lastAf.fill(-1);
  fx.lastEchoMove.fill(null);
  fx.lastEchoAge.fill(0);
  fx.swordSeen.fill(0);
  fx.projId.fill(-1);
  fx.projCursor = 0;
}

export function stepShadowFx(fx: ShadowFx, steps: number): void {
  stepSpritePool(fx.pool, steps);
}

export function drawShadowFxBack(ctx: CanvasRenderingContext2D, fx: ShadowFx): void {
  drawSpritePool(ctx, fx.pool, LAYER_BACK);
}

export function drawShadowFxFront(ctx: CanvasRenderingContext2D, fx: ShadowFx): void {
  drawSpritePool(ctx, fx.pool, LAYER_FRONT);
}

function isShadowChar(charId: string): boolean {
  for (let i = 0; i < SHADOW_CHARS.length; i++) if (SHADOW_CHARS[i] === charId) return true;
  return false;
}

function isTrailMove(id: string): boolean {
  for (let i = 0; i < TRAIL_MOVES.length; i++) if (TRAIL_MOVES[i] === id) return true;
  return false;
}

// ---------------- small emit helpers ----------------

/** A burst of `count` particles flying out of (x, y). */
function burst(
  pool: SpritePool, family: number, count: number, x: number, y: number,
  speedMin: number, speedMax: number, life: number, gravity: number, layer: number,
  variant: number, charId: string
): void {
  for (let n = 0; n < count; n++) {
    const a = srand(pool) * Math.PI * 2;
    const sp = speedMin + srand(pool) * (speedMax - speedMin);
    emitSprite(
      pool, family, x + sspread(pool, 2), y + sspread(pool, 2), Math.cos(a) * sp, Math.sin(a) * sp,
      life * (0.7 + srand(pool) * 0.6), gravity, 0.93, srand(pool) * 6.28, sspread(pool, 0.25),
      0.8 + srand(pool) * 0.4, 1, layer, variant, charId
    );
  }
}

/** A particle that flies from (x, y) to (tx, ty) in `life` frames, straight, and dies there. */
function toward(
  pool: SpritePool, family: number, x: number, y: number, tx: number, ty: number,
  life: number, alpha: number, layer: number, variant: number, charId: string
): void {
  emitSprite(
    pool, family, x, y, (tx - x) / life, (ty - y) / life, life, 0, 1, srand(pool) * 6.28,
    sspread(pool, 0.15), 0.7 + srand(pool) * 0.5, alpha, layer, variant, charId
  );
}

/** Smoke puff drifting up: the dissolve and the clone's trail. */
function smoke(
  pool: SpritePool, x: number, y: number, driftX: number, alpha: number, variant: number, charId: string
): void {
  emitSprite(
    pool, PIECE_SMOKE, x, y, driftX + sspread(pool, 0.3), -0.4 - srand(pool) * 0.5, 16 + srand(pool) * 10,
    -0.01, 0.96, srand(pool) * 6.28, sspread(pool, 0.05), 0.8 + srand(pool) * 0.5, alpha, LAYER_BACK, variant, charId
  );
}

/** Heavy dissolve smoke (pSmoke4..5, else the plain smoke crops): the KO and the clone's end. */
function dsmoke(
  pool: SpritePool, x: number, y: number, driftX: number, alpha: number, layer: number, variant: number, charId: string
): void {
  emitSprite(
    pool, PIECE_DSMOKE, x, y, driftX + sspread(pool, 0.4), -0.3 - srand(pool) * 0.6, 20 + srand(pool) * 12,
    -0.012, 0.95, srand(pool) * 6.28, sspread(pool, 0.04), 0.7 + srand(pool) * 0.5, alpha, layer, variant, charId
  );
}

/** Phase-out: the body breaks into smoke and shards over its hurtbox that fly off. */
function phaseOut(
  pool: SpritePool, x: number, y: number, count: number, tx: number, ty: number, variant: number, charId: string
): void {
  for (let n = 0; n < count; n++) {
    const px = x + sspread(pool, 12);
    const py = y - 6 - srand(pool) * 44;
    const family = n % 3 === 2 ? PIECE_SHARD : PIECE_SMOKE;
    toward(pool, family, px, py, tx + sspread(pool, 6), ty + sspread(pool, 6), 10 + srand(pool) * 8, 0.95, LAYER_FRONT, variant, charId);
  }
}

/** Materialize: particles on a ring around the chest converge into it. */
function converge(
  pool: SpritePool, x: number, y: number, count: number, radius: number, variant: number, charId: string
): void {
  const cy = y + CHEST;
  for (let n = 0; n < count; n++) {
    const a = srand(pool) * Math.PI * 2;
    const r = radius * (0.8 + srand(pool) * 0.4);
    const family = n % 3 === 0 ? PIECE_MOTE : n % 3 === 1 ? PIECE_SMOKE : PIECE_SHARD;
    toward(pool, family, x + Math.cos(a) * r, cy + Math.sin(a) * r * 1.3, x + sspread(pool, 4), cy + sspread(pool, 8), 7 + srand(pool) * 4, 1, LAYER_FRONT, variant, charId);
  }
}

// ---------------- per move frame ----------------

/** The live projectile `owner` threw from `move` (its first spawned, non-burst def), or null. */
function thrownBy(state: GameState, slot: number, move: MoveDef): { x: number; y: number } | null {
  const shots = move.projectiles;
  if (shots === undefined) return null;
  for (let s = 0; s < shots.length; s++) {
    if (shots[s].spawnFrame < 0) continue;
    for (let k = 0; k < state.projectiles.length; k++) {
      const p = state.projectiles[k];
      if (p.alive && p.owner === slot && p.defId === shots[s].id) return p;
    }
  }
  return null;
}

/** Slivers and motes on the swing's active hitboxes at move frame `k`, seen from (x, y, facing). */
function swingTrail(
  pool: SpritePool, move: MoveDef, k: number, x: number, y: number, facing: number,
  groups: readonly number[] | null, alpha: number, variant: number, charId: string
): void {
  const range = hiddenRange(move);
  for (let h = 0; h < move.hitboxes.length; h++) {
    const hb: HitboxDef = move.hitboxes[h];
    if (k < hb.start || k > hb.end || hb.end - hb.start > TRAIL_MAX_WINDOW) continue;
    if (hb.fromCounter === true || hb.grab !== undefined) continue;
    if (groups !== null && groups.indexOf(hb.group) < 0) continue;
    if (range !== null && k >= range[0] && k <= range[1]) continue;
    const hx = x + hb.x * facing;
    const hy = y + hb.y;
    // Tangent of the swing around the chest: the sliver lies along the arc.
    const dx = hx - x;
    const dy = hy - (y + CHEST);
    const len = Math.sqrt(dx * dx + dy * dy);
    const tx = len > 0.01 ? -dy / len : 0;
    const ty = len > 0.01 ? dx / len : -1;
    // The swing's direction of travel along the arc (clockwise on screen when facing right).
    const ax = tx * facing;
    const ay = ty * facing;
    const rx = len > 0.01 ? dx / len : 0;
    const ry = len > 0.01 ? dy / len : 0;
    if (srand(pool) < SLIVER_CHANCE) {
      // A sliver lying along the arc with some jitter, carried on along it, each one its own size,
      // spin and life.
      const speed = 0.5 + srand(pool) * 1.0;
      const out = sspread(pool, 0.25);
      emitSprite(
        pool, PIECE_SLIVER, hx + sspread(pool, hb.r * 0.6), hy + sspread(pool, hb.r * 0.6),
        ax * speed + rx * out, ay * speed + ry * out, 6 + srand(pool) * 5, 0, 0.88,
        Math.atan2(ay, ax) + sspread(pool, 0.35), sspread(pool, 0.04), SLIVER_SCALE_MIN + srand(pool) * SLIVER_SCALE_SPAN,
        alpha * SLIVER_ALPHA, LAYER_FRONT, variant, charId
      );
    }
    if (srand(pool) < MOTE_CHANCE) {
      const speed = 0.2 + srand(pool) * 0.6;
      emitSprite(
        pool, PIECE_MOTE, hx + sspread(pool, hb.r), hy + sspread(pool, hb.r),
        ax * speed + sspread(pool, 0.3), ay * speed + sspread(pool, 0.3), 8 + srand(pool) * 6,
        0, 0.93, 0, 0, 0.8 + srand(pool) * 0.4, alpha, LAYER_FRONT, variant, charId
      );
    }
  }
}

function moveFrameFx(
  fx: ShadowFx, state: GameState, i: number, f: FighterState, move: MoveDef, k: number, frame: number
): void {
  const pool = fx.pool;
  const v = f.variant;
  const c = f.charId;
  const x = f.x;
  const y = f.y;
  seedSprites(pool, frame, f.slot * 131 + 7, k);

  // Hidden body frames (up special): phase-out, stream, materialize around the thrown sword.
  const range = f.onBranch === true ? null : hiddenRange(move);
  if (range !== null) {
    const sword = thrownBy(state, f.slot, move);
    if (sword !== null) {
      fx.swordX[i] = sword.x;
      fx.swordY[i] = sword.y;
      fx.swordSeen[i] = 1;
    }
    const tx = sword !== null ? sword.x : fx.swordSeen[i] === 1 ? fx.swordX[i] : x + HAND_X * f.facing;
    const ty = sword !== null ? sword.y : fx.swordSeen[i] === 1 ? fx.swordY[i] : y + HAND_Y;
    const h0 = range[0];
    const h1 = range[1];
    if (k >= h0 - 2 && k <= h0 + 2) phaseOut(pool, x, y, 5, tx, ty, v, c);
    if (k >= h0 && k <= h1) {
      // The stream: smoke and motes pulled from where his body is to the sword.
      for (let n = 0; n < 2; n++) {
        toward(pool, PIECE_SMOKE, x + sspread(pool, 8), y + CHEST + sspread(pool, 14), tx, ty, 8 + srand(pool) * 4, 0.85, LAYER_BACK, v, c);
      }
      const t = srand(pool);
      emitSprite(
        pool, PIECE_MOTE, x + (tx - x) * t + sspread(pool, 3), y + CHEST + (ty - y - CHEST) * t, sspread(pool, 0.3), -0.3,
        10 + srand(pool) * 6, 0, 0.95, 0, 0, 1, 1, LAYER_FRONT, v, c
      );
    }
    if (k === h1 + 1) {
      // Out of the sword: where it was last seen, else his raised hand.
      const sx = fx.swordSeen[i] === 1 ? fx.swordX[i] : x + HAND_X * f.facing;
      const sy = fx.swordSeen[i] === 1 ? fx.swordY[i] : y + HAND_Y;
      burst(pool, PIECE_SHARD, 8, sx, sy, 1.2, 2.8, 14, 0.04, LAYER_FRONT, v, c);
      burst(pool, PIECE_MOTE, 6, sx, sy, 0.8, 2.2, 16, 0, LAYER_FRONT, v, c);
      burst(pool, PIECE_SMOKE, 4, sx, sy, 0.4, 1.2, 18, -0.01, LAYER_BACK, v, c);
    }
    if (k >= h1 + 1 && k <= h1 + 6) converge(pool, x, y, 4, 28, v, c);
    if (k > h1 + 6) fx.swordSeen[i] = 0;
  }

  // Shadow step: phase-out before the vanish, materialize on the reappear.
  const step = move.shadowStep;
  if (step !== undefined && f.onBranch !== true) {
    if (k === step.startFrame - 2) {
      phaseOut(pool, x, y, 10, x - f.facing * 10, y + CHEST - 10, v, c);
      burst(pool, PIECE_SMOKE, 6, x, y + CHEST, 0.5, 1.4, 18, -0.01, LAYER_BACK, v, c);
    }
    if (k === step.startFrame + step.travelFrames) {
      burst(pool, PIECE_SMOKE, 6, x, y + CHEST, 0.5, 1.4, 18, -0.01, LAYER_BACK, v, c);
      converge(pool, x, y, 10, 26, v, c);
    }
  }

  // Counter hit branch: a shard burst on the arc, a spike fountain on the eruption. Whiff: none.
  if (move.counter !== undefined && f.onBranch === true) {
    for (let h = 0; h < move.hitboxes.length; h++) {
      const hb = move.hitboxes[h];
      if (hb.fromCounter !== true || k < hb.start || k > hb.end) continue;
      const hx = x + hb.x * f.facing;
      if (hb.y > -20) {
        // Eruption from the floor.
        const count = k === hb.start ? 7 : 2;
        for (let n = 0; n < count; n++) {
          emitSprite(
            pool, PIECE_SPIKE, hx + sspread(pool, hb.r), y - 2, sspread(pool, 0.6), -2.4 - srand(pool) * 2.2,
            16 + srand(pool) * 8, 0.16, 0.99, sspread(pool, 0.25), 0, 0.8 + srand(pool) * 0.5, 1, LAYER_FRONT, v, c
          );
        }
        if (k === hb.start) burst(pool, PIECE_SHARD, 6, hx, y - 6, 1, 2.5, 14, 0.12, LAYER_FRONT, v, c);
      } else {
        const hy = y + hb.y;
        burst(pool, PIECE_SHARD, k === hb.start ? 10 : 3, hx, hy, 1.2, 3, 14, 0.06, LAYER_FRONT, v, c);
        if (k === hb.start) burst(pool, PIECE_MOTE, 5, hx, hy, 0.8, 2, 16, 0, LAYER_FRONT, v, c);
      }
    }
  }

  if (move.id !== undefined && isTrailMove(move.id)) swingTrail(pool, move, k, x, y, f.facing, null, 1, v, c);
  if (move.id === IMPACT_MOVE && k >= IMPACT_FROM && k <= IMPACT_TO) thrustImpact(pool, move, k, x, y, f.facing, v, c);
}

// ---------------- the dash attack impact ----------------

/** The dash attack's thrust impact: its first active frames burst at the blade's tip. */
const IMPACT_MOVE = 'dashatk';
const IMPACT_FROM = 11;
const IMPACT_TO = 13;
/** Half-angle of the forward fan (radians) and the impact flash's scale and life. */
const IMPACT_FAN = 0.55;
const FLASH_SCALE = 5;
const FLASH_LIFE = 4;

/**
 * Shards and spikes fanned forward out of the tip, motes, and an additive flash on the first
 * frame. The tip is the farthest active hitbox's front edge at move frame `k` (86 px on the
 * dash attack), so it follows the hitboxes like the swing trails do.
 */
function thrustImpact(
  pool: SpritePool, move: MoveDef, k: number, x: number, y: number, facing: number, variant: number, charId: string
): void {
  let reach = -1;
  let ty = 0;
  for (let h = 0; h < move.hitboxes.length; h++) {
    const hb = move.hitboxes[h];
    if (k < hb.start || k > hb.end || hb.grab !== undefined || hb.fromCounter === true) continue;
    if (hb.x + hb.r > reach) {
      reach = hb.x + hb.r;
      ty = hb.y;
    }
  }
  if (reach < 0) return;
  const tx = x + (reach - 4) * facing;
  const py = y + ty;
  const first = k === IMPACT_FROM;
  // A wider, faster fan on the first frame; a thinner follow-through after.
  const spikes = first ? 6 : 2;
  const shards = first ? 9 : 3;
  const speed = first ? 1 : 0.7;
  for (let n = 0; n < spikes; n++) {
    const a = sspread(pool, IMPACT_FAN);
    const sp = (3.2 + srand(pool) * 2.6) * speed;
    const vx = Math.cos(a) * sp * facing;
    const vy = Math.sin(a) * sp;
    emitSprite(
      pool, PIECE_SPIKE, tx + sspread(pool, 3), py + sspread(pool, 5), vx, vy, 9 + srand(pool) * 5, 0.04, 0.9,
      Math.atan2(vy, vx) + Math.PI / 2, 0, 0.55 + srand(pool) * 0.35, 1, LAYER_FRONT, variant, charId
    );
  }
  for (let n = 0; n < shards; n++) {
    const a = sspread(pool, IMPACT_FAN * 1.6);
    const sp = (2 + srand(pool) * 3) * speed;
    emitSprite(
      pool, PIECE_SHARD, tx + sspread(pool, 4), py + sspread(pool, 6), Math.cos(a) * sp * facing, Math.sin(a) * sp - 0.4,
      12 + srand(pool) * 6, 0.1, 0.93, srand(pool) * 6.28, sspread(pool, 0.3), 0.8 + srand(pool) * 0.5, 1, LAYER_FRONT, variant, charId
    );
  }
  burst(pool, PIECE_MOTE, first ? 6 : 2, tx, py, 0.8, 2.4, 14, 0, LAYER_FRONT, variant, charId);
  if (first) {
    // The flash: one big additive mote and a tight ring of small ones, gone in a few frames.
    emitSprite(pool, PIECE_MOTE, tx, py, 0, 0, FLASH_LIFE, 0, 1, 0, 0, FLASH_SCALE, 1, LAYER_FRONT, variant, charId);
    emitSprite(pool, PIECE_MOTE, tx - 6 * facing, py, 0, 0, FLASH_LIFE + 1, 0, 1, 0, 0, FLASH_SCALE * 0.6, 1, LAYER_FRONT, variant, charId);
    emitSprite(pool, PIECE_SLIVER, tx, py, 0, 0, FLASH_LIFE, 0, 1, 0, 0, 2.2, 1, LAYER_FRONT, variant, charId);
    burst(pool, PIECE_MOTE, 8, tx, py, 2.5, 3.5, 6, 0, LAYER_FRONT, variant, charId);
  }
}

// ---------------- the aim hold ----------------

/** Px along the aim from the sword's spawn point where the motes gather, and how far they drift. */
const AIM_MOTE_FROM = 24;
const AIM_MOTE_SPAN = 34;

/** While neutral special is held to aim: a few motes drifting out along the aim ray. */
function aimHoldFx(fx: ShadowFx, f: FighterState, frame: number): void {
  const hold = aimHoldOf(f);
  if (hold === null) return;
  const pool = fx.pool;
  seedSprites(pool, frame, f.slot * 131 + 53, 777);
  const dx = AIM_COS[hold.aim] * f.facing;
  const dy = -AIM_SIN[hold.aim];
  const sx = f.x + hold.def.x * f.facing;
  const sy = f.y + hold.def.y;
  if ((frame & 1) === 0) {
    const d = AIM_MOTE_FROM + srand(pool) * AIM_MOTE_SPAN;
    emitSprite(
      pool, PIECE_MOTE, sx + dx * d + sspread(pool, 3), sy + dy * d + sspread(pool, 3), dx * 0.5, dy * 0.5,
      10 + srand(pool) * 6, 0, 0.92, 0, 0, 1, 0.8, LAYER_FRONT, f.variant, f.charId
    );
  }
  if (frame % 6 === 0) smoke(pool, sx + sspread(pool, 4), sy + sspread(pool, 4), dx * 0.3, 0.5, f.variant, f.charId);
}

// ---------------- the shadow clone ----------------

function echoFrameFx(fx: ShadowFx, f: FighterState, move: MoveDef, age: number, frame: number): void {
  const pool = fx.pool;
  const v = f.variant;
  const c = f.charId;
  const place = echoPlace(f, move, f.x, f.y, age);
  if (place === null) return;
  const px = place.x;
  const py = place.y;
  const facing = place.facing;
  seedSprites(pool, frame, f.slot * 131 + 71, age + 1000);
  const echo = move.echo;
  if (age < 0) {
    const delay = echo !== undefined && echo.delayFrames > 0 ? echo.delayFrames : 1;
    if (age === -delay) {
      // Splits off his body in a puff of smoke (place is still on him).
      for (let n = 0; n < 6; n++) smoke(pool, px + sspread(pool, 9), py - 4 - srand(pool) * 44, sspread(pool, 0.3), 0.9, v, c);
      burst(pool, PIECE_MOTE, 3, px, py + CHEST, 0.6, 1.6, 12, 0, LAYER_FRONT, v, c);
      return;
    }
    // The dart: a wake of smoke and motes left behind it, thinning once it has arrived.
    const prev = echoPlace(f, move, f.x, f.y, age - 1);
    const moved = prev === null ? 0 : px - prev.x;
    const wake = moved > 1.5 || moved < -1.5;
    const n = wake ? 3 : 1;
    for (let k = 0; k < n; k++) {
      const back = srand(pool);
      smoke(pool, px - moved * back + sspread(pool, 5), py - 4 - srand(pool) * 40, -moved * 0.08, wake ? 0.85 : 0.6, v, c);
    }
    if (wake) {
      emitSprite(
        pool, PIECE_MOTE, px - moved * 0.5, py + CHEST + sspread(pool, 14), -moved * 0.15, sspread(pool, 0.2),
        8 + srand(pool) * 4, 0, 0.9, 0, 0, 1, 0.9, LAYER_FRONT, v, c
      );
    }
    return;
  }
  const end = echoEndAge(move);
  if (end > 0 && age > end - ECHO_TAIL) {
    // Dissolve.
    for (let n = 0; n < 2; n++) smoke(pool, px + sspread(pool, 12), py - srand(pool) * 46, -facing * 0.3, 0.9, v, c);
    dsmoke(pool, px + sspread(pool, 10), py - 6 - srand(pool) * 40, -facing * 0.2, 0.85, LAYER_BACK, v, c);
    emitSprite(pool, PIECE_MOTE, px + sspread(pool, 10), py - srand(pool) * 40, sspread(pool, 0.3), -0.6, 14, 0, 0.96, 0, 0, 1, 1, LAYER_FRONT, v, c);
    return;
  }
  if ((age & 1) === 0) smoke(pool, px + sspread(pool, 10), py - 6 - srand(pool) * 40, -facing * 0.35, 0.7, v, c);
  if (move.id !== undefined && isTrailMove(move.id)) {
    swingTrail(pool, move, age, px, py, facing, echo === undefined ? null : echo.groups, 0.85, v, c);
  }
}

// ---------------- projectiles ----------------

/** distanceScale on a projectile def, read structurally (the SIM worker adds the field). */
interface MaybeDistance { distanceScale?: { damagePerPx: number; maxDamage: number } }
/** ProjectileState spawn point, read structurally for the same reason. */
interface MaybeSpawn { spawnX?: number; spawnY?: number }

function hasDistanceTrail(def: ProjectileDef): boolean {
  return (def as ProjectileDef & MaybeDistance).distanceScale !== undefined || def.aim === true;
}

/** True once for each (projectile id, age): the trail spawns once per projectile frame. */
function projectileFresh(fx: ShadowFx, id: number, age: number): boolean {
  for (let k = 0; k < PROJ_KEYS; k++) {
    if (fx.projId[k] !== id) continue;
    if (fx.projAge[k] === age) return false;
    fx.projAge[k] = age;
    return true;
  }
  const k = fx.projCursor;
  fx.projCursor = (k + 1) % PROJ_KEYS;
  fx.projId[k] = id;
  fx.projAge[k] = age;
  return true;
}

function projectileFx(fx: ShadowFx, state: GameState, frame: number): void {
  const pool = fx.pool;
  for (let n = 0; n < state.projectiles.length; n++) {
    const p = state.projectiles[n];
    if (!p.alive) continue;
    let owner: FighterState | null = null;
    for (let i = 0; i < state.fighters.length; i++) {
      if (state.fighters[i].slot === p.owner) owner = state.fighters[i];
    }
    if (owner === null || !isShadowChar(owner.charId)) continue;
    const visual = getProjectileVisual(p.defId);
    if (visual === null || !projectileFresh(fx, p.id, p.age)) continue;
    seedSprites(pool, frame, p.id * 17 + 3, p.age);
    const v = owner.variant;
    const c = owner.charId;
    if (hasDistanceTrail(visual.def)) {
      // Distance flown, as the sim scales damage: straight line from the spawn point, else
      // speed times age for a state without it.
      const sp = p as ProjectileState & MaybeSpawn;
      const dx = sp.spawnX === undefined ? 0 : p.x - sp.spawnX;
      const dy = sp.spawnY === undefined ? 0 : p.y - sp.spawnY;
      const dist =
        sp.spawnX === undefined || sp.spawnY === undefined
          ? Math.sqrt(p.vx * p.vx + p.vy * p.vy) * p.age
          : Math.sqrt(dx * dx + dy * dy);
      let puffs = 1 + Math.floor(dist / TRAIL_PX_PER_PUFF);
      if (puffs > TRAIL_MAX_PUFFS) puffs = TRAIL_MAX_PUFFS;
      const grow = 0.8 + 0.1 * puffs;
      for (let m = 0; m < puffs; m++) {
        const back = srand(pool);
        emitSprite(
          pool, PIECE_SMOKE, p.x - p.vx * back + sspread(pool, 3), p.y - p.vy * back + sspread(pool, 3),
          -p.vx * 0.1 + sspread(pool, 0.2), -p.vy * 0.1 - 0.15, 12 + srand(pool) * 8, -0.005, 0.95,
          srand(pool) * 6.28, sspread(pool, 0.05), grow, 0.8, LAYER_BACK, v, c
        );
      }
      if (puffs >= 2 || (p.age & 1) === 0) {
        emitSprite(
          pool, PIECE_MOTE, p.x + sspread(pool, 4), p.y + sspread(pool, 4), sspread(pool, 0.4), sspread(pool, 0.4),
          10 + srand(pool) * 8, 0, 0.95, 0, 0, 1, 1, LAYER_FRONT, v, c
        );
      }
    } else if (visual.def.spawnFrame >= 0 && p.vy < 0 && p.vx * p.vx < p.vy * p.vy) {
      // The rising ascent sword: a thin wake of motes and smoke under it.
      smoke(pool, p.x + sspread(pool, 3), p.y + 10 + srand(pool) * 6, 0, 0.6, v, c);
      if ((p.age & 1) === 0) {
        emitSprite(pool, PIECE_MOTE, p.x + sspread(pool, 3), p.y + 6, 0, 0.3, 10, 0, 0.95, 0, 0, 1, 1, LAYER_FRONT, v, c);
      }
    }
  }
}

// ---------------- driver ----------------

/**
 * Spawn this sim frame's effects. Call once per newly consumed sim frame, after stepping; `steps`
 * is how many sim frames it advanced (move frames skipped by a catch-up render are backfilled).
 */
export function updateShadowFx(fx: ShadowFx, state: GameState, steps: number): void {
  const count = Math.min(state.fighters.length, MAX_PLAYERS);
  const back = steps > MAX_BACKFILL ? MAX_BACKFILL : steps < 1 ? 1 : steps;
  for (let i = 0; i < count; i++) {
    const f = state.fighters[i];
    if (!isShadowChar(f.charId)) {
      fx.lastMove[i] = null;
      fx.lastEchoMove[i] = null;
      continue;
    }
    const def = CHARACTER_DEFS[f.charId];
    if (def === undefined) continue;

    // The move.
    const moveId = f.action === 'attack' ? f.moveId : null;
    const move = moveId === null ? undefined : def.moves[moveId];
    const branch = f.onBranch === true ? 1 : 0;
    if (move === undefined || moveId === null) {
      fx.lastMove[i] = null;
      fx.lastAf[i] = -1;
    } else {
      const af = f.actionFrame;
      // Same move use: the same move and branch, and the frame did not go back (a restart).
      const same = fx.lastMove[i] === moveId && fx.lastBranch[i] === branch && af >= fx.lastAf[i];
      let from = af - back + 1;
      if (same && fx.lastAf[i] + 1 > from) from = fx.lastAf[i] + 1;
      // Never before the move's start or its branch.
      const floor = branch === 1 && move.branch !== undefined ? move.branch.start : 0;
      if (from < floor) from = floor;
      if (!f.charging) {
        for (let k = from; k <= af; k++) moveFrameFx(fx, state, i, f, move, k, state.frame - (af - k));
      } else {
        aimHoldFx(fx, f, state.frame);
      }
      fx.lastMove[i] = moveId;
      fx.lastBranch[i] = branch;
      fx.lastAf[i] = af;
    }

    // The clone.
    const echoId = f.echoMove === undefined ? null : f.echoMove;
    const echoMove = echoId === null ? undefined : def.moves[echoId];
    const age = f.echoAge;
    if (echoMove === undefined || echoId === null || age === undefined) {
      fx.lastEchoMove[i] = null;
    } else {
      const same = fx.lastEchoMove[i] === echoId && age >= fx.lastEchoAge[i];
      let from = age - back + 1;
      if (same && fx.lastEchoAge[i] + 1 > from) from = fx.lastEchoAge[i] + 1;
      const first = echoMove.echo === undefined ? 0 : -echoMove.echo.delayFrames;
      if (from < first) from = first;
      for (let a = from; a <= age; a++) echoFrameFx(fx, f, echoMove, a, state.frame - (age - a));
      fx.lastEchoMove[i] = echoId;
      fx.lastEchoAge[i] = age;
    }
  }
  for (let i = count; i < MAX_PLAYERS; i++) {
    fx.lastMove[i] = null;
    fx.lastEchoMove[i] = null;
  }
  projectileFx(fx, state, state.frame);
}

// ---------------- event bursts ----------------

/** Shards and motes on one of his hits; an echo hit adds a puff of the clone's smoke. */
export function shadowHitBurst(
  fx: ShadowFx, frame: number, x: number, y: number, damage: number, echo: boolean, variant: number, charId: string
): void {
  if (!isShadowChar(charId)) return;
  const pool = fx.pool;
  seedSprites(pool, frame, Math.round(x) * 7 + Math.round(y), 911);
  const shards = 3 + Math.min(8, Math.floor(damage / 2));
  burst(pool, PIECE_SHARD, shards, x, y, 1.2, 3.2, 14, 0.08, LAYER_FRONT, variant, charId);
  burst(pool, PIECE_MOTE, 3, x, y, 0.6, 1.8, 16, 0, LAYER_FRONT, variant, charId);
  if (echo) burst(pool, PIECE_SMOKE, 4, x, y, 0.3, 1, 18, -0.01, LAYER_BACK, variant, charId);
}

/** A KO blast: a ring of shards, motes and smoke. */
export function shadowKoBurst(fx: ShadowFx, frame: number, x: number, y: number, variant: number, charId: string): void {
  if (!isShadowChar(charId)) return;
  const pool = fx.pool;
  seedSprites(pool, frame, Math.round(x) * 7 + Math.round(y), 977);
  burst(pool, PIECE_SHARD, 16, x, y, 2, 4.5, 24, 0.03, LAYER_FRONT, variant, charId);
  burst(pool, PIECE_MOTE, 8, x, y, 1, 3, 26, 0, LAYER_FRONT, variant, charId);
  burst(pool, PIECE_SMOKE, 4, x, y, 0.5, 1.6, 28, -0.01, LAYER_BACK, variant, charId);
  burst(pool, PIECE_DSMOKE, 6, x, y, 0.4, 1.3, 32, -0.012, LAYER_BACK, variant, charId);
}

/** The recall teleport: phase-out where he stood, materialize burst at the sword. */
export function shadowRecall(
  fx: ShadowFx, frame: number, slot: number, fromX: number, fromY: number, x: number, y: number,
  variant: number, charId: string
): void {
  if (!isShadowChar(charId)) return;
  const pool = fx.pool;
  seedSprites(pool, frame, slot * 131 + 29, 1);
  phaseOut(pool, fromX, fromY, 10, x, y + CHEST, variant, charId);
  burst(pool, PIECE_SMOKE, 5, fromX, fromY + CHEST, 0.4, 1.2, 18, -0.01, LAYER_BACK, variant, charId);
  burst(pool, PIECE_SHARD, 8, x, y + CHEST, 1.2, 2.6, 14, 0.05, LAYER_FRONT, variant, charId);
  burst(pool, PIECE_MOTE, 5, x, y + CHEST, 0.6, 1.8, 16, 0, LAYER_FRONT, variant, charId);
  converge(pool, x, y, 8, 26, variant, charId);
}
