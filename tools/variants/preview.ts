/**
 * Colour variant previews. Decodes Aeval's packed body and fx atlases, runs a handful of
 * frames and the select-screen bust through src/render/palette.ts (the same remap the game
 * bakes with), and writes one PNG per variant to art/aeval/preview_variants/.
 *
 * Run: npx --yes tsx tools/variants/preview.ts
 *
 * The PNG reader handles what the atlases and icons use (8-bit RGBA or RGB, not interlaced).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { AEVAL_BODY_SHEET } from '../../src/characters/aeval/art/atlas.body';
import { AEVAL_FX_SHEET } from '../../src/characters/aeval/art/atlas.fx';
import type { ImageSheetData } from '../../src/core/types';
import { VARIANT_COUNT, VARIANT_NAMES, remapPixels } from '../../src/render/palette';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'art', 'aeval', 'preview_variants');
const SCALE = 3;
const GAP = 6;
const BG = [0x1a, 0x1b, 0x26];

const BODY_FRAMES = ['moves_idle_0', 'special_wave_5', 'special_whirl_4', 'uptilt_spike_2'];
const FX_FRAMES = ['orb3', 'orbBig5', 'crescent1', 'burst5', 'orbCharge7', 'geyser1'];

interface Img { w: number; h: number; data: Uint8Array }

function decodePng(buf: Uint8Array): Img {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  const idat: Uint8Array[] = [];
  while (o < buf.length) {
    const len = dv.getUint32(o);
    const kind = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
    const body = buf.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') {
      w = dv.getUint32(o + 8);
      h = dv.getUint32(o + 12);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit, non-interlaced PNGs');
      type = body[9];
      if (type !== 6 && type !== 2) throw new Error(`PNG colour type ${type} not handled`);
    } else if (kind === 'IDAT') {
      idat.push(body);
    }
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = type === 6 ? 4 : 3;
  const stride = w * bpp;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  if (bpp === 4) return { w, h, data: px };
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    rgba[j] = px[i];
    rgba[j + 1] = px[i + 1];
    rgba[j + 2] = px[i + 2];
    rgba[j + 3] = 255;
  }
  return { w, h, data: rgba };
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(kind: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(kind, 4, 'latin1');
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

function encodePng(img: Img): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((img.w * 4 + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw[y * (img.w * 4 + 1)] = 0;
    Buffer.from(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4)).copy(raw, y * (img.w * 4 + 1) + 1);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

function atlasOf(sheet: ImageSheetData): Img {
  const comma = sheet.url.indexOf(',');
  return decodePng(new Uint8Array(Buffer.from(sheet.url.slice(comma + 1), 'base64')));
}

function crop(src: Img, x: number, y: number, w: number, h: number): Img {
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    data.set(src.data.subarray(((y + row) * src.w + x) * 4, ((y + row) * src.w + x + w) * 4), row * w * 4);
  }
  return { w, h, data };
}

function frameOf(atlas: Img, sheet: ImageSheetData, name: string): Img {
  const r = sheet.frames[name];
  if (r === undefined) throw new Error(`frame ${name} missing`);
  return crop(atlas, r[0], r[1], r[2], r[3]);
}

/** Lay the pieces out left to right on one row per group, scaled, over the INK background. */
function sheetOf(rows: Img[][]): Img {
  let w = GAP;
  let h = GAP;
  for (const row of rows) {
    let rw = GAP;
    let rh = 0;
    for (const p of row) {
      rw += p.w * SCALE + GAP;
      rh = Math.max(rh, p.h * SCALE);
    }
    w = Math.max(w, rw);
    h += rh + GAP;
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BG[0];
    data[i + 1] = BG[1];
    data[i + 2] = BG[2];
    data[i + 3] = 255;
  }
  let oy = GAP;
  for (const row of rows) {
    let ox = GAP;
    let rh = 0;
    for (const p of row) {
      for (let y = 0; y < p.h * SCALE; y++) {
        for (let x = 0; x < p.w * SCALE; x++) {
          const s = (((y / SCALE) | 0) * p.w + ((x / SCALE) | 0)) * 4;
          const a = p.data[s + 3] / 255;
          if (a === 0) continue;
          const d = ((oy + y) * w + ox + x) * 4;
          for (let k = 0; k < 3; k++) data[d + k] = Math.round(p.data[s + k] * a + data[d + k] * (1 - a));
        }
      }
      ox += p.w * SCALE + GAP;
      rh = Math.max(rh, p.h * SCALE);
    }
    oy += rh + GAP;
  }
  return { w, h, data };
}

function main(): void {
  const body = atlasOf(AEVAL_BODY_SHEET);
  const fx = atlasOf(AEVAL_FX_SHEET);
  const bust = decodePng(new Uint8Array(readFileSync(join(ROOT, 'public', 'icons', 'aeval-bust.png'))));
  mkdirSync(OUT_DIR, { recursive: true });
  for (let v = 0; v < VARIANT_COUNT; v++) {
    const bodyRow = BODY_FRAMES.map((n) => frameOf(body, AEVAL_BODY_SHEET, n));
    const fxRow = FX_FRAMES.map((n) => frameOf(fx, AEVAL_FX_SHEET, n));
    const iconRow = [{ w: bust.w, h: bust.h, data: bust.data.slice() }];
    for (const p of [...bodyRow, ...fxRow, ...iconRow]) remapPixels(new Uint8ClampedArray(p.data.buffer), v);
    const out = join(OUT_DIR, `${v}-${VARIANT_NAMES[v].toLowerCase()}.png`);
    writeFileSync(out, encodePng(sheetOf([bodyRow, fxRow, iconRow])));
    console.log(out);
  }
}

main();
