/**
 * 5x7 pixel font baked into one strip canvas per color at load. No web fonts
 * touch the game canvas. Covers digits, capitals, percent, period, colon,
 * dash and space, which is everything the HUD and the debug overlay need.
 */

const GLYPH_W = 5;
export const GLYPH_H = 7;
const GLYPH_ADVANCE = 6;

const GLYPH_ORDER =
  ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ%.:-';

const GLYPH_ROWS: Record<string, string[]> = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['###..', '#..#.', '#...#', '#...#', '#...#', '#..#.', '###..'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
};

/** charCode (0..127) to glyph index + 1. Zero means the char has no glyph. */
const CODE_TO_INDEX = new Uint8Array(128);

const DIGIT_INDEX = new Uint8Array(10);
let percentIndex = 0;
let baked = false;

const strips = new Map<string, HTMLCanvasElement>();

function buildStrip(color: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = GLYPH_ORDER.length * GLYPH_W;
  canvas.height = GLYPH_H;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('canvas 2d context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = color;
  for (let g = 0; g < GLYPH_ORDER.length; g++) {
    const rows = GLYPH_ROWS[GLYPH_ORDER.charAt(g)];
    if (rows === undefined) continue;
    const ox = g * GLYPH_W;
    for (let y = 0; y < GLYPH_H; y++) {
      const row = rows[y];
      let x = 0;
      while (x < GLYPH_W) {
        if (row.charCodeAt(x) !== 35) {
          x++;
          continue;
        }
        let end = x + 1;
        while (end < GLYPH_W && row.charCodeAt(end) === 35) end++;
        ctx.fillRect(ox + x, y, end - x, 1);
        x = end;
      }
    }
  }
  return canvas;
}

/** Build the glyph index tables and bake the strips used by the HUD and debug. */
export function bakeFont(colors: readonly string[]): void {
  CODE_TO_INDEX.fill(0);
  for (let g = 0; g < GLYPH_ORDER.length; g++) {
    const code = GLYPH_ORDER.charCodeAt(g);
    if (code < 128) CODE_TO_INDEX[code] = g + 1;
  }
  for (let d = 0; d < 10; d++) {
    DIGIT_INDEX[d] = CODE_TO_INDEX[48 + d] - 1;
  }
  percentIndex = CODE_TO_INDEX[37] - 1;
  strips.clear();
  for (const color of colors) strips.set(color, buildStrip(color));
  baked = true;
}

function stripFor(color: string): HTMLCanvasElement | null {
  let strip = strips.get(color);
  if (strip === undefined) {
    if (!baked) return null;
    strip = buildStrip(color);
    strips.set(color, strip);
  }
  return strip;
}

function blitGlyph(
  ctx: CanvasRenderingContext2D,
  strip: HTMLCanvasElement,
  index: number,
  x: number,
  y: number,
  scale: number
): void {
  if (index < 0) return;
  ctx.drawImage(
    strip,
    index * GLYPH_W,
    0,
    GLYPH_W,
    GLYPH_H,
    x,
    y,
    GLYPH_W * scale,
    GLYPH_H * scale
  );
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: string
): void {
  const strip = stripFor(color);
  if (strip === null) return;
  const px = Math.round(x);
  const py = Math.round(y);
  const step = GLYPH_ADVANCE * scale;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 97 && code <= 122) code -= 32;
    if (code > 127) continue;
    const slot = CODE_TO_INDEX[code];
    if (slot === 0) continue;
    blitGlyph(ctx, strip, slot - 1, px + i * step, py, scale);
  }
}

/** Digit count of a non-negative integer, without building a string. */
function digitCount(value: number): number {
  let n = 1;
  let v = value;
  while (v >= 10) {
    v = Math.floor(v / 10);
    n++;
  }
  return n;
}

/** Pixel width of the string drawPercent would draw, for right alignment. */
export function percentWidth(value: number, scale: number): number {
  return (digitCount(value < 0 ? -value : value) + 1) * GLYPH_ADVANCE * scale - scale;
}

/**
 * Draw a non-negative integer followed by a percent sign. Allocation free, so
 * the HUD can call it every render frame.
 */
export function drawPercent(
  ctx: CanvasRenderingContext2D,
  value: number,
  x: number,
  y: number,
  scale: number,
  color: string
): number {
  const strip = stripFor(color);
  if (strip === null) return 0;
  let v = Math.floor(value);
  if (v < 0) v = 0;
  if (v > 999) v = 999;
  const digits = digitCount(v);
  const step = GLYPH_ADVANCE * scale;
  const px = Math.round(x);
  const py = Math.round(y);
  for (let i = digits - 1; i >= 0; i--) {
    const d = v % 10;
    v = Math.floor(v / 10);
    blitGlyph(ctx, strip, DIGIT_INDEX[d], px + i * step, py, scale);
  }
  blitGlyph(ctx, strip, percentIndex, px + digits * step, py, scale);
  return (digits + 1) * step - scale;
}
