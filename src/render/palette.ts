/**
 * Colour variants: four outfit colours per character, made by a palette swap at bake time. Pure
 * pixel maths with no DOM, so the renderer, the select screen and tools/variants/preview.ts all
 * run the same remap.
 *
 * Each character has a PaletteConfig: one or more HSL bands, and per band one target per variant.
 * A pixel's weight in a band is the product of three ramps (hue, saturation, lightness), so
 * antialiased pixels near an edge are blended part way and do not seam. Bands are applied in
 * order; a later band only gets the weight an earlier band left over.
 *
 * Aeval band 1 is the measured water blue (hue 175..265, saturation from 0.35, lightness above
 * 0.12): saturated pixels peak at 200..215 (water, eyes, fx). Its output is pinned by
 * rendertest. Band 2 is her coat (same hue, low saturation, below the hair's lightness), tinted
 * most of the way toward the variant hue so the coat follows the outfit colour and keeps its shade.
 *
 * Trekmore's glow and cloth bands are violet, measured from art/trekmore/palette_measure.json and
 * widened a little so armour highlights and band seams tint too. His ink sits below lightness
 * 0.07 and never moves.
 */

export const VARIANT_COUNT = 4;
export const VARIANT_BLUE = 0;
export const VARIANT_PURPLE = 1;
export const VARIANT_WHITE = 2;
export const VARIANT_PINK = 3;
/** Aeval's names. Kept for src/ui/lan.ts; per character names come from variantNames(charId). */
export const VARIANT_NAMES: readonly string[] = ['Blue', 'Purple', 'White', 'Pink'];

/** Aeval band 1, kept as named exports for the docs and older callers. */
export const BLUE_HUE_MIN = 175;
export const BLUE_HUE_MAX = 265;
export const BLUE_HUE_CENTER = 207;
export const SAT_FLOOR = 0.35;
export const DARK_MAX = 0.12;

/**
 * An HSL band. Weight semantics:
 * - hue: full inside hueMin..hueMax, ramps to 0 over `feather` degrees outside.
 * - saturation: full from satMin up to satMax; 0 at satMin - satFeather and at satMax + satFeather.
 * - lightness: 0 at and below lightMin, full from lightMin + lightFeather up to lightMax, 0 at
 *   lightMax + lightFeather. A max of 1 has no upper ramp.
 */
export interface PaletteBand {
  hueMin: number; hueMax: number; hueCenter: number; feather: number;
  satMin: number; satMax: number; lightMin: number; lightMax: number;
  satFeather: number; lightFeather: number;
  /** 1 = full remap, below 1 = partial tint: hue, saturation and lightness move this far toward the target. */
  strength: number;
  /** One target per variant; null leaves the band as drawn (variant 0). */
  targets: readonly (VariantTarget | null)[];
}

/** Gold: highlights move toward a pale metal colour, deep shade turns bronze. */
export interface MetalTarget {
  /** Mix toward highlightHex for pixels at or above highlightAbove (after the lift). */
  highlight: number;
  highlightAbove: number;
  highlightHex: string;
  /** Hue the deep shade takes, for pixels whose drawn lightness is at or below shadowBelow. */
  shadowHue: number;
  shadowBelow: number;
}

export interface VariantTarget {
  /** Target hue, or null to keep the pixel's hue (white). */
  hue: number | null;
  /** Share of the pixel's offset from the band centre kept around the target hue. */
  spread: number;
  /** Clamp on the resulting hue, [min, max], or null. */
  hueClamp: readonly [number, number] | null;
  /** Saturation multiplier, applied after satFloor. */
  sat: number;
  /** Saturation is raised to at least this before the multiplier (0 = none). */
  satFloor: number;
  /** Lightness lift toward white, 0..1. */
  lift: number;
  /** Mid tone lift: l + (1 - l) * lightCurve * l (0 = none). Leaves ink and highlights near where they are. */
  lightCurve: number;
  metal: MetalTarget | null;
}

