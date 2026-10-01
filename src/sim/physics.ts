import { TUNING } from '../core/constants';
import type { ActionId, CharacterDef, GameState, Rect, StageDef } from '../core/types';
import { AIR_DODGE_LAND_LAG, HELPLESS_LAND_LAG, LAND_LAG } from './actions';
import { heldDir } from './input';
import { isLedgeAction, tryLedgeGrab } from './ledge';
import { koFighter } from './match';
import { isGrabAction } from './grab';
import { fighterHurtbox, setAction, stageOf, type SimFighter } from './state';
import { landTumble } from './tech';

const BOX: Rect = { x: 0, y: 0, w: 0, h: 0 };

/** Grabbing, holding, pummelling or throwing: held directions never move these. */
function isGrabberAction(action: ActionId): boolean {
  return action === 'grab' || action === 'grabHold' || action === 'pummel' || action === 'throw';
}

function usesGroundFriction(action: ActionId): boolean {
  return action === 'idle' || action === 'crouch' || action === 'turn' || action === 'land'
    || action === 'attack' || action === 'shield' || action === 'shieldStun'
    || action === 'shieldBreak' || action === 'spotDodge' || isGrabberAction(action)
    || action === 'tech' || action === 'downed' || action === 'getUp' || action === 'footstooled';
}

function keepsActionOffLedge(action: ActionId): boolean {
  return action === 'attack' || action === 'hitstun' || action === 'tumble'
    || action === 'spotDodge' || action === 'roll' || isGrabberAction(action);
}

function applyFriction(f: SimFighter, def: CharacterDef): void {
  if (f.vx > 0) f.vx = Math.max(0, f.vx - def.groundFriction);
  else if (f.vx < 0) f.vx = Math.min(0, f.vx + def.groundFriction);
}

function airDrift(f: SimFighter, def: CharacterDef): void {
  if (f.action === 'airDodge') return;
  // A footstooled fighter cannot act, and drifting is acting.
  const dir = isGrabberAction(f.action) || f.action === 'footstooled' ? 0 : heldDir(f);
  if (dir === 0) {
    if (f.vx > 0) f.vx = Math.max(0, f.vx - def.airFriction);
    else if (f.vx < 0) f.vx = Math.min(0, f.vx + def.airFriction);
    return;
  }
  const target = dir * def.airSpeed;
  // Holding a direction never scrubs speed already above airSpeed, so launch
  // momentum survives drifting with it.
  if (dir > 0 ? f.vx < target : f.vx > target) {
    f.vx = dir > 0 ? Math.min(target, f.vx + def.airAccel) : Math.max(target, f.vx - def.airAccel);
  }
}

/** Launch speed decays along the launch direction while gravity builds separately. */
function knockbackDecay(f: SimFighter, def: CharacterDef): void {
  f.kbSpeed = Math.max(0, f.kbSpeed - TUNING.knockback.decay);
  if (f.onGround) f.kbFall = 0;
  else f.kbFall = Math.min(def.maxFall, f.kbFall + def.gravity);
  f.vx = f.kbDirX * f.kbSpeed;
  f.vy = f.kbDirY * f.kbSpeed + f.kbFall;
  if (f.onGround && f.vy > 0) f.vy = 0;
}

