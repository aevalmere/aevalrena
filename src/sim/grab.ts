import { TUNING } from '../core/constants';
import { circleRectOverlap } from '../core/math';
import { Btn } from '../core/types';
import type { ActionId, CharacterDef, GameState, GrabSpec, Rect, ThrowDef, ThrowId } from '../core/types';
import { grabKitOf } from '../characters/common/grabkit';
import { applyHit, gainFsMeter } from './hits';
import { C_STICK, clearBuffer, commandOf, peekBufferedDirect, takeBuffered, takeBufferedDirect } from './input';
import { isLedgeAction } from './ledge';
import {
  countMoveStart, defOf, fighterHurtbox, recordHit, sameTeam, setAction, simFighters, type SimFighter,
} from './state';

/**
 * Grabs, pummels and throws.
 *
 * A catch links two fighters by fighters[] index: the holder's grabPartner names the
 * victim and the victim's names the holder. Either side checks the link on its own step
 * and lets go the moment the other side has left its grab action, so anything that
 * knocks one of them out of it (a third party's hit, a KO) frees both without the hit
 * code having to know about grabs. The victim's position is owned by syncGrabbed.
 */

const HURT: Rect = { x: 0, y: 0, w: 0, h: 0 };
const PERCENT_CAP = 999;
/** Freeze frames both sides take when a pummel lands. */
const PUMMEL_HITLAG = 4;
/** A throw direction that stays held picks the throw once the hold is this many frames old. */
const HELD_THROW_FRAME = 8;
/** What a released holder and victim are left with. */
const RELEASE_LAND_LAG = 10;
const RELEASE_HITSTUN = 12;
const RELEASE_PUSH = 2.5;
/** Every press that counts toward mashing out. */
const MASH_BUTTONS = Btn.Left | Btn.Right | Btn.Up | Btn.Down | Btn.Jump | Btn.Attack
  | Btn.Special | Btn.Shield | Btn.Grab | Btn.Dodge;

/** Actions that belong to a grab, on either side of it. */
export function isGrabAction(action: ActionId): boolean {
  return action === 'grab' || action === 'grabHold' || action === 'pummel'
    || action === 'throw' || action === 'grabbed';
}

/** Actions a fighter holding someone can be in. */
function isHolderAction(action: ActionId): boolean {
  return action === 'grabHold' || action === 'pummel' || action === 'throw';
}

function indexOfFighter(fighters: SimFighter[], f: SimFighter): number {
  for (let i = 0; i < fighters.length; i++) {
    if (fighters[i] === f) return i;
  }
  return -1;
}

function partnerOf(fighters: SimFighter[], f: SimFighter): SimFighter | null {
  const i = f.grabPartner;
  return i >= 0 && i < fighters.length ? fighters[i] : null;
}

function bitCount(bits: number): number {
  let n = 0;
  let b = bits;
  while (b !== 0) {
    b &= b - 1;
    n++;
  }
  return n;
}

/**
 * Clears the grab link on `f`, and on its partner too when the partner still points
 * back at `f`. Leaves both actions alone. Safe to call on a fighter with no link.
 */
export function unlinkGrab(state: GameState, f: SimFighter): void {
  const fighters = simFighters(state);
  const partner = partnerOf(fighters, f);
  if (partner !== null && partner.grabPartner === indexOfFighter(fighters, f)) {
    partner.grabPartner = -1;
    partner.grabForce = false;
  }
  f.grabPartner = -1;
  f.grabForce = false;
}

/** Ends a grab action whose link is gone: idle on the ground, air otherwise. */
function dropOut(state: GameState, f: SimFighter): void {
  unlinkGrab(state, f);
  f.activeThrow = null;
  f.activeThrowId = null;
  setAction(f, f.onGround ? 'idle' : 'air');
}

/**
 * Whether `holder` may catch `victim` right now. Shielding victims can be grabbed; a
 * roll (highDodge) and being airborne only stop a grab that is not a force grab.
 */
