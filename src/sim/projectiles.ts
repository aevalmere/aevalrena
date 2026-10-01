import { CHARACTER_DEFS } from '../characters/registry';
import type { AimDir, GameState, MoveId, ProjectileDef, ProjectileState } from '../core/types';
import { stageOf, type SimFighter } from './state';

/** Every projectile def in the game, keyed by def id. Built at module load; see rebuildProjectileDefs. */
export const PROJECTILE_DEFS: Record<string, ProjectileDef> = buildProjectileDefs({});

/**
 * Rescans CHARACTER_DEFS into PROJECTILE_DEFS in place (same object, so every importer sees it).
 * For a def registered after module load, such as a test character.
 */
export function rebuildProjectileDefs(): void {
  const keys = Object.keys(PROJECTILE_DEFS);
  for (let i = 0; i < keys.length; i++) delete PROJECTILE_DEFS[keys[i]];
  buildProjectileDefs(PROJECTILE_DEFS);
}

function buildProjectileDefs(out: Record<string, ProjectileDef>): Record<string, ProjectileDef> {
  const charIds = Object.keys(CHARACTER_DEFS).sort();
  for (let c = 0; c < charIds.length; c++) {
    const moves = CHARACTER_DEFS[charIds[c]].moves;
    const moveIds = Object.keys(moves) as MoveId[];
    for (let m = 0; m < moveIds.length; m++) {
      const list = moves[moveIds[m]].projectiles;
      if (list === undefined) continue;
      for (let i = 0; i < list.length; i++) out[list[i].id] = list[i];
    }
  }
  return out;
}

/** Hit circle and sprite size of a charged projectile at no charge and at full. A tap comes out visibly small. */
export const PROJECTILE_SCALE_MIN = 0.6;
export const PROJECTILE_SCALE_MAX = 1.5;

type ChargedKey = 'vx' | 'lifetime' | 'damage' | 'bkb' | 'kbg' | 'r' | 'strength';

/**
 * One stat of a projectile instance, charge included. A def with `charged` lerps each listed
 * field from its base value to the full-charge value by `charge`, the instance's stored charge
 * fraction t (0..1, 0 for any move that cannot charge), mapped onto the exponential curve
 * c = (0.6 * 2.5 ** t - 0.6) / 0.9: the scale curve normalised to run 0 at a tap to 1 at full,
 * so the last quarter of the charge moves every stat furthest.
 */
export function chargedStat(def: ProjectileDef, charge: number | undefined, key: ChargedKey): number {
  const base = def[key];
  const full = def.charged === undefined ? undefined : def.charged[key];
  if (full === undefined) return base;
  let t = charge === undefined ? 0 : charge;
  if (t <= 0) return base;
  if (t > 1) t = 1;
  const scaled = PROJECTILE_SCALE_MIN * Math.pow(PROJECTILE_SCALE_MAX / PROJECTILE_SCALE_MIN, t);
  const c = (scaled - PROJECTILE_SCALE_MIN) / (PROJECTILE_SCALE_MAX - PROJECTILE_SCALE_MIN);
  return base + (full - base) * c;
}

function freeSlot(state: GameState): ProjectileState {
  for (let i = 0; i < state.projectiles.length; i++) {
    if (!state.projectiles[i].alive) return state.projectiles[i];
  }
  const fresh: ProjectileState = {
    id: 0, owner: 0, defId: '', x: 0, y: 0, vx: 0, vy: 0, facing: 1,
    age: 0, hitSlots: 0, alive: false,
    power: 1, scale: 1, returned: false,
  };
  state.projectiles.push(fresh);
  return fresh;
}

/**
 * cos and sin of AIM_ANGLES (0, 45, 90, -45, -90 degrees) as constants, so no trig runs in the
 * sim and AI code that mirrors the aim stays inside its no-trig rule.
 */
const AIM_COS: readonly number[] = [1, Math.SQRT1_2, 0, Math.SQRT1_2, 0];
const AIM_SIN: readonly number[] = [0, Math.SQRT1_2, 1, -Math.SQRT1_2, -1];

function spawnAt(
  state: GameState,
  owner: number,
  facing: 1 | -1,
  x: number,
  y: number,
  def: ProjectileDef,
  power: number,
  scale: number,
  charge: number,
  hitSlots = 0,
  aim: AimDir = 0,
): void {
  const p = freeSlot(state);
  p.id = state.nextProjectileId++;
  p.owner = owner;
  p.defId = def.id;
  p.x = x;
  p.y = y;
  if (def.aim === true) {
    const speed = chargedStat(def, charge, 'vx');
    p.vx = speed * AIM_COS[aim] * facing;
    p.vy = -speed * AIM_SIN[aim];
  } else {
    p.vx = chargedStat(def, charge, 'vx') * facing;
    p.vy = def.vy;
  }
  p.facing = facing;
  p.age = 0;
  p.hitSlots = hitSlots;
  p.alive = true;
  // A dead slot is handed back with the last projectile's values still on it, so
  // every per-instance field is reset here as well as on a fresh one.
  p.power = power;
  p.scale = def.fixedScale === true ? 1 : scale;
  p.charge = charge;
  p.returned = false;
  // Written after charge so a fresh slot's key order matches cloneProjectile's (the rollback
  // tests compare states as JSON).
  p.spawnX = x;
  p.spawnY = y;
  state.events.push({ type: 'projectileSpawn', x: p.x, y: p.y, slot: owner, defId: def.id });
}