export interface PaletteConfig {
  bands: readonly PaletteBand[];
  names: readonly string[];
  swatches: readonly string[];
  /** Echo shadow colour per variant (bake.ts getShadowFrame). */
  shadow: readonly string[];
  /** Glow base colour: charge beads, respawn glow, crit sparks. Remapped per variant. */
  glow: string;
}

function target(
  hue: number | null,
  sat: number,
  lift: number,
  extra: Partial<VariantTarget> = {}
): VariantTarget {
  return {
    hue,
    spread: 0.5,
    hueClamp: null,
    sat,
    satFloor: 0,
    lift,
    lightCurve: 0,
    metal: null,
    ...extra,
  };
}

// ---------------- Aeval ----------------

const AEVAL_BLUE: PaletteBand = {
  hueMin: BLUE_HUE_MIN, hueMax: BLUE_HUE_MAX, hueCenter: BLUE_HUE_CENTER, feather: 10,
  satMin: SAT_FLOOR, satMax: 1, satFeather: 0.05,
  lightMin: DARK_MAX, lightMax: 1, lightFeather: 0.04,
  strength: 1,
  targets: [
    null,
    target(280, 1.12, 0),
    target(null, 0.08, 0.42),
    target(340, 1, 0.14),
  ],
};

/**
 * Coat, measured (art/trekmore/palette_measure.json, aeval.coatRegion): hue 212..249, saturation
 * 0.08..0.25. Lightness starts at 0.14 because the commonest outline colour #1b192b sits at 0.133
 * inside the coat's hue and saturation range and must not tint. It stops at 0.47 (zero by 0.51)
 * because the hair shares the coat's hue and saturation and sits at lightness 0.51..0.77.
 */
const AEVAL_COAT: PaletteBand = {
  hueMin: 210, hueMax: 250, hueCenter: 232, feather: 10,
  satMin: 0.06, satMax: 0.33, satFeather: 0.02,
  lightMin: 0.14, lightMax: 0.47, lightFeather: 0.04,
  strength: 0.85,
  targets: [
    null,
    target(280, 1, 0, { satFloor: 0.3 }),
    target(null, 0.1, 0.3),
    target(335, 1, 0.06, { satFloor: 0.3 }),
  ],
};

const AEVAL_SWATCH_BASE = '#3f8fe6';

// ---------------- Trekmore ----------------

const GOLD_METAL: MetalTarget = {
  highlight: 0.65,
  highlightAbove: 0.7,
  highlightHex: '#fff2c0',
  shadowHue: 28,
  shadowBelow: 0.24,
};

function trekTargets(whiteLift: number): (VariantTarget | null)[] {
  return [
    null,
    target(358, 1.1, 0, { spread: 0.3, satFloor: 0.6, lightCurve: -0.25 }),
    target(null, 0.35, whiteLift),
    target(44, 1.05, 0, { hueClamp: [40, 48], satFloor: 0.6, lightCurve: 0.35, metal: GOLD_METAL }),
  ];
}

const TREK_GLOW: PaletteBand = {
  hueMin: 262, hueMax: 290, hueCenter: 277, feather: 14,
  satMin: 0.2, satMax: 1, satFeather: 0.05,
  lightMin: 0.3, lightMax: 1, lightFeather: 0.05,
  strength: 1,
  targets: trekTargets(0.45),
};

const TREK_CLOTH: PaletteBand = {
  hueMin: 258, hueMax: 290, hueCenter: 273, feather: 14,
  satMin: 0.2, satMax: 1, satFeather: 0.05,
  lightMin: 0.07, lightMax: 0.35, lightFeather: 0.03,
  strength: 1,
  targets: [
    null,
    target(344, 1.2, 0, { spread: 0.3, satFloor: 0.5 }),
    target(null, 0.1, 0.05, { lightCurve: 1.4 }),
    target(44, 1.05, 0, { hueClamp: [40, 48], satFloor: 0.6, lightCurve: 0.35, metal: GOLD_METAL }),
  ],
};

