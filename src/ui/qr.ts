/**
 * A small QR code encoder (ISO/IEC 18004) for the in-browser LAN join codes: byte mode only,
 * error correction level L or M, versions 1 to 40, mask picked by the standard penalty score.
 * Follows the structure of Project Nayuki's reference encoder (MIT). No dependencies.
 */

export type QrEcl = 'L' | 'M';

// Per version (index 0 unused): error correction codewords per block, and number of blocks.
const ECC_PER_BLOCK: Record<QrEcl, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const NUM_BLOCKS: Record<QrEcl, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};
/** Format bits for the level (L = 01, M = 00). */
const ECL_BITS: Record<QrEcl, number> = { L: 1, M: 0 };

export interface QrCode {
  version: number;
  size: number;
  mask: number;
  /** size * size modules, row major, true = dark. */
  modules: boolean[];
}

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver: number, ecl: QrEcl): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10; out.length < numAlign; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ---- Reed-Solomon over GF(256), polynomial 0x11D ----

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 255;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

/** Data codewords split into blocks, error correction added, then interleaved. */
function addEccAndInterleave(data: number[], ver: number, ecl: QrEcl): number[] {
  const numBlocks = NUM_BLOCKS[ecl][ver];
  const eccLen = ECC_PER_BLOCK[ecl][ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = [];
  const div = rsDivisor(eccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
    });
  }
  return result;
}

// ---- Matrix ----

class Matrix {
  readonly modules: boolean[];
  readonly isFunction: boolean[];
  constructor(readonly size: number) {
    this.modules = new Array<boolean>(size * size).fill(false);
    this.isFunction = new Array<boolean>(size * size).fill(false);
  }
  get(x: number, y: number): boolean { return this.modules[y * this.size + x]; }
  setFn(x: number, y: number, dark: boolean): void {
    this.modules[y * this.size + x] = dark;
    this.isFunction[y * this.size + x] = true;
  }
}

function drawFunctionPatterns(m: Matrix, ver: number): void {
  const size = m.size;
  for (let i = 0; i < size; i++) {
    m.setFn(6, i, i % 2 === 0);
    m.setFn(i, 6, i % 2 === 0);
  }
  const finder = (x: number, y: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) m.setFn(xx, yy, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPositions(ver);
  const n = align.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) m.setFn(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormatBits(m, 'L', 0); // placeholder, overwritten once the mask is chosen
  drawVersion(m, ver);
}

function drawFormatBits(m: Matrix, ecl: QrEcl, mask: number): void {
  const data = (ECL_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
  const size = m.size;
  for (let i = 0; i <= 5; i++) m.setFn(8, i, bit(i));
  m.setFn(8, 7, bit(6));
  m.setFn(8, 8, bit(7));
  m.setFn(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.setFn(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.setFn(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.setFn(8, size - 15 + i, bit(i));
  m.setFn(8, size - 8, true); // the dark module
}

function drawVersion(m: Matrix, ver: number): void {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m.setFn(a, b, dark);
    m.setFn(b, a, dark);
  }
}

function drawCodewords(m: Matrix, data: number[]): void {
  const size = m.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.isFunction[y * size + x] && i < data.length * 8) {
          m.modules[y * size + x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      const k = y * m.size + x;
      if (!m.isFunction[k] && maskBit(mask, x, y)) m.modules[k] = !m.modules[k];
    }
  }
}

function finderPenaltyCountPatterns(history: number[]): number {
  const n = history[1];
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}

function finderPenaltyAddHistory(run: number, history: number[], size: number): void {
  if (history[0] === 0) run += size;
  history.pop();
  history.unshift(run);
}

function finderPenaltyTerminateAndCount(runColor: boolean, run: number, history: number[], size: number): number {
  if (runColor) {
    finderPenaltyAddHistory(run, history, size);
    run = 0;
  }
  run += size;
  finderPenaltyAddHistory(run, history, size);
  return finderPenaltyCountPatterns(history);
}

function penalty(m: Matrix): number {
  const size = m.size;
  let result = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let runColor = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < size; b++) {
        const dark = pass === 0 ? m.get(b, a) : m.get(a, b);
        if (dark === runColor) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          finderPenaltyAddHistory(run, history, size);
          if (!runColor) result += finderPenaltyCountPatterns(history) * 40;
          runColor = dark;
          run = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, run, history, size) * 40;
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m.get(x, y);
      if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1)) result += 3;
    }
  }
  let dark = 0;
  for (const v of m.modules) if (v) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * 10;
  return result;
}

/**
 * Encode `text` (UTF-8, byte mode) in the smallest version that fits at level `ecl`.
 * `forceMask` (0..7) skips the penalty search; the tests use it.
 */
export function encodeQr(text: string, ecl: QrEcl = 'L', forceMask = -1): QrCode {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ver <= 40; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver, ecl) * 8) break;
  }
  if (ver > 40) throw new Error('Text too long for a QR code');
  const capacity = dataCodewords(ver, ecl) * 8;
  const bits: number[] = [];
  const put = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0x4, 4); // byte mode
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    data.push(b);
  }
  const size = ver * 4 + 17;
  const m = new Matrix(size);
  drawFunctionPatterns(m, ver);
  drawCodewords(m, addEccAndInterleave(data, ver, ecl));
  let best = 0;
  let bestScore = Number.MAX_SAFE_INTEGER;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask >= 0 && mask !== forceMask) continue;
    applyMask(m, mask);
    drawFormatBits(m, ecl, mask);
    const score = penalty(m);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(m, mask); // undo (XOR)
  }
  applyMask(m, best);
  drawFormatBits(m, ecl, best);
  return { version: ver, size, mask: best, modules: m.modules.slice() };
}

/** SVG markup for a QR code: dark modules as one path, a 4-module quiet zone, light background. */
export function qrSvg(qr: QrCode, dark = '#070a16', light = '#e8eef8'): string {
  const border = 4;
  const dim = qr.size + border * 2;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) d += `M${x + border},${y + border}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
