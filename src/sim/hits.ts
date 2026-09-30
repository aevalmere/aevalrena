import {
  FS_METER, hitlagFrames, SAKURAI_STRONG_ANGLE, SAKURAI_WEAK_ANGLE, SHIELD_BREAK_STUN, SHIELD_MAX,
  SHIELD_STUN_PER_DAMAGE, TUNING,
} from '../core/constants';
import { circleRectOverlap, degToRad } from '../core/math';
import { nextFloat } from '../core/rng';
import { MAX_PLAYERS } from '../core/types';
import type { Facing, GameState, HitboxDef, Rect, SimEvent } from '../core/types';
import { defOf, fighterHurtbox, recordHit, sameTeam, setAction, simFighters, type SimFighter } from './state';
import { PROJECTILE_DEFS, PROJECTILE_SCALE_MAX, PROJECTILE_SCALE_MIN, chargedStat, killProjectile } from './projectiles';
import { dodgesHit } from './dodge';
import { forceGrab } from './grab';
import { enterBranch } from './moves';

const HURT: Rect = { x: 0, y: 0, w: 0, h: 0 };
const hitThisFrame: boolean[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) hitThisFrame.push(false);
/** Victims a grab hitbox caught this pass. Unlike hitThisFrame it is not reset per attacker. */
const caughtThisFrame: boolean[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) caughtThisFrame.push(false);

const PERCENT_CAP = 999;
/** Below this launch angle a grounded victim slides instead of leaving the ground. */
const GROUNDED_ANGLE = 15;
const SHIELD_PUSHBACK = 2;

/** True while a fighter hangs on a ledge, where only down attacks and low enough shots reach it. */
export function hangingOnLedge(f: SimFighter): boolean {
  return f.action === 'ledgeHang' || f.action === 'ledgeGrab';
}

/**
 * The bounce on hit (dair hop): up by `vy`, fast fall cancelled, the air dodge given back
 * (the double jump is not) and the move cut so it ends `actionableIn` frames after the hitlag.
 */
function bounceAttacker(atk: SimFighter, totalFrames: number, bounce: { vy: number; actionableIn: number }): void {
  atk.vy = bounce.vy;
  atk.fastFalling = false;
  atk.airDodgeUsed = false;
  const cut = totalFrames - bounce.actionableIn;
  if (atk.actionFrame < cut) atk.actionFrame = cut;
}

export function canBeHit(f: SimFighter): boolean {
  if (f.action === 'dead' || f.action === 'respawn') return false;
  // Both sides of a Final Smash are out of reach of everyone else until the launch.
  if (f.action === 'finalSmash' || f.action === 'finalSmashVictim') return false;
  return f.invuln <= 0;
}

/**
 * Final Smash meter gain for `damage` dealt by `attacker` (null when none is known) to
 * `victim`. Only under the finalSmash rule, capped at FS_METER.max, and never for a
 * fighter who is performing a Final Smash right now. Shield hits must not call this.
 */
export function gainFsMeter(state: GameState, attacker: SimFighter | null, victim: SimFighter, damage: number): void {
  if (state.config.finalSmash !== true) return;
  if (attacker !== null && attacker !== victim && attacker.action !== 'finalSmash') {
    attacker.fsMeter = Math.min(FS_METER.max, attacker.fsMeter + damage * FS_METER.perDamageDealt);
  }
  if (victim.action !== 'finalSmash') {
    victim.fsMeter = Math.min(FS_METER.max, victim.fsMeter + damage * FS_METER.perDamageTaken);
  }
}

function fighterBySlot(state: GameState, slot: number): SimFighter | null {
  const fighters = simFighters(state);
  for (let i = 0; i < fighters.length; i++) {
    if (fighters[i].slot === slot) return fighters[i];
  }
  return null;
}

/**
 * Smash 4 / Ultimate knockback.
 *   p  = victim percent after the hit
 *   w  = victim weight (higher = harder to launch)
 *   d  = damage dealt by this hitbox after charge scaling
 *   kbg / bkb = the hitbox's knockback growth and base knockback
 * kb is a knockback unit; launch speed in px/frame is kb * TUNING.knockback.toVel.
 */
