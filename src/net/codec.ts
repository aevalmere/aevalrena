/**
 * Binary input packet, little endian. Layout:
 *
 *   u8  type (PACKET_INPUT)
 *   u8  peer id of the sender (0..3)
 *   u8  n = player count carried (the sender's own players, as fighter indices)
 *   u8  k = frame count carried
 *   i32 first frame
 *   i32 sender tick (frames it has simulated)
 *   i32 seenTick[4]  last tick the sender received from each peer id, -1 none (time sync)
 *   i32 ack[4]       last contiguous input frame the sender holds from each peer id, -1 none
 *   i32 hash frame (-1 none), u32 hash
 *   u8  player index[n]
 *   k * n * { u32 held, u32 pressed, u32 released, u8 direct }
 */

export const PACKET_INPUT = 1;
export const MAX_PEERS = 4;
const HEADER = 4 + 4 + 4 + 16 + 16 + 8;
const PER_INPUT = 13;

export interface InputPacket {
  peer: number;
  firstFrame: number;
  tick: number;
  seenTick: Int32Array;
  ack: Int32Array;
  hashFrame: number;
  hash: number;
  players: number[];
  /** frames * players * 4 ints: held, pressed, released, direct. */
  inputs: Int32Array;
  frames: number;
}

export function createPacket(): InputPacket {
  return {
    peer: 0, firstFrame: 0, tick: 0,
    seenTick: new Int32Array(MAX_PEERS).fill(-1), ack: new Int32Array(MAX_PEERS).fill(-1),
    hashFrame: -1, hash: 0, players: [], inputs: new Int32Array(0), frames: 0,
  };
}

export function encodePacket(p: InputPacket): Uint8Array {
  const n = p.players.length;
  const size = HEADER + n + p.frames * n * PER_INPUT;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, PACKET_INPUT);
  dv.setUint8(1, p.peer);
  dv.setUint8(2, n);
  dv.setUint8(3, p.frames);
  dv.setInt32(4, p.firstFrame, true);
  dv.setInt32(8, p.tick, true);
  let o = 12;
  for (let i = 0; i < MAX_PEERS; i++, o += 4) dv.setInt32(o, p.seenTick[i], true);
  for (let i = 0; i < MAX_PEERS; i++, o += 4) dv.setInt32(o, p.ack[i], true);
  dv.setInt32(o, p.hashFrame, true);
  dv.setUint32(o + 4, p.hash >>> 0, true);
  o += 8;
  for (let i = 0; i < n; i++) dv.setUint8(o++, p.players[i]);
  const total = p.frames * n;
  for (let i = 0; i < total; i++) {
    dv.setUint32(o, p.inputs[i * 4] >>> 0, true);
    dv.setUint32(o + 4, p.inputs[i * 4 + 1] >>> 0, true);
    dv.setUint32(o + 8, p.inputs[i * 4 + 2] >>> 0, true);
    dv.setUint8(o + 12, p.inputs[i * 4 + 3] & 0xff);
    o += PER_INPUT;
  }
  return buf;
}

/** Decode into `out`. Returns false for anything that is not a well formed input packet. */
export function decodePacket(buf: Uint8Array, out: InputPacket): boolean {
  if (buf.byteLength < HEADER) return false;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint8(0) !== PACKET_INPUT) return false;
  const n = dv.getUint8(2);
  const k = dv.getUint8(3);
  if (buf.byteLength !== HEADER + n + k * n * PER_INPUT) return false;
  out.peer = dv.getUint8(1);
  out.frames = k;
  out.firstFrame = dv.getInt32(4, true);
  out.tick = dv.getInt32(8, true);
  let o = 12;
  for (let i = 0; i < MAX_PEERS; i++, o += 4) out.seenTick[i] = dv.getInt32(o, true);
  for (let i = 0; i < MAX_PEERS; i++, o += 4) out.ack[i] = dv.getInt32(o, true);
  out.hashFrame = dv.getInt32(o, true);
  out.hash = dv.getUint32(o + 4, true);
  o += 8;
  out.players.length = n;
  for (let i = 0; i < n; i++) out.players[i] = dv.getUint8(o++);
  const total = k * n;
  if (out.inputs.length < total * 4) out.inputs = new Int32Array(total * 4);
  for (let i = 0; i < total; i++) {
    out.inputs[i * 4] = dv.getUint32(o, true) | 0;
    out.inputs[i * 4 + 1] = dv.getUint32(o + 4, true) | 0;
    out.inputs[i * 4 + 2] = dv.getUint32(o + 8, true) | 0;
    out.inputs[i * 4 + 3] = dv.getUint8(o + 12);
    o += PER_INPUT;
  }
  return true;
}
