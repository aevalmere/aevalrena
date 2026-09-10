import { TUNING } from '../core/constants';

/**
 * Screen shake. Amounts add up, clamp to TUNING.camera.shakeMax, and decay to
 * zero over TUNING.camera.shakeFrames sim frames. Offsets are whole pixels so
 * the world stays pixel aligned.
 *
 * Decay is driven by elapsed sim frames, not by render calls, so the shake
 * lasts the same wall-clock time on a 60 Hz and a 144 Hz display. The offset is
 * recomputed whenever the amount changes, so a hit shakes the very frame it
 * lands.
 */

export interface ShakeState {
  amount: number;
  x: number;
  y: number;
  tick: number;
}

function decayPerFrame(): number {
  const frames = TUNING.camera.shakeFrames;
  return frames > 0 ? TUNING.camera.shakeMax / frames : TUNING.camera.shakeMax;
}

export function createShake(): ShakeState {
  return { amount: 0, x: 0, y: 0, tick: 0 };
}

/** Recompute the whole-pixel offset from the current amount and tick. */
export function applyShake(shake: ShakeState): void {
  if (shake.amount <= 0) {
    shake.amount = 0;
    shake.x = 0;
    shake.y = 0;
    return;
  }
  const swing = shake.tick % 2 === 0 ? 1 : -1;
  const alt = shake.tick % 4 < 2 ? 1 : -1;
  shake.x = Math.round(shake.amount) * swing;
  shake.y = Math.round(shake.amount * 0.6) * alt;
}

export function addShake(shake: ShakeState, amount: number): void {
  if (!(amount > 0)) return;
  shake.amount += amount;
  const max = TUNING.camera.shakeMax;
  if (shake.amount > max) shake.amount = max;
  applyShake(shake);
}

export function resetShake(shake: ShakeState): void {
  shake.amount = 0;
  shake.x = 0;
  shake.y = 0;
  shake.tick = 0;
}

/** Advance `steps` sim frames of decay, then recompute the offset. */
export function stepShake(shake: ShakeState, steps: number): void {
  if (steps > 0 && shake.amount > 0) {
    const decay = decayPerFrame();
    for (let i = 0; i < steps; i++) {
      shake.tick++;
      shake.amount -= decay;
      if (shake.amount <= 0) {
        shake.amount = 0;
        break;
      }
    }
  }
  applyShake(shake);
}