function knockback(p: number, w: number, d: number, bkb: number, kbg: number): number {
  return ((((p / 10) + (p * d / 20)) * (200 / (w + 100)) * 1.4) + 18) * (kbg / 100) + bkb;
}

function launchAngle(angle: number, kb: number): number {
  if (angle !== 361) return angle;
  return kb < TUNING.knockback.sakuraiThreshold ? SAKURAI_WEAK_ANGLE : SAKURAI_STRONG_ANGLE;
}

/**
 * Extra 'hit' event fields for the next applyHit call, set just before it by resolveHits and
 * consumed (and reset) by applyHit, so applyHit keeps its signature for every other caller.
 */
let metaCrit = false;
let metaEcho = false;
let metaSource: string | null = null;

function setHitMeta(crit: boolean, echo: boolean, source: string | null): void {
  metaCrit = crit;
  metaEcho = echo;
  metaSource = source;
}

/** The 'hit' source when resolveHits named none: the attacker's throw, move or Final Smash. */
function sourceOf(state: GameState, attackerSlot: number): string | undefined {
  const atk = fighterBySlot(state, attackerSlot);
  if (atk === null) return undefined;
  if (atk.action === 'throw') return atk.activeThrowId === null ? 'custom' : atk.activeThrowId;
  if (atk.action === 'attack' && atk.moveId !== null) return atk.moveId;
  if (atk.action === 'finalSmash') return 'finalSmash';
  return undefined;
}

function breakShield(state: GameState, victim: SimFighter): void {
  victim.shieldHp = 0;
  setAction(victim, 'shieldBreak');
  victim.stateTimer = SHIELD_BREAK_STUN;
  state.events.push({ type: 'shieldBreak', x: victim.x, y: victim.y, slot: victim.slot });
}

/**
 * Applies one connecting hit. Returns the hitlag both sides freeze for, or 0 if nothing landed.
 */
export function applyHit(
  state: GameState,
  victim: SimFighter,
  attackerSlot: number,
  facing: Facing,
  rawDamage: number,
  angle: number,
  bkb: number,
  kbg: number,
  hitlagMul: number,
  rawShieldDamage: number,
  hitX: number,
  hitY: number,
  kbScale = 1,
): number {
  const crit = metaCrit;
  const echo = metaEcho;
  const source = metaSource;
  setHitMeta(false, false, null);
  // Teams rule: friendly fire is off, so a teammate's hit (a throw, a launch) lands nothing.
  if (sameTeam(state, attackerSlot, victim.slot)) return 0;
  // damageMul scales everything a hit deals, so hitlag and shield damage follow it too.
  const damage = rawDamage * TUNING.knockback.damageMul;
  const lag = Math.max(1, Math.round(hitlagFrames(damage) * hitlagMul));

  if (victim.action === 'shield' || victim.action === 'shieldStun') {
    victim.shieldHp -= rawShieldDamage * TUNING.knockback.damageMul;
    victim.hitlag = lag;
    victim.vx += (victim.x < hitX ? -1 : 1) * SHIELD_PUSHBACK;
    state.events.push({ type: 'shieldHit', x: hitX, y: hitY, victim: victim.slot });
    if (victim.shieldHp <= 0) {
      const breaker = fighterBySlot(state, attackerSlot);
      if (breaker !== null && breaker !== victim && !state.finished) breaker.stats.shieldBreaks++;
      breakShield(state, victim);
    } else {
      setAction(victim, 'shieldStun');
      victim.stateTimer = Math.floor(damage * SHIELD_STUN_PER_DAMAGE) + 2;
    }
    return lag;
  }

  const def = defOf(victim);
  recordHit(state, victim, attackerSlot, Math.min(PERCENT_CAP, victim.percent + damage) - victim.percent);
  // Meter reads the victim's action before the hit replaces it with hitstun.
  gainFsMeter(state, fighterBySlot(state, attackerSlot), victim, damage);
  victim.percent = Math.min(PERCENT_CAP, victim.percent + damage);
  const kb = knockback(victim.percent, def.weight, damage, bkb, kbg) * TUNING.knockback.kbMul * kbScale;
  const local = launchAngle(angle, kb);
  const world = facing === 1 ? local : 180 - local;
  const rad = degToRad(world);
  const speed = kb * TUNING.knockback.toVel;

  const dirX = Math.cos(rad);
  let dirY = -Math.sin(rad);
  const slides = victim.onGround && local < GROUNDED_ANGLE && kb < TUNING.knockback.tumbleKb;
  if (slides) dirY = 0;

  victim.kbDirX = dirX;
  victim.kbDirY = dirY;
  victim.kbSpeed = speed;
  victim.kbFall = 0;
  victim.vx = dirX * speed;
  victim.vy = dirY * speed;
  if (dirY < 0) victim.onGround = false;
  victim.fastFalling = false;
  victim.ledge = -1;
  victim.lastHitBy = attackerSlot;
  victim.airLock = 0;
  victim.hitlag = lag;
  victim.hitstun = Math.floor(kb * TUNING.knockback.hitstunPerKb);
  setAction(victim, kb >= TUNING.knockback.tumbleKb ? 'tumble' : 'hitstun');

  const ev: Extract<SimEvent, { type: 'hit' }> = {
    type: 'hit', x: hitX, y: hitY,
    attacker: attackerSlot, victim: victim.slot,
    damage, kb, angle: world,
  };
  const src = source !== null ? source : sourceOf(state, attackerSlot);
  if (src !== undefined) ev.source = src;
  if (crit) ev.crit = true;
  if (echo) ev.echo = true;
  state.events.push(ev);
  return lag;
}