export const PALETTES: Record<string, PaletteConfig> = {
  aeval: {
    bands: [AEVAL_BLUE, AEVAL_COAT],
    names: VARIANT_NAMES,
    swatches: [], // filled below from AEVAL_SWATCH_BASE through the remap
    shadow: ['#0e1a38', '#2a1640', '#3a3848', '#3a1028'],
    glow: '#7fb2ff',
  },
  trekmore: {
    bands: [TREK_GLOW, TREK_CLOTH],
    names: ['Purple', 'Red', 'White', 'Gold'],
    swatches: ['#8a4dff', '#c81e3a', '#e8e6f0', '#e0b040'],
    shadow: ['#2a1640', '#3a1010', '#3a3848', '#3a2a10'],
    glow: '#b070ff',
  },
};

/** The palette for `charId`; an unknown id reads as Aeval's. */
export function paletteOf(charId: string): PaletteConfig {
  const p = PALETTES[charId];
  return p === undefined ? PALETTES.aeval : p;
}

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

/** How much a pixel belongs to `band`, 0..1. */
export function bandWeight(band: PaletteBand, h: number, s: number, l: number): number {
  const hw = h < band.hueMin
    ? ramp(h, band.hueMin - band.feather, band.hueMin)
    : h > band.hueMax
      ? ramp(h, band.hueMax + band.feather, band.hueMax)
      : 1;
  if (hw === 0) return 0;
  let sw = ramp(s, band.satMin - band.satFeather, band.satMin);
  if (sw === 0) return 0;
  if (band.satMax < 1) sw *= ramp(s, band.satMax + band.satFeather, band.satMax);
  if (sw === 0) return 0;
  let lw = ramp(l, band.lightMin, band.lightMin + band.lightFeather);
  if (band.lightMax < 1) lw *= ramp(l, band.lightMax + band.lightFeather, band.lightMax);
  return hw * sw * lw;
}

/** How much a pixel belongs to Aeval's water blue band, 0..1. */
export function blueWeight(h: number, s: number, l: number): number {
  return bandWeight(AEVAL_BLUE, h, s, l);
}

/** Signed shortest hue step from `from` to `to`, -180..180. */
function hueDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

const hsl = [0, 0, 0];
const rgb = [0, 0, 0];
const metalRgb = [0, 0, 0];
const METAL_FEATHER = 0.05;
const SHADOW_FEATHER = 0.06;

function parseHexInto(hex: string, out: number[]): void {
  const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  out[0] = parseInt(h.slice(0, 2), 16);
  out[1] = parseInt(h.slice(2, 4), 16);
  out[2] = parseInt(h.slice(4, 6), 16);
}

/**
 * Target colour of one pixel (drawn HSL h0 s0 l0) under band `band` and target `t`, into `rgb`.
 */
function targetRgb(band: PaletteBand, t: VariantTarget, h0: number, s0: number, l0: number): void {
  let h = h0;
  let s = s0;
  let l = l0;
  if (t.hue !== null) {
    h = t.hue + (h0 - band.hueCenter) * t.spread;
    if (t.hueClamp !== null) {
      if (h < t.hueClamp[0]) h = t.hueClamp[0];
      if (h > t.hueClamp[1]) h = t.hueClamp[1];
    }
  }
  if (t.satFloor > 0 && s < t.satFloor) s = t.satFloor;
  s = Math.min(1, s * t.sat);
  if (t.lift !== 0) l = l + (1 - l) * t.lift;
  if (t.lightCurve !== 0) l = l + (1 - l) * t.lightCurve * l;
  const metal = t.metal;
  if (metal !== null) {
    // Deep shade goes bronze rather than mustard.
    const deep = ramp(l0, metal.shadowBelow + SHADOW_FEATHER, metal.shadowBelow);
    if (deep > 0) h = h + hueDelta(h, metal.shadowHue) * deep;
  }
  if (band.strength < 1) {
    const k = band.strength;
    h = h0 + hueDelta(h0, h) * k;
    s = s0 + (s - s0) * k;
    l = l0 + (l - l0) * k;
  }
  hslToRgb(h, s, l, rgb);
  if (metal !== null) {
    // Polished edges: bright pixels move toward the pale metal colour.
    const m = ramp(l, metal.highlightAbove - METAL_FEATHER, metal.highlightAbove) * metal.highlight;
    if (m > 0) {
      parseHexInto(metal.highlightHex, metalRgb);
      rgb[0] = Math.round(rgb[0] + (metalRgb[0] - rgb[0]) * m);
      rgb[1] = Math.round(rgb[1] + (metalRgb[1] - rgb[1]) * m);
      rgb[2] = Math.round(rgb[2] + (metalRgb[2] - rgb[2]) * m);
    }
  }
}

