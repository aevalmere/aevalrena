/**
 * Colour variants: outfit colours of one character (blue, purple, white, pink), made by a
 * palette swap at bake time. Pure pixel maths with no DOM, so the renderer, the select screen
 * and tools/variants/preview.ts all run the same remap.
 *
 * The blue cluster is found in HSL: hue inside BLUE_HUE_MIN..BLUE_HUE_MAX, saturation at or
 * above SAT_FLOOR, lightness at or above DARK_MAX. The band was measured from Aeval's body and
 * fx atlases: saturated pixels sit at hue 180..260 with the peak at 200..215 (water, eyes, fx);
 * the hair and coat are the same hue family but below saturation 0.3, and the outline is below
 * lightness 0.1, so neither moves. Skin sits at hue 0..40 and 320..360, outside the band.
 * Pixels near an edge of the band are blended part way so antialiased edges do not seam.
 */

export const VARIANT_COUNT = 4;
export const VARIANT_BLUE = 0;
export const VARIANT_PURPLE = 1;
export const VARIANT_WHITE = 2;
export const VARIANT_PINK = 3;
export const VARIANT_NAMES: readonly string[] = ['Blue', 'Purple', 'White', 'Pink'];

/** Measured blue band (degrees). Weight ramps to zero over HUE_FEATHER outside it. */
export const BLUE_HUE_MIN = 175;
export const BLUE_HUE_MAX = 265;
/** Centre of the measured cluster: a pixel at this hue lands exactly on the target hue. */
export const BLUE_HUE_CENTER = 207;
const HUE_FEATHER = 10;
/** HSL saturation floor for the blue cluster, with a ramp below it. */
export const SAT_FLOOR = 0.35;
const SAT_FEATHER = 0.05;
/** Pixels at or below this lightness (outline, deep shadow) are never touched. */
export const DARK_MAX = 0.12;
const DARK_FEATHER = 0.04;
/** Hue spread inside the band is halved around the target, so a variant reads as one colour. */
const HUE_SPREAD = 0.5;

const PURPLE_HUE = 280;
const PURPLE_SAT = 1.12;
const PINK_HUE = 340;
const PINK_LIFT = 0.14;
const WHITE_SAT = 0.08;
const WHITE_LIFT = 0.42;

/** Clamp any number (including NaN) into a valid variant index. */
export function clampVariant(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const i = Math.floor(v);
  return i < 0 || i >= VARIANT_COUNT ? 0 : i;
}

/** HSL of an 8-bit colour: [hue 0..360, saturation 0..1, lightness 0..1]. */
export function rgbToHsl(r: number, g: number, b: number, out: number[]): void {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = rf > gf ? (rf > bf ? rf : bf) : gf > bf ? gf : bf;
  const min = rf < gf ? (rf < bf ? rf : bf) : gf < bf ? gf : bf;
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rf) h = (gf - bf) / d + (gf < bf ? 6 : 0);
    else if (max === gf) h = (bf - rf) / d + 2;
    else h = (rf - gf) / d + 4;
    h *= 60;
  }
  out[0] = h;
  out[1] = s;
  out[2] = l;
}

function hueToRgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

export function hslToRgb(h: number, s: number, l: number, out: number[]): void {
  if (s <= 0) {
    const v = Math.round(l * 255);
    out[0] = v;
    out[1] = v;
    out[2] = v;
    return;
  }
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = Math.round(hueToRgb(p, q, hh + 1 / 3) * 255);
  out[1] = Math.round(hueToRgb(p, q, hh) * 255);
  out[2] = Math.round(hueToRgb(p, q, hh - 1 / 3) * 255);
}