/**
 * How far a charge got, 0 at none and 1 at full. A move that cannot charge, and a
 * chargeMax of 0, both read as 0 so nothing downstream divides by zero.
 */
export function chargeFraction(charge: number, chargeable: boolean | undefined): number {
  if (chargeable !== true || TUNING.input.chargeMax <= 0) return 0;
  return charge / TUNING.input.chargeMax;
}

/**
 * The melee charge curve. Hitbox damage rides this and nothing else: a charged smash is
 * a straight line from 1 at no charge to 1 + chargeBonus at full. Projectiles used to
 * share it and no longer do, so do not fold the two back together.
 */
export function chargeMultiplier(charge: number, chargeable: boolean | undefined): number {
  return 1 + TUNING.input.chargeBonus * chargeFraction(charge, chargeable);
}

/** What a tapped charged projectile keeps of its def damage. A tap is chip, not a hit. */
const PROJECTILE_POWER_MIN = 0.25;
// PROJECTILE_SCALE_MIN / MAX (0.6 and 1.5) live in projectiles.ts, which reads a
// shot's charge back off its scale for the def's `charged` values.

/**
 * MIN * (MAX / MIN) ** t: lands on MIN at no charge and exactly MAX at full, and grows
 * by a fixed ratio per unit of charge rather than a fixed amount, so the last quarter of
 * the charge is worth far more than the first. Used for the curve a charged projectile
 * rides, kept apart from chargeMultiplier so melee stays linear and untouched.
 */
function exponentialCharge(t: number, min: number, max: number): number {
  return min * Math.pow(max / min, t);
}

/**
 * Damage multiplier for a charged projectile whose def has no `charged` block (a def with
 * one scales through that lerp alone and spawns at power 1). Full charge lands on the
 * melee ceiling of 1 + chargeBonus. A move that cannot charge, and a chargeMax of 0, both
 * return exactly 1.
 */
export function projectileChargePower(charge: number, chargeable: boolean | undefined): number {
  if (chargeable !== true || TUNING.input.chargeMax <= 0) return 1;
  const max = 1 + TUNING.input.chargeBonus;
  return exponentialCharge(chargeFraction(charge, chargeable), PROJECTILE_POWER_MIN, max);
}

