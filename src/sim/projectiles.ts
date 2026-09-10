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

function freeSlot(state: GameState): ProjectileState {
  for (let i = 0; i < state.projectiles.length; i++) {
    if (!state.projectiles[i].alive) return state.projectiles[i];
  }
  const fresh: ProjectileState = {
    id: 0, owner: 0, defId: '', x: 0, y: 0, vx: 0, vy: 0, facing: 1,
    age: 0, hitSlots: 0, alive: false,
  };
  state.projectiles.push(fresh);
  return fresh;
}

/** Spawns from a move's projectile def, in fighter-local space mirrored by facing. */
export function spawnProjectile(state: GameState, f: SimFighter, def: ProjectileDef): void {
  const p = freeSlot(state);
  p.id = state.nextProjectileId++;
  p.owner = f.slot;
  p.defId = def.id;
  p.x = f.x + def.x * f.facing;
  p.y = f.y + def.y;
  p.vx = def.vx * f.facing;
  p.vy = def.vy;
  p.facing = f.facing;
  p.age = 0;
  p.hitSlots = 0;
  p.alive = true;
  state.events.push({ type: 'projectileSpawn', x: p.x, y: p.y, slot: f.slot, defId: def.id });
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
    p.x += p.vx;
    p.y += p.vy;
    p.vy += def.gravity;
    p.age++;
    const outside = p.x < blast.x || p.x > blast.x + blast.w || p.y < blast.y || p.y > blast.y + blast.h;
    if (p.age >= def.lifetime || outside) {
      p.alive = false;
      state.events.push({ type: 'projectileDie', x: p.x, y: p.y, defId: p.defId });
    }
  }
}