function ramp(x: number, zeroAt: number, oneAt: number): number {
  const t = (x - zeroAt) / (oneAt - zeroAt);
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** How much a pixel belongs to the blue cluster, 0..1. */
export function blueWeight(h: number, s: number, l: number): number {
  const hw = h < BLUE_HUE_MIN
    ? ramp(h, BLUE_HUE_MIN - HUE_FEATHER, BLUE_HUE_MIN)
    : h > BLUE_HUE_MAX
      ? ramp(h, BLUE_HUE_MAX + HUE_FEATHER, BLUE_HUE_MAX)
      : 1;
  if (hw === 0) return 0;
  const sw = ramp(s, SAT_FLOOR - SAT_FEATHER, SAT_FLOOR);
  if (sw === 0) return 0;
  const lw = ramp(l, DARK_MAX, DARK_MAX + DARK_FEATHER);
  return hw * sw * lw;
}

const hsl = [0, 0, 0];
const rgb = [0, 0, 0];

/**
 * Remap one colour for `variant`, writing [r, g, b] into `out`. Variant 0 and any pixel
 * outside the blue cluster come back unchanged.
 */
export function remapRgb(r: number, g: number, b: number, variant: number, out: number[]): void {
  out[0] = r;
  out[1] = g;
  out[2] = b;
  if (variant <= 0 || variant >= VARIANT_COUNT) return;
  rgbToHsl(r, g, b, hsl);
  const w = blueWeight(hsl[0], hsl[1], hsl[2]);
  if (w === 0) return;
  let h = hsl[0];
  let s = hsl[1];
  let l = hsl[2];
  const offset = (h - BLUE_HUE_CENTER) * HUE_SPREAD;
  if (variant === VARIANT_PURPLE) {
    h = PURPLE_HUE + offset;
    s = Math.min(1, s * PURPLE_SAT);
  } else if (variant === VARIANT_PINK) {
    h = PINK_HUE + offset;
    l = l + (1 - l) * PINK_LIFT;
  } else {
    // White keeps its shading: lightness is lifted toward white, never flattened to it.
    s = s * WHITE_SAT;
    l = l + (1 - l) * WHITE_LIFT;
  }
  hslToRgb(h, s, l, rgb);
  out[0] = Math.round(r + (rgb[0] - r) * w);
  out[1] = Math.round(g + (rgb[1] - g) * w);
  out[2] = Math.round(b + (rgb[2] - b) * w);
}

/** Remap RGBA pixels in place. Alpha is kept; fully transparent pixels are skipped. */
export function remapPixels(data: Uint8ClampedArray, variant: number): void {
  if (variant <= 0 || variant >= VARIANT_COUNT) return;
  const cache = new Map<number, number>();
  const out = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let packed = cache.get(key);
    if (packed === undefined) {
      remapRgb(data[i], data[i + 1], data[i + 2], variant, out);
      packed = (out[0] << 16) | (out[1] << 8) | out[2];
      cache.set(key, packed);
    }
    data[i] = (packed >> 16) & 255;
    data[i + 1] = (packed >> 8) & 255;
    data[i + 2] = packed & 255;
  }
}

function hex2(n: number): string {
  return (n < 16 ? '0' : '') + n.toString(16);
}

/** '#rrggbb' remapped for `variant`. Used for particle and charge-bead colours. */
export function remapHex(hex: string, variant: number): string {
  const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  const out = [0, 0, 0];
  remapRgb(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), variant, out);
  return '#' + hex2(out[0]) + hex2(out[1]) + hex2(out[2]);
}

/** A mid water blue from the body sheet; each swatch is this colour through the remap. */
const SWATCH_BASE = '#3f8fe6';

/** The four swatch colours on the select and lobby screens, one per variant. */
export const VARIANT_SWATCHES: readonly string[] = [0, 1, 2, 3].map((v) => remapHex(SWATCH_BASE, v));

/**
 * Per variant, `hex` remapped: a lookup table built once so the draw path never builds a
 * colour string.
 */
export function variantTable(hex: string): readonly string[] {
  const out: string[] = [];
  for (let v = 0; v < VARIANT_COUNT; v++) out.push(remapHex(hex, v));
  return out;
}
