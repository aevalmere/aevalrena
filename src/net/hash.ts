import type { FighterState, GameState } from '../core/types';

/**
 * Cheap desync fingerprint: 32-bit FNV-1a over the bytes of the numbers that matter for play
 * (frame, RNG, every fighter's position, velocity, percent, stocks, action and action frame, its
 * echo, counter and air-lock state, and every projectile). Floats are hashed by their exact IEEE
 * bits, so any drift shows.
 */

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function mixU32(h: number, v: number): number {
  h = Math.imul(h ^ (v & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((v >>> 8) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((v >>> 16) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ (v >>> 24), FNV_PRIME);
  return h;
}

function mixNum(h: number, v: number): number {
  f64[0] = v;
  return mixU32(mixU32(h, u32[0]), u32[1]);
}

function mixStr(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME);
  return h;
}

export function hashGameState(state: GameState): number {
  let h = FNV_OFFSET;
  h = mixNum(h, state.frame);
  h = mixNum(h, state.rng.s);
  h = mixNum(h, state.timeLeft);
  h = mixNum(h, state.winner);
  h = mixNum(h, state.finished ? 1 : 0);
  for (let i = 0; i < state.fighters.length; i++) {
    const f = state.fighters[i];
    h = mixNum(h, f.x);
    h = mixNum(h, f.y);
    h = mixNum(h, f.vx);
    h = mixNum(h, f.vy);
    h = mixNum(h, f.percent);
    h = mixNum(h, f.stocks);
    h = mixNum(h, f.facing);
    h = mixNum(h, f.actionFrame);
    h = mixNum(h, f.shieldHp);
    h = mixNum(h, f.hitstun);
    h = mixStr(h, f.action);
    h = mixStr(h, f.moveId ?? '-');
    // Trekmore state that decides later frames without moving anything yet: a pending echo, a
    // stored counter, the air locks and the latched aim. Absent (hand-built states) hashes as 0.
    const sf = f as FighterState & { echoHitGroups?: number; counterDamage?: number; airLock?: number };
    h = mixStr(h, sf.echoMove ?? '-');
    h = mixNum(h, sf.echoAge ?? 0);
    h = mixNum(h, sf.echoX ?? 0);
    h = mixNum(h, sf.echoY ?? 0);
    h = mixNum(h, sf.echoFacing ?? 0);
    h = mixNum(h, sf.echoHitGroups ?? 0);
    h = mixNum(h, sf.onBranch === true ? 1 : 0);
    h = mixNum(h, sf.aimDir ?? 0);
    h = mixNum(h, sf.counterDamage ?? 0);
    h = mixNum(h, sf.airLock ?? 0);
  }
  h = mixNum(h, state.projectiles.length);
  for (let i = 0; i < state.projectiles.length; i++) {
    const p = state.projectiles[i];
    h = mixNum(h, p.id);
    h = mixNum(h, p.owner);
    h = mixNum(h, p.x);
    h = mixNum(h, p.y);
    h = mixNum(h, p.vx);
    h = mixNum(h, p.vy);
    h = mixNum(h, p.age);
    h = mixNum(h, p.alive ? 1 : 0);
    h = mixStr(h, p.defId);
  }
  return h >>> 0;
}
