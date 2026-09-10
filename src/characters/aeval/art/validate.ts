import type { PixelSheet } from '../../../core/types';
import { PALETTE } from './palette';
import { BODY_FRAMES } from './body';
import { FX_FRAMES } from './fx';

/**
 * Check every frame in a sheet: rows of equal length, the expected size when
 * `w` and `h` are given, and only characters that exist in the palette
 * (plus '.' for transparent). Returns one string per problem found.
 */
export function validateSheet(sheet: PixelSheet, w: number | null, h: number | null): string[] {
  const errors: string[] = [];
  const names = Object.keys(sheet.frames);
  for (const name of names) {
    const rows = sheet.frames[name];
    if (!rows || rows.length === 0) {
      errors.push(`${name}: empty frame`);
      continue;
    }
    const width = rows[0].length;
    for (let y = 0; y < rows.length; y++) {
      if (rows[y].length !== width) {
        errors.push(`${name}: row ${y} is ${rows[y].length} wide, row 0 is ${width}`);
      }
    }
    if (h !== null && rows.length !== h) {
      errors.push(`${name}: height ${rows.length}, expected ${h}`);
    }
    if (w !== null && width !== w) {
      errors.push(`${name}: width ${width}, expected ${w}`);
    }
    const bad = new Set<string>();
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch !== '.' && sheet.palette[ch] === undefined) bad.add(ch);
      }
    }
    for (const ch of bad) errors.push(`${name}: character '${ch}' is not in the palette`);
  }
  return errors;
}

/** Expected size of every effect frame, as [width, height]. */
export const FX_SIZES: Record<string, [number, number]> = {
  orb0: [12, 12], orb1: [12, 12], orb2: [12, 12],
  crescent0: [36, 20], crescent1: [36, 20],
  geyser0: [24, 48], geyser1: [24, 48], geyser2: [24, 48],
  whirl0: [40, 24], whirl1: [40, 24], whirl2: [40, 24],
  splash0: [16, 12], splash1: [16, 12], splash2: [16, 12],
  hitspark0: [12, 12], hitspark1: [12, 12], hitspark2: [12, 12],
  dust0: [12, 6], dust1: [12, 6], dust2: [12, 6],
  ko0: [32, 32], ko1: [32, 32], ko2: [32, 32], ko3: [32, 32],
};

declare const process: { argv: string[] };

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('validate.ts')) {
  const body: PixelSheet = { palette: PALETTE, frames: BODY_FRAMES };
  const errors = validateSheet(body, 32, 40);

  const fxNames = Object.keys(FX_FRAMES);
  for (const name of fxNames) {
    const size = FX_SIZES[name];
    if (!size) {
      errors.push(`${name}: no expected size registered`);
      continue;
    }
    const one: PixelSheet = { palette: PALETTE, frames: { [name]: FX_FRAMES[name] } };
    for (const e of validateSheet(one, size[0], size[1])) errors.push(e);
  }
  for (const name of Object.keys(FX_SIZES)) {
    if (!FX_FRAMES[name]) errors.push(`${name}: expected effect frame is missing`);
  }

  for (const e of errors) console.log(e);
  if (errors.length === 0) {
    console.log(`OK ${Object.keys(BODY_FRAMES).length} body frames, ${fxNames.length} fx frames`);
  }
}