function landOn(state: GameState, f: SimFighter, def: CharacterDef, top: number, impactVy: number): void {
  f.y = top;
  f.vy = 0;
  f.onGround = true;
  f.fastFalling = false;
  f.jumpsLeft = def.jumps;
  f.airDodgeUsed = false;
  f.ledgeRegrabs = 0;
  f.ledge = -1;
  state.events.push({ type: 'land', x: f.x, y: f.y, slot: f.slot, hard: impactVy >= def.fastFall });

  // Techs and knockdowns own every tumble landing and teched hitstun landings.
  if (landTumble(state, f)) return;
  if (f.action === 'hitstun') {
    f.kbDirY = 0;
    f.kbFall = 0;
    return;
  }
  f.kbSpeed = 0;
  f.kbFall = 0;
  // A grab in progress survives touching down; landing lag would break the hold.
  if (isGrabAction(f.action)) return;
  // A footstooled fighter stays stunned through the landing; stepFootstooled ends it on its own timer.
  if (f.action === 'footstooled') return;
  if (f.action === 'attack') {
    if (f.moveId === null) return;
    const mv = def.moves[f.moveId];
    if (mv.landingLag === undefined) return;
    setAction(f, 'land');
    f.stateTimer = mv.landingLag;
    return;
  }
  if (f.action === 'airDodge') {
    setAction(f, 'land');
    f.stateTimer = AIR_DODGE_LAND_LAG;
    return;
  }
  if (f.action === 'airHelpless') {
    setAction(f, 'land');
    f.stateTimer = HELPLESS_LAND_LAG;
    return;
  }
  setAction(f, 'land');
  f.stateTimer = LAND_LAG;
}

/** Pass-through platforms only catch feet that were above the top last frame. */
function findLanding(stage: StageDef, f: SimFighter): number {
  if (f.vy < 0) return -1;
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (f.x < p.x || f.x > p.x + p.w) continue;
    if (f.y < p.y || f.prevY > p.y + 0.001) continue;
    if (!p.solid && f.dropTimer > 0) continue;
    return i;
  }
  return -1;
}

/** Least outward speed, px a frame, of a fighter sliding off a corner it cannot stand on. */
const CORNER_SLIDE = 2;

/**
 * Band, px in from a ledge corner (the fighter's centre), where rising into a solid platform's
 * underside slides the fighter out past the corner instead of stopping its rise.
 */
const UNDER_EDGE_BAND = 40;

/** Solid platforms block their sides and underside. */
function resolveSolids(state: GameState, f: SimFighter, def: CharacterDef, stage: StageDef): void {
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (!p.solid) continue;
    fighterHurtbox(f, def, BOX);
    if (BOX.x >= p.x + p.w || BOX.x + BOX.w <= p.x || BOX.y >= p.y + p.h || BOX.y + BOX.h <= p.y) continue;

    const fromLeft = (BOX.x + BOX.w) - p.x;
    const fromRight = (p.x + p.w) - BOX.x;
    const fromTop = (BOX.y + BOX.h) - p.y;
    const fromBottom = (p.y + p.h) - BOX.y;
    if (fromTop <= fromLeft && fromTop <= fromRight && fromTop <= fromBottom && f.vy >= 0) {
      // Standing needs the centre over the top, the same point checkSupport reads. A fighter
      // whose hurtbox only clips the corner with its centre past the edge slides off it,
      // outward at no less than CORNER_SLIDE px a frame, and keeps falling. Landing it there
      // instead would drop support next frame and hover it at the top forever.
      if (f.x < p.x || f.x > p.x + p.w) {
        const outward = f.x < p.x ? -1 : 1;
        const overlap = outward > 0 ? fromRight : fromLeft;
        const extra = CORNER_SLIDE - Math.max(0, f.vx * outward);
        if (extra > 0) f.x += outward * Math.min(overlap, extra);
        continue;
      }
      landOn(state, f, def, p.y, f.vy);
      return;
    }
    if (fromBottom <= fromLeft && fromBottom <= fromRight) {
      // Recovering from below (SSBU style): rising into the underside within UNDER_EDGE_BAND px of
      // a ledge corner slides the fighter out past that corner instead of bonking, so it keeps
      // rising beside the stage and can catch the ledge. Under the middle it still bonks.
      if (f.vy < 0) {
        if (p.ledgeLeft && f.x - p.x <= UNDER_EDGE_BAND && f.x - p.x <= (p.x + p.w) - f.x) {
          f.x -= fromLeft;
          if (f.vx > 0) f.vx = 0;
          continue;
        }
        if (p.ledgeRight && (p.x + p.w) - f.x <= UNDER_EDGE_BAND) {
          f.x += fromRight;
          if (f.vx < 0) f.vx = 0;
          continue;
        }
      }
      f.y += fromBottom;
      if (f.vy < 0) {
        f.vy = 0;
        f.kbSpeed = 0;
      }
    } else if (fromLeft <= fromRight) {
      f.x -= fromLeft;
      if (f.vx > 0) f.vx = 0;
    } else {
      f.x += fromRight;
      if (f.vx < 0) f.vx = 0;
    }
  }
}