/** Hit circle and sprite scale for a charged projectile, on the same exponential curve. */
export function projectileChargeScale(charge: number, chargeable: boolean | undefined): number {
  if (chargeable !== true || TUNING.input.chargeMax <= 0) return 1;
  const t = chargeFraction(charge, chargeable);
  return exponentialCharge(t, PROJECTILE_SCALE_MIN, PROJECTILE_SCALE_MAX);
}

function hitboxDamage(hb: HitboxDef, mul: number): number {
  return hb.damage * mul;
}

/**
 * Projectile versus projectile. Opposing shots whose hit circles overlap clash, and the
 * outcome reads each shot's `strength` tier (charge included) and nothing else: damage,
 * power and knockback play no part. The strictly stronger shot destroys the weaker and
 * flies on untouched; equal strength destroys both. A destroyed shot goes through
 * killProjectile, so its burst still detonates.
 *
 * Pairs are visited once (j starts at i + 1) and the outcome is decided purely by the
 * two strengths, so no result depends on which index comes first. Bursts spawn into
 * freed slots, which may sit anywhere in the array, so anything born during this pass
 * is skipped by id and cannot clash on the frame it appears.
 */
function resolveProjectileClashes(state: GameState): void {
  const idCap = state.nextProjectileId;
  for (let i = 0; i < state.projectiles.length; i++) {
    const a = state.projectiles[i];
    if (!a.alive || a.id >= idCap) continue;
    const adef = PROJECTILE_DEFS[a.defId];
    if (adef === undefined) continue;
    for (let j = i + 1; j < state.projectiles.length; j++) {
      const b = state.projectiles[j];
      if (!b.alive || b.id >= idCap) continue;
      if (b.owner === a.owner) continue;
      const bdef = PROJECTILE_DEFS[b.defId];
      if (bdef === undefined) continue;

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const reach = chargedStat(adef, a.charge, 'r') * a.scale + chargedStat(bdef, b.charge, 'r') * b.scale;
      if (dx * dx + dy * dy > reach * reach) continue;

      const as = chargedStat(adef, a.charge, 'strength');
      const bs = chargedStat(bdef, b.charge, 'strength');
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (as === bs) {
        state.events.push({ type: 'projectileClash', x: mx, y: my, ownerA: a.owner, ownerB: b.owner, winner: -1 });
        killProjectile(state, a, adef);
        killProjectile(state, b, bdef);
        break;                    // a is gone; nothing else can clash with it
      }
      if (as > bs) {
        state.events.push({ type: 'projectileClash', x: mx, y: my, ownerA: a.owner, ownerB: b.owner, winner: a.owner });
        killProjectile(state, b, bdef);
        continue;                 // a survives untouched and may meet another shot this frame
      }
      state.events.push({ type: 'projectileClash', x: mx, y: my, ownerA: a.owner, ownerB: b.owner, winner: b.owner });
      killProjectile(state, a, adef);
      break;
    }
  }
}

/**
 * Counter (plan B.2 9 to 10). A defender whose move has `counter`, inside its window and not yet
 * on a branch, absorbs the hit: it stores the counter damage (clamp(raw * scale, min, max), raw
 * being what the hit would have dealt before crit), turns toward `fromX`, jumps to its branch and
 * raises a 'counter' event. Returns the attacker freeze, or -1 when nothing was absorbed.
 */
function tryCounter(state: GameState, vic: SimFighter, attackerSlot: number, raw: number, fromX: number): number {
  if (vic.action !== 'attack' || vic.moveId === null || vic.onBranch || vic.charging) return -1;
  const mv = defOf(vic).moves[vic.moveId];
  const c = mv.counter;
  if (c === undefined || mv.branch === undefined) return -1;
  if (vic.actionFrame < c.windowStart || vic.actionFrame > c.windowEnd) return -1;
  vic.counterDamage = Math.min(c.maxDamage, Math.max(c.minDamage, raw * c.scale));
  if (fromX > vic.x) vic.facing = 1;
  else if (fromX < vic.x) vic.facing = -1;
  enterBranch(state, vic, mv);
  state.events.push({ type: 'counter', x: vic.x, y: vic.y - 24, slot: vic.slot, attacker: attackerSlot });
  return c.attackerFreeze;
}