/**
 * Spawns from a move's projectile def, in fighter-local space mirrored by facing.
 * `power` scales the damage it deals, `scale` its hit circle and sprite, and `charge`
 * (fraction 0..1) drives the def's `charged` lerp. Defaults 1, 1, 0 so an ordinary spawn
 * is exactly the def's own numbers; a charged nspecial passes them up.
 */
export function spawnProjectile(
  state: GameState, f: SimFighter, def: ProjectileDef, power = 1, scale = 1, charge = 0,
): void {
  spawnAt(state, f.slot, f.facing, f.x + def.x * f.facing, f.y + def.y, def, power, scale, charge, 0, f.aimDir);
}

/**
 * Damage and base knockback of one projectile instance at hit time, charge, power and
 * distanceScale included. The distance is the straight line from the spawn point, so an aimed
 * shot scales the same along any direction; Math.sqrt is exact (IEEE), so it stays deterministic.
 */
export function projectileHitStats(def: ProjectileDef, p: ProjectileState, out: { damage: number; bkb: number }): void {
  let damage = chargedStat(def, p.charge, 'damage');
  let bkb = chargedStat(def, p.charge, 'bkb');
  const ds = def.distanceScale;
  if (ds !== undefined) {
    const dx = p.x - (p.spawnX ?? p.x);
    const dy = p.y - (p.spawnY ?? p.y);
    const d = Math.sqrt(dx * dx + dy * dy);
    damage = Math.min(ds.maxDamage, damage + ds.damagePerPx * d);
    if (ds.bkbPerPx !== undefined) bkb += ds.bkbPerPx * d;
  }
  out.damage = damage * p.power;
  out.bkb = bkb;
}

/**
 * Retire a projectile and detonate its burst where it died. The freed slot can
 * be handed straight back for the burst, which is why the position is read into
 * arguments before anything is written. `burst` false retires it with no burst
 * (a parried or recalled shot).
 */
export function killProjectile(state: GameState, p: ProjectileState, def: ProjectileDef, burst = true): void {
  p.alive = false;
  state.events.push({ type: 'projectileDie', x: p.x, y: p.y, defId: p.defId });
  if (!burst || def.burstId === undefined) return;
  const burstDef = PROJECTILE_DEFS[def.burstId];
  if (burstDef === undefined) return;
  // The burst is as strong and as big as the shot that carried it, and skips every fighter
  // that shot already hit: a burst never re-launches (and so never overrides) its orb's hit.
  // p may be the very slot handed back to the burst, so its fields are read first.
  spawnAt(state, p.owner, p.facing, p.x, p.y, burstDef, p.power, p.scale, p.charge ?? 0, p.hitSlots);
}

/**
 * True when a dieOnGround projectile touched ground this step: its centre crossed a platform top
 * going down (from prevY above or on it to below), or it is inside a solid platform's body. On a
 * hit the centre is put on the surface, where the burst then spawns.
 */
function hitsGround(state: GameState, p: ProjectileState, prevY: number): boolean {
  const platforms = stageOf(state).platforms;
  for (let i = 0; i < platforms.length; i++) {
    const pl = platforms[i];
    if (p.x < pl.x || p.x > pl.x + pl.w) continue;
    const crossed = p.y > prevY && prevY <= pl.y && p.y >= pl.y;
    const inside = pl.solid && p.y >= pl.y && p.y <= pl.y + pl.h;
    if (!crossed && !inside) continue;
    if (crossed) p.y = pl.y;
    return true;
  }
  return false;
}

/** Step 5 of the frame: move, age, die on lifetime, on ground (dieOnGround) or outside the blast zone. */
export function stepProjectiles(state: GameState): void {
  const blast = stageOf(state).blast;
  for (let i = 0; i < state.projectiles.length; i++) {
    const p = state.projectiles[i];
    if (!p.alive) continue;
    const def = PROJECTILE_DEFS[p.defId];
    if (def === undefined) {
      p.alive = false;
      continue;
    }
    // The turnaround happens before this frame's integration, so the frame it fires on
    // is the first one stepped with age >= returnFrame, and it fires exactly once.
    if (def.returnFrame !== undefined && !p.returned && p.age >= def.returnFrame) {
      p.vx = -p.vx;
      p.facing = p.facing === 1 ? -1 : 1;
      p.hitSlots = 0;              // one more hit per target on the way back
      p.power *= def.returnPower === undefined ? 0.5 : def.returnPower;
      p.returned = true;
    }
    const prevY = p.y;
    p.x += p.vx;
    p.y += p.vy;
    p.vy += def.gravity;
    p.age++;
    const outside = p.x < blast.x || p.x > blast.x + blast.w || p.y < blast.y || p.y > blast.y + blast.h;
    if (!outside && def.dieOnGround === true && hitsGround(state, p, prevY)) {
      killProjectile(state, p, def);
    } else if (outside) {
      p.alive = false;
      state.events.push({ type: 'projectileDie', x: p.x, y: p.y, defId: p.defId });
    } else if (p.age >= Math.round(chargedStat(def, p.charge, 'lifetime'))) {
      killProjectile(state, p, def);
    }
  }
}
