import { LEDGE_HANG_INVULN, LEDGE_MAX_REGRABS, ROLL } from '../core/constants';
import { Btn } from '../core/types';
import type { ActionId, CharacterDef, GameState, Platform } from '../core/types';
import { heldDir, heldDown, heldUp, takeBuffered } from './input';
import { setAction, simFighters, stageOf, type SimFighter } from './state';
import { startMove } from './moves';

/** Feet sit this far below the platform top while hanging. */
const HANG_DROP = 20;
const CLIMB_FRAMES = 30;
const CLIMB_INVULN_FRAMES = 20;
const CLIMB_INSET = 14;
const ROLL_INSET = 34;
const LEDGE_DROP_COOLDOWN = 12;
/** How far below the corner the snap region reaches, past the grab box height. */
const SNAP_BELOW = 20;

export function isLedgeAction(action: ActionId): boolean {
  return action === 'ledgeGrab' || action === 'ledgeHang' || action === 'ledgeClimb'
    || action === 'ledgeRoll' || action === 'ledgeJump';
}

function ledgeTaken(state: GameState, index: number): boolean {
  const fighters = simFighters(state);
  for (let i = 0; i < fighters.length; i++) {
    if (fighters[i].ledge === index) return true;
  }
  return false;
}

function releaseLedge(f: SimFighter): void {
  f.ledge = -1;
}

function placeOnStage(f: SimFighter, def: CharacterDef, p: Platform, cornerX: number, inward: number, inset: number): void {
  f.x = cornerX + inward * inset;
  f.y = p.y;
  f.vx = 0;
  f.vy = 0;
  f.onGround = true;
  f.jumpsLeft = def.jumps;
  f.ledgeRegrabs = 0;
  releaseLedge(f);
}

function grabLedge(
  state: GameState, f: SimFighter, def: CharacterDef, index: number,
  cornerX: number, topY: number, inward: number,
): void {
  f.ledge = index;
  f.x = cornerX;
  f.y = topY + HANG_DROP;
  f.vx = 0;
  f.vy = 0;
  f.kbSpeed = 0;
  f.facing = inward === 1 ? 1 : -1;
  f.onGround = false;
  f.fastFalling = false;
  f.jumpsLeft = def.jumps;
  setAction(f, 'ledgeHang');
  f.ledgeRegrabs++;
  if (f.ledgeRegrabs <= LEDGE_MAX_REGRABS) f.invuln = LEDGE_HANG_INVULN;
}

/**
 * Ledge snap (SPEC 4.5). The fighter's ledgeGrabBox is tested against a region that
 * hangs off the platform corner: outward by the grab box width, from just above the
 * corner down by its height. Airborne, falling, not attacking, facing the stage or
 * drifting toward it, and the ledge must be free.
 */
export function tryLedgeGrab(state: GameState, f: SimFighter, def: CharacterDef): void {
  if (f.ledge >= 0 || f.onGround || f.vy <= 0) return;
  if (f.hitstun > 0 || f.ledgeCooldown > 0) return;
  if (f.action === 'attack' || f.action === 'hitstun' || f.action === 'tumble') return;
  if (isLedgeAction(f.action)) return;

  const box = def.ledgeGrabBox;
  const bx0 = f.x - box.w / 2;
  const bx1 = f.x + box.w / 2;
  const by0 = f.y + box.yOff;
  const by1 = by0 + box.h;
  const stage = stageOf(state);

  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    for (let side = 0; side < 2; side++) {
      if (side === 0 ? !p.ledgeLeft : !p.ledgeRight) continue;
      const index = i * 2 + side;
      if (ledgeTaken(state, index)) continue;

      const outward = side === 0 ? -1 : 1;
      const cornerX = side === 0 ? p.x : p.x + p.w;
      const rx0 = side === 0 ? cornerX - box.w : cornerX;
      const rx1 = side === 0 ? cornerX : cornerX + box.w;
      const ry0 = p.y - 4;
      const ry1 = p.y + box.h + SNAP_BELOW;
      if (bx1 < rx0 || bx0 > rx1 || by1 < ry0 || by0 > ry1) continue;
      if ((f.x - cornerX) * outward < -2) continue;

      const inward = -outward;
      const toward = f.facing === inward || f.vx * inward > 0 || heldDir(f) === inward;
      if (!toward) continue;
      grabLedge(state, f, def, index, cornerX, p.y, inward);
      return;
    }
  }
}

/** Ledge hang and its options. Position is owned here, physics skips these actions. */
export function stepLedge(state: GameState, f: SimFighter, def: CharacterDef): void {
  const stage = stageOf(state);
  const pi = f.ledge >> 1;
  if (f.ledge < 0 || pi >= stage.platforms.length) {
    releaseLedge(f);
    setAction(f, 'air');
    return;
  }
  const side = f.ledge & 1;
  const p = stage.platforms[pi];
  const cornerX = side === 0 ? p.x : p.x + p.w;
  const inward = side === 0 ? 1 : -1;

  if (f.action === 'ledgeHang') {
    f.x = cornerX;
    f.y = p.y + HANG_DROP;
    f.vx = 0;
    f.vy = 0;

    if (takeBuffered(f, Btn.Jump)) {
      releaseLedge(f);
      setAction(f, 'air');
      f.x = cornerX + inward * 6;
      f.vy = -def.jumpVel;
      f.jumpsLeft = def.jumps - 1;
      f.ledgeCooldown = LEDGE_DROP_COOLDOWN;
      state.events.push({ type: 'jump', x: f.x, y: f.y, slot: f.slot, double: false });
      return;
    }
    if (takeBuffered(f, Btn.Attack)) {
      placeOnStage(f, def, p, cornerX, inward, CLIMB_INSET);
      startMove(state, f, def, 'ledgeatk');
      return;
    }
    if (takeBuffered(f, Btn.Shield)) {
      setAction(f, 'ledgeRoll');
      return;
    }
    const dir = heldDir(f);
    if (heldUp(f) || dir === inward) {
      setAction(f, 'ledgeClimb');
      return;
    }
    if (heldDown(f) || dir === -inward) {
      releaseLedge(f);
      setAction(f, 'air');
      f.jumpsLeft = def.jumps;
      f.ledgeCooldown = LEDGE_DROP_COOLDOWN;
      return;
    }
    return;
  }

  if (f.action === 'ledgeClimb') {
    if (f.actionFrame < CLIMB_INVULN_FRAMES && f.invuln < 2) f.invuln = 2;
    if (f.actionFrame >= CLIMB_FRAMES) {
      placeOnStage(f, def, p, cornerX, inward, CLIMB_INSET);
      setAction(f, 'idle');
    }
    return;
  }

  if (f.action === 'ledgeRoll') {
    if (f.actionFrame <= ROLL.invEnd && f.invuln < 2) f.invuln = 2;
    if (f.actionFrame >= ROLL.total) {
      placeOnStage(f, def, p, cornerX, inward, ROLL_INSET);
      setAction(f, 'idle');
    }
    return;
  }

  releaseLedge(f);
  setAction(f, 'air');
}
