import { ECHO_TAIL, TUNING } from '../core/constants';
import { Btn } from '../core/types';
import type { AimDir, CharacterDef, GameState, MoveDef, MoveId, ShadowStepDef } from '../core/types';
import { heldDir, heldDown, heldUp } from './input';
import { defOf, sameTeam, setAction, simFighters, stageOf, type SimFighter } from './state';
import { spawnProjectile } from './projectiles';
import { chargeFraction, chargesPower, projectileChargePower, projectileChargeScale } from './hits';

/** Longest a holdAim move stays paused on its hold frame (MoveDef.holdAim). */
export const HOLD_AIM_MAX = 45;

/**
 * The frame a holdAim move pauses on: the one before its first timeline projectile spawns, so the
 * release frame is the spawn frame. 0 for a move with no timeline projectile.
 */
export function holdFrameOf(mv: MoveDef): number {
  const shots = mv.projectiles;
  let first = Infinity;
  if (shots !== undefined) {
    for (let i = 0; i < shots.length; i++) {
      const at = shots[i].spawnFrame;
      if (at >= 0 && at < first) first = at;
    }
  }
  return first === Infinity || first < 1 ? 0 : first - 1;
}

/**
 * Frames a charged cast adds to both the projectile spawn frames and totalFrames:
 * chargeCastFrames times the charge fraction, rounded. f.charge stays on the fighter for
 * the whole move, so this reads the same on every frame of it.
 */
export function castDelay(f: SimFighter, mv: MoveDef): number {
  if (mv.chargeCastFrames === undefined) return 0;
  return Math.round(mv.chargeCastFrames * chargeFraction(f.charge, chargesPower(mv)));
}

export function moveOf(f: SimFighter, def: CharacterDef): MoveDef {
  return def.moves[f.moveId as MoveId];
}

/**
 * Applies everything a move schedules on one of its frames: momentum injections,
 * projectile spawns and invulnerability windows. A frame that injects vy owns the
 * vertical speed for that frame, so gravity is skipped (rising specials need it).
 */
function applyMoveFrame(state: GameState, f: SimFighter, mv: MoveDef, frame: number): void {
  const vel = mv.velocity;
  if (vel !== undefined) {
    for (let i = 0; i < vel.length; i++) {
      const v = vel[i];
      if (v.frame !== frame) continue;
      if (v.vx !== undefined) {
        const dx = v.vx * f.facing;
        f.vx = v.setX === true ? dx : f.vx + dx;
      }
      if (v.vy !== undefined) {
        f.vy = v.setY === true ? v.vy : f.vy + v.vy;
        f.skipGravity = true;
      }
    }
  }
  const shots = mv.projectiles;
  if (shots !== undefined) {
    // A charged shot swells on the exponential scale curve (hit circle and sprite). A def
    // with `charged` gets all of its extra damage, strength and knockback from that lerp,
    // so its power stays exactly 1 (no double scaling); a chargeable def without `charged`
    // still rides projectileChargePower. An unchargeable move spawns at exactly 1 and 1.
    // A holdAim move counts its held frames in f.charge but never scales: power 1, scale 1, charge 0.
    const powered = chargesPower(mv);
    const power = projectileChargePower(f.charge, powered);
    const scale = projectileChargeScale(f.charge, powered);
    // 0 for a move that cannot charge, so its `charged` defs keep their base values.
    const charge = chargeFraction(f.charge, powered);
    const delay = castDelay(f, mv);
    for (let i = 0; i < shots.length; i++) {
      const at = shots[i].spawnFrame;
      // A burst-only def (spawnFrame -1) never fires from the timeline, delay or not.
      if (at >= 0 && at + delay === frame) {
        spawnProjectile(state, f, shots[i], shots[i].charged === undefined ? power : 1, scale, charge);
      }
    }
  }
  const inv = mv.invuln;
  if (inv !== undefined && frame >= inv[0] && frame <= inv[1] && f.invuln < 2) f.invuln = 2;
}