export function canBeGrabbed(state: GameState, holder: SimFighter, victim: SimFighter, force: boolean): boolean {
  if (holder === victim) return false;
  // Teams rule: friendly fire is off, and that includes grabs.
  if (sameTeam(state, holder.slot, victim.slot)) return false;
  if (victim.action === 'dead' || victim.action === 'respawn') return false;
  if (holder.action === 'dead' || holder.action === 'respawn') return false;
  if (victim.invuln > 0) return false;
  if (isLedgeAction(victim.action)) return false;
  if (isHolderAction(victim.action) || victim.action === 'grabbed') return false;
  if (!force && victim.highDodge > 0) return false;
  if (!force && !victim.onGround) return false;
  return indexOfFighter(simFighters(state), victim) >= 0;
}

/** The grab button: a standing grab, or the longer dash grab out of a dash or run. */
export function startGrab(state: GameState, f: SimFighter, def: CharacterDef): void {
  // Momentum is kept, so a dash grab slides into its reach and friction stops it. The
  // kit's boxes are read on every step, so state and def are only here for symmetry
  // with startMove.
  f.grabDash = f.action === 'dash' || f.action === 'run';
  setAction(f, 'grab');
  f.activeThrow = null;
  f.activeThrowId = null;
}

/**
 * The reusable grab. Catches `victim` for `holder` if canBeGrabbed allows it, with the
 * spec's force flag, hold length and immediate throw. Grab boxes, grab hitboxes and
 * command grabs all come through here. Returns true on a catch.
 */
export function forceGrab(state: GameState, holder: SimFighter, victim: SimFighter, spec?: GrabSpec): boolean {
  const force = spec !== undefined && spec.force === true;
  if (!canBeGrabbed(state, holder, victim, force)) return false;
  const fighters = simFighters(state);
  const kit = grabKitOf(defOf(holder));

  holder.grabPartner = indexOfFighter(fighters, victim);
  victim.grabPartner = indexOfFighter(fighters, holder);
  setAction(holder, 'grabHold');
  setAction(victim, 'grabbed');
  holder.activeThrow = null;
  holder.activeThrowId = null;
  victim.activeThrow = null;
  victim.activeThrowId = null;
  holder.grabForce = force;
  victim.grabForce = force;

  victim.facing = holder.facing === 1 ? -1 : 1;
  victim.vx = 0;
  victim.vy = 0;
  victim.kbSpeed = 0;
  victim.kbFall = 0;
  victim.hitstun = 0;
  victim.fastFalling = false;
  victim.ledge = -1;

  holder.grabTimer = spec !== undefined && spec.holdFrames !== undefined
    ? spec.holdFrames
    : Math.round(kit.holdBase + kit.holdPerPercent * victim.percent);
  clearBuffer(holder);
  clearBuffer(victim);
  state.events.push({ type: 'grab', x: victim.x, y: victim.y - 20, attacker: holder.slot, victim: victim.slot });
  if (!state.finished) holder.stats.grabs++;

  if (spec !== undefined && spec.throwNow !== undefined) startThrow(state, holder, spec.throwNow);
  return true;
}

/** Starts a throw from the holder's kit, or a custom ThrowDef. A back throw turns the holder around. */
export function startThrow(state: GameState, holder: SimFighter, t: ThrowId | ThrowDef): void {
  setAction(holder, 'throw');
  if (typeof t === 'string') {
    holder.activeThrow = grabKitOf(defOf(holder)).throws[t];
    holder.activeThrowId = t;
    if (t === 'bthrow') holder.facing = holder.facing === 1 ? -1 : 1;
    return;
  }
  holder.activeThrow = t;
  holder.activeThrowId = 'custom';
}

/**
 * Lets go without a throw, when the hold runs out: the holder takes a short landing lag
 * (or falls, airborne) and the victim is pushed away in brief hitstun.
 */
