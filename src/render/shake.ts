/**
 * Screen shake. Amounts add up, clamp to 4 px, and decay to zero over 12
 * render frames. Offsets are whole pixels so the world stays pixel aligned.
 */

const SHAKE_MAX = 4;
const SHAKE_FRAMES = 12;
const DECAY = SHAKE_MAX / SHAKE_FRAMES;

export interface ShakeState {
  amount: number;
  x: number;
  y: number;
  tick: number;
}

export function createShake(): ShakeState {
  return { amount: 0, x: 0, y: 0, tick: 0 };
}

export function addShake(shake: ShakeState, amount: number): void {
  if (!(amount > 0)) return;
  shake.amount += amount;
  if (shake.amount > SHAKE_MAX) shake.amount = SHAKE_MAX;
}

export function resetShake(shake: ShakeState): void {
  shake.amount = 0;
  shake.x = 0;
  shake.y = 0;
  shake.tick = 0;
}

/** Advance one render frame and recompute the whole-pixel offset. */
export function stepShake(shake: ShakeState): void {
  if (shake.amount <= 0) {
    shake.amount = 0;
    shake.x = 0;
    shake.y = 0;
    return;
  }
  shake.tick++;
  const swing = shake.tick % 2 === 0 ? 1 : -1;
  const alt = shake.tick % 4 < 2 ? 1 : -1;
  shake.x = Math.round(shake.amount) * swing;
  shake.y = Math.round(shake.amount * 0.6) * alt;
  shake.amount -= DECAY;
  if (shake.amount < 0) shake.amount = 0;
}