/**
 * The buttons that have to stay down for a move to keep charging, worked out once when the
 * move starts. Smashes charge on Attack and specials on Special, but a smash fired by a
 * shortcut that has no Attack key in it (the F&W up smash, the F&S down smash, the C-stick)
 * would then never charge at all, so the smash's own direction holds the charge instead.
 */
function chargeMaskFor(f: SimFighter, mv: MoveDef, id: MoveId): number {
  if (mv.chargeable !== true) return 0;
  if (mv.chargeButton === 'special') return Btn.Special;
  let mask = Btn.Attack;
  if ((f.inputHeld & Btn.Attack) === 0) {
    // Started without Attack (a chord or the C-stick): the smash's own direction holds the charge.
    if (id === 'usmash') mask |= Btn.Up | Btn.CUp;
    else if (id === 'dsmash') mask |= Btn.Down | Btn.CDown;
    else if (id === 'fsmash') mask |= f.facing === 1 ? (Btn.Right | Btn.CRight) : (Btn.Left | Btn.CLeft);
  }
  return mask;
}

/** True while the current move's charge is still being held down. */
function chargeHeld(f: SimFighter): boolean {
  return (f.inputHeld & f.chargeMask) !== 0;
}

export function startMove(state: GameState, f: SimFighter, def: CharacterDef, id: MoveId): void {
  const mv = def.moves[id];
  setAction(f, 'attack');
  f.moveId = id;
  f.hitGroups = 0;
  f.charge = 0;
  f.chargeMask = chargeMaskFor(f, mv, id);
  // A holdAim move does not pause on frame 0; it pauses on its hold frame (advanceMove).
  f.charging = mv.chargeable === true && mv.holdAim !== true && chargeHeld(f);
  const echo = mv.echo;
  if (echo !== undefined) {
    // A new echo replaces a running one. Its side is latched here: the direction he was
    // travelling (his facing when nearly still). From then on it stands offsetX px that way from
    // his current feet (syncEchoes), so it strikes in front of him however far he slides.
    const dir = f.vx >= 0.5 ? 1 : f.vx <= -0.5 ? -1 : f.facing;
    f.echoMove = id;
    f.echoAge = -echo.delayFrames;
    f.echoDir = dir;
    f.echoX = f.x + echo.offsetX * dir;
    f.echoY = f.y;
    f.echoFacing = f.facing;
    f.echoHitGroups = 0;
  }
  if (mv.shadowStep !== undefined && mv.shadowStep.oncePerAir && !f.onGround) f.airLock |= 1;
  if (movesAims(mv)) latchAim(f);
  if (!f.charging) applyMoveFrame(state, f, mv, 0);
}

/** True when the move throws an aimed projectile. */
function movesAims(mv: MoveDef): boolean {
  const shots = mv.projectiles;
  if (shots === undefined) return false;
  for (let i = 0; i < shots.length; i++) {
    if (shots[i].aim === true) return true;
  }
  return false;
}

/**
 * Reads the aim from the held stick (plan B.2 14): up plus a side = 1, up = 2, down plus a side
 * = 3, down = 4, else 0. A side held behind the fighter turns it first, so it always fires forward.
 */
function latchAim(f: SimFighter): void {
  const dir = heldDir(f);
  if (dir !== 0 && dir !== f.facing) f.facing = dir > 0 ? 1 : -1;
  let aim: AimDir = 0;
  if (heldUp(f)) aim = dir !== 0 ? 1 : 2;
  else if (heldDown(f)) aim = dir !== 0 ? 3 : 4;
  f.aimDir = aim;
}

/**
 * Jumps the current move to its branch frames (a counter trigger or a recall): the move now ends
 * at branch.end, its hit groups are fresh, and the branch's first frame is applied at once.
 */
export function enterBranch(state: GameState, f: SimFighter, mv: MoveDef): void {
  const br = mv.branch;
  if (br === undefined) return;
  f.onBranch = true;
  f.charging = false;
  f.actionFrame = br.start;
  f.hitGroups = 0;
  applyMoveFrame(state, f, mv, br.start);
}