export function releaseGrab(state: GameState, holder: SimFighter): void {
  const victim = partnerOf(simFighters(state), holder);
  const linked = victim !== null && victim.grabPartner === indexOfFighter(simFighters(state), holder);
  unlinkGrab(state, holder);
  holder.activeThrow = null;
  holder.activeThrowId = null;
  if (holder.onGround) {
    setAction(holder, 'land');
    holder.stateTimer = RELEASE_LAND_LAG;
  } else {
    setAction(holder, 'air');
  }
  if (victim === null || !linked || victim.action !== 'grabbed') return;

  setAction(victim, 'hitstun');
  victim.hitstun = RELEASE_HITSTUN;
  // Hitstun movement runs on the knockback fields, so the push is written there.
  victim.kbDirX = holder.facing;
  victim.kbDirY = 0;
  victim.kbSpeed = RELEASE_PUSH;
  victim.kbFall = 0;
  victim.vx = holder.facing * RELEASE_PUSH;
  victim.vy = 0;
  clearBuffer(victim);
}

/**
 * The throw a set of direction bits asks for, relative to the holder's facing, or null.
 * `up`/`down`/`left`/`right` are the bits to read for each direction.
 */
function throwFor(f: SimFighter, bits: number, up: number, down: number, left: number, right: number): ThrowId | null {
  if ((bits & up) !== 0) return 'uthrow';
  if ((bits & down) !== 0) return 'dthrow';
  const l = (bits & left) !== 0;
  const r = (bits & right) !== 0;
  if (l === r) return null;
  return (r ? 1 : -1) === f.facing ? 'fthrow' : 'bthrow';
}

function stepHold(state: GameState, f: SimFighter, def: CharacterDef, victim: SimFighter): void {
  const kit = grabKitOf(def);
  f.grabTimer--;
  if (!f.grabForce) f.grabTimer -= kit.mashFrames * bitCount(victim.inputPressed & MASH_BUTTONS);
  if (f.grabTimer <= 0) {
    // A command grab cannot be mashed out of or dropped: it ends in a throw.
    if (f.grabForce) startThrow(state, f, 'fthrow');
    else releaseGrab(state, f);
    return;
  }
  // The pummel and throw commands do exactly what Attack and a throw direction do. Any
  // other command has nothing to do in a hold and is dropped.
  const cmd = commandOf(peekBufferedDirect(f));
  if (cmd !== null) takeBufferedDirect(f);
  if (takeBuffered(f, Btn.Attack) || cmd === 'pummel') {
    setAction(f, 'pummel');
    return;
  }
  if (cmd === 'fthrow' || cmd === 'bthrow' || cmd === 'uthrow' || cmd === 'dthrow') {
    startThrow(state, f, cmd);
    return;
  }

  let pick: ThrowId | null = null;
  const c = f.buffer.btn & C_STICK;
  if (c !== 0) {
    takeBuffered(f, C_STICK);
    pick = throwFor(f, c, Btn.CUp, Btn.CDown, Btn.CLeft, Btn.CRight);
  }
  if (pick === null) pick = throwFor(f, f.inputPressed, Btn.Up, Btn.Down, Btn.Left, Btn.Right);
  if (pick === null && f.actionFrame >= HELD_THROW_FRAME) {
    pick = throwFor(f, f.inputHeld, Btn.Up, Btn.Down, Btn.Left, Btn.Right);
  }
  if (pick !== null) startThrow(state, f, pick);
}

function stepPummel(state: GameState, f: SimFighter, def: CharacterDef, victim: SimFighter): void {
  const pummel = grabKitOf(def).pummel;
  if (f.actionFrame === pummel.hitFrame && !sameTeam(state, f.slot, victim.slot)) {
    const damage = pummel.damage * TUNING.knockback.damageMul;
    recordHit(state, victim, f.slot, Math.min(PERCENT_CAP, victim.percent + damage) - victim.percent);
    victim.percent = Math.min(PERCENT_CAP, victim.percent + damage);
    victim.lastHitBy = f.slot;
    gainFsMeter(state, f, victim, damage);
    if (f.hitlag < PUMMEL_HITLAG) f.hitlag = PUMMEL_HITLAG;
    if (victim.hitlag < PUMMEL_HITLAG) victim.hitlag = PUMMEL_HITLAG;
    state.events.push({
      type: 'hit', x: victim.x, y: victim.y - 20,
      attacker: f.slot, victim: victim.slot, damage, kb: 0, angle: 0,
    });
  }
  // setAction leaves grabTimer alone, so the hold picks up where it paused.
  if (f.actionFrame >= pummel.totalFrames) setAction(f, 'grabHold');
}