/**
 * The crit roll for one landed body hit (plan B.2 6). Only for an attacker whose def has `crit`
 * with a chance above 0, so a match without such a character never advances state.rng.
 * Returns the damage and knockback multiplier: the def's scale on a crit, else 1.
 */
function rollCrit(state: GameState, atk: SimFighter, hb: HitboxDef, echo: boolean): number {
  const crit = defOf(atk).crit;
  if (crit === undefined || crit.chance <= 0 || hb.noCrit === true || hb.fromCounter === true) return 1;
  const chance = echo ? crit.chance / 2 : crit.chance;
  return nextFloat(state.rng) < chance ? crit.scale : 1;
}

/** One attacker's own hitboxes against every other hurtbox. */
function resolveMelee(state: GameState, fighters: SimFighter[], a: number): void {
  const atk = fighters[a];
  if (atk.action !== 'attack' || atk.moveId === null) return;
  if (atk.hitlag > 0 || atk.charging) return;
  const mv = defOf(atk).moves[atk.moveId];
  const mul = chargeMultiplier(atk.charge, mv.chargeable);
  for (let i = 0; i < fighters.length; i++) hitThisFrame[i] = false;
  // Set when a hitbox of this move lands on a fighter's body rather than a shield.
  let hitBody = false;
  // Set when a hitbox of this move lands on a shield.
  let hitShield = false;

  for (let h = 0; h < mv.hitboxes.length; h++) {
    const hb = mv.hitboxes[h];
    if (atk.actionFrame < hb.start || atk.actionFrame > hb.end) continue;
    const groupBit = 1 << hb.group;
    if ((atk.hitGroups & groupBit) !== 0) continue;
    const hx = atk.x + hb.x * atk.facing;
    const hy = atk.y + hb.y;
    let landed = false;
    let caught = false;

    for (let v = 0; v < fighters.length; v++) {
      if (v === a || hitThisFrame[v] || caughtThisFrame[v]) continue;
      const vic = fighters[v];
      if (!canBeHit(vic)) continue;
      // A ledge hanger is out of reach of every melee hitbox except a down attack's.
      if (hangingOnLedge(vic) && mv.hitsLedge !== true) continue;
      // Teams rule: a teammate's hitbox (grab hitboxes too) passes through.
      if (sameTeam(state, atk.slot, vic.slot)) continue;
      fighterHurtbox(vic, defOf(vic), HURT);
      if (!circleRectOverlap(hx, hy, hb.r, HURT)) continue;

      // A grab hitbox catches instead of hitting. canBeGrabbed owns every check a
      // grab cares about (rolls, airborne, force), and shields never stop a grab.
      if (hb.grab !== undefined) {
        if (!forceGrab(state, atk, vic, hb.grab)) continue;
        // A just-caught victim is out of reach of every later attacker in this pass.
        hitThisFrame[v] = true;
        caughtThisFrame[v] = true;
        landed = true;
        caught = true;
        break;
      }
      if (dodgesHit(vic, hy, hb.low, atk.moveId, atk.onGround)) continue;

      const dmg = hb.fromCounter === true ? atk.counterDamage : hitboxDamage(hb, mul);
      // A counter absorbs the hit whole: no damage, knockback or shield damage, and the group is spent.
      const freeze = tryCounter(state, vic, atk.slot, dmg, atk.x);
      if (freeze >= 0) {
        hitThisFrame[v] = true;
        landed = true;
        if (freeze > atk.hitlag) atk.hitlag = freeze;
        continue;
      }
      const shielded = vic.action === 'shield' || vic.action === 'shieldStun';
      const critMul = shielded ? 1 : rollCrit(state, atk, hb, false);
      const before = vic.percent;
      setHitMeta(critMul !== 1, false, atk.moveId);
      const lag = applyHit(
        state, vic, atk.slot, atk.facing, dmg * critMul, hb.angle, hb.bkb, hb.kbg,
        hb.hitlagMul === undefined ? 1 : hb.hitlagMul,
        hb.shieldDamage === undefined ? dmg : hb.shieldDamage,
        hx, hy, critMul,
      );
      hitThisFrame[v] = true;
      landed = true;
      if (!shielded && lag > 0) hitBody = true;
      if (shielded && lag > 0) hitShield = true;
      if (lag > atk.hitlag) atk.hitlag = lag;
      // Lifesteal (the whirlpool): the attacker heals a share of the damage that reached the body.
      if (hb.healFraction !== undefined && !shielded) {
        const dealt = vic.percent - before;
        if (dealt > 0) atk.percent = Math.max(0, atk.percent - dealt * hb.healFraction);
      }
    }
    if (landed) atk.hitGroups |= groupBit;
    // A catch took the attacker out of its move, so nothing else of it is active.
    if (caught) break;
  }
  if (mv.bounceOnHit !== undefined && atk.action === 'attack' && !atk.onGround) {
    if (hitBody) {
      bounceAttacker(atk, mv.totalFrames, mv.bounceOnHit);
    } else if (hitShield && mv.dive !== undefined) {
      // A dive that meets a shield bounces off it the same way, but acts later: a small disadvantage.
      bounceAttacker(atk, mv.totalFrames, { vy: mv.bounceOnHit.vy, actionableIn: mv.dive.shieldActionableIn });
    }
  }
}

