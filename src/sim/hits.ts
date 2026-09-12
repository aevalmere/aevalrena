import {
  hitlagFrames, SAKURAI_STRONG_ANGLE, SAKURAI_WEAK_ANGLE, SHIELD_BREAK_STUN, SHIELD_MAX,
  SHIELD_STUN_PER_DAMAGE, TUNING,
} from '../core/constants';
import { circleRectOverlap, degToRad } from '../core/math';
import { MAX_PLAYERS } from '../core/types';
import type { Facing, GameState, HitboxDef, Rect } from '../core/types';
import { defOf, fighterHurtbox, setAction, simFighters, type SimFighter } from './state';
import { PROJECTILE_DEFS, killProjectile } from './projectiles';

const HURT: Rect = { x: 0, y: 0, w: 0, h: 0 };
const hitThisFrame: boolean[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) hitThisFrame.push(false);

const PERCENT_CAP = 999;
/** Below this launch angle a grounded victim slides instead of leaving the ground. */
const GROUNDED_ANGLE = 15;
const SHIELD_PUSHBACK = 2;

export function canBeHit(f: SimFighter): boolean {
  if (f.action === 'dead' || f.action === 'respawn') return false;
  return f.invuln <= 0;
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
): number {
  // damageMul scales everything a hit deals, so hitlag and shield damage follow it too.
  const damage = rawDamage * TUNING.knockback.damageMul;
  const lag = Math.max(1, Math.round(hitlagFrames(damage) * hitlagMul));

  if (victim.action === 'shield' || victim.action === 'shieldStun') {
    victim.shieldHp -= rawShieldDamage * TUNING.knockback.damageMul;
    victim.hitlag = lag;
    victim.vx += (victim.x < hitX ? -1 : 1) * SHIELD_PUSHBACK;
    state.events.push({ type: 'shieldHit', x: hitX, y: hitY, victim: victim.slot });
    if (victim.shieldHp <= 0) {
      breakShield(state, victim);
    } else {
      setAction(victim, 'shieldStun');
      victim.stateTimer = Math.floor(damage * SHIELD_STUN_PER_DAMAGE) + 2;
    }
    return lag;
  }

  const def = defOf(victim);
  victim.percent = Math.min(PERCENT_CAP, victim.percent + damage);
  const kb = knockback(victim.percent, def.weight, damage, bkb, kbg) * TUNING.knockback.kbMul;
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
  victim.hitlag = lag;
  victim.hitstun = Math.floor(kb * TUNING.knockback.hitstunPerKb);
  setAction(victim, kb >= TUNING.knockback.tumbleKb ? 'tumble' : 'hitstun');

  state.events.push({
    type: 'hit', x: hitX, y: hitY,
    attacker: attackerSlot, victim: victim.slot,
    damage, kb, angle: world,
  });
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
/** Hit circle and sprite size at no charge and at full. A tap comes out visibly small. */
const PROJECTILE_SCALE_MIN = 0.6;
const PROJECTILE_SCALE_MAX = 1.5;

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
 * Damage multiplier for a charged projectile. Full charge still lands on exactly the
 * melee ceiling of 1 + chargeBonus, so a fully charged shot deals what it always did.
 * A move that cannot charge, and a chargeMax of 0, both return exactly 1.
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
 * How close two projectiles' effective damage must be, as a fraction of the stronger
 * one, for a clash to cancel both instead of letting the stronger plough through.
 * Relative rather than absolute so it reads the same for a 2 percent bead and a 20
 * percent orb, and wide enough (10 percent) that float dust from charge scaling can
 * never flip a mirror match into a one-sided win: a full 40 percent charge bonus is
 * a 29 percent gap, so a real charge still wins, while a flick of charge cancels.
 */
const CLASH_TOLERANCE = 0.1;

/**
 * Projectile versus projectile. Opposing shots whose hit circles overlap clash: near
 * enough in effective damage and both die and detonate their bursts, otherwise the
 * stronger survives with its power cut by the damage it absorbed and the weaker dies.
 *
 * Pairs are visited once (j starts at i + 1) and the outcome is decided purely by the
 * two effective damages, so no result depends on which index comes first. Bursts spawn
 * into freed slots, which may sit anywhere in the array, so anything born during this
 * pass is skipped by id and cannot clash on the frame it appears.
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
      const reach = adef.r * a.scale + bdef.r * b.scale;
      if (dx * dx + dy * dy > reach * reach) continue;

      const ad = adef.damage * a.power;
      const bd = bdef.damage * b.power;
      const gap = ad > bd ? ad - bd : bd - ad;
      const stronger = ad > bd ? ad : bd;
      if (gap <= stronger * CLASH_TOLERANCE) {
        killProjectile(state, a, adef);
        killProjectile(state, b, bdef);
        break;                    // a is gone; nothing else can clash with it
      }
      if (ad > bd) {
        a.power *= gap / ad;      // keeps only the damage left after absorbing b
        killProjectile(state, b, bdef);
        continue;                 // a survives and may meet another shot this frame
      }
      b.power *= gap / bd;
      killProjectile(state, a, adef);
      break;
    }
  }
}

/** Step 6 of the frame: fighter hitboxes then projectiles against every other hurtbox. */
export function resolveHits(state: GameState): void {
  const fighters = simFighters(state);

  for (let a = 0; a < fighters.length; a++) {
    const atk = fighters[a];
    if (atk.action !== 'attack' || atk.moveId === null) continue;
    if (atk.hitlag > 0 || atk.charging) continue;
    const mv = defOf(atk).moves[atk.moveId];
    const mul = chargeMultiplier(atk.charge, mv.chargeable);
    for (let i = 0; i < fighters.length; i++) hitThisFrame[i] = false;

    for (let h = 0; h < mv.hitboxes.length; h++) {
      const hb = mv.hitboxes[h];
      if (atk.actionFrame < hb.start || atk.actionFrame > hb.end) continue;
      const groupBit = 1 << hb.group;
      if ((atk.hitGroups & groupBit) !== 0) continue;
      const hx = atk.x + hb.x * atk.facing;
      const hy = atk.y + hb.y;
      let landed = false;

      for (let v = 0; v < fighters.length; v++) {
        if (v === a || hitThisFrame[v]) continue;
        const vic = fighters[v];
        if (!canBeHit(vic)) continue;
        fighterHurtbox(vic, defOf(vic), HURT);
        if (!circleRectOverlap(hx, hy, hb.r, HURT)) continue;

        const dmg = hitboxDamage(hb, mul);
        const lag = applyHit(
          state, vic, atk.slot, atk.facing, dmg, hb.angle, hb.bkb, hb.kbg,
          hb.hitlagMul === undefined ? 1 : hb.hitlagMul,
          hb.shieldDamage === undefined ? dmg : hb.shieldDamage,
          hx, hy,
        );
        hitThisFrame[v] = true;
        landed = true;
        if (lag > atk.hitlag) atk.hitlag = lag;
      }
      if (landed) atk.hitGroups |= groupBit;
    }
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
      if (vic.slot === pr.owner) continue;
      const bit = 1 << v;
      if ((pr.hitSlots & bit) !== 0) continue;
      if (!canBeHit(vic)) continue;
      fighterHurtbox(vic, defOf(vic), HURT);
      if (!circleRectOverlap(pr.x, pr.y, pdef.r * pr.scale, HURT)) continue;

      // Charge and the return pass scale what this instance deals, shield damage included.
      const pdmg = pdef.damage * pr.power;
      applyHit(
        state, vic, pr.owner, pr.facing, pdmg, pdef.angle, pdef.bkb, pdef.kbg, 1,
        pdmg, pr.x, pr.y,
      );
      pr.hitSlots |= bit;
      if (pdef.destroyOnHit) {
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