function stepThrow(state: GameState, f: SimFighter, victim: SimFighter | null): void {
  const t = f.activeThrow;
  if (t === null) {
    dropOut(state, f);
    return;
  }
  if (victim !== null) {
    if (f.actionFrame < t.releaseFrame) return;
    const id = f.activeThrowId === null ? 'custom' : f.activeThrowId;
    unlinkGrab(state, f);
    clearBuffer(victim);
    state.events.push({ type: 'throw', x: victim.x, y: victim.y - 10, attacker: f.slot, victim: victim.slot, throwId: id });
    if (!state.finished) {
      f.stats.throws++;
      countMoveStart(f, id);
    }
    applyHit(state, victim, f.slot, f.facing, t.damage, t.angle, t.bkb, t.kbg, 1, 0, victim.x, victim.y - 10);
  } else if (f.actionFrame <= t.releaseFrame) {
    // The victim was freed before the launch (a KO, say), so there is nothing to finish.
    dropOut(state, f);
    return;
  }
  if (f.actionFrame < t.totalFrames) return;
  f.activeThrow = null;
  f.activeThrowId = null;
  setAction(f, f.onGround ? 'idle' : 'air');
}

/** One step of any grab action, for either side. Called from stepAction. */
export function stepGrabAction(state: GameState, f: SimFighter, def: CharacterDef): void {
  const fighters = simFighters(state);
  const me = indexOfFighter(fighters, f);

  if (f.action === 'grab') {
    const kit = grabKitOf(def);
    const box = f.grabDash ? kit.dash : kit.stand;
    if (f.actionFrame >= box.start && f.actionFrame <= box.end) {
      const cx = f.x + box.x * f.facing;
      const cy = f.y + box.y;
      // Lowest index wins, so a grab into two bodies at once is decided the same way every run.
      for (let v = 0; v < fighters.length; v++) {
        const vic = fighters[v];
        if (!canBeGrabbed(state, f, vic, false)) continue;
        fighterHurtbox(vic, defOf(vic), HURT);
        if (!circleRectOverlap(cx, cy, box.r, HURT)) continue;
        forceGrab(state, f, vic);
        return;
      }
    }
    if (f.actionFrame >= box.totalFrames) setAction(f, f.onGround ? 'idle' : 'air');
    return;
  }

  const partner = partnerOf(fighters, f);
  if (f.action === 'grabbed') {
    // Only mashing reads the victim's input, and the holder does that. Position comes from syncGrabbed.
    if (partner === null || !isHolderAction(partner.action) || partner.grabPartner !== me) dropOut(state, f);
    return;
  }

  if (f.action === 'throw') {
    const released = f.grabPartner < 0;
    if (!released && (partner === null || partner.action !== 'grabbed' || partner.grabPartner !== me)) {
      dropOut(state, f);
      return;
    }
    stepThrow(state, f, released ? null : partner);
    return;
  }

  if (partner === null || partner.action !== 'grabbed' || partner.grabPartner !== me) {
    dropOut(state, f);
    return;
  }
  if (f.action === 'pummel') stepPummel(state, f, def, partner);
  else stepHold(state, f, def, partner);
}

/**
 * Pins every grabbed fighter to its holder's hand. Runs after all fighters have moved and
 * before projectiles, so hits this frame see the victim where it is drawn. A throw places
 * the victim with its own holdX/holdY.
 */
export function syncGrabbed(state: GameState): void {
  const fighters = simFighters(state);
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f.action !== 'grabbed') continue;
    const holder = partnerOf(fighters, f);
    if (holder === null || holder.grabPartner !== i || !isHolderAction(holder.action)) continue;
    const kit = grabKitOf(defOf(holder));
    const t = holder.action === 'throw' ? holder.activeThrow : null;
    const hx = t === null ? kit.holdX : t.holdX;
    const hy = t === null ? kit.holdY : t.holdY;
    f.x = holder.x + hx * holder.facing;
    f.y = holder.y + hy;
    f.vx = 0;
    f.vy = 0;
    f.onGround = holder.onGround;
    f.facing = holder.facing === 1 ? -1 : 1;
  }
}