/**
 * One attacker's shadow echo (plan B.2 4 to 5): the echoed move's chosen hitbox groups replay at
 * the latched position and facing on echo frames, scaled by damageScale. Only the victim freezes;
 * echo hits never grab or bounce, keep their own group mask, roll crits at half chance and can
 * be countered like any melee hit.
 */
function resolveEcho(state: GameState, fighters: SimFighter[], a: number): void {
  const atk = fighters[a];
  if (atk.echoMove === null || atk.echoAge < 0) return;
  const mv = defOf(atk).moves[atk.echoMove];
  const echo = mv === undefined ? undefined : mv.echo;
  if (echo === undefined) return;
  // Aerials carry landingLag; any other echoed move was started on the ground.
  const grounded = mv.landingLag === undefined;
  for (let i = 0; i < fighters.length; i++) hitThisFrame[i] = false;

  for (let h = 0; h < mv.hitboxes.length; h++) {
    const hb = mv.hitboxes[h];
    if (hb.grab !== undefined || echo.groups.indexOf(hb.group) < 0) continue;
    if (atk.echoAge < hb.start || atk.echoAge > hb.end) continue;
    const groupBit = 1 << hb.group;
    if ((atk.echoHitGroups & groupBit) !== 0) continue;
    const hx = atk.echoX + hb.x * atk.echoFacing;
    const hy = atk.echoY + hb.y;
    let landed = false;

    for (let v = 0; v < fighters.length; v++) {
      if (v === a || hitThisFrame[v] || caughtThisFrame[v]) continue;
      const vic = fighters[v];
      if (!canBeHit(vic)) continue;
      if (hangingOnLedge(vic) && mv.hitsLedge !== true) continue;
      if (sameTeam(state, atk.slot, vic.slot)) continue;
      fighterHurtbox(vic, defOf(vic), HURT);
      if (!circleRectOverlap(hx, hy, hb.r, HURT)) continue;
      if (dodgesHit(vic, hy, hb.low, atk.echoMove, grounded)) continue;

      const dmg = (hb.fromCounter === true ? atk.counterDamage : hb.damage) * echo.damageScale;
      if (tryCounter(state, vic, atk.slot, dmg, atk.echoX) >= 0) {
        // The echo is a shadow: its group is spent, but there is no body to freeze.
        hitThisFrame[v] = true;
        landed = true;
        continue;
      }
      const shielded = vic.action === 'shield' || vic.action === 'shieldStun';
      const critMul = shielded ? 1 : rollCrit(state, atk, hb, true);
      const shieldDmg = (hb.shieldDamage === undefined ? hb.damage : hb.shieldDamage) * echo.damageScale;
      setHitMeta(critMul !== 1, true, 'echo:' + atk.echoMove);
      applyHit(
        state, vic, atk.slot, atk.echoFacing, dmg * critMul, hb.angle, hb.bkb, hb.kbg,
        hb.hitlagMul === undefined ? 1 : hb.hitlagMul, shieldDmg, hx, hy, critMul,
      );
      hitThisFrame[v] = true;
      landed = true;
    }
    if (landed) atk.echoHitGroups |= groupBit;
  }
}