/**
 * Remap one colour for `variant` of `charId`, writing [r, g, b] into `out`. Variant 0 and any
 * pixel outside every band come back unchanged.
 */
export function remapRgb(
  r: number,
  g: number,
  b: number,
  variant: number,
  out: number[],
  charId = 'aeval'
): void {
  out[0] = r;
  out[1] = g;
  out[2] = b;
  if (variant <= 0 || variant >= VARIANT_COUNT) return;
  const bands = paletteOf(charId).bands;
  rgbToHsl(r, g, b, hsl);
  const h0 = hsl[0];
  const s0 = hsl[1];
  const l0 = hsl[2];
  let ar = r;
  let ag = g;
  let ab = b;
  let left = 1;
  let touched = false;
  for (let k = 0; k < bands.length && left > 0; k++) {
    const band = bands[k];
    const t = band.targets[variant];
    const bw = bandWeight(band, h0, s0, l0);
    if (bw === 0) continue;
    const w = bw * left;
    left -= w;
    if (t === null || t === undefined) continue;
    targetRgb(band, t, h0, s0, l0);
    ar += (rgb[0] - r) * w;
    ag += (rgb[1] - g) * w;
    ab += (rgb[2] - b) * w;
    touched = true;
  }
  if (!touched) return;
  out[0] = Math.round(ar);
  out[1] = Math.round(ag);
  out[2] = Math.round(ab);
}

/** Remap RGBA pixels in place. Alpha is kept; fully transparent pixels are skipped. */
export function remapPixels(data: Uint8ClampedArray, variant: number, charId = 'aeval'): void {
  if (variant <= 0 || variant >= VARIANT_COUNT) return;
  const cache = new Map<number, number>();
  const out = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let packed = cache.get(key);
    if (packed === undefined) {
      remapRgb(data[i], data[i + 1], data[i + 2], variant, out, charId);
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

/** '#rrggbb' remapped for `variant` of `charId`. Used for particle and glow colours. */
export function remapHex(hex: string, variant: number, charId = 'aeval'): string {
  const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  const out = [0, 0, 0];
  remapRgb(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), variant, out, charId);
  return '#' + hex2(out[0]) + hex2(out[1]) + hex2(out[2]);
}

/**
 * Per variant, `hex` remapped for `charId`: a lookup table built once so the draw path never
 * builds a colour string.
 */
export function variantTable(hex: string, charId = 'aeval'): readonly string[] {
  const out: string[] = [];
  for (let v = 0; v < VARIANT_COUNT; v++) out.push(remapHex(hex, v, charId));
  return out;
}

PALETTES.aeval.swatches = variantTable(AEVAL_SWATCH_BASE, 'aeval');

/** Aeval's four swatch colours (select and lobby screens). Per character: variantSwatches(charId). */
export const VARIANT_SWATCHES: readonly string[] = PALETTES.aeval.swatches;

/** Display names of `charId`'s four colours, in variant order. */
export function variantNames(charId: string): readonly string[] {
  return paletteOf(charId).names;
}

/** Swatch colours of `charId`'s four variants, in variant order. */
export function variantSwatches(charId: string): readonly string[] {
  return paletteOf(charId).swatches;
}
