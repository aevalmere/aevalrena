import { CHARACTER_DEFS } from '../characters/registry';
import type { GameState, MoveId, ProjectileDef, ProjectileState } from '../core/types';
import { stageOf, type SimFighter } from './state';

/** Every projectile def in the game, keyed by def id. Built once at module load. */
export const PROJECTILE_DEFS: Record<string, ProjectileDef> = buildProjectileDefs();

function buildProjectileDefs(): Record<string, ProjectileDef> {
  const out: Record<string, ProjectileDef> = {};
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
 * field from its base value to the full-charge value by how far along the charge curve the
 * shot was thrown. That position is read back off the instance's `scale`, which is set once
 * at spawn by projectileChargeScale (0.6 * 2.5 ** t) and never changed after: (scale - 0.6) / 0.9
 * is the same exponential normalised to run 0 at a tap to 1 at full charge, so the last
 * quarter of the charge moves every stat furthest. No per-instance field is needed.
 */
export function chargedStat(def: ProjectileDef, scale: number, key: ChargedKey): number {
  const base = def[key];
  const full = def.charged === undefined ? undefined : def.charged[key];
  if (full === undefined) return base;
  let c = (scale - PROJECTILE_SCALE_MIN) / (PROJECTILE_SCALE_MAX - PROJECTILE_SCALE_MIN);
  if (c < 0) c = 0;
  else if (c > 1) c = 1;
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

function spawnAt(
  state: GameState,
  owner: number,
  facing: 1 | -1,
  x: number,
  y: number,
  def: ProjectileDef,
  power: number,
  scale: number,
  hitSlots = 0,
): void {
  const p = freeSlot(state);
  p.id = state.nextProjectileId++;
  p.owner = owner;
  p.defId = def.id;
  p.x = x;
  p.y = y;
  p.vx = chargedStat(def, scale, 'vx') * facing;
  p.vy = def.vy;
  p.facing = facing;
  p.age = 0;
  p.hitSlots = hitSlots;
  p.alive = true;
  // A dead slot is handed back with the last projectile's values still on it, so
  // every per-instance field is reset here as well as on a fresh one.
  p.power = power;
  p.scale = scale;
  p.returned = false;
  state.events.push({ type: 'projectileSpawn', x: p.x, y: p.y, slot: owner, defId: def.id });
}

/**
 * Spawns from a move's projectile def, in fighter-local space mirrored by facing.
 * `power` scales the damage it deals and `scale` its hit circle and sprite, both 1
 * by default so an ordinary spawn is exactly the def's own numbers; a charged
 * nspecial passes them up.
 */
export function spawnProjectile(
  state: GameState, f: SimFighter, def: ProjectileDef, power = 1, scale = 1,
): void {
  spawnAt(state, f.slot, f.facing, f.x + def.x * f.facing, f.y + def.y, def, power, scale);
}

/**
 * Retire a projectile and detonate its burst where it died. The freed slot can
 * be handed straight back for the burst, which is why the position is read into
 * arguments before anything is written.
 */
export function killProjectile(state: GameState, p: ProjectileState, def: ProjectileDef): void {
  p.alive = false;
  state.events.push({ type: 'projectileDie', x: p.x, y: p.y, defId: p.defId });
  if (def.burstId === undefined) return;
  const burst = PROJECTILE_DEFS[def.burstId];
  if (burst === undefined) return;
  // The burst is as strong and as big as the shot that carried it, and skips every fighter
  // that shot already hit: a burst never re-launches (and so never overrides) its orb's hit.
  // p may be the very slot handed back to the burst, so its fields are read first.
  spawnAt(state, p.owner, p.facing, p.x, p.y, burst, p.power, p.scale, p.hitSlots);
}

/** Step 5 of the frame: move, age, die on lifetime or outside the blast zone. */
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
    p.x += p.vx;
    p.y += p.vy;
    p.vy += def.gravity;
    p.age++;
    const outside = p.x < blast.x || p.x > blast.x + blast.w || p.y < blast.y || p.y > blast.y + blast.h;
    if (outside) {
      p.alive = false;
      state.events.push({ type: 'projectileDie', x: p.x, y: p.y, defId: p.defId });
    } else if (p.age >= Math.round(chargedStat(def, p.scale, 'lifetime'))) {
      killProjectile(state, p, def);
    }
  }
}
