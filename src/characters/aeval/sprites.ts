import type { ActionId, AnimDef, AnimName, CharacterSprites, MoveId, PixelSheet } from '../../core/types';

const FRAME_W = 32;
const FRAME_H = 40;
const RECT_W = 16;
const RECT_H = 36;

/**
 * Stub sprite: an outlined 16x36 rectangle centered at the bottom of a 32x40
 * frame. The art worker replaces this file with the real pixel sheets.
 */
function buildIdleFrame(): string[] {
  const rectX0 = (FRAME_W - RECT_W) / 2;
  const rectX1 = rectX0 + RECT_W;
  const rectY0 = FRAME_H - RECT_H;
  const rectY1 = FRAME_H;

  const rows: string[] = [];
  for (let y = 0; y < FRAME_H; y++) {
    if (y < rectY0) {
      rows.push('.'.repeat(FRAME_W));
      continue;
    }
    const isTopEdge = y === rectY0;
    const isBottomEdge = y === rectY1 - 1;
    let row = '';
    for (let x = 0; x < FRAME_W; x++) {
      if (x < rectX0 || x >= rectX1) {
        row += '.';
        continue;
      }
      const isLeftEdge = x === rectX0;
      const isRightEdge = x === rectX1 - 1;
      row += isTopEdge || isBottomEdge || isLeftEdge || isRightEdge ? 'o' : 'c';
    }
    rows.push(row);
  }
  return rows;
}

const palette: Record<string, string> = { c: '#7fb2ff', o: '#0e0f17' };

const sheet: PixelSheet = {
  palette,
  frames: { idle0: buildIdleFrame() },
};

const fx: PixelSheet = {
  palette,
  frames: {},
};

const anims: Record<AnimName, AnimDef> = {
  idle: { frames: ['idle0'], fps: 6, loop: true },
};

function animFor(action: ActionId, moveId: MoveId | null): AnimName {
  return 'idle';
}

export const aevalSprites: CharacterSprites = {
  sheet,
  fx,
  anims,
  animFor,
};
