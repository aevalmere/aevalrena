import {
  hitlagFrames, SAKURAI_STRONG_ANGLE, SAKURAI_WEAK_ANGLE, SHIELD_BREAK_STUN, SHIELD_MAX,
  SHIELD_STUN_PER_DAMAGE, TUNING,
} from '../core/constants';
import { circleRectOverlap, degToRad } from '../core/math';
import { MAX_PLAYERS } from '../core/types';
import type { Facing, GameState, HitboxDef, Rect } from '../core/types';
import { defOf, fighterHurtbox, setAction, simFighters, type SimFighter } from './state';
import { PROJECTILE_DEFS } from './projectiles';

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

function chargeMultiplier(charge: number, chargeable: boolean | undefined): number {
  if (chargeable !== true) return 1;
  return 1 + TUNING.input.chargeBonus * (charge / TUNING.input.chargeMax);
}

function hitboxDamage(hb: HitboxDef, mul: number): number {
  return hb.damage * mul;
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
      if (!circleRectOverlap(pr.x, pr.y, pdef.r, HURT)) continue;

      applyHit(
        state, vic, pr.owner, pr.facing, pdef.damage, pdef.angle, pdef.bkb, pdef.kbg, 1,
        pdef.damage, pr.x, pr.y,
      );
      pr.hitSlots |= bit;
      if (pdef.destroyOnHit) {
        pr.alive = false;
        state.events.push({ type: 'projectileDie', x: pr.x, y: pr.y, defId: pr.defId });
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