/** Step 6 of the frame: fighter hitboxes, then echoes, then projectiles against every other hurtbox. */
export function resolveHits(state: GameState): void {
  const fighters = simFighters(state);
  for (let i = 0; i < fighters.length; i++) caughtThisFrame[i] = false;

  for (let a = 0; a < fighters.length; a++) {
    resolveMelee(state, fighters, a);
    resolveEcho(state, fighters, a);
  }

  // Clashes first, so a projectile that loses one never also hits a fighter this frame.
  resolveProjectileClashes(state);

  for (let i = 0; i < state.projectiles.length; i++) {
    const pr = state.projectiles[i];
    if (!pr.alive) continue;
    const pdef = PROJECTILE_DEFS[pr.defId];
    if (pdef === undefined) continue;
    for (let v = 0; v < fighters.length; v++) {
      const vic = fighters[v];
      if (vic.slot === pr.owner || sameTeam(state, pr.owner, vic.slot)) continue;
      const bit = 1 << v;
      if ((pr.hitSlots & bit) !== 0 || caughtThisFrame[v]) continue;
      if (!canBeHit(vic)) continue;
      fighterHurtbox(vic, defOf(vic), HURT);
      if (!circleRectOverlap(pr.x, pr.y, chargedStat(pdef, pr.charge, 'r') * pr.scale, HURT)) continue;
      if (dodgesHit(vic, pr.y, pdef.low, null, true)) continue;

      // Charge and the return pass scale what this instance deals, shield damage included.
      const pdmg = chargedStat(pdef, pr.charge, 'damage') * pr.power;
      const shooter = fighterBySlot(state, pr.owner);
      // A parried shot is destroyed with no burst.
      if (tryCounter(state, vic, pr.owner, pdmg, shooter !== null ? shooter.x : pr.x) >= 0) {
        pr.hitSlots |= bit;
        killProjectile(state, pr, pdef, false);
        break;
      }
      const shielded = vic.action === 'shield' || vic.action === 'shieldStun';
      const before = vic.percent;
      setHitMeta(false, false, pr.defId);
      applyHit(
        state, vic, pr.owner, pr.facing, pdmg, pdef.angle,
        chargedStat(pdef, pr.charge, 'bkb'), chargedStat(pdef, pr.charge, 'kbg'), 1,
        pdmg, pr.x, pr.y,
      );
      if (shooter !== null && !state.finished) shooter.stats.projectilesHit++;
      // Drain: the owner heals a share of the damage that reached the body.
      const heal = pdef.healFraction;
      if (heal !== undefined && !shielded && shooter !== null && shooter.action !== 'dead') {
        const dealt = vic.percent - before;
        if (dealt > 0) shooter.percent = Math.max(0, shooter.percent - dealt * heal);
      }
      pr.hitSlots |= bit;
      // A shield breaks every projectile it blocks, destroyOnHit or not (the crescent, both orb sizes).
      if (pdef.destroyOnHit || shielded) {
        killProjectile(state, pr, pdef);
        break;
      }
    }
  }
}

export function regenShield(f: SimFighter, amount: number): void {
  if (f.action === 'shield' || f.action === 'shieldStun' || f.action === 'shieldBreak') return;
  if (f.shieldHp >= SHIELD_MAX) return;
  f.shieldHp = Math.min(SHIELD_MAX, f.shieldHp + amount);
}