function checkSupport(f: SimFighter, stage: StageDef): void {
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (Math.abs(f.y - p.y) <= 0.5 && f.x >= p.x && f.x <= p.x + p.w) return;
  }
  f.onGround = false;
  if (!keepsActionOffLedge(f.action)) setAction(f, 'air');
}

function checkBlast(state: GameState, f: SimFighter, stage: StageDef): void {
  const b = stage.blast;
  if (f.x >= b.x && f.x <= b.x + b.w && f.y >= b.y && f.y <= b.y + b.h) return;
  const side = f.x < b.x ? 'left' : f.x > b.x + b.w ? 'right' : f.y < b.y ? 'top' : 'bottom';
  if (side === 'top') {
    const launched = f.hitstun > 0 || f.action === 'hitstun' || f.action === 'grabbed' || f.action === 'finalSmashVictim';
    if (!launched) {
      // Top line only KOs launched fighters, as in Smash; jumps and rising specials stop at it.
      f.y = b.y;
      if (f.vy < 0) f.vy = 0;
      return;
    }
  }
  koFighter(state, f, side);
}

/** Step 4b of the frame: velocity, integration, platforms, ledges, blast zones. */
export function stepPhysics(state: GameState, f: SimFighter, def: CharacterDef): void {
  if (f.action === 'dead' || f.action === 'respawn' || isLedgeAction(f.action)) return;
  const stage = stageOf(state);
  // A grabbed fighter hangs in the holder's hand; syncGrabbed places it every frame.
  if (f.action === 'grabbed') {
    checkBlast(state, f, stage);
    return;
  }
  // A Final Smash attacker hangs where it started and its victim rides syncFinalSmash's
  // path: no gravity, no integration, no platforms. Only the blast zone still applies.
  if (f.action === 'finalSmash' || f.action === 'finalSmashVictim') {
    checkBlast(state, f, stage);
    return;
  }

  // Launch speed decays only while hitstun lasts. A tumbling fighter is out of
  // hitstun and falls under normal air physics, so drifting back is possible.
  if (f.hitstun > 0 && (f.action === 'hitstun' || f.action === 'tumble')) {
    knockbackDecay(f, def);
  } else {
    // A move frame that set an upward vy (a rising special started on the floor) lifts
    // the fighter off the ground this frame, the way a jump does, instead of the ground
    // zeroing it. The move keeps running, so the action stays 'attack'.
    if (f.onGround && f.skipGravity && f.vy < 0) {
      f.onGround = false;
      f.fastFalling = false;
    }
    if (f.onGround) {
      f.vy = 0;
      if (usesGroundFriction(f.action)) applyFriction(f, def);
    } else {
      airDrift(f, def);
      if (!f.skipGravity) {
        const cap = f.fastFalling ? def.fastFall : def.maxFall;
        f.vy = Math.min(f.vy + def.gravity, Math.max(cap, f.vy));
      }
    }
  }

  const impactVy = f.vy;
  f.x += f.vx;
  f.y += f.vy;

  if (!f.onGround) {
    const plat = findLanding(stage, f);
    if (plat >= 0) landOn(state, f, def, stage.platforms[plat].y, impactVy);
  }
  if (!f.onGround) resolveSolids(state, f, def, stage);
  if (f.onGround) checkSupport(f, stage);
  if (!f.onGround && !isGrabAction(f.action)) tryLedgeGrab(state, f, def);
  checkBlast(state, f, stage);
}