/**
 * Moves every live echo to its owner's current feet plus echoDir * offsetX. Runs once a frame after
 * every fighter has moved and before hits resolve, so the echo strikes from where he is now.
 */
export function syncEchoes(state: GameState): void {
  const fighters = simFighters(state);
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f.echoMove === null) continue;
    const echo = defOf(f).moves[f.echoMove]?.echo;
    if (echo === undefined) continue;
    f.echoX = f.x + echo.offsetX * f.echoDir;
    f.echoY = f.y;
  }
}

/**
 * One frame of the shadow echo, run on every frame the owner is not in hitlag. It ends
 * ECHO_TAIL frames after the last replayed hitbox's last active frame.
 */
export function stepEcho(f: SimFighter, def: CharacterDef): void {
  if (f.echoMove === null) return;
  const mv = def.moves[f.echoMove];
  const echo = mv === undefined ? undefined : mv.echo;
  if (echo === undefined) {
    f.echoMove = null;
    return;
  }
  f.echoAge++;
  if (f.echoAge > echoLastEnd(mv) + ECHO_TAIL) f.echoMove = null;
}

/** Last active frame among the hitboxes an echo replays. */
export function echoLastEnd(mv: MoveDef): number {
  const echo = mv.echo;
  let last = 0;
  if (echo === undefined) return last;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const hb = mv.hitboxes[i];
    if (echo.groups.indexOf(hb.group) >= 0 && hb.end > last) last = hb.end;
  }
  return last;
}

export function endMove(f: SimFighter, mv: MoveDef): void {
  if (f.onGround) {
    setAction(f, 'idle');
    return;
  }
  setAction(f, mv.helplessAfter === true ? 'airHelpless' : 'air');
}

/** Advances the current move by one frame. Returns true on the frame the move ends. */
export function advanceMove(state: GameState, f: SimFighter, def: CharacterDef): boolean {
  const mv = moveOf(f, def);

  if (f.charging && mv.holdAim === true) {
    // Hold to aim: pinned on the hold frame, the aim follows the stick. The release frame (or the
    // 45th held frame) reads the aim one last time and runs the next frame at once, so the spawn
    // lands on the release frame. Nothing scales with the hold.
    const hold = holdFrameOf(mv);
    f.actionFrame = hold;
    if (movesAims(mv)) latchAim(f);
    if (chargeHeld(f) && f.charge < HOLD_AIM_MAX) {
      f.charge++;
      return false;
    }
    f.charging = false;
    f.actionFrame = hold + 1;
  } else if (f.charging) {
    f.actionFrame = 0;
    // The aim follows the stick for the whole charge, so the direction held at release wins.
    if (movesAims(mv)) latchAim(f);
    const holding = chargeHeld(f);
    if (holding && f.charge < TUNING.input.chargeMax) {
      f.charge++;
      return false;
    }
    f.charging = false;
    applyMoveFrame(state, f, mv, 0);
    return false;
  }

  // On a branch the move ends at branch.end; otherwise the normal path ends first, so frames
  // that only the branch reaches never run without it.
  const end = f.onBranch && mv.branch !== undefined ? mv.branch.end : mv.totalFrames + castDelay(f, mv);
  if (f.actionFrame >= end) {
    endMove(f, mv);
    return true;
  }
  if (mv.dive !== undefined) stepDive(f, mv.dive);
  // Hold to aim: while Special is still held on the way to the hold frame, the aim follows the
  // stick every frame, so it is current on the first paused frame (and on a throw let go before it).
  if (mv.holdAim === true && !f.onBranch && f.actionFrame <= holdFrameOf(mv) && chargeHeld(f) && movesAims(mv)) {
    latchAim(f);
  }
  applyMoveFrame(state, f, mv, f.actionFrame);
  if (mv.shadowStep !== undefined) stepShadow(state, f, mv.shadowStep);
  // Still holding on the hold frame: pause there (a tap released earlier never pauses).
  if (mv.holdAim === true && !f.onBranch && f.charge === 0 && f.actionFrame === holdFrameOf(mv) && chargeHeld(f)) {
    f.charging = true;
  }
  return false;
}

/**
 * One frame of a shadow step (plan B.2 18 to 21). From startFrame the fighter moves
 * distance / travelFrames px a frame along facing, written straight to x so neither friction nor
 * air drift eats it, with vy held at 0 and gravity skipped. A ground step stops at the platform
 * edge. On the last travel frame, crossing the nearest living opponent turns the fighter around.
 */
function stepShadow(state: GameState, f: SimFighter, st: ShadowStepDef): void {
  const fr = f.actionFrame;
  if (fr >= st.invuln[0] && fr <= st.invuln[1] && f.invuln < 2) f.invuln = 2;
  if (fr < st.startFrame || fr >= st.startFrame + st.travelFrames) return;
  if (fr === st.startFrame) f.stepStartX = f.x;
  let nx = f.x + (st.distance / st.travelFrames) * f.facing;
  if (f.onGround && st.stopAtEdge) {
    const stage = stageOf(state);
    for (let i = 0; i < stage.platforms.length; i++) {
      const p = stage.platforms[i];
      if (Math.abs(f.y - p.y) > 0.5 || f.x < p.x || f.x > p.x + p.w) continue;
      if (nx < p.x) nx = p.x;
      else if (nx > p.x + p.w) nx = p.x + p.w;
      break;
    }
  }
  f.x = nx;
  f.vx = 0;
  if (!f.onGround) {
    f.vy = 0;
    f.fastFalling = false;
    f.skipGravity = true;
  }
  if (fr !== st.startFrame + st.travelFrames - 1) return;
  if (st.turnIfPassed) {
    const fighters = simFighters(state);
    let best: SimFighter | null = null;
    let bestD = Infinity;
    for (let i = 0; i < fighters.length; i++) {
      const o = fighters[i];
      if (o === f || !inPlay(o) || sameTeam(state, f.slot, o.slot)) continue;
      const d = Math.abs(o.x - f.x);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (best !== null) {
      const lo = Math.min(f.stepStartX, f.x);
      const hi = Math.max(f.stepStartX, f.x);
      if (best.x > lo && best.x < hi) f.facing = f.facing === 1 ? -1 : 1;
    }
  }
  state.events.push({ type: 'teleport', slot: f.slot, fromX: f.stepStartX, fromY: f.y, x: f.x, y: f.y, kind: 'step' });
}

/** A living fighter in play: stocks left, not dead or respawning. Invulnerable still counts. */
function inPlay(o: SimFighter): boolean {
  return o.stocks > 0 && o.action !== 'dead' && o.action !== 'respawn';
}

/**
 * True while a dive move is in its dive: past the dive frame, airborne, and nothing hit yet
 * (a landed hit, body or shield, sets hitGroups). Everything it reads is fighter state the
 * snapshot already carries, so the dive needs no field of its own.
 */
export function isDiving(f: SimFighter, mv: MoveDef): boolean {
  const dive = mv.dive;
  return dive !== undefined && f.action === 'attack' && f.actionFrame >= dive.frame
    && f.hitGroups === 0 && !f.onGround;
}

/**
 * One dive frame: the move is pinned on the dive frame (like a held charge is pinned on 0), the
 * fall speed is set outright with gravity skipped, horizontal speed is zeroed (air acceleration
 * can add one frame's worth, a small drift) and the fighter is invulnerable. invuln is topped up
 * to 1, not 2: it covers this frame's hit pass and runs out on the next frame's decrement, so a
 * dive that lands carries no invulnerability into its landing lag.
 */
function stepDive(f: SimFighter, dive: NonNullable<MoveDef['dive']>): void {
  if (f.actionFrame < dive.frame || f.hitGroups !== 0 || f.onGround) return;
  f.actionFrame = dive.frame;
  f.vy = dive.vy;
  f.vx = 0;
  f.fastFalling = false;
  f.skipGravity = true;
  if (f.invuln < 1) f.invuln = 1;
}
